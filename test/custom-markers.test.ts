import test from "node:test";
import assert from "node:assert/strict";
import {
  addCustomMarkerDefinition,
  cleanCustomMarkerValue,
  createCustomMarkerId,
  customMarkerDefinitionsByKind,
  customMarkerMaxLength,
  findCustomMarkerDefinition,
  getCustomMarkerValue,
  hasDangerousMarkerCharacter,
  isEmojiMarkerValue,
  isSafeCustomMarkerId,
  MAX_CUSTOM_EMOJI_LENGTH,
  MAX_CUSTOM_MARKER_ENTRIES,
  MAX_CUSTOM_MARKER_ID_LENGTH,
  MAX_CUSTOM_TAG_LENGTH,
  moveCustomMarkerDefinition,
  normalizeCustomMarkerDefinitions,
  removeCustomMarkerDefinition,
  validateCustomMarkerValue,
  type CustomMarkerDefinition,
  type CustomMarkerKind
} from "../src/domain/custom-markers";

function definition(id: string, kind: CustomMarkerKind, value: string): CustomMarkerDefinition {
  return { id, kind, value };
}

test("cleaning strips invisible and bidirectional characters, folds whitespace and trims both ends", () => {
  assert.equal(cleanCustomMarkerValue("  绘图  "), "绘图");
  assert.equal(cleanCustomMarkerValue("\u200B绘\u200D图\uFEFF"), "绘图");
  assert.equal(cleanCustomMarkerValue("\u202Eabc\u202C"), "abc");
  // Control characters are removed instead of folding into a visible space.
  assert.equal(cleanCustomMarkerValue("绘\n图"), "绘图");
  assert.equal(cleanCustomMarkerValue("绘\t图"), "绘图");
  // Unicode whitespace folds to one ASCII space so comparisons stay canonical.
  assert.equal(cleanCustomMarkerValue("绘\u3000图"), "绘 图");
  assert.equal(cleanCustomMarkerValue("   "), "");
  assert.equal(cleanCustomMarkerValue(""), "");
  assert.equal(hasDangerousMarkerCharacter("\u200B"), true);
  assert.equal(hasDangerousMarkerCharacter("绘 图"), false);
});

test("cleaning keeps emoji and CJK values verbatim and preserves surrogate pairs", () => {
  assert.equal(cleanCustomMarkerValue("  🔥🎨  "), "🔥🎨");
  assert.equal(cleanCustomMarkerValue("绘图/草稿 v2"), "绘图/草稿 v2");
  assert.equal(Array.from(cleanCustomMarkerValue("🔥🔥")).length, 2);
  assert.equal(cleanCustomMarkerValue("🔥🔥").length, 4);
});

test("group caps are fixed per kind and independent of the other group", () => {
  assert.equal(customMarkerMaxLength("emoji"), MAX_CUSTOM_EMOJI_LENGTH);
  assert.equal(customMarkerMaxLength("tag"), MAX_CUSTOM_TAG_LENGTH);
  assert.equal(MAX_CUSTOM_EMOJI_LENGTH, 16);
  assert.equal(MAX_CUSTOM_TAG_LENGTH, 24);
  assert.equal(MAX_CUSTOM_MARKER_ENTRIES, 64);
  assert.equal(MAX_CUSTOM_MARKER_ID_LENGTH, 64);
});

test("only pictographic values are reported as emoji candidates", () => {
  assert.equal(isEmojiMarkerValue("🔥"), true);
  assert.equal(isEmojiMarkerValue("⭐"), true);
  assert.equal(isEmojiMarkerValue("✅"), true);
  assert.equal(isEmojiMarkerValue("绘图"), false);
  assert.equal(isEmojiMarkerValue("v2"), false);
  assert.equal(isEmojiMarkerValue(""), false);
});

test("validation reports empty for input that would render nothing", () => {
  assert.deepEqual(validateCustomMarkerValue("emoji", "", []), { ok: false, code: "empty" });
  assert.deepEqual(validateCustomMarkerValue("tag", "   ", []), { ok: false, code: "empty" });
  // Typing only invisible characters is reported as unsafe rather than empty:
  // the user did enter something, it just cannot be displayed.
  assert.deepEqual(validateCustomMarkerValue("tag", "\u200B", []), { ok: false, code: "unsafe" });
  assert.deepEqual(validateCustomMarkerValue("emoji", "🔥", []), { ok: true, code: "ok" });
  assert.deepEqual(validateCustomMarkerValue("tag", "绘图", []), { ok: true, code: "ok" });
});

