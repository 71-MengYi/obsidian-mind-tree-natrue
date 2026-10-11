import type { NodeId, ResourceId } from "../../types";

/**
 * Half-open [start, end) interval measured in UTF-16 units of the **original**
 * text. Half-open keeps slice/highlight math free of off-by-one fixes, and the
 * original-text anchor lets the panel highlight without re-matching.
 */
export type SearchRange = readonly [start: number, end: number];

/** Where a hit came from, so a consumer can label rows without re-deriving it. */
export type SearchHitSource = "title" | "file" | "content";

/** Fields every result row shares; not exported because `SearchHit` is the public shape. */
interface SearchHitFields {
  /** 1-based line number; title and file-name hits are always on line 1. */
  readonly line: number;
  /** Single display line: truncated ends are marked with "…" (U+2026). */
  readonly text: string;
  /** Ranges inside `text`, ascending by start and never overlapping. */
  readonly ranges: readonly SearchRange[];
}

/**
 * One clickable result row: a single display line plus the ranges to highlight.
 * Modelled as a discriminated union so `Extract<SearchHit, { source: "title" }>`
 * narrows to title hits; with a single interface whose `source` is the union,
 * that extraction would collapse to `never` and the documented `titleHit` field
 * could never hold anything.
 */
export type SearchHit =
  | ({ readonly source: "title" } & SearchHitFields)
  | ({ readonly source: "file" } & SearchHitFields)
  | ({ readonly source: "content" } & SearchHitFields);

export interface SearchCard {
  readonly nodeId: NodeId;
  /** Card heading: the node name; `titleHit` is set when the title matched. */
  readonly title: string;
  readonly titleHit?: Extract<SearchHit, { source: "title" }>;
  readonly resourceId?: ResourceId;
  readonly path?: string;
  readonly fileName?: string;
  /**
   * Root → … → this node, for the clickable path row under the heading. `path`
   * already means the linked file's vault path, so the node chain needs its own
   * name. Written only when the candidate carries ancestors; a root hit has no
   * path to show, so the field stays absent instead of holding an empty array.
   */
  readonly nodePath?: readonly NodeId[];
  /** Non-title hits in render order; the title hit never repeats here. */
  readonly hits: readonly SearchHit[];
  /**
   * Present and `true` only when `hits` was capped, so a consumer can explain the
   * missing rows. Omitted otherwise, which keeps the field additive for callers
   * written against the original contract.
   */
  readonly hitsLimited?: boolean;
}

export interface SearchResult {
  /** Card count shown next to the input box. */
  readonly cards: readonly SearchCard[];
  /** Total hits, including several hit parts of one node. */
  readonly hitCount: number;
}

export interface SearchCandidate {
  readonly nodeId: NodeId;
  /** Markdown source title, for display. */
  readonly title: string;
  /** Plain-text title, for matching. */
  readonly plainTitle: string;
  readonly resourceId?: ResourceId;
  readonly path?: string;
  readonly fileName?: string;
  /**
   * Root → … → parent node ids, excluding the hit node itself. Absent (or empty)
   * for a root hit, which is what makes the card omit its path row entirely.
   * Hosts may pass dirty data: duplicates and cycles are tolerated by the core.
   */
  readonly ancestorIds?: readonly NodeId[];
}

export interface SearchContext {
  readonly candidates: readonly SearchCandidate[];
  /** key = `path`, value = full file text; only `.md` files are present. */
  readonly fileContents: ReadonlyMap<string, string>;
  /**
   * Lazy ancestor lookup: root → … → parent, excluding the node itself; `[]` for
   * a root node and `undefined` for an unknown one. Preferred over the eager
   * `candidate.ancestorIds` snapshot because the host can build one parent index
   * once instead of O(nodes × average depth) chains, and the core calls it only
   * for the cards that survive `SEARCH_RESULT_LIMIT`.
   */
  readonly nodeAncestorIds?: (nodeId: NodeId) => readonly NodeId[] | undefined;
}

export interface SearchFileBudget {
  /** Maximum files read per search; default 400. */
  readonly maxFiles?: number;
  /** Maximum characters accepted per file; default 512 * 1024. */
  readonly maxCharactersPerFile?: number;
}

