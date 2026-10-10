import test from "node:test";
import assert from "node:assert/strict";
import { normalizePluginData } from "../src/plugin-data";
import { DEFAULT_SETTINGS } from "../src/settings-model";
import { isSafeCustomMarkerId, MAX_CUSTOM_MARKER_ENTRIES } from "../src/domain/custom-markers";

test("missing or malformed custom marker registries load as an empty list", () => {
  const cases: readonly unknown[] = [
    {},
    { settings: {} },
    { settings: { customMarkers: null } },
    { settings: { customMarkers: "绘图" } },
    { settings: { customMarkers: 42 } },
    { settings: { customMarkers: {} } }
  ];
  for (const value of cases) {
    const normalized = normalizePluginData(value);
    assert.deepEqual(normalized.settings.customMarkers, [], JSON.stringify(value));
    assert.equal(normalized.settings.theme, DEFAULT_SETTINGS.theme);
  }
  assert.deepEqual(DEFAULT_SETTINGS.customMarkers, []);
});

test("valid custom markers survive plugin data normalization with their saved order and ids", () => {
  const saved = [
    { id: "mtn-emoji-a", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-b", kind: "tag", value: " 绘图 " },
    { id: "mtn-emoji-c", kind: "emoji", value: "🎨" }
  ];
  const normalized = normalizePluginData({ settings: { customMarkers: saved } });
  assert.deepEqual(normalized.settings.customMarkers, [
    { id: "mtn-emoji-a", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-b", kind: "tag", value: "绘图" },
    { id: "mtn-emoji-c", kind: "emoji", value: "🎨" }
  ]);
  assert.notEqual(normalized.settings.customMarkers, saved);
  assert.deepEqual(saved[1], { id: "mtn-tag-b", kind: "tag", value: " 绘图 " });
});

test("malformed custom marker entries are dropped without blocking plugin load", () => {
  const normalized = normalizePluginData({
    settings: {
      theme: "removed-theme",
      customMarkers: [
        { id: "keep", kind: "emoji", value: "🔥" },
        { id: "bad-kind", kind: "progress", value: "绘图" },
        { id: "bad-value", kind: "tag", value: 7 },
        { id: "blank", kind: "tag", value: "  " },
        { id: "too-long", kind: "emoji", value: "🔥".repeat(17) },
        { id: "../escape", kind: "tag", value: "绘图" },
        null,
        "绘图"
      ]
    }
  });
  assert.deepEqual(normalized.settings.customMarkers.map((item) => [item.kind, item.value]), [
    ["emoji", "🔥"],
    ["tag", "绘图"]
  ]);
  assert.equal(normalized.settings.customMarkers[0]?.id, "keep");
  const rebuilt = normalized.settings.customMarkers[1]?.id ?? "";
  assert.match(rebuilt, /^mtn-tag-/);
  assert.equal(isSafeCustomMarkerId(rebuilt), true);
  // One bad field never aborts normalization of the rest of data.json.
  assert.equal(normalized.settings.theme, DEFAULT_SETTINGS.theme);
});

test("duplicate custom marker values normalize to one entry in first-seen order", () => {
  const normalized = normalizePluginData({
    settings: {
      customMarkers: [
        { id: "first", kind: "tag", value: "绘图" },
        { id: "second", kind: "tag", value: "绘\u200B图" },
        // Same text as the tag, but the Emoji group only accepts one glyph, so
        // this entry is dropped instead of being stored as an Emoji label.
        { id: "text-as-emoji", kind: "emoji", value: "绘图" },
        { id: "other-kind", kind: "emoji", value: "🔥" }
      ]
    }
  });
  assert.deepEqual(normalized.settings.customMarkers.map((item) => [item.id, item.kind, item.value]), [
    ["first", "tag", "绘图"],
    ["other-kind", "emoji", "🔥"]
  ]);
});

test("the custom marker cap and unrelated damaged fields cannot block plugin load", () => {
  const entries: unknown[] = [];
  for (let index = 0; index < MAX_CUSTOM_MARKER_ENTRIES + 5; index += 1) {
    entries.push({ kind: "tag", value: `tag-${index}` });
  }
  const normalized = normalizePluginData({
    settings: {
      customMarkers: entries,
      autosaveDelayMs: Number.NaN,
      ignoredPathPrefixes: ["ok", "../bad", 5]
    }
  });
  assert.equal(normalized.settings.customMarkers.length, MAX_CUSTOM_MARKER_ENTRIES);
  assert.equal(normalized.settings.customMarkers[0]?.value, "tag-0");
  assert.equal(normalized.settings.customMarkers.at(-1)?.value, `tag-${MAX_CUSTOM_MARKER_ENTRIES - 1}`);
  for (const item of normalized.settings.customMarkers) assert.equal(isSafeCustomMarkerId(item.id), true);
  assert.equal(normalized.settings.autosaveDelayMs, DEFAULT_SETTINGS.autosaveDelayMs);
  assert.deepEqual(normalized.settings.ignoredPathPrefixes, ["ok"]);
});
