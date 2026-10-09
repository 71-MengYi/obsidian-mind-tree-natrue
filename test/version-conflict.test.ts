import test from "node:test";
import assert from "node:assert/strict";
import { addNode, cloneDocument, createEmptyDocument } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { assessExternalVersion, createManagedMindTreeSnapshot, sameManagedMindTreeSnapshot } from "../src/services/document-conflict";
import { PendingConflictStore } from "../src/services/pending-conflict-store";
import { VersionConflictCoordinator, type VersionChoiceResult } from "../src/services/version-conflict-coordinator";
import { MemoryConflictIO, deferred } from "./helpers/pending-conflict-io";

function fixture() {
  const baseline = createEmptyDocument("Tree");
  const baseSource = serializeMindTreeFile(baseline);
  const local = cloneDocument(baseline);
  addNode(local, local.rootId, "Local");
  const remote = cloneDocument(baseline);
  addNode(remote, remote.rootId, "Remote");
  const io = new MemoryConflictIO();
  const store = new PendingConflictStore(io, ".obsidian/plugins/mtn", "device-a");
  const runtime = {
    path: "Tree.mtn.md", disk: serializeMindTreeFile(remote, baseSource),
    writes: 0, notifications: 0, reads: 0,
    beforeProcess: undefined as (() => void) | undefined,
    afterProcess: undefined as (() => void) | undefined,
    readOverride: undefined as (() => Promise<string>) | undefined,
    resolved: [] as VersionChoiceResult[], restored: [] as string[]
  };
  const make = () => new VersionConflictCoordinator({
    store, options: () => ({}), path: () => runtime.path,
    read: async () => { runtime.reads++; return runtime.readOverride ? runtime.readOverride() : runtime.disk; },
    process: async (transform) => {
      runtime.beforeProcess?.();
      const next = transform(runtime.disk);
      if (next !== runtime.disk) runtime.writes++;
      runtime.disk = next;
      runtime.afterProcess?.();
    },
    beginWrite: () => undefined, endWrite: () => undefined,
    changed: () => { runtime.notifications++; },
    resolved: (result) => runtime.resolved.push(result),
    restored: (document) => runtime.restored.push(document.title), createId: () => "conflict-1"
  });
  return { baseline, baseSource, local, remote, io, store, runtime, make, coordinator: make() };
}

test("clean sessions preview real remote data, never settings/prose/outline/identical results", () => {
  const f = fixture();
  assert.equal(assessExternalVersion(f.baseSource, f.baseline, f.runtime.disk).kind, "choose");
  const setting = cloneDocument(f.baseline);
  setting.settings.theme = "flat";
  assert.equal(assessExternalVersion(f.baseSource, f.baseline, serializeMindTreeFile(setting)).kind, "unchanged");
  for (const text of [f.baseSource, f.baseSource.replace("# Tree", "# Renamed\n\nNew body")
    .replace("schemaVersion: 2", "schemaVersion: 2\ncustom: value"), serializeMindTreeFile(f.local)]) {
    assert.equal(assessExternalVersion(f.baseSource, f.local, text).kind, "unchanged");
  }
});

test("current version is frozen synchronously and remains locked until journal verification", async () => {
  const f = fixture();
  const entering = f.coordinator.enter(f.local, f.baseSource);
  assert.equal(f.coordinator.active, true);
  assert.equal(f.coordinator.state?.ready, false);
  f.local.title = "Changed outside";
  await entering;
  assert.equal(f.coordinator.state?.current.title, "Tree");
  assert.equal(f.coordinator.state?.ready, true);
  assert.equal((await f.store.load(f.runtime.path))?.receipt, undefined);
  assert.equal(f.runtime.writes, 0);
});

test("choosing current preserves latest unowned text, confirms the draft, and removes only its journal", async () => {
  const f = fixture();
  const draft = { nodeId: f.local.rootId, originalTitle: "Tree", value: "Edited draft " };
  await f.coordinator.enter(f.local, f.baseSource, draft);
  f.runtime.beforeProcess = () => {
    f.runtime.disk = f.runtime.disk.replace("# Tree", "# Tree\n\nNewest body")
      .replace("schemaVersion: 2", "schemaVersion: 2\notherPlugin: keep");
  };
  const result = await f.coordinator.choose("current");
  assert.equal(result?.choice, "current");
  assert.deepEqual(result?.draft, draft);
  assert.match(f.runtime.disk, /Newest body/);
  assert.match(f.runtime.disk, /otherPlugin: keep/);
  assert.equal(f.runtime.writes, 1);
  assert.equal(f.coordinator.active, false);
  assert.equal(await f.store.load(f.runtime.path), undefined);
  assert.ok(sameManagedMindTreeSnapshot(createManagedMindTreeSnapshot(f.runtime.disk), createManagedMindTreeSnapshot(serializeMindTreeFile(f.local))));
});