test("validation keeps the code-point limit that only text tags can reach", () => {
  // A single emoji is accepted no matter how many code points its cluster uses.
  assert.deepEqual(
    validateCustomMarkerValue("emoji", "👨‍👩‍👧‍👦", []),
    { ok: true, code: "ok" }
  );
  // Only text tags can exceed their cap, because an emoji group value must be
  // one glyph and is rejected as `not-emoji` long before the cap matters.
  assert.deepEqual(
    validateCustomMarkerValue("tag", "绘".repeat(MAX_CUSTOM_TAG_LENGTH), []),
    { ok: true, code: "ok" }
  );
  // Text tags also reach `too-long`: the whole group's cap is real for them.
  assert.deepEqual(
    validateCustomMarkerValue("tag", "绘".repeat(MAX_CUSTOM_TAG_LENGTH + 1), []),
    { ok: false, code: "too-long" }
  );
  // The emoji cap counts code points, not UTF-16 units: 16 astral emoji are 32
  // units, so the same cluster budget must not be halved by the surrogate pairs.
  assert.equal("🔥".repeat(MAX_CUSTOM_EMOJI_LENGTH).length, 32);
  assert.equal(Array.from("🔥".repeat(MAX_CUSTOM_EMOJI_LENGTH)).length, MAX_CUSTOM_EMOJI_LENGTH);
});

test("the Emoji group accepts exactly one emoji and rejects text or several glyphs", () => {
  // ZWJ sequences, skin tones, flags, keycaps and a bare text-presentation
  // glyph are all one grapheme, so all of them are valid single emoji.
  for (const value of ["🔥", "⭐", "✅", "🇨🇳", "👍🏽", "❤️", "☺️", "👨‍👩‍👧‍👦", "🔥 ", "❤"]) {
    assert.deepEqual(validateCustomMarkerValue("emoji", value, []), { ok: true, code: "ok" }, JSON.stringify(value));
  }
  for (const value of ["绘图", "abc", "v2", "🔥🔥", "a🔥", "1", "🔥 说明", "note", "🔥🔥🔥"]) {
    assert.deepEqual(validateCustomMarkerValue("emoji", value, []), { ok: false, code: "not-emoji" }, JSON.stringify(value));
  }
  // A hidden character is still reported as unsafe, not as "not an emoji".
  assert.deepEqual(
    validateCustomMarkerValue("emoji", "🔥\u200B", []),
    { ok: false, code: "unsafe" }
  );
  // The same strings stay valid in the text tag group: only Emoji is strict.
  for (const value of ["绘图", "abc", "1"]) {
    assert.deepEqual(validateCustomMarkerValue("tag", value, []), { ok: true, code: "ok" }, JSON.stringify(value));
  }
  // "not an emoji" wins over "duplicate" so the message names the real problem.
  assert.deepEqual(
    validateCustomMarkerValue("emoji", "绘图", ["绘图"]),
    { ok: false, code: "not-emoji" }
  );
});

test("validation rejects invisible, control and bidi characters as unsafe", () => {
  for (const value of [
    "绘\u200B图",
    "a\u202Eb",
    "a\nb",
    "\uFEFF绘图",
    "\u009F绘图",
    "绘\u2066图\u2069"
  ]) {
    assert.deepEqual(validateCustomMarkerValue("tag", value, []), { ok: false, code: "unsafe" }, JSON.stringify(value));
  }
});

test("validation compares values after cleaning so spacing cannot create a duplicate", () => {
  assert.deepEqual(validateCustomMarkerValue("tag", " 绘图 ", ["绘图"]), { ok: false, code: "duplicate" });
  assert.deepEqual(validateCustomMarkerValue("tag", "绘\u3000图", ["绘 图"]), { ok: false, code: "duplicate" });
  assert.deepEqual(validateCustomMarkerValue("emoji", "🔥", [" 🔥 "]), { ok: false, code: "duplicate" });
  assert.deepEqual(validateCustomMarkerValue("tag", "绘图", ["绘 图"]), { ok: true, code: "ok" });
  assert.deepEqual(validateCustomMarkerValue("tag", "绘图", []), { ok: true, code: "ok" });
});

test("validation reports the length limit before the unsafe-character limit for combined input", () => {
  const combined = "\u200B".repeat(MAX_CUSTOM_TAG_LENGTH + 1) + "绘";
  assert.deepEqual(validateCustomMarkerValue("tag", combined, []), { ok: false, code: "too-long" });
});

