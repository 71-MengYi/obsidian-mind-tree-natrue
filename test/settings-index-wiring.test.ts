import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate, EN, type TranslationKey } from "../src/i18n/catalog";
import { isMcpSupported } from "../src/services/mcp/availability";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const rootFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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

test("the settings page barrel re-exports the AI page", () => {
  const barrel = source("ui/settings-pages/index.ts");
  assert.match(barrel, /export \* from "\.\/ai-settings-page";/);
  const page = source("ui/settings-pages/ai-settings-page.ts");
  assert.match(page, /export class AiSettingsPage implements SettingsPageObject/);
  assert.match(page, /constructor\(parent: HTMLElement, private readonly port: SettingsPagePort\)/);
});

test("the AI tab is declared desktop-only and the tab strip drops it on mobile", () => {
  const settingsSource = source("settings.ts");
  // `src/settings.ts` cannot be imported here (it pulls in Obsidian and the
  // plugin class), so the declared table is read from source and the real
  // platform predicate is applied to it.
  const entries = [...settingsSource.matchAll(/\{ id: "([^"]+)", label: "([^"]+)", availability: "(all|desktop)"/g)]
    .map((match) => ({
      id: match[1]!,
      label: match[2]!,
      availability: match[3]! as "all" | "desktop"
    }));
  assert.deepEqual(entries.map((entry) => entry.id),
    ["basic", "mind-map", "topic-notes", "custom-markers", "ai"]);
  const ai = entries.find((entry) => entry.id === "ai");
  assert.ok(ai, "the AI tab must be declared");
  assert.equal(ai.label, "settings.tabs.ai");
  assert.equal(ai.availability, "desktop");
  assert.ok(entries.filter((entry) => entry.id !== "ai").every((entry) => entry.availability === "all"));
  // The AI row is the one that builds the page class this task ships.
  assert.match(settingsSource, /id: "ai"[\s\S]*?new AiSettingsPage\(panel, port\)/);

  // The predicate the panel uses, applied to the declared table: desktop offers
  // all five tabs, mobile drops the AI tab entirely.
  const available = (isDesktop: boolean): string[] =>
    entries.filter((entry) => entry.availability === "all" || isMcpSupported({ isDesktop }))
      .map((entry) => entry.id);
  assert.deepEqual(available(true), entries.map((entry) => entry.id));
  assert.deepEqual(available(false), ["basic", "mind-map", "topic-notes", "custom-markers"]);

  // The tab strip is built from the filtered list, and a stored active page this
  // platform cannot host falls back to the first available one, so the AI page
  // can never become the active page on mobile.
  assert.match(settingsSource, /const facts = \{ isDesktop: !Platform\.isMobile \}/);
  assert.match(settingsSource, /return entry\.availability === "all" \|\| isMcpSupported\(facts\)/);
  assert.match(settingsSource, /SETTINGS_PAGES\.filter\(\(entry\) => isSettingsPageAvailable\(entry, facts\)\)/);
  assert.match(settingsSource, /pages\.find\(\(entry\) => entry\.id === this\.activePage\) \?\? pages\[0\]/);
  assert.match(settingsSource, /this\.renderPageTabs\(containerEl, pages\)/);
});

test("the AI page keeps Obsidian at one import and opens no blocking dialog", () => {
  const page = source("ui/settings-pages/ai-settings-page.ts");
  assert.match(page, /import \{ Setting \} from "obsidian";/);
  // One Obsidian import only: the page must not reach for views, notices or
  // platform helpers it has no business knowing about.
  assert.equal(page.match(/from "obsidian"/g)?.length, 1);
  assert.doesNotMatch(page, /\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
  assert.doesNotMatch(page, /\bwindow\./);
});

test("the AI page delegates every decision to the pure settings-page model", () => {
  const page = source("ui/settings-pages/ai-settings-page.ts");
  assert.match(page, /buildMcpPageModel\(this\.port\.mcp\.state\(\)\)/);
  assert.match(page, /parseMcpPortInput\(raw\)/);
  assert.match(page, /describeMcpStatus\(/);
  // The page renders what the model decided: it never assembles the client JSON,
  // re-parses a port or compares port bounds itself.
  assert.doesNotMatch(page, /JSON\.stringify/);
  assert.doesNotMatch(page, /mcpServers/);
  assert.doesNotMatch(page, /\^\\d/);
  assert.doesNotMatch(page, /port\s*[<>]=?\s*(?:MIN|MAX)_MCP_PORT|(?:MIN|MAX)_MCP_PORT\s*[<>]=?\s*port/);
});

test("the AI page mutates the server only through named port transitions", () => {
  const page = source("ui/settings-pages/ai-settings-page.ts");
  assert.match(page, /this\.port\.mcp\.setEnabled\(value\)/);
  assert.match(page, /this\.port\.mcp\.setAllowWrites\(value\)/);
  assert.match(page, /this\.port\.mcp\.applyPortInput\(raw\)/);
  assert.match(page, /this\.port\.mcp\.copyText\(text\)/);
  // MCP preferences live in the device-local record, so this page must not
  // claim a `data.json` write or touch the shared settings object.
  assert.doesNotMatch(page, /port\.save\(/);
  assert.doesNotMatch(page, /port\.settings\s*=/);
  assert.doesNotMatch(page, /refreshOpenLayouts/);
  // `Setting` listeners live inside the settings panel, which is dropped whole;
  // the only thing `destroy` owns is the copy-confirmation timer.
  assert.match(page, /destroy\(\): void \{[\s\S]*?clearTimeout/);
});

test("the AI stylesheet block stays namespaced and adds no colour styling", () => {
  const css = rootFile("styles.css");
  const start = css.indexOf("/* ── AI settings");
  const end = css.indexOf("/* ── Manage markers");
  assert.ok(start > 0, "the AI settings style section exists");
  assert.ok(end > start, "the AI settings style section has an end");
  const block = css.slice(start, end);

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("}")) continue;
    // Every selector in this section is namespaced, so the rules cannot leak.
    if (/^[.#[]/.test(trimmed)) assert.match(trimmed, /^\.mtn-settings-ai-/);
  }
  // The repo forbids colour and gradient styling in general, and this section
  // is reviewed on that rule. `[a-z-]*color` also covers `border-color`,
  // `outline-color` and friends; `fill`/`stroke` are paint as well.
  assert.doesNotMatch(block, /(?:^|[;{\s])(?:background|background-color|color|[a-z-]*color|fill|stroke)\s*:/m);
  assert.doesNotMatch(block, /gradient|will-change/i);
});