/** A file the host already resolved to a canonical vault path. */
export interface FileCandidate<T> {
  readonly path: string;
  readonly file: T;
}

/** Injected file access: the core never touches the vault itself. */
export interface SearchFileReader<T> {
  readonly resolve: () => Promise<readonly FileCandidate<T>[]>;
  readonly read: (file: T) => Promise<string>;
}

export interface SearchFileReadResult {
  /** key = path, value = full text. */
  readonly contents: ReadonlyMap<string, string>;
  /** Files not read because of budget or size limits (fewer hits, never an error). */
  readonly skipped: number;
}

/** Cards are capped so a huge vault cannot freeze the panel; `hitCount` stays exact. */
export const SEARCH_RESULT_LIMIT = 200;
/**
 * Hit rows per card stay bounded: a frequent single-character query in a large
 * file can match thousands of times, and neither building snippets for all of
 * them nor rendering them is survivable. `hitCount` still reports the full total.
 */
export const SEARCH_HITS_PER_CARD_LIMIT = 30;
/** Leading context: enough to recognise the line without turning a hit into a paragraph. */
export const SEARCH_SNIPPET_BEFORE = 12;
/** Trailing context: longer than the leading side because the payload usually follows the hit. */
export const SEARCH_SNIPPET_AFTER = 40;

const ELLIPSIS = "\u2026";
const TOKEN_SEPARATOR = /\s+/;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_CHARACTERS_PER_FILE = 512 * 1024;

/**
 * Canonical folding for search input: NFKC first so full-width/Kangxi forms and
 * ideographic spaces collapse, then trim, then lowercase. Trimming happens after
 * NFKC because NFKC is what turns exotic spaces into plain U+0020.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Splits a query into folded tokens. The host searches tokens independently for
 * the "should we read this file at all" decision, which must not depend on the
 * tokens appearing as one contiguous phrase. Duplicates are dropped because a
 * repeated token can only repeat work.
 */
export function queryTokens(query: string): readonly string[] {
  const folded = normalizeSearchText(query);
  if (folded.length === 0) return [];
  return [...new Set(folded.split(TOKEN_SEPARATOR).filter((token) => token.length > 0))];
}

/**
 * Case/width folding used by the literal matchers. Deliberately *without* trim:
 * `findMatches` promises literal matching, so a caller-supplied query keeps its
 * spaces; hosts that want whitespace-insensitive queries use `normalizeSearchText`.
 */
