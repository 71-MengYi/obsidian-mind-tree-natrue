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
  first.attach("first", { onSessionChange: () => undefined, commitActiveDraft: () => undefined, refreshConflictRecovery: async () => undefined, adoptSaveConflict: () => undefined });
  first.attach("second", { onSessionChange: (value) => updates.push(value), commitActiveDraft: () => undefined, refreshConflictRecovery: async () => undefined, adoptSaveConflict: () => undefined });
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
    commitActiveDraft: () => commits.push("left"),
    refreshConflictRecovery: async () => undefined,
    adoptSaveConflict: () => undefined
  });
  session.attach("right", {
    onSessionChange: () => undefined,
    commitActiveDraft: () => commits.push("right"),
    refreshConflictRecovery: async () => undefined,
    adoptSaveConflict: () => undefined
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
  session.attach("view", { onSessionChange: () => undefined, commitActiveDraft: () => undefined, refreshConflictRecovery: async () => undefined, adoptSaveConflict: () => undefined });
  registry.rename("Old.mtn.md", "Folder/New.mtn.md");

  assert.equal(registry.get("Old.mtn.md"), undefined);
  assert.equal(registry.get("Folder/New.mtn.md"), session);
  assert.equal(session.path, "Folder/New.mtn.md");
});

test("external events and Recovery creation are de-duplicated per shared session", async () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  assert.equal(session.claimExternalSource("external"), true);
  assert.equal(session.claimExternalSource("external"), false);
  session.releaseExternalSource("external");
  assert.equal(session.claimExternalSource("external"), true);

  let creates = 0;
  const [left, right] = await Promise.all([
    session.recoveryForTransition("a>b", async () => { creates += 1; return "Recovery.mtn.md"; }),
    session.recoveryForTransition("a>b", async () => { creates += 1; return "Other.mtn.md"; })
  ]);
  assert.equal(creates, 1);
  assert.equal(left, "Recovery.mtn.md");
  assert.equal(right, "Recovery.mtn.md");
});

test("closing the conflict owner transfers the verified conflict to one remaining leaf", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const adopted: string[] = [];
  const participant = (name: string) => ({
    onSessionChange: () => undefined,
    commitActiveDraft: () => undefined,
    refreshConflictRecovery: async () => undefined,
    adoptSaveConflict: (conflict: { recoveryPath: string }) => adopted.push(`${name}:${conflict.recoveryPath}`)
  });
  session.attach("left", participant("left"));
  session.attach("right", participant("right"));
  const conflict = {
    externalSource: "external",
    recoveryPath: "_Mind Tree Recovery/now/Tree.mtn.md",
    recoveredLocalFingerprint: "local"
  };

  assert.equal(session.claimConflict("left", conflict), true);
  assert.equal(session.hasConflict, true);
  session.detach("left");

  assert.deepEqual(adopted, ["right:_Mind Tree Recovery/now/Tree.mtn.md"]);
  assert.equal(session.hasConflict, true);
  session.clearConflict("right");
  assert.equal(session.hasConflict, false);
});

test("file side effects serialize and a failed Recovery can be retried", async () => {
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

  let attempts = 0;
  await assert.rejects(session.recoveryForTransition("transition", async () => {
    attempts += 1;
    throw new Error("disk full");
  }), /disk full/);
  const recovered = await session.recoveryForTransition("transition", async () => {
    attempts += 1;
    return "verified.mtn.md";
  });
  assert.equal(recovered, "verified.mtn.md");
  assert.equal(attempts, 2);
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
