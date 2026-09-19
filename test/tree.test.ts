import test from "node:test";
import assert from "node:assert/strict";
import {
  addNode,
  addSibling,
  cloneDocument,
  collectBranchIds,
  collectFileReferences,
  createEmptyDocument,
  DEFAULT_NODE_TITLE,
  deleteBranch,
  deleteBranches,
  deleteNodeOnly,
  deleteNodesOnly,
  findParentId,
  getDepth,
  getTopLevelSelectedNodeIds,
  getTreeStatistics,
  insertBranch,
  insertParentNode,
  moveNode,
  moveNodeAmongSiblings,
  moveNodes,
  renameNode,
  setAllCollapsed,
  setCollapsedAfterDepth,
  updateFileReferencePaths,
  validateDocument,
  extractBranch
} from "../src/domain/tree";

test("creates a document with exactly one protected root", () => {
  const document = createEmptyDocument("Project");
  assert.equal(document.documentId, undefined);
  assert.equal(Object.keys(document.nodes).length, 1);
  assert.equal(document.nodes[document.rootId]?.title, "Project");
  assert.equal(validateDocument(document).valid, true);
  assert.throws(() => deleteBranch(document, document.rootId), /root node cannot be deleted/i);
});

test("new structural nodes use a non-empty default title", () => {
  const document = createEmptyDocument("Root");
  const child = addNode(document, document.rootId);
  const sibling = addSibling(document, child.id);
  const parent = insertParentNode(document, child.id);
  assert.equal(child.title, DEFAULT_NODE_TITLE);
  assert.equal(sibling.title, DEFAULT_NODE_TITLE);
  assert.equal(parent.title, DEFAULT_NODE_TITLE);
});

test("saved node titles trim outer whitespace while preserving internal spaces", () => {
  const document = createEmptyDocument("Root");
  renameNode(document, document.rootId, "  A  B  ");
  assert.equal(document.nodes[document.rootId]?.title, "A  B");
});

test("adds, reorders, and reparents nodes without duplicating parents", () => {
  const document = createEmptyDocument("Project");
  const first = addNode(document, document.rootId, "First");
  const second = addSibling(document, first.id, "Second");
  const child = addNode(document, first.id, "Child");

  assert.equal(getDepth(document, first.id), 1);
  assert.equal(getDepth(document, child.id), 2);
  moveNode(document, child.id, second.id, "inside");
  assert.equal(findParentId(document, child.id), second.id);
  moveNode(document, second.id, first.id, "before");
  assert.deepEqual(document.nodes[document.rootId]?.childIds, [second.id, first.id]);
  assert.equal(validateDocument(document).valid, true);
});

test("moves selected branches from different depths as destination siblings", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "First");
  const nested = addNode(document, first.id, "Nested");
  const second = addNode(document, document.rootId, "Second");
  const retainedChild = addNode(document, second.id, "Retained child");
  const target = addNode(document, document.rootId, "Target");

  const moved = moveNodes(document, [nested.id, second.id], target.id, "inside");
  assert.deepEqual(moved, [nested.id, second.id]);
  assert.deepEqual(document.nodes[target.id]?.childIds, [nested.id, second.id]);
  assert.deepEqual(document.nodes[first.id]?.childIds, []);
  assert.deepEqual(document.nodes[second.id]?.childIds, [retainedChild.id]);
  assert.equal(validateDocument(document).valid, true);
});

test("multi-node moves keep selected descendants attached to selected ancestors", () => {
  const document = createEmptyDocument("Root");
  const branch = addNode(document, document.rootId, "Branch");
  const selectedDescendant = addNode(document, branch.id, "Selected descendant");
  const other = addNode(document, document.rootId, "Other");
  const target = addNode(document, document.rootId, "Target");

  const moved = moveNodes(document, [branch.id, selectedDescendant.id, other.id], target.id, "inside");
  assert.deepEqual(moved, [branch.id, other.id]);
  assert.deepEqual(document.nodes[target.id]?.childIds, [branch.id, other.id]);
  assert.deepEqual(document.nodes[branch.id]?.childIds, [selectedDescendant.id]);
  assert.equal(validateDocument(document).valid, true);
});

test("moves a node up or down by exchanging it with an adjacent sibling", () => {
  const document = createEmptyDocument("Project");
  const first = addNode(document, document.rootId, "First");
  const second = addNode(document, document.rootId, "Second");
  const third = addNode(document, document.rootId, "Third");

  assert.equal(moveNodeAmongSiblings(document, second.id, "up"), true);
  assert.deepEqual(document.nodes[document.rootId]?.childIds, [second.id, first.id, third.id]);
  assert.equal(moveNodeAmongSiblings(document, second.id, "up"), false);
  assert.equal(moveNodeAmongSiblings(document, second.id, "down"), true);
  assert.deepEqual(document.nodes[document.rootId]?.childIds, [first.id, second.id, third.id]);
  assert.equal(moveNodeAmongSiblings(document, document.rootId, "down"), false);
});

