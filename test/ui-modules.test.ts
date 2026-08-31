import test from "node:test";
import assert from "node:assert/strict";
import type { MindTreeNode } from "../src/types";
import { createCanvasLabelId } from "../src/ui/components/canvas-shell";
import { createBottomStatusBarState } from "../src/ui/components/models";
import { DisposerBag } from "../src/ui/components/ui-object";
import { createNodeVisualState } from "../src/ui/renderers/node-render-model";
import { KEYBOARD_HELP_ACTIONS, nodeMenuItemOrder, TOP_TOOLBAR_ORDER } from "../src/ui/ui-contracts";

test("each canvas receives a unique labelled-by target", () => {
  const first = createCanvasLabelId();
  const second = createCanvasLabelId();
  assert.match(first, /^mtn-canvas-label-\d+$/);
  assert.notEqual(first, second);
});

test("UI disposer releases resources once in reverse ownership order", () => {
  const calls: string[] = [];
  const bag = new DisposerBag();
  bag.add(() => calls.push("first"));
  bag.add(() => calls.push("second"));
  bag.dispose();
  bag.dispose();
  bag.add(() => calls.push("late"));
  assert.deepEqual(calls, ["second", "first", "late"]);
  assert.equal(bag.isDisposed, true);
});

test("toolbar and keyboard help expose the established semantic order", () => {
  assert.deepEqual(TOP_TOOLBAR_ORDER.slice(0, 4), ["expand-all", "collapse-all", "collapse-level", "markers"]);
  assert.deepEqual(TOP_TOOLBAR_ORDER.slice(-3), ["copy", "import", "export"]);
  assert.equal(KEYBOARD_HELP_ACTIONS[0], "add-sibling-below");
  assert.equal(KEYBOARD_HELP_ACTIONS.at(-1), "cancel");
});

test("node menu description changes only for applicable resource and tree state", () => {
  const plain = nodeMenuItemOrder({ hasFileResource: false, hasResource: false, isRoot: false, hasChildren: true });
  assert.deepEqual(plain.slice(0, 4), ["add-note", "add-note-template", "link-note", "link-web"]);
  assert.ok(plain.includes("add-sibling"));
  assert.ok(plain.includes("toggle-collapse"));
  const linkedRoot = nodeMenuItemOrder({ hasFileResource: true, hasResource: true, isRoot: true, hasChildren: false });
  assert.deepEqual(linkedRoot.slice(0, 4), ["title-sync", "link-web", "open-resource", "unlink-resource"]);
  assert.ok(!linkedRoot.includes("add-sibling"));
  assert.ok(!linkedRoot.includes("delete-branch"));
});

test("node render state keeps transient UI separate from the document node", () => {
  const node: MindTreeNode = {
    id: "node", title: "Topic", childIds: [], createdAt: "now", updatedAt: "now",
    resource: { type: "file", resourceId: "resource", pathHint: "Topic.md", fileKind: "note" },
    titleSync: "off",
    markers: [{ type: "priority", value: "red" }]
  };
  const state = createNodeVisualState(node, true, false);
  assert.equal(state.hasFileControls, true);
  assert.equal(state.titleSyncDisabled, true);
  assert.equal(state.selected, true);
  assert.equal(state.leaf, true);
  assert.ok(state.markerDisplayWidth > 0);
});

test("status bar model maps statistics and session state without DOM access", () => {
  const state = createBottomStatusBarState({
    topicCount: 8, noteCount: 3, depth: 4,
    saveState: "dirty", saveBusy: false, scanBusy: true, scanEnabled: true,
    canUndo: true, canRedo: false,
    text: {
      topics: (count) => `${count} topics`, notes: (count) => `${count} notes`,
      depth: (count) => `depth ${count}`, saved: "saved", unsaved: "unsaved"
    }
  });
  assert.equal(state.topicLabel, "8 topics");
  assert.equal(state.saveLabel, "unsaved");
  assert.equal(state.scanBusy, true);
  assert.equal(state.canRedo, false);
});
