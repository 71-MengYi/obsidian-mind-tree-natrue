import test from "node:test";
import assert from "node:assert/strict";
import {
  TouchGestureMachine, type GesturePointer, type TouchGestureClock,
  type TouchGestureActions, type TouchTarget
} from "../src/ui/controllers/touch-gesture";
import { pinchViewport, MAX_ZOOM, MIN_ZOOM } from "../src/ui/viewport";
import { keyboardAvoidanceDelta, KeyboardAvoidanceOffset } from "../src/ui/controllers/keyboard-avoidance-controller";

class Clock implements TouchGestureClock {
  time = 0;
  sequence = 0;
  timers = new Map<number, { time: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.sequence;
    this.timers.set(id, { time: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  tick(ms: number): void {
    this.time += ms;
    for (const [id, timer] of this.timers) if (timer.time <= this.time) {
      this.timers.delete(id); timer.callback();
    }
  }
}

const point = (x = 0, y = 0, pointerId = 1): GesturePointer => ({ pointerId, clientX: x, clientY: y });
const node: TouchTarget = { kind: "node", nodeId: "node", draggable: true };
const canvas: TouchTarget = { kind: "canvas" };

function setup() {
  const clock = new Clock();
  const calls: Array<{ name: keyof TouchGestureActions; args: unknown[] }> = [];
  const names: Array<keyof TouchGestureActions> = ["selectNode", "editNode", "showNodeMenu", "activateControl",
    "panBy", "pinch", "startNodeDrag", "moveNodeDrag", "finishNodeDrag", "cancelNodeDrag",
    "startImageResize", "moveImageResize", "finishImageResize", "cancelImageResize"];
  const actions = Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => calls.push({ name, args })])) as unknown as TouchGestureActions;
  const machine = new TouchGestureMachine(actions, clock);
  return { machine, clock, calls, count: (name: keyof TouchGestureActions) => calls.filter((call) => call.name === name).length };
}

test("ordinary finger swipes pan even when they start over a node or its buttons", () => {
  for (const target of [canvas, node, { kind: "control", nodeId: "node", action: "open" } as TouchTarget]) {
    const s = setup();
    s.machine.down(point(), target);
    s.machine.move(point(8));
    assert.equal(s.calls.length, 0);
    s.machine.move(point(12, 10));
    s.clock.tick(1000);
    s.machine.up(point(20, 10));
    assert.equal(s.count("startNodeDrag"), 0);
    assert.equal(s.count("selectNode"), 0);
    assert.equal(s.count("activateControl"), 0);
    assert.deepEqual(s.calls.filter((c) => c.name === "panBy").map((c) => c.args), [[12, 10], [8, 0]]);
  }
});

test("node taps select on release and recognize their own same-node double tap", () => {
  const s = setup();
  s.machine.down(point(10, 10), node);
  assert.equal(s.count("selectNode"), 0);
  s.machine.up(point(10, 10));
  s.clock.tick(300);
  s.machine.down(point(20, 10), node);
  s.machine.up(point(20, 10));
  assert.equal(s.count("selectNode"), 2);
  assert.equal(s.count("editNode"), 1);
  assert.equal(s.machine.mode, "idle");
});

test("double taps do not cross node, time, distance, pan or cancellation boundaries", () => {
  for (const variant of ["node", "time", "distance", "pan", "cancel"]) {
    const s = setup();
    s.machine.down(point(), node); s.machine.up(point());
    if (variant === "pan") { s.machine.down(point(), canvas); s.machine.move(point(40)); s.machine.up(point(40)); }
    if (variant === "cancel") s.machine.cancel();
    s.clock.tick(variant === "time" ? 301 : 10);
    const p = point(variant === "distance" ? 25 : 0);
    s.machine.down(p, variant === "node" ? { ...node, nodeId: "other" } : node);
    s.machine.up(p);
    assert.equal(s.count("editNode"), 0, variant);
  }
});

test("long press arms at 450ms and opens one menu only on stationary release", () => {
  const s = setup();
  s.machine.down(point(), node);
  s.clock.tick(449);
  assert.equal(s.machine.mode, "pending");
  s.clock.tick(1);
  assert.equal(s.machine.mode, "armed");
  assert.equal(s.count("selectNode"), 1);
  assert.equal(s.count("showNodeMenu"), 0);
  s.machine.move(point(8));
  s.machine.up(point(8));
  assert.equal(s.count("showNodeMenu"), 1);
  assert.equal(s.count("startNodeDrag"), 0);
});

test("armed drag commits once on the initiating finger's release, never opens a menu", () => {
  const s = setup();
  s.machine.down(point(), node); s.clock.tick(450);
  s.machine.move(point(9)); s.machine.move(point(50));
  s.machine.up(point(50, 0, 99));
  assert.equal(s.count("finishNodeDrag"), 0);
  s.machine.up(point(60)); s.machine.up(point(60));
  assert.equal(s.count("startNodeDrag"), 1);
  assert.equal(s.count("finishNodeDrag"), 1);
  assert.equal(s.count("showNodeMenu"), 0);
});

test("the protected root can show a menu but a held swipe still only pans", () => {
  const s = setup();
  s.machine.down(point(), { ...node, draggable: false }); s.clock.tick(450);
  s.machine.move(point(20)); s.machine.up(point(20));
  assert.equal(s.count("panBy"), 2);
  assert.equal(s.count("startNodeDrag"), 0);
  assert.equal(s.count("showNodeMenu"), 0);
});

