import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { McpToolError } from "../src/services/mcp/tool-error";

// Reading parses and projects real `.mtn.md` bytes; only the host language lookup
// is stubbed, so the assertions cover the reader rather than a fake of it. The
// mock URL is unique to this file: one process shares the ESM cache by URL.
const mockUrl = "file:///mind-tree-test-host/obsidian-tree-reader.mjs";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "obsidian" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === mockUrl ? { format: "module", shortCircuit: true, source:
      'export const getLanguage = () => "en";' } : next(url, context);
  }
});
const { MindTreeReader, createMcpNodeView } = await import("../src/services/mcp/tree-reader");
const { createEmptyDocument, addNode, createId } = await import("../src/domain/tree");
const { getDocumentTreeIndex } = await import("../src/domain/tree-index");
const { serializeMindTreeFile } = await import("../src/format/document");
const { t } = await import("../src/i18n");
hooks.deregister();

const PATH = "Folder/Tree.mtn.md";

function buildTree() {
  const document = createEmptyDocument("Tree");
  const alpha = addNode(document, document.rootId, "Alpha");
  const beta = addNode(document, document.rootId, "Beta");
  const gamma = addNode(document, alpha.id, "Gamma");
  const delta = addNode(document, alpha.id, "Delta");
  beta.markers = [{ type: "progress", value: "done" }];
  beta.collapsed = true;
  beta.nodeLink = gamma.id;
  beta.resource = { type: "file", resourceId: "rid-beta", pathHint: "Notes/Beta.md", fileKind: "note" };
  return {
    source: serializeMindTreeFile(document),
    rootId: document.rootId,
    alpha: alpha.id, beta: beta.id, gamma: gamma.id, delta: delta.id
  };
}

function fixture(files: Record<string, string>, cacheLimit = 32) {
  const sources = new Map(Object.entries(files));
  const reads: string[] = [];
  const reader = new MindTreeReader({
    filePaths: () => [...sources.keys()],
    read: async (path) => {
      reads.push(path);
      const source = sources.get(path);
      if (source === undefined) throw new Error(`missing file: ${path}`);
      return source;
    },
    parseOptions: () => ({})
  }, cacheLimit);
  return { reader, sources, reads };
}