test("generated ids are deterministic, prefixed per kind and always safe", () => {
  const emojiId = createCustomMarkerId("emoji", "🔥", []);
  assert.equal(emojiId, createCustomMarkerId("emoji", "🔥", []));
  assert.match(emojiId, /^mtn-emoji-[a-z0-9]+$/);
  assert.equal(isSafeCustomMarkerId(emojiId), true);

  const tagId = createCustomMarkerId("tag", "🔥", []);
  assert.match(tagId, /^mtn-tag-/);
  assert.notEqual(tagId, emojiId);
  assert.notEqual(createCustomMarkerId("emoji", "🎨", []), emojiId);
});

test("generated ids skip every id that is already in use", () => {
  const base = createCustomMarkerId("emoji", "🔥", []);
  assert.equal(
    createCustomMarkerId("emoji", "🔥", [definition(base, "emoji", "🔥")]),
    `${base}-2`
  );
  assert.equal(
    createCustomMarkerId("emoji", "🔥", [
      definition(base, "emoji", "🔥"),
      definition(`${base}-2`, "emoji", "🎨")
    ]),
    `${base}-3`
  );
});

test("adding appends cleaned definitions without mutating the input list", () => {
  const original: CustomMarkerDefinition[] = [];
  const withEmoji = addCustomMarkerDefinition(original, definition(" mtn-emoji-1 ", "emoji", " 🔥 "));
  assert.deepEqual(original, []);
  assert.notEqual(withEmoji, original);
  assert.deepEqual(withEmoji, [{ id: "mtn-emoji-1", kind: "emoji", value: "🔥" }]);

  const withTag = addCustomMarkerDefinition(withEmoji, definition("mtn-tag-1", "tag", " 绘图 "));
  assert.deepEqual(withTag.map((item) => item.value), ["🔥", "绘图"]);
  assert.deepEqual(withEmoji.map((item) => item.value), ["🔥"]);
});

test("adding rejects duplicate ids, duplicate values and blank values", () => {
  const definitions = [definition("mtn-emoji-1", "emoji", "🔥")];
  assert.equal(addCustomMarkerDefinition(definitions, definition("mtn-emoji-1", "emoji", "🎨")).length, 1);
  assert.equal(addCustomMarkerDefinition(definitions, definition("mtn-emoji-2", "emoji", " 🔥 ")).length, 1);
  assert.equal(addCustomMarkerDefinition(definitions, definition("mtn-emoji-2", "emoji", "\u200B")).length, 1);
  assert.deepEqual(addCustomMarkerDefinition(definitions, definition("mtn-emoji-2", "emoji", "   ")), definitions);
  // The two groups are separate namespaces, so the same value may exist twice.
  assert.deepEqual(
    addCustomMarkerDefinition(definitions, definition("mtn-tag-1", "tag", "🔥")).map((item) => item.kind),
    ["emoji", "tag"]
  );
});

test("adding rejects ids that are not safe registry keys", () => {
  for (const id of [
    "",
    "-lead",
    ".lead",
    "_lead",
    "../escape",
    "a/b",
    "a b",
    "绘",
    "x".repeat(MAX_CUSTOM_MARKER_ID_LENGTH + 1)
  ]) {
    assert.deepEqual(addCustomMarkerDefinition([], definition(id, "emoji", "🔥")), [], JSON.stringify(id));
  }
  // Surrounding whitespace is trimmed before the id is validated and stored.
  assert.deepEqual(
    addCustomMarkerDefinition([], definition("  lead  ", "emoji", "🔥")).map((item) => item.id),
    ["lead"]
  );
  assert.equal(
    addCustomMarkerDefinition([], definition("x".repeat(MAX_CUSTOM_MARKER_ID_LENGTH), "emoji", "🔥")).length,
    1
  );
});

test("adding stops at the entry cap instead of growing the registry or throwing", () => {
  const full: CustomMarkerDefinition[] = [];
  for (let index = 0; index < MAX_CUSTOM_MARKER_ENTRIES; index += 1) {
    full.push(definition(`mtn-emoji-${index}`, "emoji", `fire-${index}`));
  }
  const overflow = addCustomMarkerDefinition(full, definition("mtn-emoji-extra", "emoji", "extra"));
  assert.equal(overflow.length, MAX_CUSTOM_MARKER_ENTRIES);
  assert.deepEqual(overflow, full);
  assert.equal(full.length, MAX_CUSTOM_MARKER_ENTRIES);
});