test("status statistics count topics, unique linked files, and maximum depth", () => {
  const document = createEmptyDocument("Statistics");
  const first = addNode(document, document.rootId, "First note");
  const duplicate = addNode(document, first.id, "Same note again");
  const attachment = addNode(document, document.rootId, "Attachment");
  const web = addNode(document, document.rootId, "Web page");
  const sharedResource = {
    type: "file" as const,
    resourceId: "shared-note",
    pathHint: "notes/shared.md",
    fileKind: "note" as const
  };
  first.resource = { ...sharedResource };
  duplicate.resource = { ...sharedResource };
  attachment.resource = {
    type: "file",
    resourceId: "attachment",
    pathHint: "files/archive.zip",
    fileKind: "attachment"
  };
  web.resource = { type: "url", url: "https://example.com" };
  assert.deepEqual(getTreeStatistics(document), { topicCount: 5, fileCount: 2, depth: 2 });
});

test("collects every file kind once while excluding web resources", () => {
  const document = createEmptyDocument("Files");
  const note = addNode(document, document.rootId, "Note");
  const duplicate = addNode(document, note.id, "Duplicate note");
  const image = addNode(document, document.rootId, "Image");
  const attachment = addNode(document, document.rootId, "Attachment");
  const mindTree = addNode(document, document.rootId, "Mind tree");
  const drawing = addNode(document, document.rootId, "Drawing");
  const web = addNode(document, document.rootId, "Web");
  const sharedNote = {
    type: "file" as const,
    resourceId: "note",
    pathHint: "Note.md",
    fileKind: "note" as const
  };
  note.resource = { ...sharedNote };
  duplicate.resource = { ...sharedNote };
  image.resource = { type: "file", resourceId: "image", pathHint: "Image.png", fileKind: "image" };
  attachment.resource = { type: "file", resourceId: "archive", pathHint: "Archive.zip", fileKind: "attachment" };
  mindTree.resource = { type: "file", resourceId: "tree", pathHint: "Other.mtn.md", fileKind: "note" };
  drawing.resource = {
    type: "file",
    resourceId: "drawing",
    pathHint: "Drawing.md",
    fileKind: "note",
    fileSubtype: "excalidraw"
  };
  web.resource = { type: "url", url: "https://example.com" };

  const references = collectFileReferences(document, collectBranchIds(document, document.rootId));
  assert.deepEqual(references.map((reference) => reference.resourceId), [
    "note", "image", "archive", "tree", "drawing"
  ]);
  assert.notStrictEqual(references[0], note.resource);
});

test("updates every duplicate reference after a linked file moves", () => {
  const document = createEmptyDocument("Moved files");
  const first = addNode(document, document.rootId, "First");
  const duplicate = addNode(document, document.rootId, "Duplicate");
  const untouched = addNode(document, document.rootId, "Untouched");
  first.resource = { type: "file", resourceId: "shared", pathHint: "Old/File.pdf", fileKind: "attachment" };
  duplicate.resource = { ...first.resource };
  untouched.resource = { type: "file", resourceId: "other", pathHint: "Other.png", fileKind: "image" };

  assert.equal(updateFileReferencePaths(document, new Map([["shared", "New/File.pdf"]])), true);
  assert.equal(first.resource.pathHint, "New/File.pdf");
  assert.equal(duplicate.resource.pathHint, "New/File.pdf");
  assert.equal(untouched.resource.pathHint, "Other.png");
  assert.equal(updateFileReferencePaths(document, new Map([["shared", "New/File.pdf"]])), false);
});

test("rejects moving a node into its own descendant atomically", () => {
  const document = createEmptyDocument();
  const parent = addNode(document, document.rootId, "Parent");
  const child = addNode(document, parent.id, "Child");
  const before = cloneDocument(document);
  assert.throws(() => moveNode(document, parent.id, child.id, "inside"), /descendants/i);
  assert.deepEqual(document, before);
});

test("rejects placing a node beside the root atomically", () => {
  const document = createEmptyDocument();
  const child = addNode(document, document.rootId, "Child");
  const before = cloneDocument(document);
  assert.throws(() => moveNode(document, child.id, document.rootId, "before"), /before or after the root/i);
  assert.deepEqual(document, before);
});

test("delete-node-only promotes children in their original order", () => {
  const document = createEmptyDocument();
  const wrapper = addNode(document, document.rootId, "Wrapper");
  const first = addNode(document, wrapper.id, "A");
  const second = addNode(document, wrapper.id, "B");
  deleteNodeOnly(document, wrapper.id);
  assert.deepEqual(document.nodes[document.rootId]?.childIds, [first.id, second.id]);
  assert.equal(document.nodes[wrapper.id], undefined);
});

test("multi-selection deletion removes each selected branch exactly once", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "First");
  const nested = addNode(document, first.id, "Nested");
  const second = addNode(document, document.rootId, "Second");
  addNode(document, second.id, "Second child");

  const roots = getTopLevelSelectedNodeIds(document, [document.rootId, first.id, nested.id, second.id]);
  assert.deepEqual(roots, [first.id, second.id]);
  const removed = deleteBranches(document, [document.rootId, first.id, nested.id, second.id]);
  assert.equal(new Set(removed).size, 4);
  assert.deepEqual(document.nodes[document.rootId]?.childIds, []);
  assert.equal(validateDocument(document).valid, true);
});