function foldForMatching(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

interface FoldedText {
  readonly folded: string;
  /**
   * Source index of the code point that produced each folded character, or
   * `null` when folding was the identity so the mapping is trivially 1:1. The
   * tables stay lazy because ASCII-only text is the common case and two arrays
   * per call would be pure overhead.
   */
  readonly originStart: readonly number[] | null;
  readonly originEnd: readonly number[] | null;
}

/**
 * Builds the folded text plus an index map back to the original string. NFKC can
 * compose several code points into one character (base + combining mark, Hangul
 * jamo) and can expand one code point into many (ligatures), so folding code
 * points one by one cannot be trusted to line up. Growing a cluster until its
 * own fold is a prefix of the remaining folded text recovers exact indices for
 * both directions without a quadratic prefix-normalisation pass.
 */
function foldText(text: string): FoldedText {
  const folded = foldForMatching(text);
  if (folded === text) return { folded, originStart: null, originEnd: null };
  const originStart = new Array<number>(folded.length);
  const originEnd = new Array<number>(folded.length);
  let cursor = 0;
  let foldedIndex = 0;
  while (cursor < text.length && foldedIndex < folded.length) {
    let clusterEnd = nextCodePointBoundary(text, cursor);
    let cluster = foldForMatching(text.slice(cursor, clusterEnd));
    // Grow only while characters remain: at the end of the text the cluster holds
    // the whole tail, which is the correct attribution even if it does not line up
    // (and bounding on `clusterEnd` keeps the walk from running past the string).
    while (clusterEnd < text.length && (cluster.length === 0 || !folded.startsWith(cluster, foldedIndex))) {
      clusterEnd = nextCodePointBoundary(text, clusterEnd);
      cluster = foldForMatching(text.slice(cursor, clusterEnd));
    }
    if (cluster.length === 0) {
      cursor = clusterEnd;
      continue;
    }
    for (let offset = 0; offset < cluster.length && foldedIndex < folded.length; offset += 1) {
      originStart[foldedIndex] = cursor;
      originEnd[foldedIndex] = clusterEnd;
      foldedIndex += 1;
    }
    cursor = clusterEnd;
  }
  // Defensive tail: pin anything the cluster walk could not attribute to the end
  // of the text so a produced range can never point outside the original string.
  while (foldedIndex < folded.length) {
    originStart[foldedIndex] = Math.max(0, text.length - 1);
    originEnd[foldedIndex] = text.length;
    foldedIndex += 1;
  }
  return { folded, originStart, originEnd };
}

function nextCodePointBoundary(text: string, index: number): number {
  const code = text.codePointAt(index);
  if (code === undefined) return index + 1;
  return index + (code > 0xffff ? 2 : 1);
}

function originStartAt(folding: FoldedText, index: number): number {
  return folding.originStart === null ? index : folding.originStart[index]!;
}

function originEndAt(folding: FoldedText, index: number): number {
  return folding.originEnd === null ? index + 1 : folding.originEnd[index]!;
}

/** Appends a range, folding it into the previous one when the two overlap. */
function pushRange(ranges: SearchRange[], start: number, end: number): void {
  if (end <= start) return;
  const previous = ranges[ranges.length - 1];
  if (previous !== undefined && start < previous[1]) {
    if (end > previous[1]) ranges[ranges.length - 1] = [previous[0], end];
    return;
  }
  ranges.push([start, end]);
}

/**
 * Literal (never RegExp) search of every needle in `text`, mapped back to
 * original indices. Both sides are folded independently, which is what makes
 * matching width- and case-insensitive while leaving the user's input untouched.
 * Adjacent source-expanded matches are merged so the non-overlap contract holds
 * even when one code point produced several folded characters.
 */
function collectMatches(text: string, needles: readonly string[]): SearchRange[] {
  const usable = needles.filter((needle) => needle.length > 0);
  if (usable.length === 0 || text.length === 0) return [];
  const folding = foldText(text);
  const { folded } = folding;
  const found: SearchRange[] = [];
  for (const needle of usable) {
    if (needle.length > folded.length) continue;
    let from = 0;
    while (from + needle.length <= folded.length) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      found.push([originStartAt(folding, at), originEndAt(folding, at + needle.length - 1)]);
      from = at + needle.length;
    }
  }
  found.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: SearchRange[] = [];
  for (const [start, end] of found) pushRange(merged, start, end);
  return merged;
}

/**
 * All non-overlapping literal occurrences of `query`, case- and width-insensitive,
 * anchored to `text` indices. Only a query that folds to the empty string yields
 * `[]`; whitespace is matched literally, so callers that treat whitespace as a
 * separator should pass an already-normalised query.
 */
export function findMatches(text: string, query: string): readonly SearchRange[] {
  const needle = foldForMatching(query);
  if (needle.length === 0) return [];
  return collectMatches(text, [needle]);
}

/** Literal occurrences of every folded token, merged into ascending non-overlapping ranges. */
export function matchesInText(text: string, tokens: readonly string[]): readonly SearchRange[] {
  if (tokens.length === 0) return [];
  return collectMatches(
    text,
    tokens.map((token) => foldForMatching(token))
  );
}

/**
 * Cheap "is this file worth reading" predicate: every token must occur literally.
 * An empty (or entirely blank) token list answers `false`, because reading the
 * whole vault for a blank query is never what the caller wants.
 */
export function matchesSearchText(text: string, tokens: readonly string[]): boolean {
  const needles = tokens.map((token) => foldForMatching(token)).filter((token) => token.length > 0);
  if (needles.length === 0) return false;
  const folded = foldForMatching(text);
  return needles.every((needle) => folded.includes(needle));
}

/** Convenience wrapper for callers holding the raw query instead of pre-split tokens. */
export function matchesSearchQuery(text: string, query: string): boolean {
  return matchesSearchText(text, queryTokens(query));
}