test("removing deletes only the requested definition and tolerates unknown ids", () => {
  const definitions = [
    definition("A", "emoji", "1"),
    definition("B", "tag", "2"),
    definition("C", "emoji", "3")
  ];
  assert.deepEqual(removeCustomMarkerDefinition(definitions, "B").map((item) => item.id), ["A", "C"]);
  assert.deepEqual(removeCustomMarkerDefinition(definitions, "missing"), definitions);
  assert.deepEqual(definitions.map((item) => item.id), ["A", "B", "C"]);
});

test("moving places the dragged item before an index measured without it", () => {
  const definitions = ["A", "B", "C", "D"].map((id) => definition(id, "emoji", id));
  const order = (id: string, beforeIndex: number): string[] =>
    moveCustomMarkerDefinition(definitions, id, beforeIndex).map((item) => item.id);

  assert.deepEqual(order("D", 1), ["A", "D", "B", "C"]);
  assert.deepEqual(order("A", 2), ["B", "C", "A", "D"]);
  assert.deepEqual(order("C", 3), ["A", "B", "D", "C"]);
  assert.deepEqual(order("C", -5), ["C", "A", "B", "D"]);
  assert.deepEqual(order("A", 99), ["B", "C", "D", "A"]);
  assert.deepEqual(order("A", 1.9), ["B", "A", "C", "D"]);
  assert.deepEqual(definitions.map((item) => item.id), ["A", "B", "C", "D"]);
});

test("moving an unknown id returns an equal copy", () => {
  const definitions = ["A", "B", "C"].map((id) => definition(id, "tag", id));
  const moved = moveCustomMarkerDefinition(definitions, "missing", 2);
  assert.deepEqual(moved, definitions);
  assert.notEqual(moved, definitions);
});

test("lookups resolve ids per group and ignore the other group", () => {
  const definitions = [definition("A", "emoji", "🔥"), definition("B", "tag", "绘图")];
  assert.equal(findCustomMarkerDefinition(definitions, "B")?.id, "B");
  assert.equal(findCustomMarkerDefinition(definitions, "missing"), undefined);
  assert.equal(getCustomMarkerValue(definitions, "emoji", "A"), "🔥");
  assert.equal(getCustomMarkerValue(definitions, "tag", "B"), "绘图");
  assert.equal(getCustomMarkerValue(definitions, "tag", "A"), undefined);
  assert.equal(getCustomMarkerValue(definitions, "emoji", "B"), undefined);
  assert.equal(getCustomMarkerValue([], "tag", "B"), undefined);
});

test("group filtering preserves the user's order inside each group", () => {
  const definitions = [
    definition("A", "emoji", "1"),
    definition("B", "tag", "2"),
    definition("C", "emoji", "3"),
    definition("D", "tag", "4")
  ];
  assert.deepEqual(customMarkerDefinitionsByKind(definitions, "emoji").map((item) => item.id), ["A", "C"]);
  assert.deepEqual(customMarkerDefinitionsByKind(definitions, "tag").map((item) => item.id), ["B", "D"]);
  assert.deepEqual(customMarkerDefinitionsByKind([], "emoji"), []);
});

test("safe registry ids accept the generated shape and reject unsafe shapes", () => {
  assert.equal(isSafeCustomMarkerId("mtn-emoji-98lhnk"), true);
  assert.equal(isSafeCustomMarkerId("A.b_c:d-e"), true);
  assert.equal(isSafeCustomMarkerId("x".repeat(MAX_CUSTOM_MARKER_ID_LENGTH)), true);
  assert.equal(isSafeCustomMarkerId("x".repeat(MAX_CUSTOM_MARKER_ID_LENGTH + 1)), false);
  for (const id of ["", " lead", "trail ", "-lead", ".lead", "_lead", "a/b", "a b", "绘", "a\u0000b"]) {
    assert.equal(isSafeCustomMarkerId(id), false, JSON.stringify(id));
  }
});

test("normalizing a non-array value yields an empty registry", () => {
  for (const value of [undefined, null, "绘图", 42, {}, new Set(["绘图"]), () => []]) {
    assert.deepEqual(normalizeCustomMarkerDefinitions(value), []);
  }
});

