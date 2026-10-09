import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import { PendingConflictStore, resolvePendingConflict, validatePendingConflict, type PendingConflictEntry, type PendingConflictRecord } from "../src/services/pending-conflict-store";
import { MemoryConflictIO } from "./helpers/pending-conflict-io";

function setup() {
  const io = new MemoryConflictIO();
  const store = new PendingConflictStore(io, ".obsidian/plugins/mtn", "client-a");
  const source = serializeMindTreeFile(createEmptyDocument("Tree"));
  const record: PendingConflictRecord = { version: 1, id: "pending-1", path: "Tree.mtn.md", baselineSource: source, currentSource: source };
  const entry: PendingConflictEntry = { id: record.id, path: record.path, record };
  return { io, store, record, entry };
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
  const { io, store, record, entry } = setup();
  await store.put(record);
  await store.put({ ...record, id: "pending-2" });
  await assert.rejects(store.load(record.path), /Multiple unresolved/);
  assert.equal(io.files.size, 2);
  await store.put({ ...record, receipt: { choice: "external", phase: "verified", source: record.currentSource } });
  await assert.rejects(store.remove(entry), /changed before cleanup/);
  assert.equal(io.files.size, 2);
});

test("relocation re-points one record in place and refuses to act on a changed record", async () => {
  const { io, store, record, entry } = setup();
  await store.put(record);
  await store.rekey(entry, "Folder/Moved.mtn.md");
  assert.equal(await store.load(record.path), undefined);
  assert.equal((await store.load("Folder/Moved.mtn.md"))?.id, record.id);
  assert.equal(io.files.size, 1);
  const moved = (await store.pendingRecords())[0]!;
  // The stored bytes are now a different record than the entry being relocated.
  await store.put({ ...moved.record, currentSource: moved.record.currentSource.replace("Tree", "Other") });
  await assert.rejects(store.rekey(moved, "Elsewhere.mtn.md"), /changed before relocation/);
  assert.equal(io.files.size, 1);
});

test("cleanup by record content removes only the verified record", async () => {
  const { io, store, record, entry } = setup();
  await store.put(record);
  await store.remove(entry);
  assert.equal(io.files.size, 0);
  assert.deepEqual(await store.pendingRecords(), []);
});

test("journal cleanup decides from identity evidence and never guesses a location", () => {
  const recordPath = "Tree.mtn.md";
  const at = (recordDocumentId: string | undefined, recordedPathDocumentId: string | undefined,
    identityPaths: string[], recordedPathExists = true) => resolvePendingConflict({
      ...(recordDocumentId ? { recordDocumentId } : {}),
      ...(recordedPathDocumentId ? { recordedPathDocumentId } : {}),
      recordedPathExists, identityPaths, recordPath
    }).kind;
  // The recorded path still holds the same document, with or without an ID.
  assert.equal(at("id-a", "id-a", [recordPath]), "live");
  assert.equal(at("id-a", undefined, [recordPath]), "live");
  assert.equal(at(undefined, undefined, [recordPath]), "live");
  // A different established identity now lives at the recorded path.
  assert.equal(at("id-a", "id-b", [recordPath]), "stale-path");
  // The file moved: exactly one live path carries the recorded identity.
  assert.deepEqual(resolvePendingConflict({
    recordDocumentId: "id-a", recordedPathExists: false,
    identityPaths: ["Folder/Moved.mtn.md"], recordPath
  }), { kind: "rebind", path: "Folder/Moved.mtn.md" });
  // Ambiguous or unidentifiable cases keep the record and are reported.
  assert.equal(at("id-a", undefined, ["One.mtn.md", "Two.mtn.md"], false), "retain");
  assert.equal(at("id-a", undefined, [], false), "retain");
  assert.equal(at(undefined, undefined, ["One.mtn.md"], false), "retain");
  // Nothing left anywhere and nothing recorded: the resolved record is disposable.
  assert.equal(at(undefined, undefined, [], false), "live");
});