test("external choice returns exactly the displayed version without local draft effects", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource, { nodeId: f.local.rootId, originalTitle: "Tree", value: "Local draft" });
  const result = await f.coordinator.choose("external");
  assert.equal(result?.choice, "external");
  assert.equal(result?.draft, undefined);
  assert.deepEqual(result?.document.nodes, f.remote.nodes);
  assert.equal(f.runtime.writes, 0);
});

test("confirmed but unfinished filename synchronization is staged and resumed only for current choice", async () => {
  for (const choice of ["current", "external"] as const) {
    const f = fixture();
    const pending = [{ nodeId: f.local.rootId, originalTitle: "Before", value: "Tree" }];
    await f.coordinator.enter(f.local, f.baseSource, undefined, pending);
    const restarted = f.make();
    await restarted.restore();
    const result = await restarted.choose(choice);
    assert.deepEqual(result?.titleRenames, choice === "current" ? pending : undefined);
  }
});

test("click fingerprint is not replaced by a refresh while waiting for the shared write queue", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  const clicked = f.coordinator.captureDisplayedVersion();
  addNode(f.remote, f.remote.rootId, "More recent");
  f.runtime.disk = serializeMindTreeFile(f.remote);
  await f.coordinator.refresh();
  assert.equal(await f.coordinator.choose("current", clicked), undefined);
  assert.equal(f.coordinator.state?.changedAgain, true);
  assert.equal(f.runtime.writes, 0);
  assert.equal(f.coordinator.active, true);
  assert.ok(await f.store.load(f.runtime.path));
});

test("change inside the atomic process callback requires a new choice", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.runtime.beforeProcess = () => {
    addNode(f.remote, f.remote.rootId, "During click");
    f.runtime.disk = serializeMindTreeFile(f.remote);
  };
  assert.equal(await f.coordinator.choose("current"), undefined);
  assert.equal(f.coordinator.state?.changedAgain, true);
  assert.equal(f.runtime.writes, 0);
  assert.equal(f.runtime.resolved.length, 0);
});

test("a sync replacing the just-written data fails verification and keeps pending local work", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.runtime.afterProcess = () => { f.runtime.disk = serializeMindTreeFile(f.remote); };
  assert.equal(await f.coordinator.choose("current"), undefined);
  assert.equal(f.coordinator.active, true);
  assert.equal(f.coordinator.state?.changedAgain, true);
  assert.ok(await f.store.load(f.runtime.path));
  assert.equal(f.runtime.resolved.length, 0);
});

test("external notifications coalesce and never publish stale asynchronous reads", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  const first = deferred<string>();
  let calls = 0;
  f.runtime.readOverride = () => ++calls === 1 ? first.promise : Promise.resolve(f.runtime.disk);
  const oldRead = f.coordinator.refresh();
  addNode(f.remote, f.remote.rootId, "Latest");
  f.runtime.disk = serializeMindTreeFile(f.remote);
  const newRead = f.coordinator.refresh();
  first.resolve(f.baseSource);
  await Promise.all([oldRead, newRead]);
  assert.equal(calls, 2);
  assert.deepEqual(f.coordinator.state?.external?.nodes, f.remote.nodes);
});

test("failed staging cannot be hidden by a successful external refresh; retry is safe", async () => {
  const f = fixture();
  f.io.failWrite = true;
  await assert.rejects(f.coordinator.enter(f.local, f.baseSource), /disk full/);
  await f.coordinator.refresh();
  assert.equal(f.coordinator.state?.ready, false);
  assert.match(f.coordinator.state?.error ?? "", /disk full/);
  assert.equal(await f.coordinator.choose("external"), undefined);
  f.io.failWrite = false;
  await f.coordinator.retry();
  assert.equal(f.coordinator.state?.ready, true);
  assert.ok(await f.store.load(f.runtime.path));
});

test("closing/restarting restores frozen draft and latest external version without writing the tree", async () => {
  const f = fixture();
  const draft = { nodeId: f.local.rootId, originalTitle: "Tree", value: "  draft " };
  await f.coordinator.enter(f.local, f.baseSource, draft);
  await f.coordinator.settle();
  addNode(f.remote, f.remote.rootId, "While closed");
  f.runtime.disk = serializeMindTreeFile(f.remote);
  const reopened = f.make();
  assert.equal(await reopened.restore(), true);
  assert.deepEqual(reopened.state?.current.nodes, f.local.nodes);
  assert.deepEqual(reopened.state?.external?.nodes, f.remote.nodes);
  assert.deepEqual((await f.store.load(f.runtime.path))?.draft, draft);
  assert.equal(f.runtime.writes, 0);
});

