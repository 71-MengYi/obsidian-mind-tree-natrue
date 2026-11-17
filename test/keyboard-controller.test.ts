import test from "node:test";
import assert from "node:assert/strict";
import { KeyboardController, type KeyboardActions } from "../src/ui/controllers/keyboard-controller";

interface FakeKeyEvent {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function keyEvent(key: string, options: {
  shiftKey?: boolean;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
} = {}): FakeKeyEvent {
  const event: FakeKeyEvent = {
    key,
    shiftKey: options.shiftKey ?? false,
    repeat: options.repeat ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: false,
    altKey: options.altKey ?? false,
    target: options.target ?? null,
    defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; }
  };
  return event;
}

/** Minimal element stub: only the selectors `isTextEditingTarget` matches. */
function element(tag: string): EventTarget {
  const selectors = new Set([tag, "[contenteditable='true']"]);
  return {
    matches: (selector: string) => selector.split(",").some((part) => selectors.has(part.trim())),
    closest: () => null
  } as unknown as EventTarget;
}

function createHarness(hasPrimary: boolean): {
  controller: KeyboardController;
  calls: string[];
} {
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); };
  const actions: KeyboardActions = {
    hasPrimarySelection: () => hasPrimary,
    save: record("save"),
    moveSibling: () => { calls.push("moveSibling"); },
    navigate: () => { calls.push("navigate"); },
    selectAll: record("selectAll"),
    undo: record("undo"),
    redo: record("redo"),
    copy: record("copy"),
    cut: record("cut"),
    createNote: record("createNote"),
    addParent: record("addParent"),
    addChild: record("addChild"),
    editAtEnd: record("editAtEnd"),
    addSibling: () => { calls.push("addSibling"); },
    deleteSelection: record("deleteSelection"),
    cancel: record("cancel")
  };
  return { controller: new KeyboardController(actions), calls };
}

test("an unselected canvas still consumes Tab so focus cannot escape into another note", () => {
  const harness = createHarness(false);
  const event = keyEvent("Tab");
  harness.controller.keyDown(event as unknown as KeyboardEvent);
  // The browser default would move focus to the next tabbable element, which is
  // usually a Markdown editor where Tab indents the current line.
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, ["addChild"]);
});

test("Shift+Tab without a selected node stays in the canvas and creates nothing", () => {
  const harness = createHarness(false);
  const event = keyEvent("Tab", { shiftKey: true });
  harness.controller.keyDown(event as unknown as KeyboardEvent);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, []);
});

test("a selected node keeps Tab and Shift+Tab as structural commands", () => {
  const child = createHarness(true);
  const childEvent = keyEvent("Tab");
  child.controller.keyDown(childEvent as unknown as KeyboardEvent);
  assert.equal(childEvent.defaultPrevented, true);
  assert.deepEqual(child.calls, ["addChild"]);

  const parent = createHarness(true);
  const parentEvent = keyEvent("Tab", { shiftKey: true });
  parent.controller.keyDown(parentEvent as unknown as KeyboardEvent);
  assert.equal(parentEvent.defaultPrevented, true);
  assert.deepEqual(parent.calls, ["addParent"]);
});

test("held Tab repeats stay inside the canvas without creating nodes", () => {
  const harness = createHarness(false);
  const event = keyEvent("Tab", { repeat: true });
  harness.controller.keyDown(event as unknown as KeyboardEvent);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, []);
});

test("a Tab typed inside a text field or dialog keeps the control's own behaviour", () => {
  for (const target of [element("textarea"), element("input"), element("div")]) {
    const harness = createHarness(true);
    const event = keyEvent("Tab", { target });
    harness.controller.keyDown(event as unknown as KeyboardEvent);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(harness.calls, []);
  }
});

test("Mod+Tab without a selection keeps the host's tab cycling", () => {
  const harness = createHarness(false);
  const event = keyEvent("Tab", { ctrlKey: true });
  harness.controller.keyDown(event as unknown as KeyboardEvent);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(harness.calls, []);
});

test("a key recovered from a stale editor is handled although its target is a text field", () => {
  const harness = createHarness(true);
  const event = keyEvent("Tab", { target: element("textarea") });
  harness.controller.keyDownFromStaleFocus(event as unknown as KeyboardEvent);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(harness.calls, ["addChild"]);

  // The ordinary entry still leaves a real text field to its own behaviour.
  const control = createHarness(true);
  const controlEvent = keyEvent("Tab", { target: element("textarea") });
  control.controller.keyDown(controlEvent as unknown as KeyboardEvent);
  assert.equal(controlEvent.defaultPrevented, false);
  assert.deepEqual(control.calls, []);
});

test("a consumed key event is never handled twice", () => {
  const harness = createHarness(true);
  const event = keyEvent("Tab");
  event.defaultPrevented = true;
  harness.controller.keyDown(event as unknown as KeyboardEvent);
  assert.deepEqual(harness.calls, []);
});
