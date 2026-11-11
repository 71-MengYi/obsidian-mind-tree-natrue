import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "../src/i18n/catalog";
import { DEFAULT_SETTINGS } from "../src/settings-model";

/**
 * Repository files are read through `process.cwd()` so this static check also
 * runs from the compiled fallback build (`.mtn-test-build`), where
 * `import.meta.url` no longer points at the sources.
 */
const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

test("the minimap switch is part of the persisted settings model and defaults to on", () => {
  const model = readSource("src/settings-model.ts");
  assert.match(model, /minimapEnabled: boolean;/);
  assert.match(model, /minimapEnabled: true,/);
  assert.equal(DEFAULT_SETTINGS.minimapEnabled, true);
});

test("the basic settings page renders the minimap toggle and refreshes open views after saving", () => {
  const page = readSource("src/ui/settings-pages/basic-settings-page.ts");
  const start = page.indexOf('t("settings.minimap.name")');
  const end = page.indexOf('t("settings.fileBadges.heading")');
  assert.ok(start > 0, "the minimap setting is named through i18n");
  assert.ok(end > start, "the minimap row sits under the basic settings heading");
  const block = page.slice(start, end);

  assert.match(block, /\.setDesc\(t\("settings\.minimap\.desc"\)\)/);
  assert.match(block, /\.addToggle\(/);
  // The row shows the current value and edits the shared model, persists it,
  // and only then tells open views to show or hide the minimap.
  assert.match(block, /\.setValue\(port\.settings\.minimapEnabled\)/);
  assert.match(block, /port\.settings\.minimapEnabled = value/);
  const assign = block.indexOf("port.settings.minimapEnabled = value");
  const save = block.indexOf("await port.save()");
  const refresh = block.indexOf("port.refreshOpenLayouts()");
  assert.ok(assign >= 0 && save > assign && refresh > save);
});

test("the minimap setting labels exist in both languages", () => {
  for (const language of ["en", "zh"] as const) {
    const nameKey = translate("settings.minimap.name", language);
    const descKey = translate("settings.minimap.desc", language);
    assert.notEqual(nameKey, "settings.minimap.name");
    assert.notEqual(descKey, "settings.minimap.desc");
    assert.ok(descKey.length > nameKey.length);
  }
});