test("verified receipt survives cleanup failure and restart completes without a second write", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.io.failRemove = true;
  await f.coordinator.choose("current");
  assert.equal(f.coordinator.active, true);
  assert.equal((await f.store.load(f.runtime.path))?.receipt?.phase, "verified");
  const restarted = f.make();
  await restarted.restore();
  assert.equal((await f.store.load(f.runtime.path))?.receipt?.phase, "verified");
  assert.equal(restarted.active, true);
  f.io.failRemove = false;
  await restarted.retry();
  assert.equal(restarted.active, false);
  assert.equal(f.runtime.writes, 1);
  assert.equal(f.runtime.resolved.length, 1);
});

test("a prepared receipt does not discard a newer remote version after restart", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.runtime.beforeProcess = () => { throw new Error("interrupted before write"); };
  await f.coordinator.choose("current");
  const reopened = f.make();
  await reopened.restore();
  assert.equal(reopened.active, true);
  assert.equal((await f.store.load(f.runtime.path))?.receipt, undefined);
  assert.equal(f.runtime.resolved.length, 0);
});

test("rename rekeys pending locator without duplicating records or choosing a version", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.runtime.path = "Folder/Renamed.mtn.md";
  await f.coordinator.rename(f.runtime.path);
  assert.equal(await f.store.load("Tree.mtn.md"), undefined);
  assert.equal((await f.store.load(f.runtime.path))?.id, "conflict-1");
  assert.equal(f.io.files.size, 1);
});

test("dangerous identity, future schema, corrupt source and disappeared file never enable selection", async () => {
  for (const kind of ["identity", "future", "corrupt", "missing"]) {
    const f = fixture();
    f.baseline.documentId = "original";
    f.local.documentId = "original";
    f.remote.documentId = kind === "identity" ? "other" : "original";
    f.baseSource = serializeMindTreeFile(f.baseline);
    f.runtime.disk = serializeMindTreeFile(f.remote);
    if (kind === "future") f.runtime.disk = f.runtime.disk.replace("schemaVersion: 2", "schemaVersion: 99");
    if (kind === "corrupt") f.runtime.disk = "broken";
    if (kind === "missing") f.runtime.readOverride = async () => { throw new Error("file missing"); };
    await f.coordinator.enter(f.local, f.baseSource);
    assert.equal(f.coordinator.state?.ready, false, kind);
    assert.ok(f.coordinator.state?.error, kind);
    assert.equal(await f.coordinator.choose("current"), undefined);
    assert.equal(f.runtime.writes, 0);
  }
});

test("discarding an unresolvable record removes the journal and releases the session", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource, { nodeId: f.local.rootId, originalTitle: "Tree", value: "Draft" });
  assert.equal(f.coordinator.active, true);
  const notificationsBefore = f.runtime.notifications;
  await f.coordinator.discard();
  assert.equal(f.coordinator.active, false);
  assert.equal(f.coordinator.state, undefined);
  assert.equal(await f.store.load(f.runtime.path), undefined);
  assert.equal(f.io.files.size, 0);
  assert.equal(f.runtime.writes, 0);
  assert.equal(f.runtime.resolved.length, 0);
  assert.ok(f.runtime.notifications > notificationsBefore);
  // A discarded coordinator is not selectable and cannot resurrect the record.
  assert.equal(await f.coordinator.choose("current"), undefined);
  assert.equal(f.io.files.size, 0);
});

test("discard releases the session even when journal cleanup is denied", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.baseSource);
  f.io.failRemove = true;
  await f.coordinator.discard();
  assert.equal(f.coordinator.active, false);
  assert.equal(f.io.files.size, 1);
});

test("random interleaving of external refresh and choices never resolves an unseen version", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const f = fixture();
    await f.coordinator.enter(f.local, f.baseSource);
    const clicked = f.coordinator.captureDisplayedVersion();
    if (seed % 2) {
      addNode(f.remote, f.remote.rootId, `Remote-${seed}`);
      f.runtime.disk = serializeMindTreeFile(f.remote);
    }
    if (seed % 3) await f.coordinator.refresh();
    const result = await f.coordinator.choose(seed % 4 ? "current" : "external", clicked);
    if (seed % 2) {
      assert.equal(result, undefined);
      assert.equal(f.runtime.writes, 0);
    } else {
      assert.ok(result);
      assert.deepEqual(Object.entries(parseMindTreeFile(f.runtime.disk).document.nodes), Object.entries(result.document.nodes));
    }
  }
});
