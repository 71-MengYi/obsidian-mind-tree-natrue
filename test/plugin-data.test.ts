import test from "node:test";
import assert from "node:assert/strict";
import { normalizePluginData } from "../src/plugin-data";
import { DEFAULT_MCP_READ_PORT, DEFAULT_MCP_WRITE_PORT, DEFAULT_SETTINGS } from "../src/settings-model";

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

test("an absent MCP configuration stays off, read-only and on the two default ports", () => {
  const normalized = normalizePluginData({ settings: {} });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpWriteEnabled, false);
  assert.equal(normalized.settings.mcpReadPort, DEFAULT_SETTINGS.mcpReadPort);
  assert.equal(normalized.settings.mcpWritePort, DEFAULT_SETTINGS.mcpWritePort);
  assert.equal(DEFAULT_SETTINGS.mcpEnabled, false);
  assert.equal(DEFAULT_SETTINGS.mcpWriteEnabled, false);
  assert.equal(DEFAULT_SETTINGS.mcpReadPort, DEFAULT_MCP_READ_PORT);
  assert.equal(DEFAULT_SETTINGS.mcpWritePort, DEFAULT_MCP_WRITE_PORT);
  assert.notEqual(DEFAULT_MCP_READ_PORT, DEFAULT_MCP_WRITE_PORT);
});

test("a damaged MCP configuration is repaired field by field", () => {
  const normalized = normalizePluginData({
    settings: {
      mcpEnabled: "yes",
      mcpWriteEnabled: 1,
      mcpReadPort: "27321",
      mcpWritePort: "not-a-port"
    }
  });
  assert.equal(normalized.settings.mcpEnabled, false);
  assert.equal(normalized.settings.mcpWriteEnabled, false);
  assert.equal(normalized.settings.mcpReadPort, DEFAULT_SETTINGS.mcpReadPort);
  assert.equal(normalized.settings.mcpWritePort, DEFAULT_SETTINGS.mcpWritePort);
});

test("a configuration written before the two-server split keeps its port for reads only", () => {
  // An upgrade must never widen what is exposed: the old single server becomes
  // the read-only one (so an existing client configuration keeps working), and a
  // previously granted write permission is deliberately NOT carried over.
  const normalized = normalizePluginData({
    settings: { mcpEnabled: true, mcpPort: 30_000, mcpAllowWrites: true, mcpAllowTreeCreation: true }
  });
  assert.equal(normalized.settings.mcpEnabled, true);
  assert.equal(normalized.settings.mcpReadPort, 30_000);
  assert.equal(normalized.settings.mcpWriteEnabled, false);
  assert.equal(normalized.settings.mcpWritePort, DEFAULT_SETTINGS.mcpWritePort);
});

test("an out-of-range MCP port falls back instead of clamping into the privileged range", () => {
  // Silently binding to 1024 because someone typed 80 would be surprising, so a
  // non-port value is discarded rather than clamped. Both servers are checked,
  // because a write server on a privileged port would be a privilege escalation.
  for (const port of [80, 0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const settings = normalizePluginData({ settings: { mcpReadPort: port, mcpWritePort: port } }).settings;
    assert.equal(settings.mcpReadPort, DEFAULT_SETTINGS.mcpReadPort, `read port ${String(port)}`);
    assert.equal(settings.mcpWritePort, DEFAULT_SETTINGS.mcpWritePort, `write port ${String(port)}`);
  }
  for (const port of [30_000, 65_535, 1_024]) {
    const settings = normalizePluginData({ settings: { mcpReadPort: port, mcpWritePort: port } }).settings;
    assert.equal(settings.mcpReadPort, port, `read port ${String(port)}`);
    assert.equal(settings.mcpWritePort, port, `write port ${String(port)}`);
  }
  // The legacy single port is subject to the same rule when it is migrated.
  assert.equal(
    normalizePluginData({ settings: { mcpPort: 80 } }).settings.mcpReadPort,
    DEFAULT_SETTINGS.mcpReadPort
  );
});

test("the MCP switches survive a valid configuration and never leak elsewhere", () => {
  const normalized = normalizePluginData({
    settings: { mcpEnabled: true, mcpWriteEnabled: true, mcpReadPort: 29_000, mcpWritePort: 29_010 }
  });
  assert.equal(normalized.settings.mcpEnabled, true);
  assert.equal(normalized.settings.mcpWriteEnabled, true);
  assert.equal(normalized.settings.mcpReadPort, 29_000);
  assert.equal(normalized.settings.mcpWritePort, 29_010);
  // Per-tool switches are gone: the read/write split of the catalogs is the
  // boundary, so plugin data must not grow a permission key again.
  assert.equal(Object.hasOwn(normalized.settings, "mcpAllowWrites"), false);
  assert.equal(Object.hasOwn(normalized.settings, "mcpAllowTreeCreation"), false);
  // The legacy single port is migrated into mcpReadPort, not carried alongside it.
  assert.equal(Object.hasOwn(normalized.settings, "mcpPort"), false);
  // The access token is device-local and must never be part of plugin data.
  assert.equal(Object.hasOwn(normalized.settings, "mcpToken"), false);
  assert.equal(JSON.stringify(normalized).includes("Bearer"), false);
});
