import test from "node:test";
import assert from "node:assert/strict";
import { TouchGestureController, isCanvasTouchPath, isTouchCompatibilityEvent, type TouchControllerActions } from "../src/ui/controllers/touch-gesture-controller";

/** Tiny event surface: tests routing/lifecycle without requiring Obsidian or a DOM framework. */
class Surface extends EventTarget {
  listenerCount = 0;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options); this.listenerCount++;
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, listener, options); this.listenerCount--;
  }
}

function fixture() {
  let token: string | undefined = "one";
  let time = 0;
  let sequence = 0;
  const timers = new Map<number, () => void>();
  const window = new Surface();
  const document = new Surface();
  Object.assign(document, { defaultView: window, hidden: false });
  Object.assign(window, { document, performance: { now: () => time },
    setTimeout: (fn: () => void) => { timers.set(++sequence, fn); return sequence; },
    clearTimeout: (id: number) => { timers.delete(id); } });
  const captures = new Set<number>();
  const canvas = new Surface();
  Object.assign(canvas, { ownerDocument: document, isConnected: true, getClientRects: () => [{}],
    setPointerCapture: (id: number) => { captures.add(id); },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => {
      captures.delete(id);
      emit("lostpointercapture", { pointerId: id }, [canvas]);
    } });
  const node = { dataset: { nodeId: "node" }, matches: () => false,
    closest: (selector: string) => selector.startsWith(".mtn-node") ? node : null };
  const input = { matches: () => true, closest: () => node };
  const calls: string[] = [];
  const names = ["selectNode", "editNode", "showNodeMenu", "activateControl", "panBy", "pinch", "startNodeDrag",
    "moveNodeDrag", "finishNodeDrag", "cancelNodeDrag", "startImageResize", "moveImageResize", "finishImageResize", "cancelImageResize"] as const;
  const actions = {
    ...Object.fromEntries(names.map((name) => [name, () => calls.push(name)])),
    sessionToken: () => token, prepareGesture: () => calls.push("prepare"), canDragNode: () => true
  } as unknown as TouchControllerActions;
  const controller = new TouchGestureController(canvas as unknown as HTMLElement, actions);
  function emit(type: string, properties: Record<string, unknown> = {}, path: unknown[] = [node, canvas]): Event {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.assign(event, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 20, detail: 1 }, properties);
    Object.defineProperty(event, "composedPath", { value: () => [...path, document, window] });
    window.dispatchEvent(event);
    return event;
  }
  return { controller, window, document, canvas, node, input, calls, timers, captures, emit,
    tick: () => { time += 450; for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    changeSession: () => { token = "two"; } };
}

test("only touch sequences originating in this canvas are consumed", () => {
  const s = fixture();
  let hostCalls = 0;
  s.window.addEventListener("pointerdown", () => { hostCalls++; });
  assert.equal(s.emit("pointerdown").defaultPrevented, true);
  assert.equal(hostCalls, 0);
  s.emit("pointerup");
  assert.equal(s.calls.filter((name) => name === "selectNode").length, 1);
  assert.equal(s.captures.size, 0);
  assert.equal(s.emit("pointerdown", { pointerId: 2 }, []).defaultPrevented, false);
  assert.equal(s.emit("pointerdown", { pointerId: 3 }, [s.input, s.node, s.canvas]).defaultPrevented, false);
  assert.equal(s.emit("pointerdown", { pointerType: "mouse", pointerId: 4 }).defaultPrevented, false);
  assert.equal(hostCalls, 3);
  s.controller.destroy();
});

test("Touch Events are isolated for the complete sequence, not globally", () => {
  const s = fixture();
  const touches = [{ identifier: 10 }];
  const outside = [{ identifier: 20 }];
  assert.equal(s.emit("touchstart", { changedTouches: touches }).defaultPrevented, true);
  assert.equal(s.emit("touchmove", { changedTouches: touches }, []).defaultPrevented, true);
  assert.equal(s.emit("touchmove", { changedTouches: outside }, []).defaultPrevented, false);
  assert.equal(s.emit("touchend", { changedTouches: touches }, []).defaultPrevented, true);
  assert.equal(s.emit("touchmove", { changedTouches: touches }, []).defaultPrevented, false);
  assert.equal(s.emit("touchstart", { changedTouches: outside }, [s.input, s.node, s.canvas]).defaultPrevented, false);
  s.controller.destroy();
});

