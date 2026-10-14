import { Gunzip, gzipSync, strFromU8, strToU8 } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createDefaultDocumentSettings,
  DOCUMENT_SETTING_YAML_KEYS,
  documentSettingsUsedDefaults,
  normalizeDocumentSettings
} from "../document-settings";
import { createEmptyDocument, pruneDanglingNodeLinks, validateDocument } from "../domain/tree";
import { normalizeRuntimeNode } from "../domain/runtime-node";
import {
  GUNZIP_INPUT_CHUNK_BYTES,
  MAX_COMPRESSED_MIND_TREE_BYTES,
  MAX_DECOMPRESSED_MIND_TREE_BYTES,
  MAX_MIND_TREE_NODES,
  asRecord,
  assertJsonContainerDepth,
  createSafeRecord,
  exceedsNodeBudget,
  stringValue
} from "../input-limits";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeHeaderStatus,
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
import { DATA_END, DATA_FENCE_LANGUAGE, DATA_NOTICE, DATA_START, locateDataRegion, payloadSectionStart } from "./regions";
import { patchYamlHeader, type YamlPropertyPatch } from "./yaml-patch";
import { desiredTreeSettings, extractTreeSettings, initializeSettingsState, settingsForSerialization, TREE_SETTING_KEYS } from "../document-settings-state";

/**
 * The header may be preceded by blank lines (a sync client or an editor can add
 * one) but never by prose: a `---` block after text is a horizontal rule, not
 * Frontmatter. The preamble is captured so a save can put it back unchanged.
 */
const FRONTMATTER_PATTERN = /^((?:[ \t]*\r?\n)*)(\uFEFF?)(---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$))/;
const RESERVED_VERSION_KEYS = new Set(["format", "version", "schemaVersion", "revision", "codec", "checksum", "payload"]);
const DOCUMENT_SETTING_YAML_KEY_SET = new Set<string>(Object.values(DOCUMENT_SETTING_YAML_KEYS));
export { DATA_END, DATA_NOTICE, DATA_START };

/** The YAML header with its exact bytes, so an unreadable one is never rebuilt. */
interface HeaderRegion {
  readonly status: MindTreeHeaderStatus;
  /** Blank lines and BOM before the opening delimiter; always re-emitted. */
  readonly leading: string;
  /** Header bytes including both `---` delimiters and the trailing line break. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly parsed: Record<string, unknown>;
}
/**
 * Runtime fallback for a document whose `title` is missing. Deliberately not
 * `ROOT_TITLE` from domain/tree: "a parsed tree without a title" and "a brand
 * new tree" are different situations that the product may want to word
 * differently, so only the duplicated literal is removed here.
 */
const UNTITLED_TREE_TITLE = "未命名思维树";

export class MindTreeFormatError extends Error {
  constructor(message: string, readonly causes: string[] = []) {
    super(message);
    this.name = "MindTreeFormatError";
  }
}

export interface ParseMindTreeOptions {
  /** Global defaults resolve every property the file does not carry; never written back. */
  defaultLayoutMode?: MindTreeLayoutMode;
  defaultTheme?: MindTreeTheme;
  defaultNodeShape?: MindTreeNodeShape;
  defaultCollectionMode?: MindTreeCollectionMode;
  defaultConnectionStyle?: MindTreeConnectionStyle;
}

export function parseMindTreeFile(source: string, options: Readonly<ParseMindTreeOptions> = {}): ParsedMindTreeFile {
  const header = readHeaderRegion(source);
  const located = locateDataRegion(source);
  // The compressed payload is the only part of the container that carries tree
  // data, so it is the only part whose absence is a hard failure. The header and
  // the readable outline are recoverable decorations: Obsidian rewrites links
  // above the payload, sync clients replace the whole file, and users edit prose.
  if (!located.ok) {
    throw new MindTreeFormatError(located.reason === "ambiguous"
      ? "This file contains more than one Mind Tree compressed data section."
      : "This file does not contain a valid Mind Tree compressed data section.");
  }
  if (header.status === "ok" && (Object.hasOwn(header.parsed, "mindTree") || Object.hasOwn(header.parsed, "mind-tree-nature"))) {
    throw new MindTreeFormatError("Nested Mind Tree settings are no longer supported.");
  }
  const root = header.parsed;
  const headerDocumentId = stringValue(root["documentId"]);
  const decoded = asRecord(decodeCompressedPayload(located.region.payload));
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
    // An unreadable or missing header reads as the baseline version, exactly
    // like a file whose schema marker was never written.
    migrated = mindTreeMigrationFactory.migrate(root, decoded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MindTreeFormatError(`Mind Tree schema migration failed: ${message}`);
  }
  const migratedRoot = migrated.frontmatter;
  const normalizedSettings = normalizeDocumentSettings(migratedRoot, defaultSettings);
  // Defaults are runtime fallbacks, not permission to recreate deleted YAML.
  const defaultedDocumentSettings = documentSettingsUsedDefaults(migratedRoot, normalizedSettings);
  if (headerDocumentId
    && typeof migrated.machineData["documentId"] === "string"
    && migrated.machineData["documentId"] !== headerDocumentId) {
    throw new MindTreeFormatError("Frontmatter documentId does not match the compressed data.");
  }
  // Settings intentionally come only from YAML. Never trust or regenerate a
  // settings copy in the compressed JSON payload.
  const rawDocument: unknown = {
    ...migrated.machineData,
    ...(headerDocumentId ? { documentId: headerDocumentId } : {}),
    settings: normalizedSettings
  };
  const migratedFromSchemaVersion = migrated.migrated ? migrated.sourceVersion : undefined;

  const document = normalizeDocument(rawDocument);
  initializeSettingsState(document, extractTreeSettings(root));
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
    headerStatus: header.status,
    ...(migratedFromSchemaVersion !== undefined ? { migratedFromSchemaVersion } : {}),
    ...(defaultedDocumentSettings ? { defaultedDocumentSettings: true } : {})
  };
}