/**
 * Clips `text` to a one-line window around the given ranges and rebases the
 * ranges onto the returned string. Every range is kept (a caller may pass all
 * matches of one line) so a single window can carry several highlights; the
 * ellipses are part of the returned text and therefore part of the offsets.
 * Without ranges there is nothing to centre on, so the text is returned as-is.
 */
export function buildSnippet(
  text: string,
  ranges: readonly SearchRange[]
): { text: string; ranges: readonly SearchRange[] } {
  const clipped: SearchRange[] = [];
  for (const [start, end] of ranges) {
    const from = Math.max(0, Math.min(start, text.length));
    const to = Math.max(0, Math.min(end, text.length));
    if (from < to) clipped.push([from, to]);
  }
  if (clipped.length === 0) return { text, ranges: [] };
  clipped.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const first = clipped[0]!;
  const last = clipped[clipped.length - 1]!;
  const windowStart = Math.max(0, first[0] - SEARCH_SNIPPET_BEFORE);
  const windowEnd = Math.min(text.length, last[1] + SEARCH_SNIPPET_AFTER);
  const leading = windowStart > 0 ? ELLIPSIS : "";
  const trailing = windowEnd < text.length ? ELLIPSIS : "";
  const offset = leading.length - windowStart;
  const snippetRanges: SearchRange[] = [];
  for (const [start, end] of clipped) pushRange(snippetRanges, start + offset, end + offset);
  return { text: `${leading}${text.slice(windowStart, windowEnd)}${trailing}`, ranges: snippetRanges };
}

interface RankedCard {
  readonly card: SearchCard;
  /**
   * Eager ancestor fallback, kept out of the card until the cap is applied so a
   * dropped card never allocates a chain.
   */
  readonly ancestorIds: readonly NodeId[] | undefined;
  readonly hasTitleHit: boolean;
  readonly hasFileHit: boolean;
  readonly contentHitCount: number;
  readonly order: number;
}

/**
 * Pure search over one document snapshot. The query is trimmed (not tokenised)
 * so a trailing space does not silently become a literal-space requirement, and
 * the whole result is derived from the passed context, which keeps the function
 * repeatable and safe to call from a debounced input handler.
 */
export function searchMindTree(ctx: SearchContext, query: string): SearchResult {
  const needle = normalizeSearchText(query);
  if (needle.length === 0) return { cards: [], hitCount: 0 };

  const ranked: RankedCard[] = [];
  let hitCount = 0;

  for (let order = 0; order < ctx.candidates.length; order += 1) {
    const candidate = ctx.candidates[order]!;
    const titleHit = buildTitleHit(candidate.plainTitle, needle);
    const fileName = resolveFileName(candidate);
    const fileHit = fileName === undefined ? undefined : buildFileHit(fileName, needle);

    // The card title row already renders the title hit and the heading renders
    // the file-name hit, so content hits with the same line and segment are the
    // only duplicates worth suppressing.
    const rendered = new Set<string>();
    if (titleHit !== undefined) rendered.add(hitKey(titleHit));
    if (fileHit !== undefined) rendered.add(hitKey(fileHit));
    const fileHitCount = fileHit === undefined ? 0 : 1;
    const content = collectContentHits(
      ctx,
      candidate,
      needle,
      rendered,
      Math.max(0, SEARCH_HITS_PER_CARD_LIMIT - fileHitCount)
    );

    const hits: SearchHit[] = [];
    if (fileHit !== undefined) hits.push(fileHit);
    hits.push(...content.hits);
    if (titleHit === undefined && hits.length === 0) continue;

    const limited = fileHitCount + content.total > SEARCH_HITS_PER_CARD_LIMIT;
    hitCount += (titleHit === undefined ? 0 : 1) + fileHitCount + content.total;
    ranked.push({
      card: {
        nodeId: candidate.nodeId,
        title: candidate.title,
        ...(titleHit === undefined ? {} : { titleHit }),
        ...(candidate.resourceId === undefined ? {} : { resourceId: candidate.resourceId }),
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
        ...(fileName === undefined ? {} : { fileName }),
        hits,
        ...(limited ? { hitsLimited: true } : {})
      },
      hasTitleHit: titleHit !== undefined,
      hasFileHit: fileHit !== undefined,
      ancestorIds: candidate.ancestorIds,
      // Sorting keeps using the true total; capping it would reshuffle cards.
      contentHitCount: content.total,
      order
    });
  }

  ranked.sort(compareCards);
  const cards: SearchCard[] = [];
  for (const entry of ranked.slice(0, SEARCH_RESULT_LIMIT)) {
    // Resolved last on purpose: a candidate the result cap drops must neither
    // allocate a chain nor cost a lazy ancestor lookup.
    const ancestorIds = resolveAncestorIds(ctx, entry);
    const nodePath = buildNodePath(entry.card.nodeId, ancestorIds);
    cards.push(nodePath === undefined ? entry.card : { ...entry.card, nodePath });
  }
  return { cards, hitCount };
}

