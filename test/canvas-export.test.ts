import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import {
  buildCanvasFile,
  CANVAS_EXPORT_MARGIN,
  createCanvasPathCandidates
} from "../src/services/canvas-export";
import { resolveExportNodeId } from "../src/services/export";
import { DEFAULT_NODE_WRAP_WIDTH, layoutTree } from "../src/render/layout";
import type { MindTreeDocument, MindTreeLayoutMode, NodeId } from "../src/types";

/** Root + two children + one grandchild: enough to check branching both ways. */
function createTree(): {
  document: MindTreeDocument;
  rootId: NodeId;
  firstId: NodeId;
  secondId: NodeId;
  leafId: NodeId;
} {
  const document = createEmptyDocument("Roadmap");
  const first = addNode(document, document.rootId, "First");
  const second = addNode(document, document.rootId, "Second");
  const leaf = addNode(document, first.id, "Leaf");
  return { document, rootId: document.rootId, firstId: first.id, secondId: second.id, leafId: leaf.id };
}

test("canvas export reuses the shared layout and adds one fixed margin", () => {
  const { document, rootId } = createTree();
  const layout = layoutTree(document, rootId, false);
  const canvas = buildCanvasFile(document, rootId, "Untitled node");

  assert.equal(canvas.nodes.length, layout.nodes.length);
  assert.equal(canvas.edges.length, layout.connections.length);
  for (const position of layout.nodes) {
    const node = canvas.nodes.find((candidate) => candidate.id === `n-${position.id}`);
    assert.ok(node, `missing canvas node for ${position.id}`);
    assert.equal(node.type, "text");
    assert.equal(node.x, position.x + CANVAS_EXPORT_MARGIN);
    assert.equal(node.y, position.y + CANVAS_EXPORT_MARGIN);
    // The visible rectangle is the layout rectangle: no extra controls, images
    // or theme padding change a Canvas node's box.
    assert.equal(node.width, position.width);
    assert.equal(node.height, position.height);
  }
});

test("canvas export forwards wrap width, layout mode and alignment to the layout", () => {
  const { document, rootId } = createTree();
  for (const layoutMode of ["balanced", "tree", "radial", "left"] as const) {
    for (const nodeAlignment of ["level", "compact"] as const) {
      const layout = layoutTree(document, rootId, false, 160, layoutMode, nodeAlignment);
      const canvas = buildCanvasFile(document, rootId, "Untitled node", 160, layoutMode, nodeAlignment);
      // Same order, same rectangles: only the fixed margin separates them.
      assert.deepEqual(
        canvas.nodes.map((node) => [node.x, node.y, node.width, node.height]),
        layout.nodes.map((node) => [node.x + CANVAS_EXPORT_MARGIN, node.y + CANVAS_EXPORT_MARGIN, node.width, node.height]),
        `${layoutMode}/${nodeAlignment}`
      );
    }
  }
});

test("canvas output stays plain, stringifiable JSON data", () => {
  const { document, rootId } = createTree();
  const canvas = buildCanvasFile(document, rootId, "Untitled node");
  assert.deepEqual(JSON.parse(JSON.stringify(canvas)), canvas);
  for (const node of canvas.nodes) {
    // Pinning the field set keeps vault paths and image payloads out of the file.
    assert.deepEqual(Object.keys(node).sort(), ["height", "id", "text", "type", "width", "x", "y"]);
  }
  for (const edge of canvas.edges) {
    assert.deepEqual(Object.keys(edge).sort(), ["fromNode", "fromSide", "id", "toNode", "toSide"]);
  }
});

test("an untitled node shows the caller-provided placeholder", () => {
  const document = createEmptyDocument("Roadmap");
  const untitled = addNode(document, document.rootId, "");
  const canvas = buildCanvasFile(document, document.rootId, "Untitled node");
  assert.equal(canvas.nodes.find((node) => node.id === `n-${untitled.id}`)?.text, "Untitled node");
  assert.equal(canvas.nodes.find((node) => node.id === `n-${document.rootId}`)?.text, "Roadmap");
});

