import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * `MindTreeView` has no DOM harness, so its search wiring is pinned against the
 * source the same way `test/association-target.test.ts` pins the association
 * entry points.
 *
 * Regression being guarded: the panel is created and mounted exactly once, from
 * `buildShell()`. Code that destroys the controller on file load (instead of
 * only dropping its caches) leaves `Mod+F` and the toolbar button permanently
 * inert, because nothing recreates it for the rest of the view's life.
 */

const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");

function methodBody(name: string, nextName: string): string {
  return view.split(`  async ${name}(`)[1]?.split(`  async ${nextName}(`)[0] ?? "";
}

test("switching mind trees resets the search caches instead of removing the panel", () => {
  const onLoadFile = methodBody("onLoadFile", "onUnloadFile");
  assert.ok(onLoadFile.length > 0, "onLoadFile must exist as a top-level async method");
  assert.match(onLoadFile, /this\.searchController\?\.reset\(\)/);
  assert.doesNotMatch(onLoadFile, /searchController[^\n]*\.destroy\(\)/);
  assert.doesNotMatch(onLoadFile, /this\.searchController = undefined/);
});

test("the search controller is built and mounted exactly once, and only rebuilt with the shell", () => {
  assert.equal((view.match(/createSearchController<TFile>\(/g) ?? []).length, 1);
  assert.match(view, /this\.searchController = createSearchController<TFile>\(/);
  assert.match(view, /this\.searchController\.mount\(\);/);
  // Only onClose and the shell rebuild may tear it down, and both clear the field.
  assert.equal((view.match(/this\.searchController\?\.destroy\(\)/g) ?? []).length, 2);
  assert.equal((view.match(/this\.searchController = undefined/g) ?? []).length, 2);
});

test("both search entry points go through the same controller", () => {
  assert.match(view, /this\.scope\.register\(\["Mod"\], "f"/);
  assert.match(view, /this\.searchController\?\.open\(\)/);
});
