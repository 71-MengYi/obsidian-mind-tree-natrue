/**
 * Region locators for the `.mtn.md` container.
 *
 * The compressed payload is the only part of the file that carries tree data,
 * and it is also the only part this plugin ever writes. Everything above it
 * (YAML header, user prose, generated outline, H1) is either derived or owned by
 * other writers: Obsidian rewrites wiki links after a rename, sync clients
 * replace the whole file, and users add notes. So the payload must be located by
 * content, never by line number, and its surrounding markers must be treated as
 * decoration that can be missing or moved without making the document invalid.
 */

export const DATA_NOTICE = "这段话之后的内容是压缩json，无需读取和分析。";
export const DATA_START = "<!-- mtn:data:start -->";
export const DATA_END = "<!-- mtn:data:end -->";
export const DATA_FENCE_LANGUAGE = "mtn-data-gzip";

/** The replaceable machine-data section, inclusive of its generated markers. */
export interface DataRegion {
  /** First byte of the section this plugin owns (separator/notice/fence start). */
  readonly replaceStart: number;
  /** First byte after the section (`DATA_END` when present, else the closing fence). */
  readonly replaceEnd: number;
  /** Base64 text between the fence lines, before any decoding or trimming. */
  readonly payload: string;
}

export type DataRegionLocation =
  | { readonly ok: true; readonly region: DataRegion }
  | { readonly ok: false; readonly reason: "missing" | "ambiguous" };

/** An indented-or-not fence line; the writer only emits column-zero fences. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,})([^\n]*)$/gm;
/** Lines this plugin generates directly above the payload. */
const GENERATED_SECTION_LINES = new Set([DATA_START, DATA_END, DATA_NOTICE, "---"]);

/**
 * Find the single machine data section.
 *
 * A file with no `mtn-data-gzip` fence is "missing"; a file with two is
 * "ambiguous". Neither outcome guesses which payload is authoritative, because
 * choosing the wrong one would silently show (or overwrite) another tree.
 */
export function locateDataRegion(source: string): DataRegionLocation {
  const candidates: Array<{ fenceStart: number; fenceEnd: number; payload: string }> = [];
  FENCE_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_LINE.exec(source)) !== null) {
    const ticks = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (info.split(/\s+/)[0]?.toLowerCase() !== DATA_FENCE_LANGUAGE) continue;
    const payloadStart = match.index + match[0].length + lineBreakLength(source, match.index + match[0].length);
    const closing = findClosingFence(source, ticks.length, payloadStart);
    if (closing === undefined) continue;
    candidates.push({
      fenceStart: match.index,
      fenceEnd: closing.end,
      payload: trimTrailingLineBreak(source.slice(payloadStart, closing.start))
    });
    FENCE_LINE.lastIndex = closing.end;
  }
  if (candidates.length === 0) return { ok: false, reason: "missing" };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous" };
  const candidate = candidates[0]!;
  return {
    ok: true,
    region: {
      replaceStart: payloadSectionStart(source, candidate.fenceStart),
      replaceEnd: readEnd(source, candidate.fenceEnd),
      payload: candidate.payload
    }
  };
}

/**
 * Walk the generated decoration directly above a payload fence, one line at a
 * time, and return the start of the section it belongs to.
 *
 * A section whose comment markers were partly lost must still be replaced as a
 * whole: stopping at the fence alone would leave the old notice and separator in
 * the body, and every save would add another copy of them.
 */
export function payloadSectionStart(source: string, fenceStart: number): number {
  let cursor = fenceStart;
  for (let step = 0; step < GENERATED_SECTION_LINES.size; step += 1) {
    const before = source.slice(0, cursor);
    const contentEnd = before.replace(/[ \t\r\n]+$/, "").length;
    if (contentEnd === before.length) return cursor;
    const lineStart = before.lastIndexOf("\n", contentEnd - 1) + 1;
    const line = before.slice(lineStart, contentEnd).trim();
    if (!GENERATED_SECTION_LINES.has(line)) return cursor;
    cursor = lineStart;
    // The separator always closes the generated decoration.
    if (line === "---") return cursor;
  }
  return cursor;
}

/** `DATA_END` closes the owned section when it follows the fence. */
function readEnd(source: string, fenceEnd: number): number {
  const end = source.indexOf(DATA_END, fenceEnd);
  if (end < 0) return fenceEnd;
  return source.slice(fenceEnd, end).trim() === "" ? end + DATA_END.length : fenceEnd;
}

function findClosingFence(source: string, minimumTicks: number, from: number): { start: number; end: number } | undefined {
  const scan = new RegExp(FENCE_LINE.source, "gm");
  scan.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(source)) !== null) {
    const info = (match[2] ?? "").trim();
    // An unclosed fence must never swallow a later, well-formed section: that
    // would turn a damaged file into an unreadable one on the next save.
    if (info.split(/\s+/)[0]?.toLowerCase() === DATA_FENCE_LANGUAGE) return undefined;
    if (info !== "") continue;
    if ((match[1] ?? "").length < minimumTicks) continue;
    return { start: match.index, end: match.index + match[0].length };
  }
  return undefined;
}

function lineBreakLength(source: string, index: number): number {
  if (source.startsWith("\r\n", index)) return 2;
  if (source.startsWith("\n", index)) return 1;
  return 0;
}

function trimTrailingLineBreak(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