test("a branch export contains exactly the selected subtree, expanded", () => {
  const document = createEmptyDocument("Roadmap");
  const first = addNode(document, document.rootId, "First");
  const leaf = addNode(document, first.id, "Leaf");
  addNode(document, document.rootId, "Second");
  // Export reveals collapsed branches on purpose, exactly like PNG/SVG export.
  first.collapsed = true;

  const whole = buildCanvasFile(document, document.rootId, "Untitled node");
  const branch = buildCanvasFile(document, first.id, "Untitled node");

  assert.equal(whole.nodes.length, 4);
  assert.equal(branch.nodes.length, 2);
  assert.deepEqual(
    new Set(branch.nodes.map((node) => node.id)),
    new Set([`n-${first.id}`, `n-${leaf.id}`])
  );
  // The branch is its own layout origin, so the branch root sits on the margin.
  const branchRoot = branch.nodes.find((node) => node.id === `n-${first.id}`);
  assert.ok(branchRoot);
  assert.equal(branchRoot.x, CANVAS_EXPORT_MARGIN);
  assert.equal(branch.edges.length, 1);
  assert.equal(branch.edges[0]?.fromNode, `n-${first.id}`);
  assert.equal(branch.edges[0]?.toNode, `n-${leaf.id}`);
});

test("canvas node and edge ids are stable, unique and prefixed", () => {
  const { document, rootId, firstId, leafId } = createTree();
  const canvas = buildCanvasFile(document, rootId, "Untitled node");
  // Same document, same export: a re-export must not churn node ids.
  assert.deepEqual(buildCanvasFile(document, rootId, "Untitled node"), canvas);

  const ids = [...canvas.nodes.map((node) => node.id), ...canvas.edges.map((edge) => edge.id)];
  assert.equal(new Set(ids).size, ids.length);
  for (const node of canvas.nodes) assert.match(node.id, /^n-/u);
  for (const edge of canvas.edges) {
    assert.match(edge.id, /^e-/u);
    assert.equal(edge.id, `e-${edge.fromNode}-${edge.toNode}`);
    assert.ok(canvas.nodes.some((node) => node.id === edge.fromNode));
    assert.ok(canvas.nodes.some((node) => node.id === edge.toNode));
  }
  // Every edge follows the document's parent → child direction.
  const parentOfLeaf = canvas.edges.find((edge) => edge.toNode === `n-${leafId}`);
  assert.ok(parentOfLeaf);
  assert.equal(parentOfLeaf.fromNode, `n-${firstId}`);
});

test("edge sides follow the layout direction", () => {
  const document = createEmptyDocument("Roadmap");
  const first = addNode(document, document.rootId, "First");
  const parent = addNode(document, first.id, "Parent");
  addNode(document, parent.id, "Leaf");
  const expectations: ReadonlyArray<readonly [MindTreeLayoutMode, "left" | "right", "left" | "right"]> = [
    ["right", "right", "left"],
    ["tree", "right", "left"],
    ["balanced", "right", "left"],
    ["radial", "right", "left"],
    ["left", "left", "right"]
  ];
  for (const [mode, fromSide, toSide] of expectations) {
    const canvas = buildCanvasFile(document, document.rootId, "Untitled node", DEFAULT_NODE_WRAP_WIDTH, mode);
    assert.ok(canvas.edges.length > 0, mode);
    for (const edge of canvas.edges) {
      assert.equal(edge.fromSide, fromSide, mode);
      assert.equal(edge.toSide, toSide, mode);
    }
  }
});

test("an unknown export start produces an empty canvas instead of throwing", () => {
  const { document } = createTree();
  assert.deepEqual(buildCanvasFile(document, "deleted-node", "Untitled node"), { nodes: [], edges: [] });
});

test("canvas paths keep the source folder and add a numeric suffix", () => {
  assert.deepEqual(createCanvasPathCandidates("", "Roadmap", 3), [
    "Roadmap.canvas", "Roadmap-2.canvas", "Roadmap-3.canvas"
  ]);
  assert.deepEqual(createCanvasPathCandidates("notes/maps", "Roadmap", 2), [
    "notes/maps/Roadmap.canvas", "notes/maps/Roadmap-2.canvas"
  ]);
  // A vault-relative folder never carries leading, trailing or doubled slashes.
  assert.deepEqual(createCanvasPathCandidates("/notes/", "Roadmap", 1), ["notes/Roadmap.canvas"]);
  assert.deepEqual(createCanvasPathCandidates("notes//maps/", "Roadmap", 1), ["notes/maps/Roadmap.canvas"]);
});

test("the export target is the selection, or the whole tree without one", () => {
  const { document, firstId } = createTree();
  assert.equal(resolveExportNodeId(document, firstId), firstId);
  // No selection and a vanished selection both fall back to the tree root,
  // which is what makes PNG/Markdown/Canvas export the whole tree.
  assert.equal(resolveExportNodeId(document, undefined), document.rootId);
  assert.equal(resolveExportNodeId(document, "deleted-node"), document.rootId);
});
