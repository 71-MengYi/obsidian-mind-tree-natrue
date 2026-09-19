import { createId } from "../domain/tree";
import {
  MAX_MIND_TREE_DEPTH,
  MAX_MIND_TREE_NODES,
  MAX_TEXT_IMPORT_BYTES,
  InputLimitError,
  createSafeRecord,
  utf8ByteLength
} from "../input-limits";
import type {
  BranchClipboardPayload,
  ClipboardLinkTarget,
  MindTreeNode,
  NodeId
} from "../types";
import { parseTextLine, type ParsedTextNode } from "./text-links";

// Keep the existing internal import path for clipboard validation callers.
export { normalizeSafeHttpUrl } from "./text-url";

/** Import rules are runtime UI choices and are never persisted in .mtn.md. */
export type TextImportRule = "list" | "headings";

/** The import dialog starts with the first, least surprising rule selected. */
export const DEFAULT_TEXT_IMPORT_RULE: TextImportRule = "list";

export type DirectTextPaste =
  | { kind: "empty" }
  | { kind: "multiline"; text: string }
  | { kind: "nodes"; nodes: ParsedTextNode[] };

interface ImportBuilder {
  nodes: Record<NodeId, MindTreeNode>;
  rootIds: NodeId[];
  depthById: Map<NodeId, number>;
  linkTargets: Record<NodeId, ClipboardLinkTarget>;
  count: number;
}

/** Parse text only with the rule explicitly selected in the import dialog. */
export function parseTextImport(source: string, rule: TextImportRule): BranchClipboardPayload | undefined {
  assertTextImportSize(source);
  return rule === "list" ? parseListImport(source) : parseHeadingImport(source);
}

function assertTextImportSize(source: string): void {
  if (utf8ByteLength(source) > MAX_TEXT_IMPORT_BYTES) {
    throw new InputLimitError("text-import-bytes", "Text import exceeds the 10 MiB safety limit.");
  }
}

/**
 * Classify external plain text without applying any list/heading heuristics.
 * Structured Mind Tree clipboard data is handled before this function is used.
 */
export function classifyDirectTextPaste(source: string): DirectTextPaste {
  assertTextImportSize(source);
  // Clipboard providers commonly append a line ending even when the user
  // copied one visual line. Normalize and trim the complete payload before
  // deciding whether an internal line break really remains.
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { kind: "empty" };
  if (normalized.includes("\n")) return { kind: "multiline", text: normalized };

  return { kind: "nodes", nodes: parseTextLine(normalized) };
}

/** Single-line paste shares link semantics, but never strips list/ATX markers. */
export function createTextPastePayload(nodes: readonly ParsedTextNode[]): BranchClipboardPayload | undefined {
  const builder = createBuilder();
  for (const node of nodes) addImportedNode(builder, node);
  return finishPayload(builder);
}

/**
 * One list import may freely mix bullets, ordered markers, and markerless text.
 * Any increase in visual indentation makes the line a child of the previous
 * shallower item; equal/decreased indentation returns to the matching ancestor.
 */
function parseListImport(source: string): BranchClipboardPayload | undefined {
  const builder = createBuilder();
  const stack: Array<{ indent: number; id: NodeId }> = [];

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([ \t]*)(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(.*?)\s*$/.exec(line);
    if (!match) continue;
    const label = match[2]?.trim() ?? "";
    if (!label) continue;
    const indent = indentationWidth(match[1] ?? "");
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const id = addImportedLine(builder, label, stack.at(-1)?.id);
    if (!id) continue;
    stack.push({ indent, id });
  }
  return finishPayload(builder);
}

/**
 * ATX headings define the main hierarchy. Explicit Markdown list items form a
 * second, indentation-based stack below the latest heading (or at the root
 * before the first heading). A heading or ordinary body line closes that list
 * stack, so prose never accidentally continues the preceding list branch.
 */
