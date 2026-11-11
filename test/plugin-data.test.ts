import test from "node:test";
import assert from "node:assert/strict";
import { normalizePluginData } from "../src/plugin-data";
import { DEFAULT_MCP_PORT, DEFAULT_SETTINGS } from "../src/settings-model";

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

// ─── Minimap: a global display preference only ──────────────────────────────

test("an absent minimap preference defaults to on", () => {
  assert.equal(DEFAULT_SETTINGS.minimapEnabled, true);
  assert.equal(normalizePluginData({ settings: {} }).settings.minimapEnabled, true);
});

test("the minimap preference preserves explicit booleans", () => {
  assert.equal(normalizePluginData({ settings: { minimapEnabled: false } }).settings.minimapEnabled, false);
  assert.equal(normalizePluginData({ settings: { minimapEnabled: true } }).settings.minimapEnabled, true);
});

test("a damaged minimap preference is repaired to the default", () => {
  for (const value of ["false", "yes", 1, 0, null, {}, []]) {
    assert.equal(
      normalizePluginData({ settings: { minimapEnabled: value } }).settings.minimapEnabled,
      DEFAULT_SETTINGS.minimapEnabled,
      String(value)
    );
  }
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

// ─── MCP: one merged server (mcpEnabled + mcpPort) ──────────────────────────

test("an absent MCP configuration stays off on the single default port", () => {
  const normalized = normalizePluginData({ settings: {} });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpPort, DEFAULT_SETTINGS.mcpPort);
  assert.equal(DEFAULT_SETTINGS.mcpPort, DEFAULT_MCP_PORT);
  assert.equal(DEFAULT_MCP_PORT, 27321);
  // The read/write split is gone from the persistent model itself.
  for (const key of ["mcpReadPort", "mcpWritePort", "mcpWriteEnabled"]) {
    assert.equal(Object.hasOwn(normalized.settings, key), false, key);
    assert.equal(Object.hasOwn(DEFAULT_SETTINGS, key), false, key);
  }
});

test("a damaged MCP configuration is repaired field by field", () => {
  const normalized = normalizePluginData({
    settings: { mcpEnabled: "yes", mcpPort: "27321", mcpWriteEnabled: 1 }
  });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpPort, DEFAULT_SETTINGS.mcpPort);
  // The retired write switch is not part of the merged settings object.
  assert.equal(Object.hasOwn(normalized.settings, "mcpWriteEnabled"), false);
});

test("mcpPort wins over both legacy two-server ports", () => {
  const settings = normalizePluginData({
    settings: { mcpPort: 30_000, mcpReadPort: 30_001, mcpWritePort: 30_002 }
  }).settings;
  assert.equal(settings.mcpPort, 30_000);
});

test("the legacy read port is carried over for installed client configurations", () => {
  // In the two-server era only the read server was guaranteed to be listening,
  // so its configuration is the one users actually have today.
  assert.equal(normalizePluginData({ settings: { mcpReadPort: 29_000 } }).settings.mcpPort, 29_000);
  assert.equal(
    normalizePluginData({ settings: { mcpReadPort: 29_000, mcpWritePort: 29_010 } }).settings.mcpPort,
    29_000
  );
});

test("the old write port is only a fallback when neither newer key carries a usable port", () => {
  assert.equal(normalizePluginData({ settings: { mcpWritePort: 29_010 } }).settings.mcpPort, 29_010);
  // An invalid mcpPort/mcpReadPort does not clamp into the bindable range; the
  // next legacy key is considered instead.
  assert.equal(
    normalizePluginData({ settings: { mcpPort: 80, mcpReadPort: 80, mcpWritePort: 29_010 } }).settings.mcpPort,
    29_010
  );
  assert.equal(
    normalizePluginData({ settings: { mcpWritePort: 29_010, mcpReadPort: 29_000 } }).settings.mcpPort,
    29_000
  );
});

test("an out-of-range or non-numeric MCP port falls back instead of clamping", () => {
  // Silently binding to 1024 because someone typed 80 would be surprising, so a
  // non-port value is discarded rather than clamped.
  for (const port of [80, 0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "27321", null]) {
    const settings = normalizePluginData({ settings: { mcpPort: port } }).settings;
    assert.equal(settings.mcpPort, DEFAULT_SETTINGS.mcpPort, `port ${String(port)}`);
  }
  for (const port of [30_000, 65_535, 1_024]) {
    assert.equal(normalizePluginData({ settings: { mcpPort: port } }).settings.mcpPort, port);
  }
});

test("the merged switch and port survive a valid configuration and nothing legacy leaks", () => {
  const normalized = normalizePluginData({
    settings: {
      mcpEnabled: true,
      mcpPort: 29_000,
      mcpWriteEnabled: true,
      mcpReadPort: 29_005,
      mcpWritePort: 29_010,
      mcpAllowWrites: true,
      mcpAllowTreeCreation: true,
      mcpToken: "Bearer leaked"
    }
  });
  assert.equal(normalized.settings.mcpEnabled, true);
  assert.equal(normalized.settings.mcpPort, 29_000);
  // The normalized object is exactly the merged model: no retired key survives,
  // and the device-local token is never part of plugin data.
  assert.deepEqual(Object.keys(normalized.settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  for (const key of [
    "mcpReadPort",
    "mcpWritePort",
    "mcpWriteEnabled",
    "mcpAllowWrites",
    "mcpAllowTreeCreation",
    "mcpToken"
  ]) {
    assert.equal(Object.hasOwn(normalized.settings, key), false, key);
  }
  assert.equal(JSON.stringify(normalized).includes("Bearer"), false);
});

test("the merged switch survives independently of a damaged port", () => {
  const normalized = normalizePluginData({ settings: { mcpEnabled: true, mcpPort: 80 } });
  assert.equal(normalized.settings.mcpEnabled, true);
  assert.equal(normalized.settings.mcpPort, DEFAULT_SETTINGS.mcpPort);
});
