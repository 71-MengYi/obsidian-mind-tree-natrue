import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import {
  resolveArrowNavigationTarget,
  shouldHandleStructuralCreationKey
} from "../src/ui/keyboard-navigation";

test("structural keys accept distinct presses and reject held-key auto-repeat", () => {
  assert.equal(shouldHandleStructuralCreationKey("Enter", false), true);
  assert.equal(shouldHandleStructuralCreationKey("Tab", false), true);
  assert.equal(shouldHandleStructuralCreationKey("Enter", true), false);
  assert.equal(shouldHandleStructuralCreationKey("Tab", true), false);
  assert.equal(shouldHandleStructuralCreationKey(" ", false), false);
});

test("up and down arrows move through persistent sibling order", () => {
  const document = createEmptyDocument("Root");
  const first = addNode(document, document.rootId, "First");
  const second = addNode(document, document.rootId, "Second");
  const third = addNode(document, document.rootId, "Third");

  assert.equal(resolveArrowNavigationTarget(document, second.id, "ArrowUp", "right"), first.id);
  assert.equal(resolveArrowNavigationTarget(document, second.id, "ArrowDown", "right"), third.id);
  assert.equal(resolveArrowNavigationTarget(document, first.id, "ArrowUp", "right"), undefined);
  assert.equal(resolveArrowNavigationTarget(document, third.id, "ArrowDown", "right"), undefined);
});

test("left and right arrows follow right-facing and left-facing hierarchy directions", () => {
  const document = createEmptyDocument("Root");
  const parent = addNode(document, document.rootId, "Parent");
  const firstChild = addNode(document, parent.id, "First child");
  addNode(document, parent.id, "Second child");

  assert.equal(resolveArrowNavigationTarget(document, parent.id, "ArrowRight", "right"), firstChild.id);
  assert.equal(resolveArrowNavigationTarget(document, parent.id, "ArrowLeft", "right"), document.rootId);
  assert.equal(resolveArrowNavigationTarget(document, parent.id, "ArrowLeft", "left"), firstChild.id);
  assert.equal(resolveArrowNavigationTarget(document, parent.id, "ArrowRight", "left"), document.rootId);
});

test("balanced branches reverse hierarchy keys on the left side", () => {
  const document = createEmptyDocument("Root");
  const leftBranch = addNode(document, document.rootId, "Left");
  const child = addNode(document, leftBranch.id, "Child");
  const positions = [
    { id: document.rootId, depth: 0, x: 200, y: 100, width: 100, height: 30 },
    { id: leftBranch.id, depth: 1, x: 20, y: 100, width: 100, height: 30 },
    { id: child.id, depth: 2, x: -140, y: 100, width: 100, height: 30 }
  ];

  assert.equal(
    resolveArrowNavigationTarget(document, leftBranch.id, "ArrowLeft", "balanced", positions),
    child.id
  );
  assert.equal(
    resolveArrowNavigationTarget(document, leftBranch.id, "ArrowRight", "balanced", positions),
    document.rootId
  );
});

test("collapsed branches do not focus hidden children", () => {
  const document = createEmptyDocument("Root");
  const parent = addNode(document, document.rootId, "Parent");
  addNode(document, parent.id, "Hidden child");
  parent.collapsed = true;
  assert.equal(resolveArrowNavigationTarget(document, parent.id, "ArrowRight", "right"), undefined);
});
