import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNode, cloneDocument, createEmptyDocument, renameNode } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile, mindTreeMachineDataFingerprint } from "../src/format/document";
import { restoreDocumentIdentity } from "../src/format/document-identity";
import { PendingConflictStore } from "../src/services/pending-conflict-store";
import { VersionConflictCoordinator, type VersionChoiceResult } from "../src/services/version-conflict-coordinator";
import { MemoryConflictIO, deferred } from "./helpers/pending-conflict-io";

function fixture() {
  const baseline = createEmptyDocument("Tree");
  baseline.documentId = "original-identity";
  const source = serializeMindTreeFile(baseline);
  const local = cloneDocument(baseline);
  addNode(local, local.rootId, "Local work");
  const io = new MemoryConflictIO();
  const store = new PendingConflictStore(io, ".obsidian/plugins/mtn", "device");
  const runtime = {
    disk: source.replace(/^documentId:.*\n/m, ""), writes: 0,
    beforeProcess: undefined as (() => void) | undefined,
    afterProcess: undefined as (() => void) | undefined,
    check: async (): Promise<() => void> => () => undefined,
    resolved: [] as VersionChoiceResult[], scheduled: 0
  };
  const make = () => new VersionConflictCoordinator({
    store, options: () => ({}), path: () => "Tree.mtn.md", read: async () => runtime.disk,
    process: async (transform) => {
      runtime.beforeProcess?.();
      const next = transform(runtime.disk);
      if (next !== runtime.disk) runtime.writes++;
      runtime.disk = next;
      runtime.afterProcess?.();
    },
    beginWrite: () => undefined, endWrite: () => undefined, changed: () => undefined,
    resolved: (result) => runtime.resolved.push(result), restored: () => undefined,
    createId: () => "repair-record", checkIdentityAvailable: () => runtime.check(),
    scheduleResume: () => { runtime.scheduled++; }
  });
  return { baseline, source, local, io, store, runtime, make, coordinator: make() };
}

test("identity scalar repair preserves all other YAML and body bytes, including compressed data", () => {
  const f = fixture();
  const source = f.runtime.disk.replace("schemaVersion: 2", 'schemaVersion: 2 # comment\ncustom: "值"\naliases: [a, b]')
    .replace("# Tree", "# Tree\n\nUser notes");
  const repaired = restoreDocumentIdentity(source, undefined, "original-identity");
  assert.equal(repaired.replace(/^documentId:.*\n/m, ""), source);
  const replaced = restoreDocumentIdentity(repaired, "original-identity", "other-id");
  assert.equal(replaced.replace('"other-id"', '"original-identity"'), repaired);
  assert.throws(() => restoreDocumentIdentity(repaired, undefined, "original-identity"), /changed again/);
  const crlf = source.replace(/\n/g, "\r\n");
  assert.equal(restoreDocumentIdentity(crlf, undefined, "original-identity").replace(/^documentId:.*\r\n/m, ""), crlf);
  const invalidNode = source.replace("schemaVersion: 2", "documentId:\n  - wrong-type\nschemaVersion: 2");
  assert.throws(() => restoreDocumentIdentity(invalidNode, undefined, "original-identity"), /safely locate/);
});

test("matching external JSON is not rolled back to the pre-draft title during automatic resume", async () => {
  const f = fixture();
  const draft = { nodeId: f.local.rootId, originalTitle: "Tree", value: "New title" };
  const candidate = cloneDocument(f.local);
  renameNode(candidate, candidate.rootId, "New title");
  f.runtime.disk = serializeMindTreeFile(candidate).replace(/^documentId:.*\n/m, "");
  await f.coordinator.enter(candidate, f.source, draft, [], f.local);
  await f.coordinator.restoreIdentity(undefined);
  await f.coordinator.resumeUnchanged();
  assert.equal(parseMindTreeFile(f.runtime.disk).document.title, "New title");
  assert.deepEqual(f.runtime.resolved[0]?.resumeDraft, draft);
});

