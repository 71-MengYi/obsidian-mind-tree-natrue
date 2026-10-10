import { EMOJI_CATALOG, type EmojiCatalogEntry } from "./emoji-data";

/**
 * Search over the bundled offline emoji catalogue.
 *
 * Matching is deliberately simple and fully offline: every whitespace-separated
 * query token must be a substring of the entry's haystack (glyph, English name
 * or Chinese keywords). That makes `smile` find every smiling face, `笑脸` find
 * the same faces through the Chinese keywords, and `flag china` narrow the
 * country flags, without needing fuzzy matching or a server.
 */

/**
 * English words that users type for a category but that the per-entry names and
 * Chinese keyword lists do not contain. A real stemmer is not worth the bundle
 * size (`smile` → `smiling` cannot be reached by prefix matching either), so the
 * handful of groups users actually type are listed once, per category.
 * A value must be a substring of the category id it is listed under.
 */
const CATEGORY_ALIAS_TERMS: Readonly<Record<string, string>> = {
  "smileys-emotion": "smile smiley happy sad angry cry laugh love heart kiss",
  "people-body": "person people body hand gesture clamp wave point pray muscle",
  "animals-nature": "animal nature plant flower tree weather sun moon cloud rain snow star",
  "food-drink": "food fruit vegetable drink coffee tea wine beer dessert meal",
  "travel-places": "travel place building car train plane ship road city map",
  "activities": "activity sport game music party art ball trophy",
  "objects": "object tool computer phone book money key bag clock",
  "symbols": "symbol arrow warning sign check cross question number",
  "flags": "flag country nation"
};

/**
 * A few two-letter country aliases: the catalogue stores the English country
 * name (keyword-matched) and the Chinese name, not the abbreviation.
 */
const COUNTRY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["cn", "中国"],
  ["us", "美国"],
  ["uk", "英国"],
  ["jp", "日本"],
  ["kr", "韩国"],
  ["de", "德国"],
  ["fr", "法国"],
  ["ru", "俄罗斯"],
  ["in", "印度"],
  ["br", "巴西"]
];

/** One extra string per entry, built once, so a keystroke stays a lookup. */
function aliasHaystack(entry: EmojiCatalogEntry): string {
  const terms = [CATEGORY_ALIAS_TERMS[entry.c] ?? ""];
  for (const [abbreviation, chineseName] of COUNTRY_ALIASES) {
    if (entry.k.includes(chineseName)) terms.push(abbreviation);
  }
  return terms.join(" ");
}

/** Search haystack per entry, precomputed once instead of per keystroke. */
const HAYSTACK: readonly string[] = EMOJI_CATALOG.map((entry) => {
  const name = entry.n.toLowerCase();
  // Every word contributes its 4-character prefix *in addition to itself*:
  // a query is matched as a substring, so adding `smil` lets the query `smile`
  // reach `smiling face`. Replacing the word with its prefix would instead
  // break the exact query.
  const wordPrefixes = (value: string): string => value
    .split(/\s+/)
    .map((word) => word.slice(0, 4))
    .join(" ");
  return `${entry.g}\u0000${name}\u0000${wordPrefixes(name)}\u0000${entry.k}\u0000${aliasHaystack(entry)}`;
});

/** Fold full-width characters and case so `ＡＢ` and `ab` match the same entry. */
function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Entries matching every token of `query`, in catalogue order.
 * An empty or whitespace-only query returns the **whole** catalogue, because the
 * picker is the browsing surface: a truncated "popular" list would hide entries
 * the user cannot guess a keyword for.
 */
export function searchEmoji(query: string): readonly EmojiCatalogEntry[] {
  const tokens = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return EMOJI_CATALOG;
  const result: EmojiCatalogEntry[] = [];
  for (let index = 0; index < EMOJI_CATALOG.length; index += 1) {
    const haystack = HAYSTACK[index]!;
    if (tokens.every((token) => haystack.includes(token))) result.push(EMOJI_CATALOG[index]!);
  }
  return result;
}

/** How many entries a query matches. Exposed so the picker can label the list. */
export function countEmojiMatches(query: string): number {
  const tokens = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return EMOJI_CATALOG.length;
  let matches = 0;
  for (const haystack of HAYSTACK) {
    if (tokens.every((token) => haystack.includes(token))) matches += 1;
  }
  return matches;
}

/** The catalogue size, used by tests and by the empty-state copy. */
export const EMOJI_CATALOG_SIZE = EMOJI_CATALOG.length;
