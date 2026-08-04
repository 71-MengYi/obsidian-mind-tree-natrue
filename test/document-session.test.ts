import test from "node:test";
import assert from "node:assert/strict";
import {
  DocumentSession,
  changesOnlyGeneratedOutline,
  createRecoveryDocument
} from "../src/services/document-session";
import { OUTLINE_END, OUTLINE_START } from "../src/format/outline";
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
    throw new Error("coalesced requests use the active view save task");
  });
  releaseFirst();
  await Promise.all([save, duplicateRequest]);

  assert.deepEqual(revisions, [1, 2]);
  assert.equal(session.sourceBaseline, "disk-2");
  assert.equal(session.dirty, false);
});

test("generated outline-only changes are not treated as user data conflicts", () => {
  const prefix = "---\nschemaVersion: 2\n---\n\nUser prose\n\n";
  const suffix = "\n\nUser footer";
  const baseline = `${prefix}${OUTLINE_START}\n- Old\n${OUTLINE_END}${suffix}`;
  const externalOutline = `${prefix}${OUTLINE_START}\n- New\n${OUTLINE_END}${suffix}`;
  const externalMarkdown = `${prefix}Changed prose\n\n${OUTLINE_START}\n- New\n${OUTLINE_END}${suffix}`;

  assert.equal(changesOnlyGeneratedOutline(baseline, externalOutline), true);
  assert.equal(changesOnlyGeneratedOutline(baseline, externalMarkdown), false);
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
