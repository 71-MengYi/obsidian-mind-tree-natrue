import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { createBranchReference } from "../src/domain/branch-reference";
import { serializeMindTreeFile } from "../src/format/document";
import { MindTreeReferenceService } from "../src/services/mind-tree-reference";
import type { MindTreeDocument } from "../src/types";

function treeSource(documentId: string, titles: readonly string[]): { source: string; document: MindTreeDocument; childIds: string[] } {
  const document = createEmptyDocument("Root");
  document.documentId = documentId;
  const childIds = titles.map((title) => addNode(document, document.rootId, title).id);
  return { source: serializeMindTreeFile(document), document, childIds };
}

function harness(files: Record<string, string>, index: Record<string, string[]> = {}): {
  files: Map<string, string>;
  index: Map<string, string[]>;
  reads: string[];
  service: MindTreeReferenceService;
} {
  const fileMap = new Map(Object.entries(files));
  const indexMap = new Map(Object.entries(index));
  const reads: string[] = [];
  const service = new MindTreeReferenceService({
    fileExists: (path) => fileMap.has(path),
    read: async (path) => {
      reads.push(path);
      const source = fileMap.get(path);
      if (source === undefined) throw new Error("missing file");
      return source;
    },
    parseOptions: () => ({}),
    indexedTreePaths: (documentId) => indexMap.get(documentId) ?? []
  });
  return { files: fileMap, index: indexMap, reads, service };
}

test("a reference resolves through its path hint while the node still exists", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { service, reads } = harness({ "Notes/A.mtn.md": tree.source });
  const reference = createBranchReference("tree-a", tree.childIds[0]!, "Notes/A.mtn.md");
  const resolution = await service.resolve(reference);
  assert.equal(resolution.kind, "ready");
  assert.equal(resolution.kind === "ready" ? resolution.path : "", "Notes/A.mtn.md");
  assert.equal(resolution.kind === "ready" ? resolution.document.documentId : "", "tree-a");
  assert.deepEqual(reads, ["Notes/A.mtn.md"]);
});

test("a deleted node invalidates the reference while the tree stays valid", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { service } = harness({ "Notes/A.mtn.md": tree.source });
  const gone = await service.resolve(createBranchReference("tree-a", "gone-node", "Notes/A.mtn.md"));
  assert.equal(gone.kind, "missing-node");
  // The resolved path is reported so the placeholder can still open the tree.
  assert.equal(gone.kind === "missing-node" ? gone.path : "", "Notes/A.mtn.md");
  assert.equal((await service.resolve(createBranchReference("tree-a", tree.document.rootId, "Notes/A.mtn.md"))).kind, "ready");
});

test("renaming the tree file keeps the reference valid through the identity index", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { files, index, service } = harness({ "Old/A.mtn.md": tree.source }, { "tree-a": ["Old/A.mtn.md"] });
  const reference = createBranchReference("tree-a", tree.childIds[0]!, "Old/A.mtn.md");
  assert.equal((await service.resolve(reference)).kind, "ready");
  files.delete("Old/A.mtn.md");
  files.set("New/A.mtn.md", tree.source);
  index.set("tree-a", ["New/A.mtn.md"]);
  service.notifyRenamed("Old/A.mtn.md", "New/A.mtn.md");
  const resolution = await service.resolve(reference);
  assert.equal(resolution.kind, "ready");
  assert.equal(resolution.kind === "ready" ? resolution.path : "", "New/A.mtn.md");
});

test("a reused path whose identity differs fails closed instead of showing the wrong tree", async () => {
  const replaced = treeSource("tree-b", ["Other"]);
  const { service } = harness({ "Notes/A.mtn.md": replaced.source });
  assert.equal((await service.resolve(createBranchReference("tree-a", "any", "Notes/A.mtn.md"))).kind, "missing-tree");
});

test("two files with one identity are reported as ambiguous, never guessed", async () => {
  const first = treeSource("tree-a", ["Branch"]);
  const second = treeSource("tree-a", ["Branch"]);
  const { service } = harness({ "One.mtn.md": first.source, "Two.mtn.md": second.source },
    { "tree-a": ["One.mtn.md", "Two.mtn.md"] });
  assert.equal((await service.resolve(createBranchReference("tree-a", first.childIds[0]!, "One.mtn.md"))).kind, "ambiguous");
});

test("missing or damaged files report missing-tree and unreadable without throwing", async () => {
  const { service } = harness({ "Broken.mtn.md": "---\nschemaVersion: 2\n---\n# Broken\n" });
  assert.equal((await service.resolve(createBranchReference("tree-a", "node", "Broken.mtn.md"))).kind, "unreadable");
  assert.equal((await service.resolve(createBranchReference("tree-a", "node"))).kind, "missing-tree");
});

test("parsed trees are shared by every embed of the same file", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { service, reads } = harness({ "Notes/A.mtn.md": tree.source });
  const first = createBranchReference("tree-a", tree.document.rootId, "Notes/A.mtn.md");
  const second = createBranchReference("tree-a", tree.childIds[0]!, "Notes/A.mtn.md");
  await Promise.all([service.resolve(first), service.resolve(second), service.resolve(first)]);
  assert.deepEqual(reads, ["Notes/A.mtn.md"]);
  // A vault event for that path drops only that path's parsed copy.
  service.notifyChanged("Notes/A.mtn.md");
  await service.resolve(first);
  assert.equal(reads.length, 2);
});

test("a failed parse is retried instead of being cached forever", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { files, service, reads } = harness({ "Notes/A.mtn.md": "---\nschemaVersion: 2\n---\n# Broken\n" });
  const reference = createBranchReference("tree-a", tree.document.rootId, "Notes/A.mtn.md");
  assert.equal((await service.resolve(reference)).kind, "unreadable");
  files.set("Notes/A.mtn.md", tree.source);
  assert.equal((await service.resolve(reference)).kind, "ready");
  assert.deepEqual(reads, ["Notes/A.mtn.md", "Notes/A.mtn.md"]);
});

test("subscribers hear every vault notification and can unsubscribe", async () => {
  const tree = treeSource("tree-a", ["Branch"]);
  const { service } = harness({ "Notes/A.mtn.md": tree.source });
  let calls = 0;
  const unsubscribe = service.subscribe(() => { calls += 1; });
  service.notifyChanged("Notes/A.mtn.md");
  service.notifyRemoved("Notes/A.mtn.md");
  service.notifyRenamed("Old.mtn.md", "New.mtn.md");
  service.notifyChanged();
  assert.equal(calls, 4);
  unsubscribe();
  service.notifyChanged("Notes/A.mtn.md");
  assert.equal(calls, 4);
  // A throwing listener must not stop the remaining ones.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = () => { errors.push("reported"); };
  try {
    service.subscribe(() => { throw new Error("listener failed"); });
    let reached = false;
    service.subscribe(() => { reached = true; });
    service.notifyChanged("Notes/A.mtn.md");
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
  service.destroy();
});
