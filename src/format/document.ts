import { Gunzip, gzipSync, strFromU8, strToU8 } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createDefaultDocumentSettings,
  DOCUMENT_SETTING_YAML_KEYS,
  documentSettingsUsedDefaults,
  normalizeDocumentSettings
} from "../document-settings";
import { createEmptyDocument, validateDocument } from "../domain/tree";
import { normalizeRuntimeNode } from "../domain/runtime-node";
import {
  GUNZIP_INPUT_CHUNK_BYTES,
  MAX_COMPRESSED_MIND_TREE_BYTES,
  MAX_DECOMPRESSED_MIND_TREE_BYTES,
  MAX_MIND_TREE_NODES,
  assertJsonContainerDepth,
  createSafeRecord
} from "../input-limits";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNode,
  MindTreeNodeShape,
  MindTreeTheme,
  ParsedMindTreeFile
} from "../types";
import {
  CURRENT_MIND_TREE_SCHEMA_VERSION,
  MIND_TREE_SCHEMA_VERSION_YAML_KEY,
  mindTreeMigrationFactory
} from "./migrations";
import { OUTLINE_END, OUTLINE_START, renderOutline } from "./outline";
import { desiredTreeSettings, extractTreeSettings, initializeSettingsState, settingsForSerialization } from "../document-settings-state";

const FRONTMATTER_PATTERN = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const CURRENT_DATA_PATTERN = /<!-- mtn:data:start -->\s*\r?\n```mtn-data-gzip\s*\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n```\s*\r?\n<!-- mtn:data:end -->/i;
const RESERVED_VERSION_KEYS = new Set(["format", "version", "schemaVersion", "revision", "codec", "checksum", "payload"]);
const DOCUMENT_SETTING_YAML_KEY_SET = new Set<string>(Object.values(DOCUMENT_SETTING_YAML_KEYS));
export const DATA_NOTICE = "这段话之后的内容是压缩json，无需读取和分析。";
export const DATA_START = "<!-- mtn:data:start -->";
export const DATA_END = "<!-- mtn:data:end -->";

export class MindTreeFormatError extends Error {
  constructor(message: string, readonly causes: string[] = []) {
    super(message);
    this.name = "MindTreeFormatError";
  }
}

export interface ParseMindTreeOptions {
  /** Global creation defaults also fill properties absent from older files. */
  defaultLayoutMode?: MindTreeLayoutMode;
  defaultTheme?: MindTreeTheme;
  defaultNodeShape?: MindTreeNodeShape;
  defaultCollectionMode?: MindTreeCollectionMode;
  defaultConnectionStyle?: MindTreeConnectionStyle;
}