test("deleted identity has a distinct repair action; repair does not overwrite remote node data", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.source);
  assert.equal(f.coordinator.state?.mode, "identity");
  assert.equal(f.coordinator.state?.ready, false);
  assert.equal(f.coordinator.state?.canRestoreIdentity, true);
  assert.equal(f.coordinator.state?.originalId, "original-identity");
  assert.equal(f.coordinator.state?.currentId, undefined);
  const machine = mindTreeMachineDataFingerprint(parseMindTreeFile(f.runtime.disk).document);
  await f.coordinator.restoreIdentity(undefined);
  assert.equal(mindTreeMachineDataFingerprint(parseMindTreeFile(f.runtime.disk).document), machine);
  assert.equal(f.coordinator.state?.mode, "metadata");
  assert.ok(f.runtime.scheduled);
  await f.coordinator.resumeUnchanged();
  assert.equal(f.coordinator.active, false);
  assert.equal(Object.keys(parseMindTreeFile(f.runtime.disk).document.nodes).length, 2);
  assert.equal(await f.store.load("Tree.mtn.md"), undefined);
});

test("identity repair restores an unconfirmed draft after restart without confirming or renaming it", async () => {
  const f = fixture();
  const draft = { nodeId: f.local.rootId, originalTitle: "Tree", value: " 原始草稿 " };
  const candidate = cloneDocument(f.local);
  renameNode(candidate, candidate.rootId, "原始草稿");
  await f.coordinator.enter(candidate, f.source, draft, [], f.local);
  const restarted = f.make();
  await restarted.restore();
  await restarted.restoreIdentity(undefined);
  const result = await restarted.resumeUnchanged();
  assert.deepEqual(result?.resumeDraft, draft);
  assert.equal(result?.draft, undefined);
  assert.equal(result?.document.title, "Tree");
  assert.equal(parseMindTreeFile(f.runtime.disk).document.title, "Tree");
  assert.equal(Object.keys(result!.document.nodes).length, 2);
});

test("old pending metadata-only records resume with latest properties and retain local node edits", async () => {
  const f = fixture();
  f.runtime.disk = f.source.replace(/^theme:.*\n/m, "");
  await f.store.put({ version: 1, id: "repair-record", path: "Tree.mtn.md", baselineSource: f.source,
    currentSource: serializeMindTreeFile(f.local, f.source) });
  await f.coordinator.restore();
  assert.equal(f.coordinator.state?.mode, "metadata");
  await f.coordinator.resumeUnchanged();
  assert.equal(f.coordinator.active, false);
  assert.doesNotMatch(f.runtime.disk, /^theme:/m);
  assert.equal(Object.keys(parseMindTreeFile(f.runtime.disk).document.nodes).length, 2);
});

test("after repairing identity a genuine machine change still requires an explicit choice", async () => {
  const f = fixture();
  const remote = cloneDocument(f.baseline);
  addNode(remote, remote.rootId, "External");
  delete remote.documentId;
  f.runtime.disk = serializeMindTreeFile(remote).replace("theme: vibrant", "theme: ocean");
  await f.coordinator.enter(f.local, f.source);
  await f.coordinator.restoreIdentity(undefined);
  assert.equal(f.coordinator.state?.mode, "comparison");
  assert.equal(f.coordinator.state?.ready, true);
  assert.equal(f.coordinator.state?.current.settings.theme, "ocean");
  assert.equal(await f.coordinator.resumeUnchanged(), undefined);
  const shown = f.coordinator.captureDisplayedVersion();
  f.runtime.beforeProcess = () => { f.runtime.disk = f.runtime.disk.replace(/^theme:.*\n/m, ""); };
  const chosen = await f.coordinator.choose("current", shown);
  assert.ok(chosen);
  assert.doesNotMatch(f.runtime.disk, /^theme:/m);
  assert.equal(Object.values(chosen.document.nodes).some((node) => node.title === "Local work"), true);
});

