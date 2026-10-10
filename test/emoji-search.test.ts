import test from "node:test";
import assert from "node:assert/strict";
import { isSingleEmojiValue } from "../src/domain/custom-markers";
import { EMOJI_CATALOG } from "../src/ui/emoji-data";
import {
  countEmojiMatches,
  EMOJI_CATALOG_SIZE,
  EMOJI_PICKER_DEFAULT_LIMIT,
  EMOJI_PICKER_RESULT_LIMIT,
  searchEmoji
} from "../src/ui/emoji-search";

/**
 * The picker is the only way to add an Emoji marker, so the catalogue itself is
 * part of the feature contract: every entry must be storable as a marker value,
 * searchable in both languages, and cheap enough to render while typing.
 */

test("every catalogue entry is exactly one emoji and carries a searchable name", () => {
  const seen = new Set<string>();
  for (const entry of EMOJI_CATALOG) {
    assert.equal(isSingleEmojiValue(entry.g), true, `not one emoji: ${JSON.stringify(entry.g)}`);
    assert.equal(seen.has(entry.g), false, `duplicate glyph: ${entry.g}`);
    seen.add(entry.g);
    assert.ok(entry.n.trim().length > 0, `missing name for ${entry.g}`);
    assert.ok(entry.k.trim().length > 0, `missing keywords for ${entry.g}`);
    assert.ok(entry.c.trim().length > 0, `missing category for ${entry.g}`);
  }
  assert.equal(EMOJI_CATALOG_SIZE, EMOJI_CATALOG.length);
  assert.ok(EMOJI_CATALOG_SIZE > 1_000, "the catalogue should cover everyday emoji");
});

test("an empty query returns the popular head of the catalogue", () => {
  assert.equal(searchEmoji("").length, EMOJI_PICKER_DEFAULT_LIMIT);
  assert.equal(searchEmoji("   ").length, EMOJI_PICKER_DEFAULT_LIMIT);
  assert.equal(searchEmoji("")[0]!.n, "grinning face");
  assert.equal(countEmojiMatches(""), EMOJI_CATALOG_SIZE);
});

test("search matches English names, their inflections and Chinese keywords", () => {
  // `smile` must reach `smiling face`; the prefix + alias layers exist for that.
  assert.ok(countEmojiMatches("smile") > 5, "smile reaches several faces");
  assert.ok(countEmojiMatches("heart") > 5, "heart reaches the heart set");
  assert.ok(countEmojiMatches("flag") > 100, "flag reaches the country flags");

  const china = searchEmoji("中国");
  assert.deepEqual(china.map((entry) => entry.g), ["🇨🇳"]);
  assert.equal(china[0]!.n, "flag China");

  const fire = searchEmoji("火").map((entry) => entry.g);
  assert.ok(fire.includes("🔥"), "the fire keyword reaches the flame");

  // Tokens are ANDed, so a two-word query narrows rather than widens.
  const narrow = searchEmoji("flag china");
  assert.ok(narrow.length < countEmojiMatches("flag"));
  assert.equal(narrow[0]!.g, "🇨🇳");
});

test("search is case- and width-insensitive and can find a pasted emoji", () => {
  assert.deepEqual(searchEmoji("FIRE").map((e) => e.g), searchEmoji("fire").map((e) => e.g));
  assert.deepEqual(searchEmoji("ＦＩＲＥ").map((e) => e.g), searchEmoji("fire").map((e) => e.g));
  // Pasting the glyph itself is a natural way to look for the same marker.
  assert.deepEqual(searchEmoji("🚀").map((e) => e.g), ["🚀"]);
  assert.deepEqual(searchEmoji("  ROCKET  ").map((e) => e.g), ["🚀"]);
});

test("a query with no match returns nothing and reports zero", () => {
  assert.deepEqual(searchEmoji("zzzzzz"), []);
  assert.equal(countEmojiMatches("zzzzzz"), 0);
  assert.deepEqual(searchEmoji("🔥 说明"), []);
});

test("results are capped so typing stays cheap, and the count is exact", () => {
  // `flag` matches every country, far more than one screen; the list must clip.
  const matches = countEmojiMatches("flag");
  assert.ok(matches > EMOJI_PICKER_RESULT_LIMIT, "the query matches more than the cap");
  assert.equal(searchEmoji("flag").length, EMOJI_PICKER_RESULT_LIMIT);
  // Every returned entry really matches the query.
  for (const entry of searchEmoji("flag")) {
    assert.ok(entry.n.toLowerCase().includes("flag") || entry.k.includes("旗"), entry.n);
  }
});

test("the catalogue is ordered by category so the default list is predictable", () => {
  const categories = new Set(EMOJI_CATALOG.map((entry) => entry.c));
  for (const category of categories) {
    const indices = EMOJI_CATALOG
      .map((entry, index) => (entry.c === category ? index : -1))
      .filter((index) => index >= 0);
    const span = (indices.at(-1) ?? 0) - (indices[0] ?? 0) + 1;
    assert.equal(span, indices.length, `category ${category} is not contiguous`);
  }
});
