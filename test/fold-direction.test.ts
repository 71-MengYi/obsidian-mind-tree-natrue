import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { resolveFoldDirections } from "../src/ui/fold-direction";
import type { PositionedNode } from "../src/types";

test("one-direction layouts place every fold control on their growth side", () => {
  const document = createEmptyDocument("Root");
  const child = addNode(document, document.rootId, "Child");
  const positions = [position(document.rootId, 10, 10), position(child.id, 100, 100)];

  for (const [layout, direction] of [["right", "right"], ["left", "left"], ["tree", "down"]] as const) {
    const resolved = resolveFoldDirections(document, positions, layout);
    assert.equal(resolved.get(document.rootId), direction);
    assert.equal(resolved.get(child.id), direction);
  }
});

test("balanced branches inherit the side assigned to their first-level root", () => {
  const document = createEmptyDocument("Root");
  const left = addNode(document, document.rootId, "Left");
  const leftDescendant = addNode(document, left.id, "Left descendant");
  const right = addNode(document, document.rootId, "Right");
  const positions = [
    position(document.rootId, 100, 100),
    position(left.id, 0, 80),
    // Deliberately cross the root in this synthetic layout: inheritance, not a
    // local coordinate guess, must keep the descendant control facing left.
    position(leftDescendant.id, 240, 70),
    position(right.id, 220, 120)
  ];
  const resolved = resolveFoldDirections(document, positions, "balanced");

  assert.equal(resolved.get(document.rootId), "right");
  assert.equal(resolved.get(left.id), "left");
  assert.equal(resolved.get(leftDescendant.id), "left");
  assert.equal(resolved.get(right.id), "right");
});

test("radial controls follow the dominant outward axis and prefer horizontal ties", () => {
  const document = createEmptyDocument("Root");
  const west = addNode(document, document.rootId, "West");
  const east = addNode(document, document.rootId, "East");
  const north = addNode(document, document.rootId, "North");
  const south = addNode(document, document.rootId, "South");
  const tie = addNode(document, document.rootId, "Tie");
  const positions = [
    position(document.rootId, 100, 100),
    position(west.id, 0, 100),
    position(east.id, 220, 100),
    position(north.id, 100, 0),
    position(south.id, 100, 220),
    position(tie.id, 220, 220)
  ];
  const resolved = resolveFoldDirections(document, positions, "radial");

  assert.equal(resolved.get(document.rootId), "right");
  assert.equal(resolved.get(west.id), "left");
  assert.equal(resolved.get(east.id), "right");
  assert.equal(resolved.get(north.id), "up");
  assert.equal(resolved.get(south.id), "down");
  assert.equal(resolved.get(tie.id), "right");
});

function position(id: string, x: number, y: number): PositionedNode {
  return { id, depth: 0, x, y, width: 20, height: 20 };
}