test("a stale deleted-ID click cannot overwrite an identity assigned while awaiting the queue", async () => {
  const f = fixture();
  await f.coordinator.enter(f.local, f.source);
  const captured = f.coordinator.state?.currentId; // undefined is a real expected value, not a request to recapture.
  f.runtime.disk = f.source.replace("original-identity", "new-identity");
  await f.coordinator.refresh();
  await f.coordinator.restoreIdentity(captured);
  assert.equal(f.runtime.writes, 0);
  assert.equal(f.coordinator.state?.currentId, "new-identity");
  assert.match(f.coordinator.state?.error ?? "", /changed again/);
});

test("duplicate IDs and index changes during repair do not modify the original file", async () => {
  for (const atProcess of [false, true]) {
    const f = fixture();
    f.runtime.check = async () => {
      if (!atProcess) throw new Error("Duplicate ID: Other.mtn.md");
      return () => { throw new Error("Index changed while checking identities"); };
    };
    await f.coordinator.enter(f.local, f.source);
    await f.coordinator.restoreIdentity(undefined);
    assert.equal(f.runtime.writes, 0);
    assert.equal(f.coordinator.active, true);
    assert.match(f.coordinator.state?.error ?? "", /Duplicate ID|Index changed/);
    assert.ok(await f.store.load("Tree.mtn.md"));
  }
});

test("identity repair catches a concurrent change inside Vault.process and verifies readback", async () => {
  for (const after of [false, true]) {
    const f = fixture();
    await f.coordinator.enter(f.local, f.source);
    const change = () => { f.runtime.disk = f.source.replace("original-identity", "new-identity"); };
    if (after) f.runtime.afterProcess = change;
    else f.runtime.beforeProcess = change;
    await f.coordinator.restoreIdentity(undefined);
    assert.equal(f.coordinator.active, true);
    assert.equal(parseMindTreeFile(f.runtime.disk).document.documentId, "new-identity");
    assert.ok(f.coordinator.state?.error);
    assert.ok(await f.store.load("Tree.mtn.md"));
  }
});

test("staging errors cannot enable repair; a successful retry recovers the action", async () => {
  const f = fixture();
  f.io.failWrite = true;
  await assert.rejects(f.coordinator.enter(f.local, f.source), /disk full/);
  await f.coordinator.refresh();
  assert.equal(f.coordinator.state?.canRestoreIdentity, false);
  await f.coordinator.restoreIdentity(undefined);
  assert.equal(f.runtime.writes, 0);
  f.io.failWrite = false;
  await f.coordinator.retry();
  assert.equal(f.coordinator.state?.canRestoreIdentity, true);
});

test("a captured repair remains checked when the duplicate scan is asynchronous", async () => {
  const f = fixture();
  const wait = deferred<() => void>();
  f.runtime.check = () => wait.promise;
  await f.coordinator.enter(f.local, f.source);
  const repairing = f.coordinator.restoreIdentity(undefined);
  f.runtime.disk = f.source.replace("original-identity", "during-scan");
  wait.resolve(() => undefined);
  await repairing;
  assert.equal(f.runtime.writes, 0);
  assert.equal(f.coordinator.state?.currentId, "during-scan");
});

test("safety UI hides version choices and has an independent accessible repair action", () => {
  const ui = readFileSync(new URL("../src/ui/components/version-comparison.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/ui/components/document-safety-panel.ts", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
  assert.match(ui, /this\.currentButton\.hidden = this\.externalButton\.hidden = !comparison/);
  assert.match(panel, /conflict\.restoreIdentity/);
  assert.match(panel, /this\.restore\.disabled = !state\.canRestoreIdentity/);
  assert.match(view, /deferMetadataRender/);
  assert.doesNotMatch(view, /\|\| parsed\.defaultedDocumentSettings === true/);
});
