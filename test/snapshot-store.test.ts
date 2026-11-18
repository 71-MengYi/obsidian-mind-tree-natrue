import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import {
  MAX_SNAPSHOT_SOURCE_BYTES,
  MAX_SNAPSHOTS_PER_TREE,
  SNAPSHOT_DIRECTORY,
  TreeSnapshotStore,
  restoreSnapshotDocument,
  snapshotKey,
  validateTreeSnapshot,
  type SnapshotCaptureInput,
  type SnapshotIO,
  type TreeSnapshot,
  type TreeSnapshotEntry
} from "../src/services/snapshot-store";

/** Deterministic adapter: no host filesystem and no timing dependency. */
class MemorySnapshotIO implements SnapshotIO {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  failWrite = false;
  failRemove = false;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const parent = (candidate: string): string => candidate.slice(0, candidate.lastIndexOf("/"));
    return {
      files: [...this.files.keys()].filter((file) => parent(file) === path),
      folders: [...this.folders].filter((folder) => parent(folder) === path)
    };
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing snapshot: ${path}`);
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(path, data);
  }

  async remove(path: string): Promise<void> {
    if (this.failRemove) throw new Error("cleanup denied");
    this.files.delete(path);
  }
}

function treeSource(title: string, documentId?: string, mutate?: (document: ReturnType<typeof createEmptyDocument>) => void): string {
  const document = createEmptyDocument(title);
  if (documentId) document.documentId = documentId;
  mutate?.(document);
  return serializeMindTreeFile(document);
}

function captureInput(source: string, options: {
  readonly path?: string;
  readonly documentId?: string;
  readonly title?: string;
  readonly nodeCount?: number;
} = {}): SnapshotCaptureInput {
  return {
    path: options.path ?? "Folder/Tree.mtn.md",
    ...(options.documentId ? { documentId: options.documentId } : {}),
    title: options.title ?? "Tree",
    nodeCount: options.nodeCount ?? 1,
    source
  };
}

function setup(now = 1_700_000_000_000) {
  const io = new MemorySnapshotIO();
  const errors: string[] = [];
  const warnings: string[] = [];
  const store = new TreeSnapshotStore(io, {
    now: () => now,
    logger: { error: (message) => { errors.push(message); }, warn: (message) => { warnings.push(message); } }
  });
  return { io, store, errors, warnings, setNow: (value: number) => { now = value; }, getNow: () => now };
}

const entryStub = (file: string): TreeSnapshotEntry => ({
  file, capturedAt: new Date(1_700_000_000_000).toISOString(), title: "Tree", nodeCount: 1, size: 10
});

test("a document id drives the directory key and a missing or unsafe id falls back to a stable path hash", () => {
  assert.equal(snapshotKey("Folder/Tree.mtn.md", "tree-123"), "tree-123");
  const hashed = snapshotKey("Folder\\Tree.mtn.md");
  assert.match(hashed, /^[0-9a-f]{16}$/);
  assert.equal(snapshotKey("Folder/Tree.mtn.md"), hashed);
  assert.match(snapshotKey("Folder/Tree.mtn.md", "../escape"), /^[0-9a-f]{16}$/);
  assert.match(snapshotKey("Folder/Tree.mtn.md", "x".repeat(81)), /^[0-9a-f]{16}$/);
});

test("a capture writes one versioned JSON file under the vault-root dot directory", async () => {
  const { io, store, errors, warnings } = setup();
  const source = treeSource("Tree", "tree-1");
  assert.equal(await store.capture(captureInput(source, { documentId: "tree-1", title: "Tree", nodeCount: 1 })), true);
  const file = `${SNAPSHOT_DIRECTORY}/tree-1/1700000000000-0001.json`;
  const text = io.files.get(file);
  assert.ok(text, "snapshot file must exist");
  const record = JSON.parse(text) as Record<string, unknown>;
  assert.equal(record["version"], 1);
  assert.equal(record["capturedAt"], new Date(1_700_000_000_000).toISOString());
  assert.equal(record["path"], "Folder/Tree.mtn.md");
  assert.equal(record["documentId"], "tree-1");
  assert.equal(record["title"], "Tree");
  assert.equal(record["nodeCount"], 1);
  assert.equal(record["source"], source);
  // The directory name is derived from identity, never from the note path.
  assert.ok([...io.files.keys()].every((path) => path.startsWith(`${SNAPSHOT_DIRECTORY}/`)));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("byte-identical saves are skipped and a changed source is appended", async () => {
  const context = setup();
  const { io, store } = context;
  const source = treeSource("Tree");
  assert.equal(await store.capture(captureInput(source)), true);
  context.setNow(context.getNow() + 1_000);
  assert.equal(await store.capture(captureInput(source)), false);
  assert.equal(io.files.size, 1);
  context.setNow(context.getNow() + 1_000);
  const changed = treeSource("Tree", undefined, (document) => {
    addNode(document, document.rootId, "Child");
  });
  assert.equal(await store.capture(captureInput(changed, { title: "Tree", nodeCount: 2 })), true);
  assert.equal(io.files.size, 2);
  const entries = await store.list(snapshotKey("Folder/Tree.mtn.md"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.file, "1700000002000-0001.json");
});

test("retention keeps only the newest snapshots for one tree", async () => {
  const context = setup();
  const { io, store } = context;
  const start = context.getNow();
  for (let index = 0; index < MAX_SNAPSHOTS_PER_TREE + 5; index += 1) {
    const source = treeSource(`Tree ${index}`, "tree-1");
    assert.equal(await store.capture(captureInput(source, { documentId: "tree-1", title: `Tree ${index}` })), true);
    context.setNow(context.getNow() + 1_000);
  }
  const entries = await store.list("tree-1");
  assert.equal(entries.length, MAX_SNAPSHOTS_PER_TREE);
  assert.equal(entries[0]?.capturedAt, new Date(context.getNow() - 1_000).toISOString());
  const files = [...io.files.keys()].filter((path) => path.includes("/tree-1/"));
  assert.equal(files.length, MAX_SNAPSHOTS_PER_TREE);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(!files.includes(`${SNAPSHOT_DIRECTORY}/tree-1/${start + index * 1_000}-0001.json`),
      "the oldest snapshots must be pruned");
  }
});

test("failed retention deletes are ignored and never reject a capture", async () => {
  const context = setup();
  const { io, store } = context;
  io.failRemove = true;
  for (let index = 0; index < MAX_SNAPSHOTS_PER_TREE + 2; index += 1) {
    const source = treeSource(`Tree ${index}`, "tree-1");
    assert.equal(await store.capture(captureInput(source, { documentId: "tree-1", title: `Tree ${index}` })), true);
    context.setNow(context.getNow() + 1_000);
  }
  assert.equal([...io.files.keys()].filter((path) => path.includes("/tree-1/")).length, MAX_SNAPSHOTS_PER_TREE + 2);
  assert.deepEqual(context.errors, []);
});

test("damaged and unknown-version files are skipped while valid rows list newest first", async () => {
  const context = setup();
  const { io, store } = context;
  const captured: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const source = treeSource(`Tree ${index}`, "tree-1");
    await store.capture(captureInput(source, { documentId: "tree-1", title: `Tree ${index}` }));
    captured.push(new Date(context.getNow()).toISOString());
    context.setNow(context.getNow() + 1_000);
  }
  const directory = `${SNAPSHOT_DIRECTORY}/tree-1`;
  io.files.set(`${directory}/9999999999999-0001.json`, "{not json");
  io.files.set(`${directory}/9999999999999-0002.json`,
    JSON.stringify({ version: 2, capturedAt: new Date().toISOString(), path: "Folder/Tree.mtn.md", title: "X", nodeCount: 1, source: "x" }));
  const entries = await store.list("tree-1");
  assert.deepEqual(entries.map((entry) => entry.capturedAt), [...captured].reverse());
  assert.equal(await store.load("tree-1", entryStub("9999999999999-0001.json")), undefined);
  assert.equal(await store.load("tree-1", entryStub("9999999999999-0002.json")), undefined);
  assert.equal(await store.list("../escape").then((value) => value.length), 0);
});

test("oversized sources and write failures are logged without note text and never reject", async () => {
  const context = setup();
  const marker = "SNAPSHOT-BODY-MARKER";
  const oversized = marker + "x".repeat(MAX_SNAPSHOT_SOURCE_BYTES);
  assert.equal(await context.store.capture(captureInput(oversized, { title: marker })), false);
  assert.equal(context.io.files.size, 0);
  assert.equal(context.warnings.length, 1);
  assert.doesNotMatch(context.warnings[0]!, new RegExp(marker));

  context.io.failWrite = true;
  const source = treeSource(marker);
  assert.equal(await context.store.capture(captureInput(source, { title: marker })), false);
  assert.equal(context.errors.length, 1);
  assert.doesNotMatch(context.errors[0]!, new RegExp(marker));
});

test("snapshot records reject unknown versions, traversal paths and out-of-range fields", () => {
  const source = treeSource("Tree", "tree-1");
  const base = {
    version: 1,
    capturedAt: new Date(1_700_000_000_000).toISOString(),
    path: "Tree.mtn.md",
    documentId: "tree-1",
    title: "Tree",
    nodeCount: 1,
    source
  };
  assert.ok(validateTreeSnapshot(base));
  assert.equal(validateTreeSnapshot({ ...base, version: 2 }), undefined);
  assert.equal(validateTreeSnapshot({ ...base, path: "../Tree.mtn.md" }), undefined);
  assert.equal(validateTreeSnapshot({ ...base, path: "Notes/Tree.md" }), undefined);
  assert.equal(validateTreeSnapshot({ ...base, nodeCount: -1 }), undefined);
  assert.equal(validateTreeSnapshot({ ...base, documentId: "bad id" }), undefined);
  assert.equal(validateTreeSnapshot({ ...base, source: "x".repeat(MAX_SNAPSHOT_SOURCE_BYTES + 1) }), undefined);
});

test("restore parses a snapshot only after identity and path prove it belongs to the open tree", () => {
  const document = createEmptyDocument("Tree");
  document.documentId = "tree-1";
  const snapshot: TreeSnapshot = {
    version: 1,
    capturedAt: new Date(1_700_000_000_000).toISOString(),
    path: "Folder/Tree.mtn.md",
    documentId: "tree-1",
    title: "Tree",
    nodeCount: 1,
    source: serializeMindTreeFile(document)
  };
  const accepted = restoreSnapshotDocument(snapshot, { path: "Folder/Tree.mtn.md", documentId: "tree-1" });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.document.documentId, "tree-1");
    assert.equal(accepted.document.title, "Tree");
  }
  assert.deepEqual(restoreSnapshotDocument(snapshot, { path: "Folder/Tree.mtn.md", documentId: "tree-2" }),
    { ok: false, reason: "mismatch" });
  // Identity wins over the path: a renamed tree keeps its history.
  assert.equal(restoreSnapshotDocument(snapshot, { path: "Renamed/Tree.mtn.md", documentId: "tree-1" }).ok, true);

  const anonymous = createEmptyDocument("Anonymous");
  const anonymousSnapshot: TreeSnapshot = {
    ...snapshot,
    path: "Anonymous.mtn.md",
    documentId: undefined,
    source: serializeMindTreeFile(anonymous)
  };
  assert.equal(restoreSnapshotDocument(anonymousSnapshot, { path: "Anonymous.mtn.md" }).ok, true);
  assert.deepEqual(restoreSnapshotDocument(anonymousSnapshot, { path: "Other.mtn.md" }),
    { ok: false, reason: "mismatch" });
  // One-sided identity is not provably the same tree.
  assert.deepEqual(restoreSnapshotDocument(anonymousSnapshot, { path: "Anonymous.mtn.md", documentId: "tree-1" }),
    { ok: false, reason: "mismatch" });

  assert.deepEqual(restoreSnapshotDocument({ ...snapshot, source: "not a mind tree" },
    { path: "Folder/Tree.mtn.md", documentId: "tree-1" }), { ok: false, reason: "invalid" });
  // Metadata identity must match what the content actually parses to.
  assert.deepEqual(restoreSnapshotDocument({ ...anonymousSnapshot, documentId: "tree-1" },
    { path: "Anonymous.mtn.md", documentId: "tree-1" }), { ok: false, reason: "invalid" });
});
