import test from "node:test";
import assert from "node:assert/strict";
import {
  addNode,
  collectBranchIds,
  createEmptyDocument,
  deleteBranch,
  deleteNodeOnly,
  extractBranches,
  insertBranches
} from "../src/domain/tree";
import {
  NodeLinkError,
  collectNodeLinks,
  createNodeLink,
  isNodeLinkParticipant,
  nodeTitlePath,
  removeNodeLinks
} from "../src/domain/node-link";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import {
  OUTLINE_END,
  OUTLINE_LINKS,
  outlineBlockId,
  renderBranchMarkdown,
  renderOutline
} from "../src/format/outline";
import type { MindTreeDocument, NodeId } from "../src/types";

function fixture() {
  const document = createEmptyDocument("Root");
  const a = addNode(document, document.rootId, "A");
  const b = addNode(document, document.rootId, "B");
  const hub = addNode(document, document.rootId, "Hub");
  const aChild = addNode(document, a.id, "A child");
  const hubChild = addNode(document, hub.id, "Hub child");
  return { document, a, b, hub, aChild, hubChild };
}

/** Every node id plus its child list: the data a node link must never touch. */
function structureSnapshot(document: MindTreeDocument): Array<{ id: NodeId; childIds: NodeId[] }> {
  return collectBranchIds(document, document.rootId)
    .map((id) => ({ id, childIds: [...(document.nodes[id]?.childIds ?? [])] }));
}

test("creating a node link writes one pointer and copies nothing", () => {
  const { document, a, b, hub, aChild, hubChild } = fixture();
  const before = structureSnapshot(document);
  createNodeLink(document, a.id, b.id);
  assert.equal(document.nodes[a.id]?.nodeLink, b.id);
  assert.equal(document.nodes[b.id]?.nodeLink, undefined);
  assert.deepEqual(structureSnapshot(document), before);
  assert.deepEqual(collectBranchIds(document, a.id), [a.id, aChild.id]);
  assert.deepEqual(collectBranchIds(document, b.id), [b.id]);
  assert.ok(document.nodes[hubChild.id]);
  assert.deepEqual(collectNodeLinks(document), [{ sourceId: a.id, targetId: b.id }]);
  assert.equal(isNodeLinkParticipant(document, a.id), true);
  assert.equal(isNodeLinkParticipant(document, b.id), true);
  assert.equal(isNodeLinkParticipant(document, hub.id), false);
});

test("node links reject self references, resource sources, second outgoing links and missing nodes", () => {
  const { document, a, b, hub } = fixture();
  const code = (value: unknown): string | undefined =>
    value instanceof NodeLinkError ? value.code : undefined;
  assert.throws(() => createNodeLink(document, a.id, a.id), (error) => code(error) === "self");
  assert.throws(() => createNodeLink(document, a.id, "missing"), (error) => code(error) === "missing-target");
  assert.throws(() => createNodeLink(document, "missing", b.id), (error) => code(error) === "missing-source");

  document.nodes[hub.id]!.resource = { type: "url", url: "https://example.com/" };
  assert.throws(() => createNodeLink(document, hub.id, a.id), (error) => code(error) === "source-has-resource");
  // The target may carry a resource; only the source is restricted.
  createNodeLink(document, a.id, hub.id);
  assert.equal(document.nodes[a.id]?.nodeLink, hub.id);
  assert.throws(() => createNodeLink(document, a.id, b.id), (error) => code(error) === "source-linked");
});

test("removing a link clears every edge for that node and leaves subtrees untouched", () => {
  const { document, a, b, hub, hubChild } = fixture();
  createNodeLink(document, a.id, hub.id);
  createNodeLink(document, b.id, hub.id);
  const before = structureSnapshot(document);
  assert.equal(removeNodeLinks(document, hub.id), 2);
  assert.equal(document.nodes[a.id]?.nodeLink, undefined);
  assert.equal(document.nodes[b.id]?.nodeLink, undefined);
  assert.deepEqual(structureSnapshot(document), before);
  assert.ok(document.nodes[hubChild.id]);
  // Idempotent: nothing participates any more.
  assert.equal(removeNodeLinks(document, hub.id), 0);
});

