import { utf8ByteLength } from "../input-limits";
import type { NodeId } from "../types";
import { BRANCH_REFERENCE_LANGUAGE, parseBranchReference } from "./branch-reference";

/**
 * One mind-tree reference found in note text. `line` is 1-based and points at
 * the JSON body inside the fenced block, which is the line an editor should put
 * the caret on.
 */
export interface BranchReferenceOccurrence {
  readonly documentId: string;
  readonly nodeId: NodeId;
  readonly line: number;
}

/**
 * Notes above this size are skipped before any parse. A note that big is not a
 * realistic home for a short reference block, and reading it on every change
 * would make the background index visible to the user.
 */
export const MAX_BACKLINK_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * One note can point at a bounded number of nodes. Counting reference blocks
 * (not successful parses) keeps a hostile note from forcing thousands of JSON
 * parses before the cap is noticed.
 */
export const MAX_BACKLINK_BLOCKS_PER_FILE = 64;

interface OpeningFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly language: string;
}

const OPENING_FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

function openingFence(line: string): OpeningFence | undefined {
  const match = OPENING_FENCE.exec(line);
  if (!match) return undefined;
  const fence = match[1] ?? "";
  const info = (match[2] ?? "").trim();
  // A backtick fence's info string may not contain a backtick: such a line is
  // ordinary text (for example an inline code span), not a fence.
  if (fence.startsWith("`") && info.includes("`")) return undefined;
  return {
    marker: fence.startsWith("~") ? "~" : "`",
    length: fence.length,
    language: info.split(/\s+/, 1)[0] ?? ""
  };
}

function closesFence(line: string, fence: OpeningFence): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  for (const character of trimmed) {
    if (character !== fence.marker) return false;
  }
  return true;
}

function closingLine(lines: readonly string[], from: number, fence: OpeningFence): number | undefined {
  for (let index = from; index < lines.length; index += 1) {
    if (closesFence(lines[index] ?? "", fence)) return index;
  }
  return undefined;
}

/**
 * Extract every `mind-tree-ref` fenced block from one note.
 *
 * This is the reverse direction of `parseBranchReferenceBlock`: a note may hold
 * several references anywhere in its text, so the reader walks code fences the
 * way CommonMark does, skips every other fenced block (including nested example
 * blocks) and reports the payload line. Invalid JSON, oversized blocks and an
 * unterminated fence simply produce no occurrence; the caller never has to
 * handle an exception while scanning untrusted notes.
 */
export function extractBranchReferences(source: string): BranchReferenceOccurrence[] {
  if (utf8ByteLength(source) > MAX_BACKLINK_SCAN_BYTES) return [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const occurrences: BranchReferenceOccurrence[] = [];
  let blocks = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = openingFence(lines[index] ?? "");
    if (!fence) continue;
    const close = closingLine(lines, index + 1, fence);
    // An unterminated fence swallows the rest of the document, exactly as it
    // does in the Markdown renderer, so scanning must stop here.
    if (close === undefined) break;
    if (fence.language === BRANCH_REFERENCE_LANGUAGE) {
      if (blocks >= MAX_BACKLINK_BLOCKS_PER_FILE) break;
      blocks += 1;
      const reference = parseBranchReference(lines.slice(index + 1, close).join("\n"));
      if (reference) {
        occurrences.push({
          documentId: reference.documentId,
          nodeId: reference.nodeId,
          line: index + 2
        });
      }
    }
    index = close;
  }
  return occurrences;
}