function parseHeadingImport(source: string): BranchClipboardPayload | undefined {
  const builder = createBuilder();
  const headingStack: Array<{ level: number; id: NodeId }> = [];
  const listStack: Array<{ indent: number; id: NodeId }> = [];

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      listStack.length = 0;
      const level = heading[1]!.length;
      const label = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (!label) continue;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      const id = addImportedLine(builder, label, headingStack.at(-1)?.id);
      if (id) headingStack.push({ level, id });
      continue;
    }

    const listItem = parseExplicitListItem(line);
    if (listItem) {
      while (listStack.length > 0 && listStack[listStack.length - 1]!.indent >= listItem.indent) {
        listStack.pop();
      }
      const parentId = listStack.at(-1)?.id ?? headingStack.at(-1)?.id;
      const id = addImportedLine(builder, listItem.label, parentId);
      if (id) listStack.push({ indent: listItem.indent, id });
      continue;
    }

    listStack.length = 0;
    addImportedLine(builder, line.trim(), headingStack.at(-1)?.id);
  }
  return finishPayload(builder);
}

/** Parse only explicit Markdown list markers; markerless text remains prose. */
function parseExplicitListItem(line: string): { indent: number; label: string } | undefined {
  const match = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*?)\s*$/.exec(line);
  const label = match?.[2]?.trim() ?? "";
  return match && label
    ? { indent: indentationWidth(match[1] ?? ""), label }
    : undefined;
}

function createBuilder(): ImportBuilder {
  return {
    nodes: createSafeRecord<MindTreeNode>(),
    rootIds: [],
    depthById: new Map<NodeId, number>(),
    linkTargets: createSafeRecord<ClipboardLinkTarget>(),
    count: 0
  };
}

/**
 * Split one logical line into siblings. Only its first result owns subsequent
 * indented items/headings, including when that first result is leftover prose.
 */
function addImportedLine(builder: ImportBuilder, value: string, parentId?: NodeId): NodeId | undefined {
  let firstId: NodeId | undefined;
  for (const parsed of parseTextLine(value)) {
    const id = addImportedNode(builder, parsed, parentId);
    firstId ??= id;
  }
  return firstId;
}

/** Construct a bounded forest first; asynchronous file lookup happens later. */
function addImportedNode(builder: ImportBuilder, parsed: ParsedTextNode, parentId?: NodeId): NodeId | undefined {
  if (!parsed.title) return undefined;
  if (builder.count >= MAX_MIND_TREE_NODES) {
    throw new InputLimitError("node-count", `Text import exceeds ${MAX_MIND_TREE_NODES} nodes.`);
  }
  const depth = parentId ? (builder.depthById.get(parentId) ?? 0) + 1 : 0;
  if (depth >= MAX_MIND_TREE_DEPTH) {
    throw new InputLimitError("tree-depth", `Text import exceeds ${MAX_MIND_TREE_DEPTH} levels.`);
  }
  const id = createId();
  const now = new Date().toISOString();
  builder.nodes[id] = { id, title: parsed.title, childIds: [], createdAt: now, updatedAt: now };
  if (parentId) builder.nodes[parentId]?.childIds.push(id);
  else builder.rootIds.push(id);
  builder.depthById.set(id, depth);
  builder.count += 1;

  if (parsed.linkTarget) builder.linkTargets[id] = parsed.linkTarget;
  if (parsed.linkTarget?.type === "url") {
    builder.nodes[id]!.resource = { type: "url", url: parsed.linkTarget.url };
    builder.nodes[id]!.titleSync = "off";
  }
  return id;
}

function finishPayload(builder: ImportBuilder): BranchClipboardPayload | undefined {
  const rootId = builder.rootIds[0];
  if (!rootId) return undefined;
  return {
    sourceDocumentId: "text-import",
    rootId,
    rootIds: builder.rootIds,
    nodes: builder.nodes,
    ...(Object.keys(builder.linkTargets).length > 0 ? { linkTargets: builder.linkTargets } : {})
  };
}

/** Tabs advance to the next four-column stop; only relative indentation matters. */
function indentationWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    if (character === "\t") width += 4 - (width % 4);
    else width += 1;
  }
  return width;
}