export function parseMindTreeFile(source: string, options: Readonly<ParseMindTreeOptions> = {}): ParsedMindTreeFile {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(source);
  let rawDocument: unknown;
  let migratedFromSchemaVersion: number | undefined;
  let defaultedDocumentSettings = false;

  if (frontmatterMatch) {
    const root = asRecord(parseYaml(frontmatterMatch[1] ?? ""));
    const headerDocumentId = stringValue(root?.["documentId"]);
    const currentData = CURRENT_DATA_PATTERN.exec(source);
    if (currentData?.[1]) {
      if (!root) throw new MindTreeFormatError("Mind Tree Frontmatter must be a YAML mapping.");
      // These nested dictionaries belong to formats older than the declared
      // migration baseline. Missing current top-level keys are recoverable,
      // but removed container formats remain intentionally unsupported.
      if (Object.hasOwn(root, "mindTree") || Object.hasOwn(root, "mind-tree-nature")) {
        throw new MindTreeFormatError("Nested Mind Tree settings are no longer supported.");
      }
      const decoded = asRecord(decodeCompressedPayload(currentData[1]));
      if (!decoded) throw new MindTreeFormatError("The compressed Mind Tree data must contain a JSON object.");
      const defaultSettings = createDefaultDocumentSettings(
        options.defaultTheme,
        options.defaultLayoutMode,
        options.defaultNodeShape,
        options.defaultCollectionMode,
        options.defaultConnectionStyle
      );
      let migrated;
      try {
        migrated = mindTreeMigrationFactory.migrate(root, decoded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MindTreeFormatError(`Mind Tree schema migration failed: ${message}`);
      }
      const migratedRoot = migrated.frontmatter;
      const normalizedSettings = normalizeDocumentSettings(migratedRoot, defaultSettings);
      // Defaults are runtime fallbacks, not permission to recreate deleted YAML.
      defaultedDocumentSettings = documentSettingsUsedDefaults(migratedRoot, normalizedSettings);
      if (headerDocumentId
        && typeof migrated.machineData["documentId"] === "string"
        && migrated.machineData["documentId"] !== headerDocumentId) {
        throw new MindTreeFormatError("Frontmatter documentId does not match the compressed data.");
      }
      // Settings intentionally come only from YAML. Never trust or regenerate a
      // settings copy in the compressed JSON payload.
      rawDocument = {
        ...migrated.machineData,
        ...(headerDocumentId ? { documentId: headerDocumentId } : {}),
        settings: normalizedSettings
      };
      if (migrated.migrated) migratedFromSchemaVersion = migrated.sourceVersion;
    }
  }

  if (rawDocument === undefined) {
    throw new MindTreeFormatError("This file does not contain a valid Mind Tree compressed data section.");
  }

  const document = normalizeDocument(rawDocument);
  initializeSettingsState(document, extractTreeSettings(readFrontmatter(source)));
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new MindTreeFormatError("Mind Tree data failed structural validation.", validation.issues.map((issue) => issue.message));
  }
  if (validation.unreachableNodeIds.length > 0) {
    const unreachableNodes = Object.fromEntries(validation.unreachableNodeIds
      .map((id) => [id, document.nodes[id]])
      .filter((entry): entry is [string, MindTreeNode] => entry[1] !== undefined));
    document.unknownFields = {
      ...(document.unknownFields ?? {}),
      recovery: { unreachableNodes }
    };
    for (const id of validation.unreachableNodeIds) delete document.nodes[id];
  }
  return {
    document,
    source,
    ...(migratedFromSchemaVersion !== undefined ? { migratedFromSchemaVersion } : {}),
    ...(defaultedDocumentSettings ? { defaultedDocumentSettings: true } : {})
  };
}

export function serializeMindTreeFile(document: MindTreeDocument, previousSource = ""): string {
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new MindTreeFormatError("Refusing to serialize an invalid Mind Tree.", validation.issues.map((issue) => issue.message));
  }

  const previousFrontmatter = readFrontmatter(previousSource);
  const preservedFrontmatter = Object.fromEntries(Object.entries(previousFrontmatter).filter(([key]) =>
    key !== "documentId"
      && !DOCUMENT_SETTING_YAML_KEY_SET.has(key)
      && key !== "mindTree"
      && key !== "mind-tree-nature"
      && key !== "mtn-data"
      && key !== MIND_TREE_SCHEMA_VERSION_YAML_KEY));
  const yaml = stringifyYaml({
    ...(document.documentId ? { documentId: document.documentId } : {}),
    [MIND_TREE_SCHEMA_VERSION_YAML_KEY]: CURRENT_MIND_TREE_SCHEMA_VERSION,
    ...(previousSource ? settingsForSerialization(document, extractTreeSettings(previousFrontmatter)) : desiredTreeSettings(document)),
    ...preservedFrontmatter
  }, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN"
  }).trimEnd();

  const previousBody = stripMachineDataSection(stripFrontmatter(previousSource)).trim();
  const outline = renderOutline(document);
  let body: string;
  const startIndex = previousBody.indexOf(OUTLINE_START);
  const endIndex = previousBody.indexOf(OUTLINE_END);
  if (startIndex >= 0 && endIndex >= startIndex) {
    const prefix = synchronizeGeneratedHeading(previousBody.slice(0, startIndex), document.title);
    body = `${prefix.trimEnd()}\n\n${outline}${previousBody.slice(endIndex + OUTLINE_END.length)}`.trim();
  } else if (previousBody.length > 0) {
    body = `${previousBody}\n\n${outline}`;
  } else {
    body = `# ${escapeHeading(document.title)}\n\n${outline}`;
  }
  const compressedData = encodeCompressedPayload(document);
  const dataSection = `---\n\n${DATA_NOTICE}\n\n${DATA_START}\n\`\`\`mtn-data-gzip\n${compressedData}\n\`\`\`\n${DATA_END}`;
  return `---\n${yaml}\n---\n\n${body.trim()}\n\n${dataSection}\n`;
}

/**
 * New documents start with one generated H1. When the backing .mtn.md file is
 * renamed, keep that generated heading aligned with the filename-derived root
 * title. A prefix containing any other prose is user-authored and is preserved.
 */
