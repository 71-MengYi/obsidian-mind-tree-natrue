import type { NodeId } from "../../types";

/** Distances are screen CSS pixels, deliberately independent of canvas zoom. */
export const TOUCH_MOVE_TOLERANCE = 8;
export const TOUCH_LONG_PRESS_MS = 450;
export const TOUCH_DOUBLE_TAP_MS = 300;
export const TOUCH_DOUBLE_TAP_DISTANCE = 24;

export interface GesturePointer {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
}

export type TouchTarget =
  | { readonly kind: "canvas" }
  | { readonly kind: "node"; readonly nodeId: NodeId; readonly draggable: boolean }
  | { readonly kind: "control"; readonly nodeId: NodeId; readonly action: "fold" | "open" }
  | { readonly kind: "resize"; readonly nodeId: NodeId };

export type TouchPair = readonly [GesturePointer, GesturePointer];
export type TouchGestureMode = "idle" | "pending" | "armed" | "pan" | "drag" | "resize" | "pinch";

export interface TouchGestureClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

/** Named ports keep gesture recognition independent of DOM and domain mutations. */
export interface TouchGestureActions {
  selectNode(nodeId: NodeId): void;
  editNode(nodeId: NodeId): void;
  showNodeMenu(nodeId: NodeId, point: GesturePointer): void;
  activateControl(nodeId: NodeId, action: "fold" | "open"): void;
  panBy(x: number, y: number): void;
  pinch(previous: TouchPair, current: TouchPair): void;
  startNodeDrag(nodeId: NodeId, point: GesturePointer): void;
  moveNodeDrag(point: GesturePointer): void;
  finishNodeDrag(point: GesturePointer): void;
  cancelNodeDrag(): void;
  startImageResize(nodeId: NodeId, point: GesturePointer): void;
  moveImageResize(point: GesturePointer): void;
  finishImageResize(point: GesturePointer): void;
  cancelImageResize(): void;
}

/**
 * One touch sequence has exactly one owner. A second finger always supersedes
 * a speculative structural operation; only a real final pointer-up can commit.
 * This class has no browser dependencies so all interleavings can be tested.
 */
export class TouchGestureMachine {
  private readonly pointers = new Map<number, GesturePointer>();
  private target: TouchTarget = { kind: "canvas" };
  private origin?: GesturePointer;
  private timer?: number;
  private lastTap?: { nodeId: NodeId; point: GesturePointer; time: number };
  private _mode: TouchGestureMode = "idle";

  constructor(private readonly actions: TouchGestureActions, private readonly clock: TouchGestureClock) {}

  get mode(): TouchGestureMode { return this._mode; }
  get active(): boolean { return this.pointers.size > 0; }
  hasPointer(id: number): boolean { return this.pointers.has(id); }

  down(point: GesturePointer, target: TouchTarget): void {
    if (this.pointers.has(point.pointerId)) return;
    this.pointers.set(point.pointerId, point);
    if (this.pointers.size > 1) {
      this.clearTimer();
      this.lastTap = undefined;
      this.cancelMutation();
      this._mode = "pinch";
      return;
    }
    this.target = target;
    this.origin = point;
    this._mode = target.kind === "resize" ? "resize" : "pending";
    if (target.kind === "resize") {
      this.lastTap = undefined;
      this.actions.startImageResize(target.nodeId, point);
    } else if (target.kind === "node") {
      this.timer = this.clock.setTimeout(() => {
        this.timer = undefined;
        if (this._mode !== "pending" || this.pointers.size !== 1) return;
        this._mode = "armed";
        this.lastTap = undefined;
        this.actions.selectNode(target.nodeId);
      }, TOUCH_LONG_PRESS_MS);
    }
  }

  move(point: GesturePointer): void {
    const previous = this.pointers.get(point.pointerId);
    if (!previous) return;
    const oldPair = this.pair();
    this.pointers.set(point.pointerId, point);
    if (this._mode === "pinch") {
      const pair = this.pair();
      // Extra fingers are tracked for cleanup, but cannot perturb the pair.
      if (oldPair && pair && oldPair.some((item) => item.pointerId === point.pointerId)) {
        this.actions.pinch(oldPair, pair);
      }
      return;
    }
    if (this._mode === "drag") { this.actions.moveNodeDrag(point); return; }
    if (this._mode === "resize") { this.actions.moveImageResize(point); return; }
    if (this._mode === "pan") {
      this.actions.panBy(point.clientX - previous.clientX, point.clientY - previous.clientY);
      return;
    }
    const origin = this.origin;
    if (!origin || distance(point, origin) <= TOUCH_MOVE_TOLERANCE) return;
    this.clearTimer();
    this.lastTap = undefined;
    if (this._mode === "armed" && this.target.kind === "node" && this.target.draggable) {
      this._mode = "drag";
      this.actions.startNodeDrag(this.target.nodeId, point);
    } else {
      this._mode = "pan";
      this.actions.panBy(point.clientX - origin.clientX, point.clientY - origin.clientY);
    }
  }

  up(point: GesturePointer): void {
    if (!this.pointers.has(point.pointerId)) return;
    // Some WebViews deliver the last coordinate only with pointer-up.
    this.move(point);
    this.clearTimer();
    const mode = this._mode;
    this.pointers.delete(point.pointerId);
    if (this.pointers.size > 0) {
      this._mode = this.pointers.size > 1 ? "pinch" : "pan";
      this.origin = this.pointers.values().next().value;
      return;
    }
    // Reset before invoking callbacks: a commit may synchronously replace DOM.
    this._mode = "idle";
    const target = this.target;
    this.origin = undefined;
    if (mode === "drag") this.actions.finishNodeDrag(point);
    else if (mode === "resize") this.actions.finishImageResize(point);
    else if (mode === "armed" && target.kind === "node") this.actions.showNodeMenu(target.nodeId, point);
    else if (mode === "pending") {
      if (target.kind === "control") {
        this.lastTap = undefined;
        this.actions.activateControl(target.nodeId, target.action);
      } else if (target.kind === "node") {
        const time = this.clock.now();
        const last = this.lastTap;
        this.actions.selectNode(target.nodeId);
        if (last?.nodeId === target.nodeId && time - last.time <= TOUCH_DOUBLE_TAP_MS
          && distance(last.point, point) <= TOUCH_DOUBLE_TAP_DISTANCE) {
          this.lastTap = undefined;
          this.actions.editNode(target.nodeId);
        } else this.lastTap = { nodeId: target.nodeId, point, time };
      } else this.lastTap = undefined;
    }
  }

  cancel(): void {
    this.clearTimer();
    const mode = this._mode;
    this._mode = "idle";
    this.pointers.clear();
    this.origin = undefined;
    this.lastTap = undefined;
    if (mode === "drag") this.actions.cancelNodeDrag();
    if (mode === "resize") this.actions.cancelImageResize();
  }

  private cancelMutation(): void {
    const mode = this._mode;
    this._mode = "pinch";
    if (mode === "drag") this.actions.cancelNodeDrag();
    if (mode === "resize") this.actions.cancelImageResize();
  }

  private pair(): TouchPair | undefined {
    const values = [...this.pointers.values()];
    const first = values[0];
    const second = values[1];
    return first && second ? [first, second] : undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function distance(a: GesturePointer, b: GesturePointer): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
