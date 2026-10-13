import { asRecord, MAX_BRANCH_REFERENCE_BYTES, stringValue, utf8ByteLength } from "../input-limits";
import type { NodeId } from "../types";

/**
 * Code-block language that turns a fenced block in any Markdown note into a
 * read-only view of one mind-tree branch. It is deliberately a code block
 * instead of an embed link: `.mtn.md` is an ordinary Markdown file, so
 * Obsidian's native embed would render the outline and the compressed data
 * block verbatim, and no public API can take over that rendering.
 */
export const BRANCH_REFERENCE_LANGUAGE = "mind-tree-ref";

const MAX_DOCUMENT_ID_LENGTH = 512;
const MAX_NODE_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;

/**
 * A pointer to one node inside one mind tree. It is intentionally not a copy:
 * the referenced node keeps living in its own document and may be moved
 * anywhere inside it. Cutting the node into another tree removes it from the
 * referenced document, which is exactly what invalidates the reference.
 */
export interface BranchReference {
  /** Stable tree identity (`documentId`), so a renamed tree file stays valid. */
  readonly documentId: string;
  readonly nodeId: NodeId;
  /** Fast lookup hint only; a stale value never rebinds the reference. */
  readonly pathHint?: string;
}

function isIdentity(value: string | undefined, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

export function createBranchReference(documentId: string, nodeId: NodeId, pathHint?: string): BranchReference {
  if (!isIdentity(documentId, MAX_DOCUMENT_ID_LENGTH)) {
    throw new Error("A branch reference needs a non-empty tree identity.");
  }
  if (!isIdentity(nodeId, MAX_NODE_ID_LENGTH)) {
    throw new Error("A branch reference needs a non-empty node id.");
  }
  const path = isIdentity(pathHint, MAX_PATH_LENGTH) ? pathHint : undefined;
  return { documentId, nodeId, ...(path ? { pathHint: path } : {}) };
}

/** Fixed key order keeps copied text stable and diff-friendly. */
export function serializeBranchReference(reference: BranchReference): string {
  return JSON.stringify({
    tree: reference.documentId,
    node: reference.nodeId,
    ...(reference.pathHint ? { path: reference.pathHint } : {})
  });
}

/**
 * Parse untrusted note content. Everything invalid collapses to `undefined`;
 * callers show a placeholder instead of throwing inside Obsidian's renderer.
 */
export function parseBranchReference(source: string): BranchReference | undefined {
  const trimmed = source.trim();
  if (!trimmed || utf8ByteLength(trimmed) > MAX_BRANCH_REFERENCE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const documentId = stringValue(record["tree"])?.trim();
  const nodeId = stringValue(record["node"])?.trim();
  if (!isIdentity(documentId, MAX_DOCUMENT_ID_LENGTH) || !isIdentity(nodeId, MAX_NODE_ID_LENGTH)) return undefined;
  const pathHint = stringValue(record["path"])?.trim();
  return createBranchReference(documentId, nodeId, isIdentity(pathHint, MAX_PATH_LENGTH) ? pathHint : undefined);
}

/**
 * Recognize clipboard text that is exactly one reference block. Partial or
 * interleaved text must stay ordinary text so a note that merely mentions the
 * language is never hijacked.
 */
export function parseBranchReferenceBlock(text: string): BranchReference | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 3) return undefined;
  const [open, body, close] = lines;
  if (!open || !body || !close) return undefined;
  if (!new RegExp(`^\`{3,}${BRANCH_REFERENCE_LANGUAGE}\\s*$`).test(open)) return undefined;
  if (!/^`{3,}$/.test(close)) return undefined;
  return parseBranchReference(body);
}

export function renderBranchReferenceBlock(reference: BranchReference): string {
  return `\`\`\`${BRANCH_REFERENCE_LANGUAGE}\n${serializeBranchReference(reference)}\n\`\`\``;
}