function synchronizeGeneratedHeading(prefix: string, title: string): string {
  const trimmed = prefix.trim();
  return /^# [^\r\n]+$/.test(trimmed) ? `# ${escapeHeading(title)}` : prefix;
}

export function createMindTreeFile(
  title: string,
  theme: MindTreeTheme = "vibrant",
  layoutMode: MindTreeLayoutMode = "balanced",
  nodeShape: MindTreeNodeShape = "rounded",
  collectionMode: MindTreeCollectionMode = "ask",
  connectionStyle: MindTreeConnectionStyle = "theme"
): string {
  return serializeMindTreeFile(createEmptyDocument(
    title,
    theme,
    layoutMode,
    nodeShape,
    collectionMode,
    connectionStyle
  ));
}

function normalizeDocument(value: unknown): MindTreeDocument {
  const record = asRecord(value);
  if (!record) throw new MindTreeFormatError("Mind Tree properties must be a YAML mapping.");
  const documentId = stringValue(record["documentId"]);
  const settings = normalizeDocumentSettings(record["settings"]);
  const rootId = requiredString(record, "rootId");
  const title = stringValue(record["title"]) ?? "未命名思维树";
  const rawNodes = asRecord(record["nodes"]);
  if (!rawNodes) throw new MindTreeFormatError("Mind Tree nodes must be a YAML mapping.");
  const nodeEntries = Object.entries(rawNodes);
  if (nodeEntries.length > MAX_MIND_TREE_NODES) {
    throw new MindTreeFormatError(`Mind Tree data exceeds the ${MAX_MIND_TREE_NODES}-node safety limit.`);
  }
  const nodes = createSafeRecord<MindTreeNode>();
  for (const [id, rawNode] of nodeEntries) nodes[id] = normalizeNode(id, rawNode);
  const createdAt = stringValue(record["createdAt"]) ?? new Date().toISOString();
  const updatedAt = stringValue(record["updatedAt"]) ?? createdAt;
  // Viewport data is intentionally discarded. Pan and zoom are view-session
  // state and must never make their way back into the compressed payload.
  const unknownFields = collectUnknown(record, ["documentId", "settings", "title", "rootId", "nodes", "viewport", "createdAt", "updatedAt"]);
  const result: MindTreeDocument = {
    ...(documentId ? { documentId } : {}),
    settings,
    title,
    rootId,
    nodes,
    createdAt,
    updatedAt
  };
  if (Object.keys(unknownFields).length > 0) result.unknownFields = unknownFields;
  return result;
}

