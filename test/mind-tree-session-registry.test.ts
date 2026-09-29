import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyDocument } from "../src/domain/tree";
import {
  MindTreeSessionRegistry,
  SharedMindTreeSession,
  type SharedSessionSnapshot
} from "../src/services/mind-tree-session-registry";

test("all leaves of one path share document, history, and change broadcasts", () => {
  const registry = new MindTreeSessionRegistry();
  const first = registry.acquire("Folder/Tree.mtn.md");
  const second = registry.acquire("Folder\\Tree.mtn.md");
  assert.equal(first, second);

  const updates: SharedSessionSnapshot[] = [];
  first.attach("first", { onSessionChange: () => undefined, commitActiveDraft: () => undefined });
  first.attach("second", { onSessionChange: (value) => updates.push(value), commitActiveDraft: () => undefined });
  const document = createEmptyDocument("Tree");
  first.initialize(document, "source");
  first.history.markChanged();
  first.replaceDocument(document, "first", "document");

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.document, document);
  assert.equal(updates[0]?.dirty, true);
});

test("a shared session commits the old editor before another leaf claims it", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const commits: string[] = [];
  session.attach("left", {
    onSessionChange: () => undefined,
    commitActiveDraft: () => commits.push("left")
  });
  session.attach("right", {
    onSessionChange: () => undefined,
    commitActiveDraft: () => commits.push("right")
  });
  session.claimEditor("left");
  session.updateTitleDraft("left", "node", "before", "after");
  session.claimEditor("right");

  assert.deepEqual(commits, ["left"]);
  assert.equal(session.draft, undefined);
});

test("registry rekeys a live session when its file is renamed", () => {
  const registry = new MindTreeSessionRegistry();
  const session = registry.acquire("Old.mtn.md");
  session.attach("view", { onSessionChange: () => undefined, commitActiveDraft: () => undefined });
  registry.rename("Old.mtn.md", "Folder/New.mtn.md");

  assert.equal(registry.get("Old.mtn.md"), undefined);
  assert.equal(registry.get("Folder/New.mtn.md"), session);
  assert.equal(session.path, "Folder/New.mtn.md");
});

test("external notifications are de-duplicated per shared session", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  assert.equal(session.claimExternalSource("external"), true);
  assert.equal(session.claimExternalSource("external"), false);
  session.releaseExternalSource("external");
  assert.equal(session.claimExternalSource("external"), true);

});

test("a locked session survives its last view closing without selecting a version", () => {
  const registry = new MindTreeSessionRegistry();
  const session = registry.acquire("Tree.mtn.md");
  session.initialize(createEmptyDocument("Local"), "baseline");
  session.restoring = true;
  registry.releaseSession(session, "view");
  assert.equal(registry.acquire("Tree.mtn.md"), session);
  assert.equal(session.document?.title, "Local");
  assert.equal(session.history.isMutationBlocked(), true);
  session.restoring = false;
  registry.releaseSession(session, "view");
  assert.equal(registry.get("Tree.mtn.md"), undefined);
});

test("file side effects serialize and a failed operation does not poison the queue", async () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = session.runFileOperation(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = session.runFileOperation(async () => { order.push("second"); });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);

  await assert.rejects(session.runFileOperation(async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(await session.runFileOperation(async () => "retried"), "retried");
});

test("current choice retains history and confirms a draft exactly once; external choice clears it", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const before = createEmptyDocument("Before");
  session.initialize(before, "baseline");
  const edited = session.history.execute(before, (document) => { document.title = "Edited"; });
  session.replaceDocument(edited, "view");
  const current = structuredClone(edited);
  current.title = "Draft";
  current.nodes[current.rootId]!.title = "Draft";
  session.acceptVersion({ choice: "current", source: "written", document: current,
    draft: { nodeId: current.rootId, originalTitle: "Edited", value: "Draft" } });
  assert.equal(session.history.undo(current), edited);
  assert.ok(session.takeResolvedDraft());
  assert.equal(session.takeResolvedDraft(), undefined);
  session.acceptVersion({ choice: "external", source: "remote", document: before });
  assert.equal(session.history.canUndo, false);
  assert.equal(session.history.canRedo, false);
  assert.equal(session.history.dirty, false);
});

test("unchanged title drafts do not add duplicate undo entries when current version is chosen", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const document = createEmptyDocument("Tree");
  session.initialize(document, "baseline");
  session.acceptVersion({ choice: "current", source: "written", document,
    draft: { nodeId: document.rootId, originalTitle: "Tree", value: " Tree " } });
  assert.equal(session.history.canUndo, false);
});

test("a write receipt remains recognizable until verification completes", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  session.beginWrite("serialized");
  assert.equal(session.isPendingWrite("serialized"), true);
  assert.equal(session.isPendingWrite("other"), false);
  session.endWrite("other");
  assert.equal(session.isPendingWrite("serialized"), true);
  session.endWrite("serialized");
  assert.equal(session.isPendingWrite("serialized"), false);
});