test("normalizing keeps valid entries in order, cleans values and rebuilds unsafe ids", () => {
  const normalized = normalizeCustomMarkerDefinitions([
    definition("keep", "emoji", " 🔥 "),
    { id: "../escape", kind: "tag", value: " 绘图 " },
    definition("keep", "emoji", "🎨"),
    { kind: "emoji" },
    { kind: "tag", value: 7 },
    { kind: "progress", value: "绘图" },
    null,
    ["tag", "绘图"],
    definition("long", "emoji", "🔥".repeat(MAX_CUSTOM_EMOJI_LENGTH + 1)),
    definition("blank", "tag", "\u200B")
  ]);

  assert.deepEqual(normalized.map((item) => [item.kind, item.value]), [
    ["emoji", "🔥"],
    ["tag", "绘图"],
    ["emoji", "🎨"]
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0]!.id, "keep");
  // The unsafe id and the duplicate id are both rebuilt into unique safe ids.
  assert.match(normalized[1]!.id, /^mtn-tag-/);
  assert.match(normalized[2]!.id, /^mtn-emoji-/);
  assert.notEqual(normalized[2]!.id, "keep");
  for (const item of normalized) assert.equal(isSafeCustomMarkerId(item.id), true);
});

test("normalizing drops duplicate values after cleaning, keeps the first entry and rejects Emoji text", () => {
  const normalized = normalizeCustomMarkerDefinitions([
    definition("first", "tag", "绘图"),
    definition("second", "tag", "绘\u200B图"),
    definition("third", "tag", " 绘图 "),
    // Same text in the other group is a different value, not a duplicate.
    definition("same-value-other-kind", "tag", "绘图"),
    definition("emoji-as-text", "emoji", "绘图"),
    definition("emoji-ok", "emoji", "🔥")
  ]);
  assert.deepEqual(normalized.map((item) => [item.id, item.kind, item.value]), [
    ["first", "tag", "绘图"],
    ["emoji-ok", "emoji", "🔥"]
  ]);
});

test("normalizing keeps only the first 64 entries of a group", () => {
  const entries: unknown[] = [];
  for (let index = 0; index < MAX_CUSTOM_MARKER_ENTRIES; index += 1) {
    entries.push(definition(`id-${index}`, "tag", `tag-${index}`));
  }
  entries.push(definition("extra", "tag", "tag-extra"));

  const normalized = normalizeCustomMarkerDefinitions(entries);
  assert.equal(normalized.length, MAX_CUSTOM_MARKER_ENTRIES);
  assert.equal(normalized[0]?.value, "tag-0");
  assert.equal(normalized.at(-1)?.value, `tag-${MAX_CUSTOM_MARKER_ENTRIES - 1}`);
  assert.equal(normalized.some((item) => item.id === "extra"), false);
});

test("a full group never consumes the other group's budget while loading", () => {
  // Malformed entries inside the bounded scan window are skipped without
  // stopping the scan, so an entry of the other kind is still read.
  const entries: unknown[] = [{ kind: "unknown", value: "x" }];
  entries.push(definition("late", "emoji", "🔥"));
  assert.deepEqual(normalizeCustomMarkerDefinitions(entries), [
    { id: "late", kind: "emoji", value: "🔥" }
  ]);

  // Four distinct emoji plus a full tag list is a valid registry: both groups
  // keep their own budget of MAX_CUSTOM_MARKER_ENTRIES.
  const full = [
    ...["🔥", "🎨", "⭐", "✅"].map((value, index) => definition(`emoji-${index}`, "emoji", value)),
    ...Array.from({ length: MAX_CUSTOM_MARKER_ENTRIES }, (_unused, index) =>
      definition(`tag-${index}`, "tag", `t${index}`))
  ];
  const normalized = normalizeCustomMarkerDefinitions(full);
  assert.equal(normalized.filter((entry) => entry.kind === "emoji").length, 4);
  assert.equal(normalized.filter((entry) => entry.kind === "tag").length, MAX_CUSTOM_MARKER_ENTRIES);

  // One entry past the tag group's ceiling is dropped, and Emoji still survives.
  const overflow = [...full, definition("tag-extra", "tag", "t-extra")];
  const trimmed = normalizeCustomMarkerDefinitions(overflow);
  assert.equal(trimmed.some((entry) => entry.id === "tag-extra"), false);
  assert.equal(trimmed.filter((entry) => entry.kind === "tag").length, MAX_CUSTOM_MARKER_ENTRIES);
  assert.equal(trimmed.filter((entry) => entry.kind === "emoji").length, 4);
});
