import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { getNodeLinkTargetId, isNodeLinkParticipant } from "../src/domain/node-link";
import { createBranchReference } from "../src/domain/branch-reference";
import { insertBranchReferenceNode, resolveBranchReferenceTarget } from "../src/services/clipboard";

function treeWith(documentId: string, titles: readonly string[]): {
  document: ReturnType<typeof createEmptyDocument>;
  ids: string[];
} {
  const document = createEmptyDocument("Root");
  document.documentId = documentId;
  const ids = titles.map((title) => addNode(document, document.rootId, title).id);
  return { document, ids };
}

test("a reference can only be materialized in the tree it was copied from", () => {
  const { document, ids } = treeWith("tree-a", ["Target"]);
  const reference = createBranchReference("tree-a", ids[0]!, "Notes/A.mtn.md");
  const resolved = resolveBranchReferenceTarget(document, reference);
  assert.equal(resolved.kind, "ready");
  assert.equal(resolved.kind === "ready" ? resolved.target.id : "", ids[0]);

  // A reference from another tree, and a tree that has no identity yet, are both
  // refused: a node link is an id inside one document.
  assert.equal(resolveBranchReferenceTarget(document, createBranchReference("tree-b", ids[0]!)).kind, "other-tree");
  const unidentified = createEmptyDocument("Root");
  assert.equal(
    resolveBranchReferenceTarget(unidentified, createBranchReference("tree-a", unidentified.rootId)).kind,
    "other-tree"
  );
});

test("a deleted target is reported instead of linked", () => {
  const { document } = treeWith("tree-a", ["Target"]);
  assert.equal(resolveBranchReferenceTarget(document, createBranchReference("tree-a", "gone")).kind, "missing-target");
});

test("pasting a reference inserts one linked node and leaves the target subtree alone", () => {
  const { document, ids } = treeWith("tree-a", ["Target", "Host"]);
  const targetId = ids[0]!;
  const hostId = ids[1]!;
  const targetChild = addNode(document, targetId, "Target child");

  const createdId = insertBranchReferenceNode(
    document,
    hostId,
    createBranchReference("tree-a", targetId),
    "Untitled node"
  );

  assert.ok(createdId);
  const created = document.nodes[createdId!];
  assert.equal(created?.title, "Target");
  assert.equal(getNodeLinkTargetId(created), targetId);
  assert.deepEqual(created?.childIds, []);
  // The target keeps its own children, gains no back-reference, and is only
  // "participating" because something points at it.
  assert.deepEqual(document.nodes[targetId]?.childIds, [targetChild.id]);
  assert.equal(document.nodes[targetId]?.nodeLink, undefined);
  assert.equal(isNodeLinkParticipant(document, targetId), true);
  assert.deepEqual(document.nodes[hostId]?.childIds, [createdId]);
});

test("a refused paste inserts nothing at all", () => {
  const { document, ids } = treeWith("tree-a", ["Target", "Host"]);
  const hostId = ids[1]!;
  const before = JSON.stringify(document);
  assert.equal(insertBranchReferenceNode(document, hostId, createBranchReference("tree-b", ids[0]!), "Untitled"), undefined);
  assert.equal(insertBranchReferenceNode(document, hostId, createBranchReference("tree-a", "gone"), "Untitled"), undefined);
  assert.equal(JSON.stringify(document), before);
});

test("an untitled target falls back to the caller's localized placeholder", () => {
  const { document, ids } = treeWith("tree-a", [""]);
  const createdId = insertBranchReferenceNode(document, document.rootId, createBranchReference("tree-a", ids[0]!), "未命名节点");
  assert.equal(document.nodes[createdId!]?.title, "未命名节点");
});

test("the canvas paste path is wired to the shared check and stays picker-free", () => {
  const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
  const menu = readFileSync(new URL("../src/ui/menus/node-context-menu.ts", import.meta.url), "utf8");
  const contracts = readFileSync(new URL("../src/ui/ui-contracts.ts", import.meta.url), "utf8");
  assert.match(view, /private pasteBranchReference\(reference: BranchReference, context: PasteInsertionContext\)/);
  assert.match(view, /resolveBranchReferenceTarget\(document, reference\)/);
  assert.match(view, /insertBranchReferenceNode\(draft, context\.parentId, reference, title\)/);
  assert.match(view, /notice\.branchReferenceOtherTree/);
  // The picker, its async creation path and the toolbar entry are gone for good.
  assert.doesNotMatch(view, /NodeLinkSuggestModal|nodeLinkCandidates|createNodeLinkFor|toggleNodeLink/);
  assert.doesNotMatch(menu, /menu\.linkNode/);
  assert.doesNotMatch(contracts, /"link-node"/);
});
