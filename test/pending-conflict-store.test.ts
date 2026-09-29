import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import { PendingConflictStore, validatePendingConflict, type PendingConflictRecord } from "../src/services/pending-conflict-store";
import { MemoryConflictIO } from "./helpers/pending-conflict-io";

function setup() {
  const io = new MemoryConflictIO();
  const store = new PendingConflictStore(io, ".obsidian/plugins/mtn", "client-a");
  const source = serializeMindTreeFile(createEmptyDocument("Tree"));
  const record: PendingConflictRecord = { version: 1, id: "pending-1", path: "Tree.mtn.md", baselineSource: source, currentSource: source };
  return { io, store, record };
}

test("journal is isolated by device and captures immutable bytes before queuing", async () => {
  const { io, store, record } = setup();
  const writing = store.put(record);
  record.path = "Other.mtn.md";
  await writing;
  assert.ok(await store.load("Tree.mtn.md"));
  assert.equal(await store.load(record.path), undefined);
  const other = new PendingConflictStore(io, ".obsidian/plugins/mtn", "client-b");
  assert.equal(await other.load("Tree.mtn.md"), undefined);
  assert.ok([...io.files.keys()].every((path) => path.startsWith(store.directory)));
});

test("failed readback does not claim durability and can be retried without removing local data", async () => {
  const { io, store, record } = setup();
  io.corruptReadback = true;
  await assert.rejects(store.put(record), /verification/);
  assert.equal(io.files.size, 1);
  io.corruptReadback = false;
  await store.put(record);
  assert.deepEqual(await store.load(record.path), record);
});

test("invalid locators, draft nodes and source formats are rejected", () => {
  const { record } = setup();
  for (const path of ["../Tree.mtn.md", "/Tree.mtn.md", "a//Tree.mtn.md", "a/./Tree.mtn.md", "file.md"]) {
    assert.throws(() => validatePendingConflict({ ...record, path }));
  }
  assert.throws(() => validatePendingConflict({ ...record, id: "../record" }));
  assert.throws(() => validatePendingConflict({ ...record, draft: { nodeId: "absent", originalTitle: "", value: "" } }));
  assert.throws(() => validatePendingConflict({ ...record, currentSource: "broken" }));
});

test("duplicate locator and changed cleanup receipt block cleanup without deleting records", async () => {
  const { io, store, record } = setup();
  await store.put(record);
  await store.put({ ...record, id: "pending-2" });
  await assert.rejects(store.load(record.path), /Multiple unresolved/);
  assert.equal(io.files.size, 2);
  await store.put({ ...record, receipt: { choice: "external", phase: "verified", source: record.currentSource } });
  await assert.rejects(store.remove(record), /changed before cleanup/);
  assert.equal(io.files.size, 2);
});
