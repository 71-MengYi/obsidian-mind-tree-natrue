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

/** Import rules are runtime UI choices and are never persisted in .mtn.md. */
export type TextImportRule = "list" | "headings";

export type DirectTextPaste =
  | { kind: "empty" }
  | { kind: "multiline"; text: string }
  | { kind: "text"; title: string }
  | { kind: "url"; title: string; url: string };

interface ImportBuilder {
  nodes: Record<NodeId, MindTreeNode>;
  linkTargets: Record<NodeId, ClipboardLinkTarget>;
  rootIds: NodeId[];
  depthById: Map<NodeId, number>;
  count: number;
}

interface ParsedImportLabel {
  title: string;
  linkTarget?: ClipboardLinkTarget;
}

/** Parse text only with the rule explicitly selected in the import dialog. */
export function parseTextImport(source: string, rule: TextImportRule): BranchClipboardPayload | undefined {
  if (utf8ByteLength(source) > MAX_TEXT_IMPORT_BYTES) {
    throw new InputLimitError("text-import-bytes", "Text import exceeds the 10 MiB safety limit.");
  }
  return rule === "list" ? parseListImport(source) : parseHeadingImport(source);
}

/**
 * Classify external plain text without applying any list/heading heuristics.
 * Structured Mind Tree clipboard data is handled before this function is used.
 */
export function classifyDirectTextPaste(source: string): DirectTextPaste {
  // Clipboard providers commonly append a line ending even when the user
  // copied one visual line. Normalize and trim the complete payload before
  // deciding whether an internal line break really remains.
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { kind: "empty" };
  if (normalized.includes("\n")) return { kind: "multiline", text: normalized };

  const title = normalized;
  const url = normalizeSafeHttpUrl(title);
  return url ? { kind: "url", title, url } : { kind: "text", title };
}

/** Return a canonical HTTP(S) URL and reject whitespace or unsafe protocols. */
export function normalizeSafeHttpUrl(value: string): string | undefined {
  if (!value || /\s/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
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
    const id = addImportedNode(builder, label, stack.at(-1)?.id);
    if (!id) continue;
    stack.push({ indent, id });
  }
  return finishPayload(builder);
}

/**
 * ATX headings define the hierarchy. Body lines become direct children of the
 * most recent heading; text before the first heading remains a top-level node.
 * Heading-level jumps attach to the nearest preceding lower-level heading and
 * never synthesize invisible placeholder nodes.
 */
function parseHeadingImport(source: string): BranchClipboardPayload | undefined {
  const builder = createBuilder();
  const headingStack: Array<{ level: number; id: NodeId }> = [];

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const label = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (!label) continue;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      const id = addImportedNode(builder, label, headingStack.at(-1)?.id);
      if (id) headingStack.push({ level, id });
      continue;
    }

    addImportedNode(builder, line.trim(), headingStack.at(-1)?.id);
  }
  return finishPayload(builder);
}

function createBuilder(): ImportBuilder {
  return {
    nodes: createSafeRecord<MindTreeNode>(),
    linkTargets: createSafeRecord<ClipboardLinkTarget>(),
    rootIds: [],
    depthById: new Map<NodeId, number>(),
    count: 0
  };
}

/** Create one import node and retain its first supported link for later vault resolution. */
function addImportedNode(builder: ImportBuilder, value: string, parentId?: NodeId): NodeId | undefined {
  const parsed = parseImportLabel(value);
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

  if (parsed.linkTarget) {
    builder.linkTargets[id] = parsed.linkTarget;
    if (parsed.linkTarget.type === "url") {
      builder.nodes[id]!.resource = { type: "url", url: parsed.linkTarget.url };
      builder.nodes[id]!.titleSync = "off";
    }
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

/** Extract the first Wiki, Markdown, or bare HTTP(S) link and keep readable text. */
function parseImportLabel(value: string): ParsedImportLabel {
  const candidates: Array<{
    index: number;
    raw: string;
    display: string;
    target: ClipboardLinkTarget;
  }> = [];

  const wiki = /!?\[\[((?:\\.|[^\]\r\n])+)\]\]/.exec(value);
  if (wiki?.[0] && wiki[1]) {
    const { linkPath, alias } = splitWikiLink(wiki[1]);
    if (linkPath) {
      candidates.push({
        index: wiki.index,
        raw: wiki[0],
        display: alias || readableWikiTarget(linkPath),
        target: { type: "file", linkPath }
      });
    }
  }

  const markdownLink = /!?\[((?:\\.|[^\]\r\n])*)\]\(((?:\\.|[^)\r\n])+)\)/.exec(value);
  if (markdownLink?.[0] && markdownLink[2]) {
    const targetText = normalizeMarkdownLinkTarget(markdownLink[2]);
    const safeUrl = normalizeSafeHttpUrl(targetText);
    if (targetText) {
      candidates.push({
        index: markdownLink.index,
        raw: markdownLink[0],
        display: markdownLink[1]?.trim() || readableWikiTarget(targetText),
        target: safeUrl ? { type: "url", url: safeUrl } : { type: "file", linkPath: targetText }
      });
    }
  }

  const bareUrl = /https?:\/\/[^\s<>\]]+/i.exec(value);
  if (bareUrl?.[0]) {
    const raw = bareUrl[0];
    const safeUrl = normalizeSafeHttpUrl(raw.replace(/[),.;!?]+$/, ""));
    if (safeUrl) {
      candidates.push({
        index: bareUrl.index,
        raw,
        display: raw,
        target: { type: "url", url: safeUrl }
      });
    }
  }

  const first = candidates.sort((left, right) => left.index - right.index)[0];
  const readable = first
    ? `${value.slice(0, first.index)}${first.display}${value.slice(first.index + first.raw.length)}`
    : value;
  const title = unescapeMarkdownText(readable);
  return first ? { title, linkTarget: first.target } : { title };
}

function splitWikiLink(value: string): { linkPath: string; alias: string } {
  let separatorIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && value[index - 1] !== "\\") {
      separatorIndex = index;
      break;
    }
  }
  const rawPath = separatorIndex >= 0 ? value.slice(0, separatorIndex) : value;
  const rawAlias = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : "";
  return {
    linkPath: rawPath.replace(/\\([\\|\[\]])/g, "$1").trim(),
    alias: unescapeMarkdownText(rawAlias)
  };
}

function normalizeMarkdownLinkTarget(value: string): string {
  let target = value.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  const titledTarget = /^(.*?)(?:\s+(?:"[^"]*"|'[^']*'))$/.exec(target);
  if (titledTarget?.[1]) target = titledTarget[1].trim();
  target = target.replace(/\\([\\() ])/g, "$1");
  try { return decodeURIComponent(target); } catch { return target; }
}

function readableWikiTarget(value: string): string {
  const withoutSubpath = value.split("#", 1)[0] || value;
  const name = withoutSubpath.replace(/\\/g, "/").split("/").at(-1) || withoutSubpath;
  return name.replace(/\.md$/i, "").trim();
}

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\[\]()*_`\\|])/g, "$1").trim();
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