export function serializeMindTreeFile(document: MindTreeDocument, previousSource = ""): string {
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new MindTreeFormatError("Refusing to serialize an invalid Mind Tree.", validation.issues.map((issue) => issue.message));
  }

  const source = previousSource ?? "";
  const header = readHeaderRegion(source);
  const located = locateDataRegion(source);
  // Two payload sections mean something else already damaged the container.
  // Picking one would drop the other, so the file is left exactly as it is.
  if (!located.ok && located.reason === "ambiguous") {
    throw new MindTreeFormatError("Refusing to rewrite a file with more than one Mind Tree compressed data section.");
  }
  const bodyEnd = located.ok ? damagedSectionStart(source, header.end, located.region.replaceStart) : source.length;
  const trailing = located.ok ? source.slice(located.region.replaceEnd) : "";

  const preservedFrontmatter = Object.fromEntries(Object.entries(header.parsed).filter(([key]) =>
    key !== "documentId"
      && !DOCUMENT_SETTING_YAML_KEY_SET.has(key)
      && key !== "mindTree"
      && key !== "mind-tree-nature"
      && key !== "mtn-data"
      && key !== MIND_TREE_SCHEMA_VERSION_YAML_KEY));
  const yaml = stringifyYaml({
    ...(document.documentId ? { documentId: document.documentId } : {}),
    [MIND_TREE_SCHEMA_VERSION_YAML_KEY]: CURRENT_MIND_TREE_SCHEMA_VERSION,
    ...(source ? settingsForSerialization(document, extractTreeSettings(header.parsed)) : desiredTreeSettings(document)),
    ...preservedFrontmatter
  }, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN"
  }).trimEnd();
  // Owned properties are patched in place so comments, key order and Frontmatter
  // the plugin does not own stay byte-identical. A header that cannot be patched
  // safely falls back to regeneration; an unreadable one is never rebuilt.
  const headerText = header.status === "unreadable"
    ? header.text
    : header.status === "ok"
      ? patchYamlHeader(header.text, headerPropertyPatch(document, header.parsed)) ?? `---\n${yaml}\n---`
      : `---\n${yaml}\n---`;
  // Only this plugin's own regions are replaced. Prose, the preamble and the
  // YAML header come back exactly as they were read from the disk text that
  // Vault.process handed to this call. Both joins are normalized so that a body
  // whose own spacing was rewritten cannot push the header delimiters apart.
  const body = spliceOutline(source.slice(header.end, bodyEnd), renderOutline(document), document.title)
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  const dataSection = `\n\n---\n\n${DATA_NOTICE}\n\n${DATA_START}\n\`\`\`${DATA_FENCE_LANGUAGE}\n${encodeCompressedPayload(document)}\n\`\`\`\n${DATA_END}`;
  return `${header.leading}${headerText}\n\n${body}${dataSection}${trailing.length > 0 ? trailing : "\n"}`;
}

/**
 * The only YAML properties this plugin may write: its version marker, the
 * optional link identity, and the six per-tree settings the document explicitly
 * owns. An absent setting stays absent (it follows global defaults at runtime).
 */
function headerPropertyPatch(document: MindTreeDocument, parsed: Record<string, unknown>): YamlPropertyPatch {
  const patch: YamlPropertyPatch = {
    documentId: document.documentId ?? undefined,
    [MIND_TREE_SCHEMA_VERSION_YAML_KEY]: CURRENT_MIND_TREE_SCHEMA_VERSION
  };
  const settings = settingsForSerialization(document, extractTreeSettings(parsed));
  for (const key of TREE_SETTING_KEYS) {
    const value = settings[key];
    if (value === undefined) {
      // A property that is present on disk but dropped from the serializable
      // set was explicitly returned to "absent" (undo, or an external delete).
      if (Object.hasOwn(parsed, key)) patch[key] = undefined;
      continue;
    }
    // Only scalars can be patched positionally; a hand-edited collection value
    // stays untouched rather than being replaced by a truncated rendering.
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      patch[key] = value;
    }
  }
  return patch;
}

