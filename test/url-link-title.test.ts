import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The dialog sits on the Obsidian modal layer, so this suite pins the wiring
// instead of a DOM: the view must hand the node's own text to the modal, and the
// modal must seed both the submitted value and the rendered field from it.
const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/ui/modals/text-prompt-modal.ts", import.meta.url), "utf8");

function viewMethod(name: string): string {
  return view.split(new RegExp(`  private ${name}\\(`))[1]!.split(/\n  private /)[0]!;
}

test("linking a web page passes the node text to the title field", () => {
  const linkUrl = viewMethod("linkUrl");
  assert.match(linkUrl, /const nodeTitle = this\.document\?\.nodes\[nodeId\]\?\.title \?\? "";/);
  // The default title is the third argument, so the modal keeps the node name.
  assert.match(linkUrl, /\}, nodeTitle\)\.open\(\);/);
});

test("the URL dialog seeds its title field and still falls back to the host name", () => {
  assert.match(modal, /initialTitle = ""/);
  assert.match(modal, /this\.title = initialTitle\.trim\(\);/);
  assert.match(modal, /input\.setValue\(this\.title\)\.onChange\(/);
  assert.match(modal, /this\.title \|\| parsed\.hostname/);
});