function buildTitleHit(
  plainTitle: string,
  needle: string
): Extract<SearchHit, { source: "title" }> | undefined {
  const ranges = findMatches(plainTitle, needle);
  if (ranges.length === 0) return undefined;
  const snippet = buildSnippet(plainTitle, ranges);
  return { source: "title", line: 1, text: snippet.text, ranges: snippet.ranges };
}

/**
 * Ancestors of one card that already survived the result cap. The lazy host
 * callback wins whenever it has an answer, so a host can pay one parent-index
 * build instead of one chain per node. When the callback is provided it is
 * authoritative: `undefined` and `[]` both mean "this node has no path row", and
 * the core must not fall back to a possibly stale `candidate.ancestorIds`
 * snapshot, which would draw a wrong path for the current document. The snapshot
 * is consulted only when no callback exists at all.
 */
function resolveAncestorIds(ctx: SearchContext, entry: RankedCard): readonly NodeId[] | undefined {
  if (ctx.nodeAncestorIds !== undefined) return ctx.nodeAncestorIds(entry.card.nodeId);
  return entry.ancestorIds;
}

/**
 * Root → … → self chain for a card's clickable path row, or `undefined` when the
 * card must not render one.
 *
 * Ancestors are host-supplied, lazily or as a snapshot, so they are treated as
 * dirty: a repeated id is dropped instead of duplicating a row, and a chain that
 * already contains the hit node itself (a cycle, which cannot be a truthful
 * root-to-self path) drops the whole chain rather than throwing. Iterating the
 * finite input array with a `Set` is what makes this unable to loop, so no
 * separate depth cap is needed; the chain never takes part in ranking or hit
 * counting.
 */
function buildNodePath(
  nodeId: NodeId,
  ancestorIds: readonly NodeId[] | undefined
): readonly NodeId[] | undefined {
  if (ancestorIds === undefined || ancestorIds.length === 0) return undefined;
  const seen = new Set<NodeId>();
  const chain: NodeId[] = [];
  for (const ancestorId of ancestorIds) {
    if (seen.has(ancestorId)) continue;
    seen.add(ancestorId);
    chain.push(ancestorId);
  }
  // `nodeId` among its own ancestors: stop instead of appending a duplicate.
  if (seen.has(nodeId)) return undefined;
  chain.push(nodeId);
  return chain;
}

function buildFileHit(fileName: string, needle: string): SearchHit | undefined {
  const ranges = findMatches(fileName, needle);
  if (ranges.length === 0) return undefined;
  const snippet = buildSnippet(fileName, ranges);
  return { source: "file", line: 1, text: snippet.text, ranges: snippet.ranges };
}

/**
 * File name used for `source: "file"` hits. `fileName` wins because the host may
 * have display-adjusted it, and the path basename is the documented fallback so a
 * partially populated candidate still produces file hits instead of silence.
 */
function resolveFileName(candidate: SearchCandidate): string | undefined {
  if (candidate.fileName !== undefined && candidate.fileName.length > 0) return candidate.fileName;
  if (candidate.path === undefined) return undefined;
  const withoutTrailingSlash = candidate.path.endsWith("/")
    ? candidate.path.slice(0, -1)
    : candidate.path;
  const separator = withoutTrailingSlash.lastIndexOf("/");
  const name = separator < 0 ? withoutTrailingSlash : withoutTrailingSlash.slice(separator + 1);
  return name.length > 0 ? name : undefined;
}

