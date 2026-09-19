import test from "node:test";
import assert from "node:assert/strict";
import { NodeDragController } from "../src/ui/controllers/node-drag-controller";
import { ImageResizeController } from "../src/ui/controllers/image-resize-controller";
import { CanvasInteractionController } from "../src/ui/controllers/canvas-interaction-controller";
import { DocumentSession } from "../src/services/document-session";
import { addNode, createEmptyDocument, moveNodes } from "../src/domain/tree";

function environment() {
  const window = new EventTarget();
  const document = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const ghosts: unknown[] = [];
  Object.assign(document, { defaultView: window, hidden: false, body: { appendChild: (child: unknown) => ghosts.push(child) } });
  Object.assign(window, { document,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (key: number) => frames.delete(key),
    getComputedStyle: () => ({ getPropertyValue: () => "" }) });
  const emit = (name: string, pointerId = 1, clientX = 0): void => {
    const event = new Event(name);
    Object.assign(event, { pointerId, clientX, clientY: 0 });
    window.dispatchEvent(event);
  };
  return { window: window as unknown as Window, document, frames, emit, ghosts };
}

function element(document: EventTarget, nodeId = "") {
  const classes = new Set<string>();
  const item = {
    ownerDocument: document,
    dataset: { nodeId },
    offsetWidth: 100, offsetHeight: 30,
    style: { width: "100px", height: "30px", setProperty: () => {} },
    classList: { add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, value: boolean) => value ? classes.add(name) : classes.delete(name) },
    addClass: (name: string) => classes.add(name), removeClass: (name: string) => classes.delete(name),
    toggleClass: (name: string, value: boolean) => value ? classes.add(name) : classes.delete(name),
    querySelector: () => null, removeAttribute: () => {}, remove: () => {},
    cloneNode: (): unknown => element(document),
    classes
  };
  return item;
}

test("mouse node drag ignores unrelated fingers and pointercancel never creates history", () => {
  for (const ending of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
    const env = environment();
    let doc = createEmptyDocument("Root");
    const source = addNode(doc, doc.rootId, "Source");
    const target = addNode(doc, doc.rootId, "Target");
    const history = new DocumentSession();
    history.load("disk");
    const root = element(env.document);
    const sourceEl = element(env.document, source.id);
    const nodes = { querySelectorAll: () => [sourceEl] };
    const lines = { querySelectorAll: () => [] };
    let commits = 0;
    const controller = new NodeDragController(root as unknown as HTMLElement, nodes as unknown as HTMLElement, lines as unknown as SVGSVGElement, {
      resolvePlacement: () => ({ targetId: target.id, position: "inside" }),
      showPlacement: () => sourceEl as unknown as HTMLElement,
      clearPlacement: () => {},
      moveNodes: (ids, targetId, position) => {
        commits++; doc = history.execute(doc, (draft) => moveNodes(draft, ids, targetId, position));
      }, reportFailure: (error) => { throw error; }
    });
    controller.start({ pointerId: 1, clientX: 0, clientY: 0 }, {
      nodeId: source.id, draggedRootIds: [source.id], excludedIds: new Set([source.id]),
      sourceElement: sourceEl as unknown as HTMLElement,
      sourceRect: { width: 100, height: 30 } as DOMRect
    });
    env.emit("pointermove", 2, 90); env.emit("pointerup", 2, 90);
    assert.equal(env.ghosts.length, 0);
    env.emit("pointermove", 1, 40);
    assert.equal(env.ghosts.length, 1);
    assert.equal(sourceEl.classes.has("is-drag-hidden"), true);
    env.emit(ending, 1, 50); env.emit("pointerup", 1, 60);
    assert.equal(commits, ending === "pointerup" ? 1 : 0);
    assert.equal(history.canUndo, ending === "pointerup");
    assert.equal(sourceEl.classes.has("is-drag-hidden"), false);
    assert.equal(root.classes.has("is-dragging-node"), false);
    controller.destroy();
  }
});

test("image resizing locks pointer identity, clamps size, and commits only one history entry", () => {
  for (const external of [false, true]) {
    const env = environment();
    const committed: number[] = [];
    let cancels = 0;
    const controller = new ImageResizeController(env.window, {
      preview: () => {}, commit: (_id, size) => { committed.push(size.width); assert.equal(size.width / size.height, 2); },
      cancel: () => { cancels++; }
    });
    const start = { pointerId: 1, clientX: 0, clientY: 0 };
    const input = { nodeId: "image", size: { width: 100, height: 50 }, aspectRatio: 2, zoom: 2 };
    controller.start(start, input, external);
    controller.move({ ...start, pointerId: 2, clientX: 300 });
    controller.finish({ ...start, pointerId: 2, clientX: 300 });
    assert.deepEqual(committed, []);
    controller.move({ ...start, clientX: 120 });
    controller.finish({ ...start, clientX: 200 });
    controller.finish({ ...start, clientX: 200 });
    assert.deepEqual(committed, [200]);
    assert.equal(env.frames.size, 0);
    controller.start(start, input, external);
    controller.move({ ...start, clientX: 2000 });
    if (external) controller.cancel(); else env.emit("pointercancel");
    assert.equal(cancels, 1);
    assert.deepEqual(committed, [200]);
    assert.equal(env.frames.size, 0);
    controller.start(start, { ...input, size: { width: 20, height: 10 } }, external);
    controller.finish(start);
    assert.deepEqual(committed, [200], "tapping a tiny image handle must not resize it");
    controller.destroy();
  }
});

test("normal marquee completion is not undone by lost capture, while cancellation restores selection", () => {
  let selection = new Set<string>();
  const captures = new Set<number>();
  const canvas = { focus: () => {}, addClass: () => {}, removeClass: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id); controller.pointerCancel(pointer(id)); } };
  const nodeLayer = { querySelectorAll: () => [{ dataset: { nodeId: "hit" }, getBoundingClientRect: () => ({ left: 1, right: 2, top: 1, bottom: 2 }) }] };
  const marquee = { style: {}, hide: () => {}, show: () => {}, getBoundingClientRect: () => ({ left: 0, right: 10, top: 0, bottom: 10 }) };
  const controller = new CanvasInteractionController(canvas as unknown as HTMLElement, nodeLayer as unknown as HTMLElement, marquee as unknown as HTMLElement, {
    hasDocument: () => true, readSelection: () => ({ ids: selection }),
    replaceSelection: (ids) => { selection = new Set(ids); }, panBy: () => {}, panWheel: () => {},
    zoomAtStep: () => {}, rememberZoomAnchor: () => {}, suppressNextContextMenu: () => {}
  });
  function pointer(id = 1): PointerEvent {
    return { pointerId: id, pointerType: "mouse", button: 0, clientX: 0, clientY: 0,
      target: { closest: () => null }, preventDefault: () => {} } as unknown as PointerEvent;
  }
  controller.pointerDown(pointer()); controller.pointerUp(pointer());
  assert.deepEqual([...selection], ["hit"]);
  selection = new Set(["before"]);
  controller.pointerDown(pointer()); controller.pointerCancel(pointer());
  assert.deepEqual([...selection], ["before"]);
  controller.destroy();
});
