import test from "node:test";
import assert from "node:assert/strict";
import {
  centerDragGhostAtPointer,
  resolveDropPlacement,
  type DropNodeRect
} from "../src/ui/drop-placement";

const vertical: DropNodeRect[] = [
  { id: "parent", left: 0, top: 40, right: 100, bottom: 70 },
  { id: "first", parentId: "parent", left: 180, top: 0, right: 280, bottom: 30 },
  { id: "second", parentId: "parent", left: 180, top: 60, right: 280, bottom: 90 }
];

test("node bodies always resolve to child insertion", () => {
  assert.deepEqual(resolveDropPlacement(vertical, 220, 70, "right"), {
    targetId: "second",
    position: "inside"
  });
});

test("vertical sibling gaps and both outer edges resolve to ordered insertion", () => {
  assert.deepEqual(resolveDropPlacement(vertical, 220, 45, "right"), { targetId: "second", position: "before" });
  assert.deepEqual(resolveDropPlacement(vertical, 220, -15, "right"), { targetId: "first", position: "before" });
  assert.deepEqual(resolveDropPlacement(vertical, 220, 110, "right"), { targetId: "second", position: "after" });
  assert.equal(resolveDropPlacement(vertical, 400, 45, "right"), undefined);
});

test("tree layout uses horizontal sibling gaps", () => {
  const horizontal: DropNodeRect[] = [
    { id: "parent", left: 100, top: 0, right: 200, bottom: 30 },
    { id: "first", parentId: "parent", left: 0, top: 100, right: 80, bottom: 130 },
    { id: "second", parentId: "parent", left: 110, top: 100, right: 190, bottom: 130 }
  ];
  assert.deepEqual(resolveDropPlacement(horizontal, 95, 115, "tree"), { targetId: "second", position: "before" });
});

test("excluded dragged branches cannot become drop targets", () => {
  assert.equal(resolveDropPlacement(vertical, 220, 15, "right", new Set(["first"])), undefined);
});

test("drag preview is centered on the pointer at every rendered node size", () => {
  assert.deepEqual(centerDragGhostAtPointer(300, 200, 120, 40), { left: 240, top: 180 });
  assert.deepEqual(centerDragGhostAtPointer(300, 200, 72, 28), { left: 264, top: 186 });
});