test("deleting a node drops the references pointing at it instead of leaving dangling links", () => {
  const { document, a, b } = fixture();
  createNodeLink(document, a.id, b.id);
  deleteBranch(document, b.id);
  assert.equal(document.nodes[a.id]?.nodeLink, undefined);

  const second = fixture();
  createNodeLink(second.document, second.a.id, second.hub.id);
  deleteNodeOnly(second.document, second.hub.id);
  assert.equal(second.document.nodes[second.a.id]?.nodeLink, undefined);
  // Only-delete promotes the children; the link disappears, the child does not.
  assert.equal(second.document.nodes[second.hubChild.id]?.title, "Hub child");
  assert.deepEqual(second.document.nodes[second.hubChild.id]?.childIds, []);
});

test("clipboard and paste never carry a node link into a copied branch", () => {
  const { document, a, b } = fixture();
  createNodeLink(document, a.id, b.id);
  const payload = extractBranches(document, [a.id]);
  assert.equal(payload.nodes[a.id]?.nodeLink, b.id);
  const restored = createEmptyDocument("Other");
  const inserted = insertBranches(restored, restored.rootId, payload);
  assert.equal(inserted.length, 1);
  assert.equal(Object.values(restored.nodes).every((node) => node.nodeLink === undefined), true);
});

test("the outline exposes a block id per participant and one one-way link line", () => {
  const { document, a, b, aChild, hub, hubChild } = fixture();
  const plain = renderOutline(document);
  assert.equal(plain.includes(OUTLINE_LINKS), false);
  createNodeLink(document, a.id, b.id);
  const outline = renderOutline(document);
  assert.ok(outline.includes(`- A ^${a.id}`));
  assert.ok(outline.includes(`- B ^${b.id}`));
  // Children of a participant are not participants themselves.
  assert.equal(outline.includes(`- A child ^${aChild.id}`), false);
  assert.equal(outline.includes(`- Hub ^${hub.id}`), false);
  assert.ok(document.nodes[hubChild.id]);
  assert.ok(outline.indexOf(OUTLINE_LINKS) > outline.indexOf(`- B ^${b.id}`));
  assert.ok(outline.indexOf(OUTLINE_LINKS) < outline.indexOf(OUTLINE_END));
  assert.ok(outline.includes(`${a.id}->${b.id}`));
  // A branch fragment keeps the block id but is not a document link field.
  const branch = renderBranchMarkdown(document, a.id);
  assert.ok(branch.includes(`- A ^${a.id}`));
  assert.equal(branch.includes(OUTLINE_LINKS), false);
});

test("outline block ids keep only characters Obsidian accepts", () => {
  assert.equal(outlineBlockId("a1b2-c3"), "a1b2-c3");
  assert.equal(outlineBlockId("a b/c"), "abc");
  assert.equal(outlineBlockId("！！！"), undefined);
});

test("node links survive a save and reload while the outline stays idempotent", () => {
  const { document, a, b } = fixture();
  createNodeLink(document, a.id, b.id);
  const source = serializeMindTreeFile(document);
  const parsed = parseMindTreeFile(source);
  assert.equal(parsed.document.nodes[a.id]?.nodeLink, b.id);
  const firstOutline = renderOutline(parsed.document);
  const reserialized = serializeMindTreeFile(parsed.document, source);
  assert.ok(reserialized.includes(`${a.id}->${b.id}`));
  assert.equal(renderOutline(parseMindTreeFile(reserialized).document), firstOutline);
});

test("a stored link to a missing node is dropped instead of failing the document", () => {
  const { document, a } = fixture();
  document.nodes[a.id]!.nodeLink = "ghost";
  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  assert.equal(parsed.document.nodes[a.id]?.nodeLink, undefined);
  // A self reference written by an external tool is dropped on read as well.
  const self = fixture();
  self.document.nodes[self.a.id]!.nodeLink = self.a.id;
  const reparsed = parseMindTreeFile(serializeMindTreeFile(self.document));
  assert.equal(reparsed.document.nodes[self.a.id]?.nodeLink, undefined);
});

test("node title paths describe the target inside a picker or notice", () => {
  const { document, aChild, hub } = fixture();
  assert.equal(nodeTitlePath(document, aChild.id), "Root → A → A child");
  assert.equal(nodeTitlePath(document, hub.id, "Untitled"), "Root → Hub");
  assert.equal(nodeTitlePath(document, "missing"), "");
});
