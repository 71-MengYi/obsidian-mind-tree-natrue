import { addNode, extractBranches } from "../domain/tree";
import { normalizeBranchClipboardPayload } from "../domain/clipboard-payload";
import { renderBranchMarkdown } from "../format/outline";
import { MAX_STRUCTURED_CLIPBOARD_BYTES, utf8ByteLength } from "../input-limits";
import type {
  BranchClipboardPayload,
  FileResourceRef,
  MindTreeDocument,
  NodeId
} from "../types";
import { normalizeSafeHttpUrl, parseTextImport } from "./text-import";

export const MIND_TREE_MIME = "application/x-mind-tree-nature+json";

interface InternalBranchClipboard {
  markdown: string;
  payload: BranchClipboardPayload;
}

export type ClipboardPasteContent =
  | { kind: "structured"; payload: BranchClipboardPayload }
  | { kind: "text"; text: string }
  | { kind: "empty" };

// Chromium/WebView versions used by Obsidian do not consistently permit custom
// MIME types in ClipboardItem. Keep the last plugin copy in memory and use it
// only while the clipboard's plain text still exactly matches that copy.
let internalBranchClipboard: InternalBranchClipboard | undefined;

export async function copyBranch(
  document: MindTreeDocument,
  nodeId: NodeId,
  mode: "branch" | "markdown"
): Promise<void> {
  await copyBranches(document, [nodeId], mode);
}

/** Copy a selection as a forest while retaining resources in the custom data. */
export async function copyBranches(
  document: MindTreeDocument,
  nodeIds: Iterable<NodeId>,
  mode: "branch" | "markdown"
): Promise<void> {
  const payload = extractBranches(document, nodeIds);
  const rootIds = payload.rootIds?.length ? payload.rootIds : [payload.rootId];
  const markdown = rootIds.map((nodeId) => renderBranchMarkdown(document, nodeId)).join("\n");
  if (mode === "markdown") {
    await navigator.clipboard.writeText(markdown);
    internalBranchClipboard = undefined;
    return;
  }
  await writeBranchClipboard(markdown, payload);
}

/**
 * Read only Mind Tree-owned clipboard data. External text is deliberately not
 * parsed here: direct paste and the explicit import dialog have separate rules.
 */
export function readStructuredBranchFromClipboardEvent(event: ClipboardEvent): BranchClipboardPayload | undefined {
  const json = event.clipboardData?.getData(MIND_TREE_MIME);
  if (json && utf8ByteLength(json) <= MAX_STRUCTURED_CLIPBOARD_BYTES) {
    try {
      return normalizeBranchClipboardPayload(JSON.parse(json) as unknown);
    } catch { /* Fall through to the safe same-session/plain-text paths. */ }
  }
  const text = event.clipboardData?.getData("text/plain");
  return text ? readStructuredBranchFromPlainText(text) : undefined;
}

/**
 * Recover the high-fidelity branch kept for this plugin session when only the
 * system clipboard's plain-text representation is available. Exact matching
 * prevents unrelated external text from inheriting stale node metadata.
 */
export function readStructuredBranchFromPlainText(text: string): BranchClipboardPayload | undefined {
  if (!text || internalBranchClipboard?.markdown !== text) return undefined;
  try {
    return normalizeBranchClipboardPayload(internalBranchClipboard.payload);
  } catch {
    internalBranchClipboard = undefined;
    return undefined;
  }
}

/**
 * Read synchronously available event data in strict priority order. The view
 * performs navigator.clipboard.readText() only when this result is empty.
 */
export function readClipboardEventContent(event: ClipboardEvent): ClipboardPasteContent {
  const structured = readStructuredBranchFromClipboardEvent(event);
  if (structured) return { kind: "structured", payload: structured };
  const text = event.clipboardData?.getData("text/plain") ?? "";
  return text === "" ? { kind: "empty" } : { kind: "text", text };
}

/** Apply the same-session branch check before treating fallback text as external. */
export function readClipboardTextContent(text: string): ClipboardPasteContent {
  const structured = readStructuredBranchFromPlainText(text);
  if (structured) return { kind: "structured", payload: structured };
  return text === "" ? { kind: "empty" } : { kind: "text", text };
}

/** Read delayed system text and classify it through the same-session cache. */
export async function readClipboardFallbackContent(
  readText: () => Promise<string>
): Promise<ClipboardPasteContent> {
  return readClipboardTextContent(await readText());
}

/** Retained as the reusable Markdown-list parser for export round-trip tests. */
export function parseMarkdownBranch(markdown: string): BranchClipboardPayload | undefined {
  return parseTextImport(markdown, "list");
}

export interface ResolveMarkdownLinksResult {
  payload: BranchClipboardPayload;
  unresolvedFileLinks: string[];
}

/**
 * Resolve file targets after parsing but before insertion. Markdown parsing is
 * intentionally vault-independent; this asynchronous boundary is where the UI
 * may assign stable IDs or rename previously unmanaged attachments.
 */
export async function resolveMarkdownBranchLinks(
  payload: BranchClipboardPayload,
  resolveFile: (linkPath: string) => Promise<FileResourceRef | undefined>,
  titleSync: boolean
): Promise<ResolveMarkdownLinksResult> {
  const resolved = normalizeBranchClipboardPayload(payload);
  const unresolvedFileLinks: string[] = [];
  for (const [nodeId, target] of Object.entries(resolved.linkTargets ?? {})) {
    const node = resolved.nodes[nodeId];
    if (!node) continue;
    // URL association is finalized at the same boundary as vault-file links.
    // Text import already supplies it for immediate previews, but doing
    // it again here makes externally supplied/older clipboard payloads safe too.
    if (target.type === "url") {
      const safeUrl = normalizeSafeHttpUrl(target.url);
      if (safeUrl) {
        node.resource = { type: "url", url: safeUrl };
        node.titleSync = "off";
      }
      continue;
    }
    let reference: FileResourceRef | undefined;
    try {
      reference = await resolveFile(target.linkPath);
    } catch (error) {
      // Identity conflicts need an explicit path list; treating them as an
      // ordinary unresolved link would hide a copied-tree problem.
      if (error instanceof Error && error.name === "DuplicateResourceIdError") throw error;
      reference = undefined;
    }
    if (!reference) {
      unresolvedFileLinks.push(target.linkPath);
      continue;
    }
    node.resource = reference;
    node.titleSync = titleSync ? "bidirectional" : "off";
  }
  delete resolved.linkTargets;
  return { payload: resolved, unresolvedFileLinks };
}

export function insertPlainTextAsNode(document: MindTreeDocument, parentId: NodeId, text: string): NodeId {
  return addNode(document, parentId, text.trim()).id;
}

async function writeBranchClipboard(markdown: string, payload: BranchClipboardPayload): Promise<void> {
  const safePayload = normalizeBranchClipboardPayload(payload);
  const json = JSON.stringify(safePayload);
  if (utf8ByteLength(json) > MAX_STRUCTURED_CLIPBOARD_BYTES) {
    throw new Error("Structured clipboard data exceeds the 10 MiB safety limit.");
  }
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    try {
      const item = new ClipboardItem({
        [MIND_TREE_MIME]: new Blob([json], { type: MIND_TREE_MIME }),
        "text/plain": new Blob([markdown], { type: "text/plain" })
      });
      await navigator.clipboard.write([item]);
      internalBranchClipboard = { markdown, payload: safePayload };
      return;
    } catch {
      // Some WebView clipboard implementations reject custom MIME types.
    }
  }
  await navigator.clipboard.writeText(markdown);
  internalBranchClipboard = { markdown, payload: safePayload };
}