test("recursively collapses and expands every branch node", () => {
  const document = createEmptyDocument("Root");
  const branch = addNode(document, document.rootId, "Branch");
  const nested = addNode(document, branch.id, "Nested");
  addNode(document, nested.id, "Leaf");

  setAllCollapsed(document, branch.id, true);
  assert.equal(document.nodes[branch.id]?.collapsed, true);
  assert.equal(document.nodes[nested.id]?.collapsed, true);

  setAllCollapsed(document, branch.id, false);
  assert.equal(document.nodes[branch.id]?.collapsed, false);
  assert.equal(document.nodes[nested.id]?.collapsed, false);
});

test("level folding shows through the selected global depth and prepares stepwise expansion", () => {
  const document = createEmptyDocument("Root");
  const levels = [];
  let parentId = document.rootId;
  for (let depth = 1; depth <= 10; depth += 1) {
    const node = addNode(document, parentId, `Level ${depth}`);
    levels.push(node);
    parentId = node.id;
  }
  document.nodes[document.rootId]!.collapsed = true;

  setCollapsedAfterDepth(document, 1);
  assert.equal(document.nodes[document.rootId]?.collapsed, false);
  assert.equal(document.nodes[levels[0]!.id]?.collapsed, true);
  assert.equal(document.nodes[levels[1]!.id]?.collapsed, true);

  setCollapsedAfterDepth(document, 2);
  assert.equal(document.nodes[document.rootId]?.collapsed, false);
  assert.equal(document.nodes[levels[0]!.id]?.collapsed, false);
  assert.equal(document.nodes[levels[1]!.id]?.collapsed, true);
  assert.equal(document.nodes[levels[2]!.id]?.collapsed, true);

  setCollapsedAfterDepth(document, 9);
  assert.equal(document.nodes[document.rootId]?.collapsed, false);
  assert.equal(document.nodes[levels[7]!.id]?.collapsed, false);
  assert.equal(document.nodes[levels[8]!.id]?.collapsed, true);
  assert.equal(document.nodes[levels[9]!.id]?.collapsed, undefined);
});

test("multi-selection node-only deletion promotes descendants deterministically", () => {
  const document = createEmptyDocument("Root");
  const parent = addNode(document, document.rootId, "Parent");
  const child = addNode(document, parent.id, "Child");
  const leaf = addNode(document, child.id, "Leaf");

  deleteNodesOnly(document, [parent.id, child.id]);
  assert.deepEqual(document.nodes[document.rootId]?.childIds, [leaf.id]);
  assert.equal(validateDocument(document).valid, true);
});

test("inserts a parent above ordinary nodes and the root", () => {
  const document = createEmptyDocument("Root");
  const branch = addNode(document, document.rootId, "Branch");
  const leaf = addNode(document, branch.id, "Leaf");

  const inserted = insertParentNode(document, leaf.id, "Wrapper");
  assert.deepEqual(document.nodes[branch.id]?.childIds, [inserted.id]);
  assert.deepEqual(inserted.childIds, [leaf.id]);
  assert.equal(findParentId(document, leaf.id), inserted.id);

  const oldRootId = document.rootId;
  const newRoot = insertParentNode(document, oldRootId, "New root");
  assert.equal(document.rootId, newRoot.id);
  assert.deepEqual(newRoot.childIds, [oldRootId]);
  assert.equal(validateDocument(document).valid, true);
});

test("branch copy regenerates every node ID on insert", () => {
  const source = createEmptyDocument("Source");
  const branch = addNode(source, source.rootId, "Branch");
  branch.resource = {
    type: "file",
    resourceId: "linked-note",
    pathHint: "notes/Branch.md",
    fileKind: "note"
  };
  branch.titleSync = "bidirectional";
  addNode(source, branch.id, "Leaf");
  const payload = extractBranch(source, branch.id);

  const target = createEmptyDocument("Target");
  const insertedRoot = insertBranch(target, target.rootId, payload);
  const insertedIds = collectBranchIds(target, insertedRoot);
  assert.equal(insertedIds.length, 2);
  assert.equal(insertedIds.some((id) => payload.nodes[id] !== undefined), false);
  assert.deepEqual(target.nodes[insertedRoot]?.resource, branch.resource);
  assert.equal(target.nodes[insertedRoot]?.titleSync, "bidirectional");
  assert.equal(validateDocument(target).valid, true);
});

test("validation reports cycles and unreachable nodes", () => {
  const document = createEmptyDocument();
  const child = addNode(document, document.rootId, "Child");
  document.nodes[child.id]?.childIds.push(document.rootId);
  const orphan = addNode(document, document.rootId, "Orphan");
  document.nodes[document.rootId]!.childIds = document.nodes[document.rootId]!.childIds.filter((id) => id !== orphan.id);
  const result = validateDocument(document);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "cycle" || issue.code === "root-has-parent"));
  assert.deepEqual(result.unreachableNodeIds, [orphan.id]);
});