/**
 * A payload fence that never closes above the readable section is left-over
 * damage, not user prose. Its whole section is cut so that a save can never
 * leave the file with two `mtn-data-gzip` blocks or a duplicate notice.
 */
function damagedSectionStart(source: string, from: number, regionStart: number): number {
  const unclosed = new RegExp(`^[ \\t]{0,3}\`{3,}[ \\t]*${DATA_FENCE_LANGUAGE}[ \\t]*$`, "m");
  const match = unclosed.exec(source.slice(from, regionStart));
  return match ? payloadSectionStart(source, from + match.index) : regionStart;
}

/**
 * Replace the generated outline, or recreate it once when its markers were lost.
 * The outline is always derived from the same document as the payload, so a
 * missing marker pair must never accumulate one more copy per save.
 */
function spliceOutline(bodySource: string, outline: string, title: string): string {
  const start = bodySource.indexOf(OUTLINE_START);
  const end = start < 0 ? -1 : bodySource.indexOf(OUTLINE_END, start + OUTLINE_START.length);
  if (start >= 0 && end >= 0) {
    const prefix = synchronizeGeneratedHeading(bodySource.slice(0, start), title);
    return `${prefix.replace(/\s+$/, "")}\n\n${outline}${bodySource.slice(end + OUTLINE_END.length)}`;
  }
  const withoutMarkers = bodySource.split(OUTLINE_START).join("").split(OUTLINE_END).join("");
  const heading = /^# [^\r\n]+$/m.exec(withoutMarkers);
  if (!heading) {
    const kept = withoutMarkers.replace(/^\s+/, "").replace(/\s+$/, "");
    return `# ${escapeHeading(title)}\n\n${outline}${kept.length > 0 ? `\n\n${kept}` : ""}`;
  }
  const insertAt = heading.index + heading[0].length;
  return `${withoutMarkers.slice(0, insertAt)}\n\n${outline}${withoutMarkers.slice(insertAt)}`;
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

/**
 * Create the content of a brand-new tree. No setting property is written: a new
 * tree inherits the current global defaults at runtime, and only a later
 * explicit per-tree choice records a value in the Frontmatter.
 */
export function createMindTreeFile(title: string): string {
  return serializeMindTreeFile(createEmptyDocument(title));
}

function normalizeDocument(value: unknown): MindTreeDocument {
  const record = asRecord(value);
  if (!record) throw new MindTreeFormatError("Mind Tree properties must be a YAML mapping.");
  const documentId = stringValue(record["documentId"]);
  const settings = normalizeDocumentSettings(record["settings"]);
  const rootId = requiredString(record, "rootId");
  const title = stringValue(record["title"]) ?? UNTITLED_TREE_TITLE;
  const rawNodes = asRecord(record["nodes"]);
  if (!rawNodes) throw new MindTreeFormatError("Mind Tree nodes must be a YAML mapping.");
  const nodeEntries = Object.entries(rawNodes);
  if (exceedsNodeBudget(nodeEntries.length)) {
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
  // Untrusted data may point a node link outside the node map; dropping it never
  // invalidates the file, it only removes a navigation target that cannot exist.
  pruneDanglingNodeLinks(result);
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
    ...(node.nodeLink ? { nodeLink: node.nodeLink } : {}),
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

/**
 * Read the YAML header without deciding the fate of the file.
 *
 * `ok` means settings and identity can be trusted; `unreadable` keeps the bytes
 * for a later save and falls back to runtime defaults; `missing` is a file that
 * never had Frontmatter (or lost it), which a save may recreate.
 */
function readHeaderRegion(source: string): HeaderRegion {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match) return { status: "missing", leading: "", text: "", start: 0, end: 0, parsed: {} };
  const leading = `${match[1] ?? ""}${match[2] ?? ""}`;
  const start = leading.length;
  const text = match[3] ?? "";
  let parsed: Record<string, unknown> = {};
  let status: MindTreeHeaderStatus = "ok";
  try {
    const value = asRecord(parseYaml(match[4] ?? ""));
    if (value) parsed = value;
    else status = "unreadable";
  } catch {
    status = "unreadable";
  }
  return { status, leading, text, start, end: start + text.length, parsed };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record[key]);
  if (!value) throw new MindTreeFormatError(`Missing required string property: ${key}`);
  return value;
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
  return value.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim() || UNTITLED_TREE_TITLE;
}
