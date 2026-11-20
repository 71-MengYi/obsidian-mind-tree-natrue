import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The invalid-resource mark depends on runtime index state and vault events, so
 * these tests read the small, stable seams instead of booting a view: the
 * verification gate, the derived set, the render state hand-off, and the delete
 * subscription that re-derives it.
 */

const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/services/resource-index.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../src/ui/renderers/node-renderer.ts", import.meta.url), "utf8");
const model = readFileSync(new URL("../src/ui/renderers/node-render-model.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("an unverified index never reports a missing file", () => {
  assert.match(index, /isVerified\(\): boolean \{ return this\.catalog\.isFullyVerified\(\); \}/);
  assert.match(view, /const isFileResolved: \(\(reference: FileResourceRef\) => boolean\) \| undefined = resources\.isVerified\(\)/);
  assert.match(view, /if \(isResourceInvalid\(node\.resource, isFileResolved\)\) ids\.add\(node\.id\);/);
});

test("the view derives the invalid set and hands it to the renderer", () => {
  assert.match(view, /private invalidResourceNodeIds: ReadonlySet<NodeId> = new Set<NodeId>\(\);/);
  assert.match(view, /private refreshInvalidResourceNodeIds\(\): boolean \{/);
  assert.match(view, /handleResourceAvailabilityChanged\(\): void \{/);
  // Reflow must refresh first, then pass the current set to the node renderer.
  const renderCall = view.indexOf("this.nodeRenderer?.render({");
  const refresh = view.lastIndexOf("this.refreshInvalidResourceNodeIds();", renderCall);
  assert.ok(refresh > 0 && refresh < renderCall, "the set is re-derived before rendering");
  assert.match(view, /invalidResourceNodeIds: this\.invalidResourceNodeIds/);
  // A re-indexed file may come back, so the metadata path refreshes it too.
  assert.match(view, /this\.refreshInvalidResourceNodeIds\(\);\s*this\.imageNodePresentation\?\.invalidate\(resourceId\);/);
});

test("a deleted file re-derives every open tree's warning marks", () => {
  const deleteHandler = main.slice(main.indexOf('this.app.vault.on("delete"'));
  assert.ok(deleteHandler.indexOf("this.resources.removePath(file.path)") > 0, "index updated first");
  assert.match(deleteHandler, /leaf\.view\.handleResourceAvailabilityChanged\(\);/);
});

test("invalid nodes swap the icon and keep the accessibility name honest", () => {
  assert.match(model, /resourceInvalid: resourceInvalid && controls\.hasOpenButton,/);
  assert.match(renderer, /state\.invalidResourceNodeIds\?\.has\(node\.id\) === true/);
  assert.match(renderer, /visual\.resourceInvalid \? " is-missing" : ""/);
  assert.match(renderer, /visual\.resourceInvalid \? t\("node\.resourceInvalid"\) : t\("node\.openLinkedResource"\)/);
});

test("the warning mark is red and keeps the muted open control otherwise", () => {
  const rule = css.match(/\.mtn-node-controls > \.mtn-resource-open\.is-missing,\s+\.mtn-node-controls > \.mtn-resource-open\.is-missing:hover,[\s\S]*?\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /color:\s*var\(--text-error\);/);
  // The healthy control keeps the shared muted treatment.
  const muted = css.match(/\.mtn-node-controls > \.mtn-resource-open:active\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(muted, /color:\s*var\(--text-muted\);/);
});