test("compatibility clicks are swallowed once without breaking keyboard or real mouse activation", () => {
  const s = fixture();
  s.emit("pointerdown"); s.emit("pointerup");
  assert.equal(s.emit("click").defaultPrevented, true);
  assert.equal(s.emit("dblclick").defaultPrevented, true);
  assert.equal(s.emit("click", { pointerType: "", detail: 0 }).defaultPrevented, false);
  assert.equal(s.emit("click", { pointerType: "mouse" }).defaultPrevented, false);
  const recent = { time: 0, point: { pointerId: 1, clientX: 10, clientY: 10 } };
  const click = { type: "click", detail: 1, clientX: 10, clientY: 10 };
  assert.equal(isTouchCompatibilityEvent(click, recent, 500, false), true);
  assert.equal(isTouchCompatibilityEvent(click, recent, 801, false), false);
  assert.equal(isTouchCompatibilityEvent({ ...click, clientX: 100 }, recent, 500, false), false);
  assert.equal(s.calls.filter((name) => name === "selectNode").length, 1);
  s.controller.destroy();
});

test("the shared resource-open button activates once per touch without a synthetic second click", () => {
  const s = fixture();
  const button = {
    matches: () => false,
    closest: (selector: string): unknown => selector === ".mtn-resource-open"
      ? button : selector.startsWith(".mtn-node") ? s.node : null
  };
  const path = [button, s.node, s.canvas];
  s.emit("pointerdown", {}, path);
  s.emit("pointerup", {}, path);
  assert.equal(s.calls.filter((name) => name === "activateControl").length, 1);
  assert.equal(s.calls.filter((name) => name === "selectNode").length, 0);
  assert.equal(s.emit("click", {}, path).defaultPrevented, true);
  assert.equal(s.emit("dblclick", {}, path).defaultPrevented, true);
  assert.equal(s.calls.filter((name) => name === "activateControl").length, 1);
  s.controller.destroy();
});

test("switching sessions during a hold or drag never applies the operation to the new file", () => {
  const s = fixture();
  s.emit("pointerdown"); s.changeSession(); s.tick(); s.emit("pointerup");
  assert.equal(s.calls.filter((name) => name !== "prepare").length, 0);
  assert.equal(s.captures.size, 0);
  s.emit("pointerdown"); s.tick(); s.emit("pointermove", { clientX: 60 });
  assert.ok(s.calls.includes("startNodeDrag"));
  s.emit("pointercancel"); s.emit("pointerup");
  assert.ok(s.calls.includes("cancelNodeDrag"));
  assert.ok(!s.calls.includes("finishNodeDrag"));
  s.controller.destroy();
});

test("blur, lost capture, hidden documents and destroy release all resources without committing", () => {
  for (const ending of ["blur", "lostpointercapture", "visibilitychange", "destroy"]) {
    const s = fixture();
    s.emit("pointerdown"); s.tick(); s.emit("pointermove", { clientX: 60 });
    if (ending === "destroy") s.controller.destroy();
    else if (ending === "visibilitychange") {
      Object.assign(s.document, { hidden: true });
      s.document.dispatchEvent(new Event("visibilitychange"));
    } else s.emit(ending);
    s.controller.destroy(); s.controller.destroy();
    assert.equal(s.calls.filter((name) => name === "cancelNodeDrag").length, 1, ending);
    assert.ok(!s.calls.includes("finishNodeDrag"), ending);
    assert.equal(s.captures.size, 0, ending);
    assert.equal(s.timers.size, 0, ending);
    assert.equal(s.window.listenerCount + s.document.listenerCount, 0, ending);
  }
});

test("multiple canvases and native input composed paths cannot claim one another's touch", () => {
  const a = {} as HTMLElement;
  const b = {} as HTMLElement;
  const native = { matches: () => true } as unknown as HTMLElement;
  assert.equal(isCanvasTouchPath([a], a), true);
  assert.equal(isCanvasTouchPath([b], a), false);
  assert.equal(isCanvasTouchPath([native, a], a), false);
  const popup = { matches: (selector: string) => selector.includes(".modal") } as unknown as HTMLElement;
  assert.equal(isCanvasTouchPath([popup, a], a), false);
});
