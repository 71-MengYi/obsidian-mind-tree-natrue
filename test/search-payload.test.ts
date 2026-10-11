import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchCandidates, buildSearchParentIndex, nodeAncestorIds, normalizeSearchPath, resolveSearchMarkdownFiles } from "../src/ui/search/search-payload";
import type { FileResourceRef, MindTreeDocument, MindTreeNode } from "../src/types";

/**
 * The search window must stay bounded: only node titles, file names and the
 * Markdown files behind those nodes are searched. These rules decide what the
 * vault is allowed to read, so they are pinned here independently of Obsidian.
 */

function node(id: string, title: string, resource?: FileResourceRef, childIds: string[] = []): MindTreeNode {
  return resource
    ? { id, title, childIds, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", resource }
    : { id, title, childIds, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function fileRef(resourceId: string, pathHint: string): FileResourceRef {
  return { type: "file", resourceId, pathHint, fileKind: "note" };
}

function documentWith(nodes: MindTreeNode[]): MindTreeDocument {
  const map: Record<string, MindTreeNode> = {};
  for (const entry of nodes) map[entry.id] = entry;
  return {
    rootId: nodes[0]?.id ?? "root",
    title: "Tree",
    nodes: map,
    settings: {
      layoutMode: "right", recursiveScan: false, collectionMode: "off",
      theme: "flat", connectionStyle: "theme", nodeShape: "rounded"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

/** Every node id the document contains, which is what the accessor validates against. */
function documentIds(document: MindTreeDocument): string[] {
  return Object.keys(document.nodes);
}

test("search candidates follow node order and keep plain titles for matching", () => {
  const document = documentWith([
    node("root", "Root"),
    node("bold", "**Bold** title", fileRef("res-1", "Notes/Bold.md")),
    node("plain", "Plain node"),
    node("second", "Second", fileRef("res-2", "Notes/Second.md"))
  ]);
  const candidates = buildSearchCandidates(document, undefined);
  // File-backed nodes come first in node order, then the fileless ones; the
  // read budget must cover the same files on every call.
  assert.deepEqual(candidates.map((entry) => entry.nodeId), ["bold", "second", "root", "plain"]);
  assert.deepEqual(buildSearchCandidates(document, undefined).map((entry) => entry.nodeId), ["bold", "second", "root", "plain"]);
  const byId = new Map(candidates.map((entry) => [entry.nodeId, entry]));
  assert.equal(byId.get("bold")!.title, "**Bold** title");
  assert.equal(byId.get("bold")!.plainTitle, "Bold title");
  assert.equal(byId.get("bold")!.fileName, "Bold");
  assert.equal(byId.get("bold")!.path, "Notes/Bold.md");
  assert.equal(byId.get("plain")!.resourceId, undefined);
  assert.equal(byId.get("plain")!.path, undefined);
});

test("the current mind tree is never a search candidate and repeated resources appear once", () => {
  const shared = fileRef("res-shared", "Notes/Shared.md");
  const document = documentWith([
    node("root", "Root"),
    node("self", "This tree", fileRef("res-self", "Maps/Current.mtn.md")),
    node("one", "One", shared),
    node("two", "Two", shared)
  ]);
  const candidates = buildSearchCandidates(document, "Maps/Current.mtn.md");
  assert.deepEqual(candidates.map((entry) => entry.nodeId), ["one", "root"]);
});

test("a URL node is still searchable by title even though it has no file content", () => {
  const urlNode: MindTreeNode = {
    id: "link", title: "Docs site", childIds: [], createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resource: { type: "url", url: "https://example.com/docs" }
  };
  const document = documentWith([node("root", "Root"), urlNode]);
  const candidates = buildSearchCandidates(document, undefined);
  const link = candidates.find((entry) => entry.nodeId === "link");
  assert.ok(link, "a URL node must reach the search list");
  assert.equal(link.plainTitle, "Docs site");
  assert.equal(link.path, undefined);
  assert.equal(link.resourceId, undefined);
});

test("path comparison is separator and prefix tolerant", () => {
  assert.equal(normalizeSearchPath("Notes\\Sub\\A.md"), "Notes/Sub/A.md");
  assert.equal(normalizeSearchPath("./Notes/A.md"), "Notes/A.md");
  const document = documentWith([node("a", "A", fileRef("res-1", "Notes\\A.md"))]);
  assert.deepEqual(buildSearchCandidates(document, "Notes/A.md"), []);
});

test("only verified Markdown files are read, and one failure never drops the rest", async () => {
  const requested: FileResourceRef[] = [];
  const files = new Map([
    ["Notes/A.md", { path: "Notes/A.md" }],
    ["Notes/B.mtn.md", { path: "Notes/B.mtn.md" }],
    ["Assets/C.png", { path: "Assets/C.png" }],
    ["Notes/Moved.md", { path: "Notes/Moved.md" }]
  ]);
  const candidates = buildSearchCandidates(documentWith([
    node("a", "A", fileRef("res-a", "Notes/A.md")),
    node("b", "B", fileRef("res-b", "Notes/B.mtn.md")),
    node("c", "C", fileRef("res-c", "Assets/C.png")),
    node("d", "D", fileRef("res-d", "Notes/Old.md")),
    node("e", "E", fileRef("res-e", "Notes/Broken.md")),
    node("f", "F", fileRef("res-f", "Notes/Moved.md"))
  ]), undefined);
  const resolved = await resolveSearchMarkdownFiles({
    resolveVerified: async (reference) => {
      requested.push(reference);
      if (reference.resourceId === "res-e") throw new Error("index unavailable");
      // A moved file resolves to its current path instead of the stored hint.
      if (reference.resourceId === "res-d") return files.get("Notes/Moved.md");
      return files.get(reference.pathHint);
    }
  }, candidates, undefined);

  assert.deepEqual(resolved.map((entry) => entry.path), ["Notes/A.md", "Notes/Moved.md"]);
  // Every reference is verified with an explicit file kind, never guessed.
  assert.equal(requested.length, 6);
  assert.equal(requested[0]!.fileKind, "note");
});

test("the current file and another mind tree are excluded after resolution", async () => {
  const files = new Map([
    ["Maps/Current.mtn.md", { path: "Maps/Current.mtn.md" }],
    ["Maps/Other.mtn.md", { path: "Maps/Other.mtn.md" }],
    ["Notes/A.md", { path: "Notes/A.md" }]
  ]);
  const candidates = buildSearchCandidates(documentWith([
    node("a", "A", fileRef("res-a", "Stale/A.md")),
    node("b", "Other", fileRef("res-b", "Maps/Other.mtn.md"))
  ]), "Maps/Current.mtn.md");
  // The stale hint resolves to the current file, which must still be excluded.
  const resolved = await resolveSearchMarkdownFiles({
    resolveVerified: async (reference) => reference.resourceId === "res-a"
      ? files.get("Maps/Current.mtn.md")
      : files.get(reference.pathHint)
  }, candidates, "Maps/Current.mtn.md");
  assert.deepEqual(resolved, []);
});

test("result cards carry the root-to-node path so every ancestor stays clickable", () => {
  const document = documentWith([
    node("root", "Root", undefined, ["mid"]),
    node("mid", "Middle", undefined, ["leaf"]),
    node("leaf", "Leaf", fileRef("res-leaf", "Notes/Leaf.md")),
    node("other", "Other")
  ]);
  // The lazy ancestor walk mirrors `SearchCandidate.ancestorIds`: root first, no self.
  const ancestry = nodeAncestorIds(buildSearchParentIndex(document), new Set(Object.keys(document.nodes)));
  assert.deepEqual(ancestry("root"), []);
  assert.deepEqual(ancestry("mid"), ["root"]);
  assert.deepEqual(ancestry("leaf"), ["root", "mid"]);
  assert.deepEqual(ancestry("other"), []);

  const paths = new Map<string, readonly string[]>(
    Object.keys(document.nodes).map((nodeId) => [nodeId, ancestry(nodeId) ?? []])
  );
  const candidates = buildSearchCandidates(document, undefined, paths);
  const leaf = candidates.find((entry) => entry.nodeId === "leaf");
  assert.deepEqual(leaf?.ancestorIds, ["root", "mid"]);
  assert.deepEqual(candidates.find((entry) => entry.nodeId === "root")?.ancestorIds, []);
});

test("a cycling or duplicated parent chain terminates without repeated ancestors", () => {
  const document = documentWith([
    node("a", "A", undefined, ["b"]),
    node("b", "B", undefined, ["a"])
  ]);
  // findParentId prefers the first parent that lists the child, so this cycle
  // must still terminate and never list the node twice.
  const ancestry = nodeAncestorIds(buildSearchParentIndex(document), new Set(Object.keys(document.nodes)));
  for (const nodeId of Object.keys(document.nodes)) {
    const chain = ancestry(nodeId) ?? [];
    assert.equal(new Set(chain).size, chain.length, "no ancestor may repeat");
  }
  // A self-referencing parent must not appear in its own ancestor list either.
  const selfParent = documentWith([node("solo", "Solo", undefined, ["solo"])]);
  const soloAncestry = nodeAncestorIds(buildSearchParentIndex(selfParent), new Set(["solo"]));
  assert.deepEqual(soloAncestry("solo"), []);
});

test("candidates without an ancestor map stay path-free instead of throwing", () => {
  const document = documentWith([node("root", "Root"), node("child", "Child", fileRef("res-1", "Notes/Child.md"))]);
  const candidates = buildSearchCandidates(document, undefined);
  for (const candidate of candidates) assert.deepEqual(candidate.ancestorIds, []);
});

test("the lazy ancestor accessor answers per node and keeps cycles finite", () => {
  const document = documentWith([
    node("root", "Root", undefined, ["mid"]),
    node("mid", "Middle", undefined, ["leaf"]),
    node("leaf", "Leaf"),
    node("orphan", "Orphan")
  ]);
  const ancestors = nodeAncestorIds(buildSearchParentIndex(document), new Set(documentIds(document)));
  assert.deepEqual(ancestors("root"), []);
  assert.deepEqual(ancestors("leaf"), ["root", "mid"]);
  // A parentless node is the root and answers with an empty chain; a node the
  // document does not contain answers `undefined` so the two stay distinct.
  assert.deepEqual(ancestors("orphan"), []);
  assert.equal(ancestors("missing"), undefined);

  // A self-parented node must not list itself as its own ancestor.
  const selfParent = documentWith([node("solo", "Solo", undefined, ["solo"])]);
  assert.deepEqual(nodeAncestorIds(buildSearchParentIndex(selfParent), new Set(["solo"]))("solo"), []);
});
