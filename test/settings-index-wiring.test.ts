import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate, EN, type TranslationKey } from "../src/i18n/catalog";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("plugin wiring keeps data.json settings-only and never saves settings from index or unload events", () => {
  const main = source("main.ts");
  assert.match(main, /write: \(settings\) => this\.saveData\(\{ settings \}/);
  assert.doesNotMatch(main, /resourceIndexData|savePluginData|schedulePluginData/);
  const shutdown = main.slice(main.indexOf("  onunload():"), main.indexOf("  async loadSettings"));
  assert.doesNotMatch(shutdown, /saveData|saveSettings/);
  assert.match(shutdown, /prepareForPluginUnload/);
  assert.match(shutdown, /resources\?\.destroy/);
  assert.match(main, /onExternalSettingsChange[\s\S]*?settingsPersistence\?\.reload/);
  assert.match(main, /adapter\.process\(path, removeLegacyResourceIndex\)/);
});

test("rebuild UI shows progress and paths through a port without document mutation access", () => {
  const page = source("ui/settings-pages/basic-settings-page.ts");
  assert.match(page, /renderResourceIndex/);
  assert.match(page, /button\.setDisabled\(true\)/);
  assert.match(page, /button\.setDisabled\(false\)/);
  assert.match(page, /await port\.rebuildResourceIndex/);
  assert.match(page, /report\.conflicts/);
  assert.match(page, /report\.failures/);
  const method = page.slice(page.indexOf("  private renderResourceIndex"), page.indexOf("  private renderIgnoredExtensions"));
  assert.doesNotMatch(method, /port\.save|port\.settings\s*=|vault\.|applySystemMutation/);
});

test("external settings and manual rebuild do not recreate a live title editor", () => {
  const view = source("ui/mind-tree-view.ts");
  const method = view.slice(view.indexOf("  refreshLayoutFromSettings()"), view.indexOf("  addChildNode()"));
  assert.match(method, /if \(this\.editingNodeId\) return/);
  assert.match(method, /captureLayoutViewportAnchor/);
  assert.doesNotMatch(method, /commit\(|applySystemMutation|selectedIds\.clear|scheduleSave/);
  const load = view.slice(view.indexOf("  async onLoadFile("), view.indexOf("  async onUnloadFile("));
  assert.ok(load.indexOf("resources.verifyIndex()") < load.indexOf("super.onLoadFile(file)"));
});

test("all index and settings safety messages have English and Chinese strings", () => {
  const keys = Object.keys(EN).filter((key) => key.startsWith("resourceIndex.") || key.startsWith("settings.sync.")) as TranslationKey[];
  assert.ok(keys.length > 10);
  for (const key of keys) {
    assert.notEqual(translate(key, "en"), key);
    assert.notEqual(translate(key, "zh"), translate(key, "en"));
  }
});
