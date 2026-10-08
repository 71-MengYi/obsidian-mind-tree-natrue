import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { WorkspaceUpdateHost, type UpdateViewParticipant } from "../src/services/updates/workspace-update-host";
import { updateRuntime } from "../src/services/updates/update-coordinator";
import { UpdateError } from "../src/services/updates/release-client";
import type { PluginReloadBridge } from "../src/services/updates/plugin-reload-bridge";
import { MIND_TREE_VIEW_TYPE } from "../src/view-routing";

function workspaceFixture() {
  const calls: string[] = [];
  const file = { path: "Notes/Tree.mtn.md" };
  let source = "saved source", saved = "saved source", blocked = false, unsafe = false;
  let reads = 0;
  const presentation = { viewport: { x: 8, y: 16, scale: 1 }, selectedIds: ["root"] };
  const view: Record<string, unknown> = {
    file, getViewType: () => MIND_TREE_VIEW_TYPE,
    pauseForUpdate() { calls.push("pause"); },
    async flushForUpdate() { calls.push("save-tree"); saved = source; },
    assertUpdateSafe() { calls.push("safe"); if (unsafe) throw new UpdateError("save", file.path); },
    updateSourceBaseline: () => saved,
    resumeAfterUpdate() { calls.push("resume"); },
    captureUpdatePresentation: () => presentation,
    restoreUpdatePresentation(value: unknown) { assert.deepEqual(value, presentation); calls.push("presentation"); }
  };
  const leaf = {
    view,
    getViewState: () => ({ type: MIND_TREE_VIEW_TYPE, state: { file: file.path }, active: true }),
    async setViewState(state: { type: string }) {
      calls.push(state.type);
      this.view = state.type === "empty" ? { getViewType: () => "empty" } : view;
    }
  };
  view.leaf = leaf;
  const runtime = updateRuntime({});
  const app = { vault: { async read() { reads++; return source; } },
    workspace: { getMostRecentLeaf: () => leaf,
      iterateAllLeaves: (callback: (value: typeof leaf) => void) => callback(leaf),
      setActiveLeaf: () => { calls.push("active"); } } } as unknown as App;
  const bridge = {
    canReload: () => true,
    async unload() { calls.push("unload"); },
    async load(version: string) { calls.push("load:" + version); }
  } as unknown as PluginReloadBridge;
  const host = new WorkspaceUpdateHost(app, bridge, runtime, {
    views: () => leaf.view === view ? [view as unknown as UpdateViewParticipant] : [],
    async settle() { calls.push("settle"); },
    async flushSettings() { calls.push("save-settings"); },
    isUnloading: () => false, hasBlockingDialog: () => blocked
  });
  return { host, runtime, calls, file, view, leaf, reads: () => reads,
    externalChange: () => { source = "external source"; file.path = "Notes/Renamed.mtn.md"; },
    block: () => { blocked = true; }, unsafe: () => { unsafe = true; } };
}

test("workspace preparation saves before replacement, keeps baselines and restores the same leaves", async () => {
  const f = workspaceFixture(); const prepared = await f.host.prepare();
  assert.equal(f.runtime.paused, true); assert.equal(f.runtime.frozen, true);
  assert.ok(f.calls.indexOf("pause") < f.calls.indexOf("save-tree"));
  assert.ok(f.calls.includes("save-settings"));
  assert.equal(f.runtime.baselines?.get("Notes/Tree.mtn.md"), "saved source");
  await prepared.assertSafe(); await prepared.unload(); await prepared.load("1.0.2"); await prepared.restore();
  assert.ok(f.calls.indexOf("empty") < f.calls.indexOf("unload"));
  assert.ok(f.calls.indexOf("load:1.0.2") < f.calls.indexOf("presentation"));
  assert.equal(f.leaf.view, f.view);
  prepared.resume(); assert.equal(f.runtime.paused, false); assert.equal(f.runtime.frozen, false);
});

test("external changes during program installation do not cause repeated note reads or overwrite notes", async () => {
  const f = workspaceFixture(); const prepared = await f.host.prepare();
  const reads = f.reads();
  f.externalChange(); await prepared.assertSafe();
  await prepared.unload(); await prepared.assertSafe();
  await prepared.load("1.0.2"); await prepared.restore();
  assert.equal(f.reads(), reads);
  assert.equal(f.runtime.baselines?.get("Notes/Tree.mtn.md"), "saved source");
  prepared.resume();
});

test("unsaved work and blocking dialogs still stop preparation and release the pause", async () => {
  const blocked = workspaceFixture(); blocked.block();
  await assert.rejects(blocked.host.prepare(), (error: unknown) => error instanceof UpdateError && error.code === "busy");
  assert.equal(blocked.runtime.paused, false); assert.deepEqual(blocked.calls, []);
  const unsafe = workspaceFixture(); unsafe.unsafe();
  await assert.rejects(unsafe.host.prepare(), (error: unknown) => error instanceof UpdateError && error.code === "save");
  assert.equal(unsafe.runtime.paused, false); assert.equal(unsafe.runtime.frozen, false);
  assert.ok(unsafe.calls.includes("resume")); assert.ok(!unsafe.calls.includes("unload"));
});