/**
 * One hit per match per line: separate rows keep each match's own context and
 * give the panel a natural place for a separator. `\r` is stripped from CRLF
 * files so the rendered text never carries a stray carriage return.
 *
 * `capacity` bounds snippet construction, so the returned `hits` stop at the cap
 * while `total` keeps counting every remaining match. Only the *first* match of
 * line 1 can duplicate a header row (later matches on the same line have their
 * own ranges, so their rendered row differs), and that first match is always
 * built because the cap leaves at least one content slot, which keeps `total`
 * truthful even after the cap is hit.
 */
function collectContentHits(
  ctx: SearchContext,
  candidate: SearchCandidate,
  needle: string,
  rendered: Set<string>,
  capacity: number
): { hits: SearchHit[]; total: number } {
  const hits: SearchHit[] = [];
  let total = 0;
  if (candidate.path === undefined) return { hits, total };
  const content = ctx.fileContents.get(candidate.path);
  if (content === undefined) return { hits, total };
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]!;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    for (const match of findMatches(line, needle)) {
      if (hits.length >= capacity) {
        total += 1;
        continue;
      }
      const snippet = buildSnippet(line, [match]);
      const hit: SearchHit = {
        source: "content",
        line: index + 1,
        text: snippet.text,
        ranges: snippet.ranges
      };
      const key = hitKey(hit);
      if (rendered.has(key)) continue;
      rendered.add(key);
      hits.push(hit);
      total += 1;
    }
  }
  return { hits, total };
}

/**
 * Identity of one rendered row: same line plus same text and ranges means the
 * user would see the exact same row twice, regardless of which source produced it.
 */
function hitKey(hit: SearchHit): string {
  const ranges = hit.ranges.map(([start, end]) => `${start}-${end}`).join(",");
  return `${hit.line}\u0000${hit.text}\u0000${ranges}`;
}

/**
 * Title hits first, then file-name hits, then the rest by content-hit count, with
 * the original candidate order as the tie-break so equally relevant nodes stay in
 * document order and repeated searches never reshuffle them.
 */
function compareCards(left: RankedCard, right: RankedCard): number {
  if (left.hasTitleHit !== right.hasTitleHit) return left.hasTitleHit ? -1 : 1;
  if (left.hasFileHit !== right.hasFileHit) return left.hasFileHit ? -1 : 1;
  if (left.contentHitCount !== right.contentHitCount) return right.contentHitCount - left.contentHitCount;
  return left.order - right.order;
}

/**
 * Reads the candidate files the host decided are worth reading. Files are read
 * sequentially in resolve order so ordering and budget accounting stay
 * deterministic, and every refusal (budget, oversize, failed read) only bumps
 * `skipped` — a search must degrade to fewer hits, never to an error. Budget
 * counts read attempts, so failed and oversized reads consume it.
 */
export async function readSearchFiles<T>(
  reader: SearchFileReader<T>,
  matcher: (candidate: FileCandidate<T>) => boolean,
  budget?: SearchFileBudget
): Promise<SearchFileReadResult> {
  const maxFiles = resolveBudget(budget?.maxFiles, DEFAULT_MAX_FILES);
  const maxCharactersPerFile = resolveBudget(
    budget?.maxCharactersPerFile,
    DEFAULT_MAX_CHARACTERS_PER_FILE
  );
  const candidates = await reader.resolve();
  const contents = new Map<string, string>();
  const seenPaths = new Set<string>();
  let skipped = 0;
  let readAttempts = 0;
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;
    seenPaths.add(candidate.path);
    if (!matcher(candidate)) continue;
    if (readAttempts >= maxFiles) {
      skipped += 1;
      continue;
    }
    readAttempts += 1;
    let content: string;
    try {
      content = await reader.read(candidate.file);
    } catch {
      skipped += 1;
      continue;
    }
    if (content.length > maxCharactersPerFile) {
      skipped += 1;
      continue;
    }
    contents.set(candidate.path, content);
  }
  return { contents, skipped };
}

/** Invalid or negative budgets fall back to the documented default instead of disabling search. */
function resolveBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
