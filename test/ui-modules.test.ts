import test from "node:test";
import assert from "node:assert/strict";
import type { MindTreeNode } from "../src/types";
import { createCanvasLabelId } from "../src/ui/components/canvas-shell";
import { createBottomStatusBarState } from "../src/ui/components/models";
import { DisposerBag } from "../src/ui/components/ui-object";
import { createNodeVisualState } from "../src/ui/renderers/node-render-model";
import { guardNodeMenuAction, COPY_AS_MENU_ORDER, EXPORT_MENU_ORDER, KEYBOARD_HELP_ACTIONS, nodeMenuItemOrder, nodeResourceMenuItemOrder, TOP_TOOLBAR_ORDER } from "../src/ui/ui-contracts";

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
  // The node-link command lives directly to the right of the marker button.
  assert.equal(TOP_TOOLBAR_ORDER.indexOf("link-node"), TOP_TOOLBAR_ORDER.indexOf("markers") + 1);
  assert.deepEqual(TOP_TOOLBAR_ORDER.slice(-3), ["copy", "import", "export"]);
  assert.equal(KEYBOARD_HELP_ACTIONS[0], "add-sibling-below");
  assert.equal(KEYBOARD_HELP_ACTIONS.at(-1), "cancel");
  // The search window is a real view shortcut, so the help table lists it in the
  // same position as the menu: right after save.
  assert.equal(KEYBOARD_HELP_ACTIONS.indexOf("search"), KEYBOARD_HELP_ACTIONS.indexOf("save") + 1);
});

test("node menu description changes only for applicable resource and tree state", () => {
  const plain = nodeMenuItemOrder({ hasFileResource: false, hasResource: false, isDesktopApp: true, isRoot: false, hasChildren: true, nodeLinked: false });
  assert.deepEqual(plain.slice(0, 4), ["add-note", "add-file-template", "link-file", "link-web"]);
  assert.ok(plain.includes("add-sibling"));
  assert.ok(plain.includes("toggle-collapse"));
  assert.ok(plain.includes("move-files"));
  // The node link sits directly under the marker entry, for every node state.
  assert.equal(plain.indexOf("node-link"), plain.indexOf("markers") + 1);
  const linkedRoot = nodeMenuItemOrder({ hasFileResource: true, hasResource: true, isDesktopApp: true, isRoot: true, hasChildren: false, nodeLinked: true });
  assert.deepEqual(linkedRoot.slice(0, 4), ["title-sync", "open-resource", "open-default-app", "unlink-resource"]);
  assert.equal(linkedRoot.indexOf("node-link"), linkedRoot.indexOf("markers") + 1);
  assert.ok(!linkedRoot.includes("add-sibling"));
  assert.ok(!linkedRoot.includes("delete-branch"));
  // "复制分支" stays a direct row, with the shared "复制为…" and export groups
  // directly under it: the node menu and the toolbar render the same rows.
  for (const menu of [plain, linkedRoot]) {
    assert.equal(menu.indexOf("copy-as"), menu.indexOf("copy-branch") + 1);
    assert.equal(menu.indexOf("export"), menu.indexOf("copy-as") + 1);
  }
  // A node link is already this node's association, so the creation entries and
  // the resource open/remove entries are not offered without a real resource.
  const nodeLinkedOnly = nodeMenuItemOrder({ hasFileResource: false, hasResource: false, isDesktopApp: true, isRoot: false, hasChildren: false, nodeLinked: true });
  assert.deepEqual(nodeLinkedOnly.slice(0, 3), ["markers", "node-link", "add-child"]);
  for (const item of ["add-note", "add-file-template", "link-file", "link-web"] as const) {
    assert.equal(nodeLinkedOnly.includes(item), false);
  }
});

test("both menu surfaces share one copy-as order and one export order", () => {
  assert.deepEqual(COPY_AS_MENU_ORDER, ["copy-as-reference", "copy-as-outline", "copy-as-mermaid"]);
  assert.deepEqual(EXPORT_MENU_ORDER, ["export-png", "export-markdown"]);
  // Ordering is the contract: the reference pointer first, then the two
  // text renderings, and PNG before Markdown on every surface.
  assert.equal(new Set(COPY_AS_MENU_ORDER).size, COPY_AS_MENU_ORDER.length);
  assert.equal(new Set(EXPORT_MENU_ORDER).size, EXPORT_MENU_ORDER.length);
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

test("a node link reserves the trailing control column without a resource", () => {
  const node: MindTreeNode = {
    id: "node", title: "Topic", childIds: [], createdAt: "now", updatedAt: "now",
    nodeLink: "target"
  };
  const visual = createNodeVisualState(node, false, false, undefined, (id) => id === "target");
  assert.equal(visual.hasResourceControls, true);
  assert.equal(visual.hasResource, false);
  assert.equal(visual.hasNodeLink, true);
  assert.equal(visual.nodeLinkTargetId, "target");
  assert.equal(visual.nodeLinkMissing, false);
  // A vanished target keeps the mark but reports that it cannot navigate.
  const missing = createNodeVisualState(node, false, false, undefined, () => false);
  assert.equal(missing.nodeLinkMissing, true);
  assert.equal(createNodeVisualState({ ...node, nodeLink: undefined }, false, false).hasNodeLink, false);
  // A stale resource on a linked node is suppressed: the link owns the single
  // trailing slot, so the rendered box cannot overflow it.
  const staleResource: MindTreeNode = { ...node,
    resource: { type: "file", resourceId: "note", pathHint: "Topic.md", fileKind: "note" },
    titleSync: "off" };
  const stale = createNodeVisualState(staleResource, false, false, undefined, () => true);
  assert.equal(stale.hasNodeLink, true);
  assert.equal(stale.hasResource, false);
  assert.equal(stale.titleSyncDisabled, false);
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