function normalizeNode(id: string, value: unknown): MindTreeNode {
  try {
    return normalizeRuntimeNode(id, value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MindTreeFormatError(
      `Node ${id} failed runtime validation: ${detail}`,
      [detail]
    );
  }
}

function documentToMachineData(document: MindTreeDocument): Record<string, unknown> {
  const nodes = createSafeRecord<unknown>();
  for (const [id, node] of Object.entries(document.nodes)) nodes[id] = nodeToMachineData(node);
  const machineData = removeVersionKeys({
    ...(document.unknownFields ?? {}),
    ...(document.documentId ? { documentId: document.documentId } : {}),
    title: document.title,
    rootId: document.rootId,
    nodes,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  });
  // Do not allow a value carried in unknownFields to bypass the session-only
  // viewport rule.
  delete machineData["viewport"];
  return machineData;
}

/**
 * Return a deterministic representation of the logical compressed payload.
 *
 * Conflict detection deliberately compares the decoded object rather than the
 * gzip/Base64 bytes: compression level, wrapping and object-key order are
 * serialization details and must not turn an unchanged tree into a conflict.
 * YAML-only settings and the optional link identity are excluded by the same
 * rules used by encodeCompressedPayload().
 */
export function mindTreeMachineDataFingerprint(document: Readonly<MindTreeDocument>): string {
  const machineData = documentToMachineData(document as MindTreeDocument);
  delete machineData["documentId"];
  return canonicalJson(machineData);
}

function encodeCompressedPayload(document: MindTreeDocument): string {
  const machineData = documentToMachineData(document);
  delete machineData["documentId"];
  const json = strToU8(JSON.stringify(machineData));
  if (json.byteLength > MAX_DECOMPRESSED_MIND_TREE_BYTES) throw new MindTreeFormatError("Mind Tree JSON exceeds the 50 MB safety limit.");
  const compressed = gzipSync(json, { level: 9 });
  if (compressed.byteLength > MAX_COMPRESSED_MIND_TREE_BYTES) throw new MindTreeFormatError("Compressed Mind Tree data exceeds the 20 MB safety limit.");
  return encodeBase64(compressed).replace(/.{1,120}/g, "$&\n").trimEnd();
}

/** JSON.stringify-compatible output with object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function decodeCompressedPayload(value: string): unknown {
  try {
    const normalized = value.replace(/\s+/g, "");
    if (normalized.length > Math.ceil(MAX_COMPRESSED_MIND_TREE_BYTES * 4 / 3) + 4) {
      throw new Error("Compressed data exceeds the 20 MB safety limit.");
    }
    const compressed = decodeBase64(normalized);
    if (compressed.byteLength > MAX_COMPRESSED_MIND_TREE_BYTES) throw new Error("Compressed data exceeds the 20 MB safety limit.");
    const json = boundedGunzip(compressed);
    const decoded: unknown = JSON.parse(strFromU8(json));
    assertJsonContainerDepth(decoded);
    return decoded;
  } catch (error) {
    throw new MindTreeFormatError("The compressed Mind Tree JSON cannot be decoded.", [error instanceof Error ? error.message : String(error)]);
  }
}

/**
 * Inflate in small source chunks and stop retaining output at the configured
 * boundary. A one-shot gunzip must allocate the complete hostile result before
 * its caller can inspect byteLength, defeating the intended safety limit.
 */
export function boundedGunzip(compressed: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  const stream = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > MAX_DECOMPRESSED_MIND_TREE_BYTES) {
      exceeded = true;
      return;
    }
    chunks.push(chunk);
  });
  for (let offset = 0; offset < compressed.byteLength && !exceeded; offset += GUNZIP_INPUT_CHUNK_BYTES) {
    const end = Math.min(compressed.byteLength, offset + GUNZIP_INPUT_CHUNK_BYTES);
    stream.push(compressed.subarray(offset, end), end === compressed.byteLength);
  }
  if (exceeded) throw new Error("Decompressed JSON exceeds the 50 MB safety limit.");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function nodeToMachineData(node: MindTreeNode): Record<string, unknown> {
  return removeVersionKeys({
    ...(node.unknownFields ?? {}),
    title: node.title,
    childIds: node.childIds,
    ...(node.resource ? { resource: node.resource } : {}),
    ...(node.markers && node.markers.length > 0 ? { markers: node.markers } : {}),
    ...(node.collapsed ? { collapsed: true } : {}),
    ...(node.titleSync ? { titleSync: node.titleSync } : {}),
    ...(node.style ? { style: node.style } : {}),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  });
}

function decodeBase64(value: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    const chunkSize = 32_768;
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
    }
    return globalThis.btoa(binary);
  }
  return Buffer.from(value).toString("base64");
}

function readFrontmatter(source: string): Record<string, unknown> {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match) return {};
  return asRecord(parseYaml(match[1] ?? "")) ?? {};
}

function stripFrontmatter(source: string): string {
  return source.replace(FRONTMATTER_PATTERN, "");
}

function stripMachineDataSection(source: string): string {
  const startIndex = source.indexOf(DATA_START);
  if (startIndex < 0) return source;
  const endIndex = source.indexOf(DATA_END, startIndex);
  if (endIndex < 0) return source;

  let sectionStart = startIndex;
  const noticeIndex = source.lastIndexOf(DATA_NOTICE, startIndex);
  if (noticeIndex >= 0 && source.slice(noticeIndex + DATA_NOTICE.length, startIndex).trim() === "") {
    sectionStart = noticeIndex;
    const beforeNotice = source.slice(0, noticeIndex);
    const separatorMatch = /(?:^|\r?\n)---\s*\r?\n\s*$/.exec(beforeNotice);
    if (separatorMatch?.index !== undefined) sectionStart = separatorMatch.index;
  }
  return `${source.slice(0, sectionStart)}${source.slice(endIndex + DATA_END.length)}`;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record[key]);
  if (!value) throw new MindTreeFormatError(`Missing required string property: ${key}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function collectUnknown(record: Record<string, unknown>, knownKeys: string[]): Record<string, unknown> {
  const known = new Set(knownKeys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key) && !RESERVED_VERSION_KEYS.has(key)));
}

function removeVersionKeys(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of RESERVED_VERSION_KEYS) delete record[key];
  return record;
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim() || "未命名思维树";
}