test("a second finger cancels long press, node drag and image resize before pinching", () => {
  for (const variant of ["pending", "drag", "resize"]) {
    const s = setup();
    s.machine.down(point(), variant === "resize" ? { kind: "resize", nodeId: "image" } : node);
    if (variant === "drag") { s.clock.tick(450); s.machine.move(point(20)); }
    s.machine.down(point(100, 0, 2), canvas);
    s.clock.tick(1000);
    assert.equal(s.machine.mode, "pinch");
    s.machine.move(point(150, 0, 2));
    s.machine.up(point(150, 0, 2)); s.machine.up(point(20));
    assert.equal(s.count("finishNodeDrag"), 0);
    assert.equal(s.count("finishImageResize"), 0);
    assert.equal(s.count("showNodeMenu"), 0);
    assert.equal(s.count("cancelNodeDrag"), variant === "drag" ? 1 : 0);
    assert.equal(s.count("cancelImageResize"), variant === "resize" ? 1 : 0);
  }
});

test("pinch pointer replacement and return to one finger do not create taps or jumps", () => {
  const s = setup();
  s.machine.down(point(), node);
  s.machine.down(point(100, 0, 2), node);
  s.machine.down(point(200, 0, 3), node);
  s.machine.move(point(900, 0, 3));
  assert.equal(s.count("pinch"), 0);
  s.machine.up(point()); // fingers 2 and 3 now form the pair, without applying a jump
  const before = s.count("pinch");
  s.machine.move(point(110, 0, 2));
  assert.equal(s.count("pinch"), before + 1);
  s.machine.up(point(900, 0, 3));
  assert.equal(s.machine.mode, "pan");
  s.machine.move(point(113, 0, 2));
  assert.deepEqual(s.calls.at(-1), { name: "panBy", args: [3, 0] });
  s.machine.up(point(113, 0, 2));
  assert.equal(s.count("selectNode"), 0);
  assert.equal(s.count("editNode"), 0);
});

test("cancelling a touch sequence releases timers and cancels without committing", () => {
  for (const variant of ["pending", "drag", "resize"]) {
    const s = setup();
    s.machine.down(point(), variant === "resize" ? { kind: "resize", nodeId: "image" } : node);
    if (variant === "drag") { s.clock.tick(450); s.machine.move(point(20)); }
    s.machine.cancel(); s.machine.cancel(); s.clock.tick(2000); s.machine.up(point(20));
    assert.equal(s.clock.timers.size, 0);
    assert.equal(s.machine.mode, "idle");
    assert.equal(s.count("finishNodeDrag") + s.count("finishImageResize") + s.count("showNodeMenu"), 0);
  }
});

test("node controls activate once, and an image handle uses the resize path only", () => {
  const s = setup();
  s.machine.down(point(), { kind: "control", nodeId: "node", action: "fold" });
  s.machine.up(point()); s.machine.up(point());
  assert.equal(s.count("activateControl"), 1);
  s.machine.down(point(), { kind: "resize", nodeId: "image" });
  s.machine.move(point(20)); s.machine.up(point(25));
  assert.equal(s.count("startImageResize"), 1);
  assert.equal(s.count("finishImageResize"), 1);
  assert.equal(s.count("panBy") + s.count("startNodeDrag"), 0);
});

test("pinch preserves midpoint world anchors, moves at limits, and is not quantized", () => {
  const initial = { x: 40, y: 30, zoom: 1 };
  const result = pinchViewport(initial, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 120, y: 120 }, { x: 233, y: 120 }]);
  assert.equal(result.zoom, 1.13);
  assert.ok(Math.abs((176.5 - result.x) / result.zoom - 110) < 1e-9);
  assert.ok(Math.abs((120 - result.y) / result.zoom - 70) < 1e-9);
  const maximum = pinchViewport({ x: 0, y: 0, zoom: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 10 }, { x: 100, y: 10 }]);
  assert.equal(maximum.zoom, MAX_ZOOM);
  assert.equal(maximum.y, 10);
  const minimum = pinchViewport(initial, [{ x: 0, y: 0 }, { x: 1000, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  assert.equal(minimum.zoom, MIN_ZOOM);
  const identical = pinchViewport(initial, [{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 10, y: 0 }, { x: 10, y: 0 }]);
  assert.deepEqual(identical, { ...initial, x: 50 });
});

test("keyboard avoidance is minimal, uses the caret for tall drafts and never undoes user navigation", () => {
  const visible = { left: 0, top: 0, right: 400, bottom: 400 };
  const field = { left: 30, top: 390, right: 200, bottom: 430 };
  assert.deepEqual(keyboardAvoidanceDelta(field, field, visible), { x: 0, y: -42 });
  const tall = { left: 30, top: -300, right: 200, bottom: 800 };
  const caret = { left: 50, top: 250, right: 51, bottom: 270 };
  assert.deepEqual(keyboardAvoidanceDelta(tall, caret, visible), { x: 0, y: 0 });
  const offset = new KeyboardAvoidanceOffset();
  offset.add(4, -42); offset.add(0, -10);
  assert.deepEqual(offset.takeRestoration(), { x: -4, y: 52 });
  offset.add(0, -20); offset.userNavigated();
  const restored = offset.takeRestoration();
  assert.ok(restored.x === 0 && restored.y === 0);
});
