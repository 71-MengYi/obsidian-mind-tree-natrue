import test from "node:test";
import assert from "node:assert/strict";
import {
  DocumentSession,
  createRecoveryDocument
} from "../src/services/document-session";
import { addNode, createEmptyDocument } from "../src/domain/tree";

test("save requests are serialized and a mutation during I/O schedules one more pass", async () => {
  const session = new DocumentSession();
  session.load("disk-0");
  session.markChanged();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const revisions: number[] = [];
  const save = session.requestSave(async () => {
    const revision = session.currentRevision;
    revisions.push(revision);
    if (revisions.length === 1) await firstBlocked;
    session.markSaved(revision, `disk-${revision}`);
    return session.dirty;
  });

  session.markChanged();
  const duplicateRequest = session.requestSave(async () => {
    const revision = session.currentRevision;
    revisions.push(revision);
    session.markSaved(revision, `disk-${revision}`);
    return session.dirty;
  });
  releaseFirst();
  await Promise.all([save, duplicateRequest]);

  assert.deepEqual(revisions, [1, 2]);
  assert.equal(session.sourceBaseline, "disk-2");
  assert.equal(session.dirty, false);
});

test("a shared session uses the newest view callback for a queued save pass", async () => {
  const session = new DocumentSession();
  session.load("baseline");
  session.markChanged();
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = session.requestSave(async () => {
    calls.push("first");
    await firstGate;
    return false;
  });
  const second = session.requestSave(async () => {
    calls.push("second");
    return false;
  });
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(calls, ["first", "second"]);
});

test("document session owns immutable 100-step history and recovery removes identity", () => {
  const session = new DocumentSession();
  session.load("source");
  const original = createEmptyDocument("Root");
  original.documentId = "linked-tree-id";
  const changed = session.execute(original, (draft) => { addNode(draft, draft.rootId, "Child"); });
  assert.equal(Object.keys(original.nodes).length, 1);
  assert.equal(Object.keys(changed.nodes).length, 2);
  assert.equal(session.undo(changed), original);
  assert.equal(session.redo(original), changed);

  const recovery = createRecoveryDocument(changed);
  assert.equal(recovery.documentId, undefined);
  assert.equal(changed.documentId, "linked-tree-id");
});
