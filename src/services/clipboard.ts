import { addNode, extractBranches } from "../domain/tree";
import { normalizeBranchClipboardPayload } from "../domain/clipboard-payload";
import { renderBranchMarkdown } from "../format/outline";
import { linkedFileTitle } from "../format/resource-id";
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
  | { kind: "images"; images: ClipboardImageInput[] }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export interface ClipboardImageInput {
  readonly blob: Blob;
  readonly name: string;
  readonly mimeType: string;
}

const CLIPBOARD_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg"
});

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
  const images = clipboardEventImages(event);
  if (images.length > 0) return { kind: "images", images };
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
  readText: () => Promise<string>,
  readItems?: () => Promise<readonly ClipboardItem[]>
): Promise<ClipboardPasteContent> {
  if (readItems) {
    try {
      const itemContent = await readClipboardItems(await readItems());
      if (itemContent.kind !== "empty") return itemContent;
    } catch {
      // A denied Clipboard.read() must not prevent the more widely supported
      // readText() fallback from recovering the same user gesture.
    }
  }
  return readClipboardTextContent(await readText());
}

/** Convert event-owned image files before the ClipboardEvent loses validity. */
export function clipboardEventImages(event: ClipboardEvent): ClipboardImageInput[] {
  const transfer = event.clipboardData;
  if (!transfer) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && clipboardImageExtension(file.type, file.name)) files.push(file);
  }
  for (const file of Array.from(transfer.files ?? [])) {
    if (clipboardImageExtension(file.type, file.name)) files.push(file);
  }
  return deduplicateClipboardFiles(files).map((file, index) => ({
    blob: file,
    name: clipboardImageFileName(file.name, file.type, index),
    mimeType: normalizedClipboardImageType(file.type, file.name)
  }));
}

/** Async Clipboard API equivalent used only when the paste event has no data. */
export async function readClipboardItems(items: readonly ClipboardItem[]): Promise<ClipboardPasteContent> {
  for (const item of items) {
    if (!item.types.includes(MIND_TREE_MIME)) continue;
    try {
      const json = await (await item.getType(MIND_TREE_MIME)).text();
      if (utf8ByteLength(json) <= MAX_STRUCTURED_CLIPBOARD_BYTES) {
        return { kind: "structured", payload: normalizeBranchClipboardPayload(JSON.parse(json) as unknown) };
      }
    } catch { /* Continue with safe image/text representations. */ }
  }
  const images: ClipboardImageInput[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => clipboardImageExtension(type));
    if (!imageType) continue;
    try {
      const blob = await item.getType(imageType);
      images.push({
        blob,
        name: clipboardImageFileName("", imageType, images.length),
        mimeType: normalizedClipboardImageType(imageType)
      });
    } catch { /* One inaccessible representation must not discard later items. */ }
  }
  return images.length > 0 ? { kind: "images", images } : { kind: "empty" };
}

export function clipboardImageFileName(
  candidate: string,
  mimeType: string,
  sequence = 0,
  now = new Date()
): string {
  const safeCandidate = candidate.replace(/[\\/]/g, " ").trim();
  const extension = clipboardImageExtension(mimeType, safeCandidate) ?? "png";
  if (safeCandidate && clipboardImageExtension("", safeCandidate)) return safeCandidate;
  const two = (value: number): string => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `Pasted image ${timestamp}${sequence > 0 ? `-${sequence + 1}` : ""}.${extension}`;
}

export function clipboardImageExtension(mimeType: string, name = ""): string | undefined {
  const byMime = CLIPBOARD_IMAGE_EXTENSIONS[mimeType.toLowerCase()];
  if (byMime) return byMime;
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.exec(name)?.[1]?.toLowerCase();
}

function normalizedClipboardImageType(mimeType: string, name = ""): string {
  const normalized = mimeType.toLowerCase();
  if (CLIPBOARD_IMAGE_EXTENSIONS[normalized]) return normalized;
  const extension = clipboardImageExtension("", name);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return extension ? `image/${extension === "svg" ? "svg+xml" : extension}` : "image/png";
}

function deduplicateClipboardFiles(files: readonly File[]): File[] {
  const result: File[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const signature = `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(file);
  }
  return result;
}

/** Retained as the reusable Markdown-list parser for export round-trip tests. */
export function parseMarkdownBranch(markdown: string): BranchClipboardPayload | undefined {
  return parseTextImport(markdown, "list");
}

export interface ResolveMarkdownLinksResult {
  payload: BranchClipboardPayload;
  unresolvedFileLinks: string[];
  /** A partial resolution must never be inserted into another view session. */
  cancelled?: true;
}

/**
 * Resolve file targets after parsing but before insertion. Markdown parsing is
 * intentionally vault-independent; this asynchronous boundary is where the UI
 * may assign stable IDs or rename previously unmanaged attachments.
 */
export async function resolveMarkdownBranchLinks(
  payload: BranchClipboardPayload,
  resolveFile: (linkPath: string) => Promise<FileResourceRef | undefined>,
  titleSync: boolean,
  isCurrent: () => boolean = () => true
): Promise<ResolveMarkdownLinksResult> {
  const resolved = normalizeBranchClipboardPayload(payload);
  const unresolvedFileLinks: string[] = [];
  // First-time identity assignment can rename an attachment. Reuse the result
  // for repeated source paths so later occurrences do not resolve a stale name.
  const files = new Map<string, FileResourceRef | undefined>();
  for (const [nodeId, target] of Object.entries(resolved.linkTargets ?? {})) {
    if (!isCurrent()) return { payload: resolved, unresolvedFileLinks, cancelled: true };
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
      if (!files.has(target.linkPath)) files.set(target.linkPath, await resolveFile(target.linkPath));
      reference = files.get(target.linkPath);
    } catch (error) {
      // Identity conflicts need an explicit path list; treating them as an
      // ordinary unresolved link would hide a copied-tree problem.
      if (error instanceof Error && error.name === "DuplicateResourceIdError") throw error;
      reference = undefined;
    }
    if (!isCurrent()) return { payload: resolved, unresolvedFileLinks, cancelled: true };
    if (!reference) {
      unresolvedFileLinks.push(target.linkPath);
      if (target.fallbackTitle) node.title = target.fallbackTitle;
      continue;
    }
    node.resource = reference;
    node.titleSync = titleSync ? "bidirectional" : "off";
    // Import never renames the source file to an alias. Match the normal
    // load/save reconciliation rule immediately, without a transient old title.
    if (titleSync) node.title = linkedFileTitle(reference.pathHint);
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
