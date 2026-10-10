import test from "node:test";
import assert from "node:assert/strict";
import { normalizePluginData } from "../src/plugin-data";
import { DEFAULT_SETTINGS } from "../src/settings-model";

test("damaged settings fall back field-by-field without blocking plugin load", () => {
  const normalized = normalizePluginData({
    settings: {
      autosaveDelayMs: Number.NaN,
      theme: "removed-theme",
      titleSync: "yes",
      templateFolder: "../outside",
      ignoredPathPrefixes: ["valid/folder", "../outside", 42]
    }
  });
  assert.equal(normalized.settings.autosaveDelayMs, DEFAULT_SETTINGS.autosaveDelayMs);
  assert.equal(normalized.settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(normalized.settings.titleSync, DEFAULT_SETTINGS.titleSync);
  assert.equal(normalized.settings.templateFolder, DEFAULT_SETTINGS.templateFolder);
  assert.deepEqual(normalized.settings.ignoredPathPrefixes, ["valid/folder"]);
  assert.deepEqual(normalized.settings.ignoredFileBadgeExtensions, []);
  assert.deepEqual(Object.keys(normalized.settings.fileExtensionBadgeAliases), []);
});

test("file badge settings normalize case, deduplicate entries, and discard unsafe values", () => {
  const normalized = normalizePluginData({
    settings: {
      ignoredFileBadgeExtensions: [".PDF", "pdf", "tar.gz", "bad/value", 42],
      fileExtensionBadgeAliases: JSON.parse(`{
        ".PDF":" Portable ",
        "tar.gz":"Archive",
        "bad/value":"Bad",
        "__proto__":"Unsafe",
        "png":" ",
        "zip":"${"x".repeat(33)}"
      }`) as unknown
    }
  });
  assert.deepEqual(normalized.settings.ignoredFileBadgeExtensions, ["pdf", "tar.gz"]);
  assert.deepEqual({ ...normalized.settings.fileExtensionBadgeAliases }, {
    pdf: "Portable",
    "tar.gz": "Archive"
  });
  assert.equal(Object.getPrototypeOf(normalized.settings.fileExtensionBadgeAliases), null);
});

test("legacy synced indexes are ignored instead of becoming trusted ownership history", () => {
  const normalized = normalizePluginData({
    settings: {},
    resourceIndex: {
      good: { resourceId: "good", path: "notes/good.md", fileKind: "note" },
      bad: { resourceId: "different", path: "../escape.md", fileKind: "note" }
    }
  });
  assert.deepEqual(Object.keys(normalized), ["settings"]);
  assert.equal(Object.hasOwn(normalized, "resourceIndex"), false);
});

test("normalized custom markers are an independent array that cannot mutate plugin defaults", () => {
  const first = normalizePluginData({
    settings: { customMarkers: [{ id: "mtn-emoji-a", kind: "emoji", value: "🔥" }] }
  });
  first.settings.customMarkers.push({ id: "mtn-tag-b", kind: "tag", value: "绘图" });
  assert.deepEqual(first.settings.customMarkers.map((item) => item.id), ["mtn-emoji-a", "mtn-tag-b"]);

  const second = normalizePluginData({ settings: {} });
  assert.deepEqual(second.settings.customMarkers, []);
  assert.deepEqual(DEFAULT_SETTINGS.customMarkers, []);
});
