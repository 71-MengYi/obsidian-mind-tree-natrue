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

test("an absent MCP configuration stays off, read-only and on the default port", () => {
  const normalized = normalizePluginData({ settings: {} });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpAllowWrites, false);
  assert.equal(normalized.settings.mcpAllowTreeCreation, false);
  assert.equal(normalized.settings.mcpPort, DEFAULT_SETTINGS.mcpPort);
  assert.equal(DEFAULT_SETTINGS.mcpEnabled, false);
});

test("a damaged MCP configuration is repaired field by field", () => {
  const normalized = normalizePluginData({
    settings: {
      mcpEnabled: "yes",
      mcpAllowWrites: 1,
      mcpAllowTreeCreation: "true",
      mcpPort: "27321"
    }
  });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpAllowWrites, false);
  assert.equal(normalized.settings.mcpAllowTreeCreation, false);
  assert.equal(normalized.settings.mcpPort, DEFAULT_SETTINGS.mcpPort);
});

test("a configuration written before the capability split grants no tree creation", () => {
  // An upgrade must never hand out *more* access than the user asked for, so the
  // new switch defaults to off instead of inheriting the old write switch.
  const normalized = normalizePluginData({ settings: { mcpEnabled: true, mcpAllowWrites: true } });
  assert.equal(normalized.settings.mcpAllowWrites, true);
  assert.equal(normalized.settings.mcpAllowTreeCreation, false);
});

test("an out-of-range MCP port falls back instead of clamping into the privileged range", () => {
  // Silently binding to 1024 because someone typed 80 would be surprising, so a
  // non-port value is discarded rather than clamped.
  for (const port of [80, 0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizePluginData({ settings: { mcpPort: port } }).settings.mcpPort,
      DEFAULT_SETTINGS.mcpPort, `port ${String(port)}`);
  }
  assert.equal(normalizePluginData({ settings: { mcpPort: 30_000 } }).settings.mcpPort, 30_000);
  assert.equal(normalizePluginData({ settings: { mcpPort: 65_535 } }).settings.mcpPort, 65_535);
  assert.equal(normalizePluginData({ settings: { mcpPort: 1_024 } }).settings.mcpPort, 1_024);
});

test("the MCP switches survive a valid configuration and never leak elsewhere", () => {
  const normalized = normalizePluginData({
    settings: { mcpEnabled: true, mcpAllowWrites: true, mcpAllowTreeCreation: true, mcpPort: 29_000 }
  });
  assert.equal(normalized.settings.mcpEnabled, true);
  assert.equal(normalized.settings.mcpAllowWrites, true);
  assert.equal(normalized.settings.mcpAllowTreeCreation, true);
  assert.equal(normalized.settings.mcpPort, 29_000);
  // The access token is device-local and must never be part of plugin data.
  assert.equal(Object.hasOwn(normalized.settings, "mcpToken"), false);
  assert.equal(JSON.stringify(normalized).includes("Bearer"), false);
});
