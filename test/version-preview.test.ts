import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import { previewDocument, changedVersionSettings } from "../src/ui/components/version-preview-model";
import { layoutTree } from "../src/ui/layout";

test("temporary folds are independent per pane and cannot change serialized data or selected versions", () => {
  const document = createEmptyDocument("Root");
  const child = addNode(document, document.rootId, "Child");
  addNode(document, child.id, "Grandchild");
  const source = serializeMindTreeFile(document);
  const left = previewDocument(document, new Map([[child.id, true]]));
  const right = previewDocument(document, new Map([[document.rootId, true]]));
  assert.equal(left.nodes[child.id]?.collapsed, true);
  assert.equal(right.nodes[child.id]?.collapsed, undefined);
  assert.equal(left.nodes[left.rootId]?.collapsed, undefined);
  for (const mode of ["balanced", "right", "left", "tree", "radial"] as const) {
    assert.equal(layoutTree(left, left.rootId, true, 240, mode).nodes.length, 2);
    assert.equal(layoutTree(right, right.rootId, true, 240, mode).nodes.length, 1);
  }
  assert.equal(serializeMindTreeFile(document), source);
});

test("settings comparison includes scan/collection differences even if both trees look identical", () => {
  const document = createEmptyDocument("Root");
  const left = { ...document.settings, recursiveScan: false };
  const right = { ...left, recursiveScan: true, collectionMode: "off" as const };
  assert.deepEqual(new Set(changedVersionSettings(left, right)), new Set(["recursiveScan", "collectionMode"]));
  assert.deepEqual(changedVersionSettings(left, left), []);
});

test("comparison UI has two explicit choices, no autofocus/default Enter, and reuses readonly renderers", () => {
  const ui = readFileSync(new URL("../src/ui/components/version-comparison.ts", import.meta.url), "utf8");
  const preview = readFileSync(new URL("../src/ui/components/read-only-tree-preview.ts", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.equal((ui.match(/cls: "mtn-version-keep"/g) ?? []).length, 2);
  assert.doesNotMatch(ui, /\.focus\(|autofocus|keydown/);
  assert.match(ui, /this\.currentButton\.disabled = this\.externalButton\.disabled = !state\.ready/);
  assert.match(preview, /readOnly: true/);
  assert.match(preview, /this\.connections\.render/);
  assert.match(preview, /BrowserImageNodePresentation/);
  assert.match(preview, /if \(!this\.fitted && width > 0 && height > 0\)/);
  assert.match(preview, /visibilitychange/);
  assert.match(preview, /this\.own\(releasePointers\)/);
  assert.match(view, /session\.conflict\.captureDisplayedVersion\(\)/);
  assert.match(view, /session\.history\.runExclusiveWrite\(\(\) => session\.conflict!\.choose\(side, displayed\)\)/);
  assert.match(view, /this\.rootEl\.inert = true/);
  assert.match(css, /\.mtn-version-pane\.is-current > \.mtn-version-keep\s*\{\s*right:/);
  assert.match(css, /\.mtn-version-pane\.is-external > \.mtn-version-keep\s*\{\s*left:/);
  for (const file of ["../src/main.ts", "../src/ui/mind-tree-view.ts", "../src/ui/modals/index.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /RecoveryReminder|createRecovery|SaveConflictModal|_Mind Tree Recovery/);
  }
});