async function expectError(run: () => Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof McpToolError, `expected McpToolError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

test("list_trees enumerates mind trees only, sorted, without unreadable files", async () => {
  const tree = buildTree();
  const other = buildTree();
  const { reader } = fixture({
    "B/Two.mtn.md": other.source,
    "A/One.mtn.md": tree.source,
    "Notes/plain.md": "# note",
    "A/Broken.mtn.md": "not a mind tree at all"
  });
  const summaries = await reader.listTrees();
  assert.deepEqual(summaries.map((summary) => summary.path), ["A/One.mtn.md", "B/Two.mtn.md"]);
  assert.equal(summaries[0]!.title, "Tree");
  assert.equal(summaries[0]!.nodeCount, 5);
  assert.equal(summaries[0]!.documentId, undefined);
});

test("read_tree pages through document order with parents and depths", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  const page = await reader.readTree(PATH, 3, 0);

  assert.equal(page.rootId, tree.rootId);
  assert.equal(page.nodeCount, 5);
  assert.equal(page.total, 5);
  assert.equal(page.returned, 3);
  assert.equal(page.nextOffset, 3);
  assert.deepEqual(page.nodes.map((node) => node.title), ["Tree", "Alpha", "Gamma"]);
  assert.deepEqual(page.nodes.map((node) => node.depth), [0, 1, 2]);
  assert.equal(page.nodes[0]!.parentId, null);
  assert.equal(page.nodes[1]!.parentId, tree.rootId);

  const rest = await reader.readTree(PATH, 3, 3);
  assert.deepEqual(rest.nodes.map((node) => node.title), ["Delta", "Beta"]);
  assert.equal(rest.returned, 2);
  assert.equal(rest.nextOffset, undefined);
  const past = await reader.readTree(PATH, 10, 99);
  assert.equal(past.returned, 0);
  assert.equal(past.nextOffset, undefined);
});

test("read_tree bounds a request that asks for everything", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  const page = await reader.readTree(PATH, 100_000, -5);
  assert.equal(page.returned, 5);
});

test("find_nodes matches titles case-insensitively and honours the limit", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  assert.deepEqual((await reader.findNodes(PATH, "a", 2)).map((row) => row.title), ["Alpha", "Gamma"]);
  assert.deepEqual((await reader.findNodes(PATH, "DELTA", 10)).map((row) => row.title), ["Delta"]);
  // An empty query browses instead of matching nothing.
  assert.deepEqual((await reader.findNodes(PATH, "   ", 2)).map((row) => row.title), ["Tree", "Alpha"]);
  assert.deepEqual(await reader.findNodes(PATH, "nothing", 10), []);
});

test("single-node reads project the parent, children and path", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });

  const alpha = await reader.getNode(PATH, tree.alpha);
  assert.equal(alpha.parentId, tree.rootId);
  assert.deepEqual(alpha.childIds, [tree.gamma, tree.delta]);
  assert.equal(alpha.depth, 1);

  assert.equal(await reader.getParent(PATH, tree.rootId), null);
  assert.equal((await reader.getParent(PATH, tree.gamma))!.id, tree.alpha);

  assert.deepEqual((await reader.getChildren(PATH, tree.alpha, false)).map((node) => node.title), ["Gamma", "Delta"]);
  assert.deepEqual((await reader.getChildren(PATH, tree.alpha, true)).map((node) => node.title), ["Gamma", "Delta"]);
  assert.deepEqual((await reader.getChildren(PATH, tree.rootId, true)).map((node) => node.title),
    ["Alpha", "Gamma", "Delta", "Beta"]);

  assert.deepEqual((await reader.getNodePath(PATH, tree.delta)).map((entry) => entry.title), ["Tree", "Alpha", "Delta"]);
});

test("linked files and node links are reported as copies, never as shared state", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  const linked = await reader.getLinkedFiles(PATH, tree.beta);
  assert.deepEqual(linked, {
    id: tree.beta,
    resource: { type: "file", resourceId: "rid-beta", pathHint: "Notes/Beta.md", fileKind: "note" },
    nodeLink: tree.gamma
  });
  (linked.resource as { pathHint: string }).pathHint = "mutated";
  const again = await reader.getLinkedFiles(PATH, tree.beta);
  assert.equal((again.resource as { pathHint: string }).pathHint, "Notes/Beta.md");

  const beta = await reader.getNode(PATH, tree.beta);
  assert.deepEqual(beta.markers, [{ type: "progress", value: "done" }]);
  assert.equal(beta.collapsed, true);
  assert.equal(beta.nodeLink, tree.gamma);
});

test("tree stats count files, reachable nodes and depth", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  assert.deepEqual(await reader.getTreeStats(PATH), {
    path: PATH,
    title: "Tree",
    nodeCount: 5,
    fileCount: 1,
    depth: 2
  });
});

test("a dangling child id is ignored by the traversal and the projection", async () => {
  // A hand-edited compressed payload can name a child that is not in the node
  // map; the serializer refuses to produce one, so the defect is built in memory.
  const document = createEmptyDocument("Tree");
  const child = addNode(document, document.rootId, "Child");
  document.nodes[document.rootId]!.childIds.push("missing-node");

  const view = createMcpNodeView(document, document.rootId);
  assert.deepEqual(view.childIds, [child.id]);
  assert.deepEqual([...getDocumentTreeIndex(document).preorderIds], [document.rootId, child.id]);
});

test("parsed trees are cached, re-read after invalidation, and bounded", async () => {
  const tree = buildTree();
  const { reader, reads } = fixture({
    [PATH]: tree.source,
    "B/Two.mtn.md": buildTree().source,
    "C/Three.mtn.md": buildTree().source,
    "D/Four.mtn.md": buildTree().source
  }, 2);

  await reader.getNode(PATH, tree.alpha);
  await reader.getNode(PATH, tree.beta);
  assert.equal(reads.length, 1);

  reader.invalidate(PATH);
  await reader.getNode(PATH, tree.alpha);
  assert.equal(reads.length, 2);

  // With a limit of two, the oldest entry is evicted before the third path.
  await reader.getTreeStats("B/Two.mtn.md");
  await reader.getTreeStats("C/Three.mtn.md");
  await reader.getTreeStats("D/Four.mtn.md");
  const before = reads.length;
  await reader.getTreeStats("B/Two.mtn.md");
  assert.equal(reads.length, before + 1);

  reader.invalidateAll();
  await reader.getNode(PATH, tree.alpha);
  assert.equal(reads.length, before + 2);
});

test("unknown, unreadable and non-tree paths fail by name", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source, "A/Broken.mtn.md": "definitely not a mind tree" });
  await expectError(() => reader.getNode("Missing.mtn.md", tree.alpha), "tree-not-found",
    t("mcp.error.treeNotFound", { target: "Missing.mtn.md" }));
  await expectError(() => reader.getNode("Notes/plain.md", tree.alpha), "tree-not-found",
    t("mcp.error.treeNotFound", { target: "Notes/plain.md" }));
  await expectError(() => reader.readTree("A/Broken.mtn.md", 10, 0), "tree-not-found",
    t("mcp.error.treeNotFound", { target: "A/Broken.mtn.md" }));
  await expectError(() => reader.getNode(PATH, "missing-node"), "node-not-found",
    t("mcp.error.nodeNotFound", { nodeId: "missing-node" }));
});

test("the exported projection agrees with the reader's own view", async () => {
  const tree = buildTree();
  const { reader } = fixture({ [PATH]: tree.source });
  const document = createEmptyDocument("X");
  const node = addNode(document, document.rootId, "Only");
  const projected = createMcpNodeView(document, node.id);
  assert.equal(projected.parentId, document.rootId);
  assert.equal(projected.depth, 1);
  // A node without optional data must produce exactly the same field set as the
  // reader's projection of one, so a write result and a read result look alike.
  const fromReader = await reader.getNode(PATH, tree.gamma);
  assert.deepEqual(Object.keys(projected).sort(), Object.keys(fromReader).sort());
  assert.equal(createId().length > 0, true);
});
