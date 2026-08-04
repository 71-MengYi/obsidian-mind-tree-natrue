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
});

test("one malformed ownership entry discards the persisted index for a safe rebuild", () => {
  const normalized = normalizePluginData({
    settings: {},
    resourceIndex: {
      good: { resourceId: "good", path: "notes/good.md", fileKind: "note" },
      bad: { resourceId: "different", path: "../escape.md", fileKind: "note" }
    }
  });
  assert.deepEqual(Object.keys(normalized.resourceIndex), []);
  assert.equal(Object.getPrototypeOf(normalized.resourceIndex), null);
});
