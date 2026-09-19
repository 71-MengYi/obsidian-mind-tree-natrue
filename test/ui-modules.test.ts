import test from "node:test";
import assert from "node:assert/strict";
import type { MindTreeNode } from "../src/types";
import { createCanvasLabelId } from "../src/ui/components/canvas-shell";
import { createBottomStatusBarState } from "../src/ui/components/models";
import { DisposerBag } from "../src/ui/components/ui-object";
import { createNodeVisualState } from "../src/ui/renderers/node-render-model";
import { guardNodeMenuAction, KEYBOARD_HELP_ACTIONS, nodeMenuItemOrder, nodeResourceMenuItemOrder, TOP_TOOLBAR_ORDER } from "../src/ui/ui-contracts";

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
  const plain = nodeMenuItemOrder({ hasFileResource: false, hasResource: false, isDesktopApp: true, isRoot: false, hasChildren: true });
  assert.deepEqual(plain.slice(0, 4), ["add-note", "add-file-template", "link-file", "link-web"]);
  assert.ok(plain.includes("add-sibling"));
  assert.ok(plain.includes("toggle-collapse"));
  assert.ok(plain.includes("move-files"));
  const linkedRoot = nodeMenuItemOrder({ hasFileResource: true, hasResource: true, isDesktopApp: true, isRoot: true, hasChildren: false });
  assert.deepEqual(linkedRoot.slice(0, 4), ["title-sync", "open-resource", "open-default-app", "unlink-resource"]);
  assert.ok(!linkedRoot.includes("add-sibling"));
  assert.ok(!linkedRoot.includes("delete-branch"));
});

test("resource menu never offers replacement, and default-app opening is desktop-only for files and URLs", () => {
  for (const isDesktopApp of [true, false]) {
    assert.deepEqual(nodeResourceMenuItemOrder({ hasFileResource: false, hasResource: false, isDesktopApp }),
      ["add-note", "add-file-template", "link-file", "link-web"]);
    for (const hasFileResource of [true, false]) {
      const expected = [
        ...(hasFileResource ? ["title-sync"] : []), "open-resource",
        ...(isDesktopApp ? ["open-default-app"] : []), "unlink-resource"
      ];
      const menu = nodeResourceMenuItemOrder({ hasFileResource, hasResource: true, isDesktopApp });
      assert.deepEqual(menu, expected);
      for (const item of ["add-note", "add-file-template", "link-file", "link-web"] as const) {
        assert.equal(menu.includes(item), false);
      }
    }
  }
});

test("stale menu callbacks validate at activation and do not execute their action", () => {
  let current = true;
  let calls = 0;
  let validations = 0;
  const action = guardNodeMenuAction(() => { validations++; return current; }, () => { calls++; });
  assert.equal(validations, 0);
  action();
  current = false;
  action();
  assert.equal(calls, 1);
  assert.equal(validations, 2);
});

test("node render state keeps transient UI separate from the document node", () => {
  const node: MindTreeNode = {
    id: "node", title: "Topic", childIds: [], createdAt: "now", updatedAt: "now",
    resource: { type: "file", resourceId: "resource", pathHint: "Topic.md", fileKind: "note" },
    titleSync: "off",
    markers: [{ type: "priority", value: "red" }]
  };
  const state = createNodeVisualState(node, true, false);
  assert.equal(state.hasResourceControls, true);
  assert.equal(state.titleSyncDisabled, true);
  assert.equal(state.selected, true);
  assert.equal(state.leaf, true);
  assert.ok(state.markerDisplayWidth > 0);
});

test("all linked resources expose the same open control but only files expose disabled title sync", () => {
  const node: MindTreeNode = {
    id: "node", title: "Topic", childIds: [], createdAt: "now", updatedAt: "now"
  };
  assert.equal(createNodeVisualState(node, false, false).hasResourceControls, false);
  for (const fileKind of ["note", "image", "attachment"] as const) {
    node.resource = { type: "file", fileKind, resourceId: "resource", pathHint: "Topic.ext" };
    node.titleSync = "bidirectional";
    assert.equal(createNodeVisualState(node, false, false).hasResourceControls, true);
    assert.equal(createNodeVisualState(node, false, false).titleSyncDisabled, false);
    node.titleSync = "off";
    assert.equal(createNodeVisualState(node, false, false).titleSyncDisabled, true);
  }
  node.resource = { type: "url", url: "https://example.com/" };
  for (const titleSync of [undefined, "off", "bidirectional"] as const) {
    node.titleSync = titleSync;
    const visual = createNodeVisualState(node, false, false);
    assert.equal(visual.hasResourceControls, true);
    assert.equal(visual.titleSyncDisabled, false);
  }
});

test("status bar model maps statistics and session state without DOM access", () => {
  const state = createBottomStatusBarState({
    topicCount: 8, fileCount: 3, depth: 4,
    saveState: "dirty", saveBusy: false, scanBusy: true, scanEnabled: true,
    canUndo: true, canRedo: false,
    text: {
      topics: (count) => `${count} topics`, files: (count) => `${count} files`,
      depth: (count) => `depth ${count}`, saved: "saved", unsaved: "unsaved"
    }
  });
  assert.equal(state.topicLabel, "8 topics");
  assert.equal(state.fileLabel, "3 files");
  assert.equal(state.saveLabel, "unsaved");
  assert.equal(state.scanBusy, true);
  assert.equal(state.canRedo, false);
});
