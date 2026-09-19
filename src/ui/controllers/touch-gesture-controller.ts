import { DisposerBag } from "../components/ui-object";
import {
  TouchGestureMachine, type GesturePointer, type TouchGestureActions, type TouchTarget
} from "./touch-gesture";

const NATIVE_INPUT_SELECTOR = "input,textarea,select,[contenteditable]:not([contenteditable='false']),.cm-editor,.modal,.menu";

export interface TouchControllerActions extends TouchGestureActions {
  sessionToken(): string | undefined;
  prepareGesture(): void;
  canDragNode(nodeId: string): boolean;
}

/** Use the event's actual composed path, not a stale activeElement from a leaf. */
export function isCanvasTouchPath(path: readonly EventTarget[], canvas: HTMLElement): boolean {
  if (!path.includes(canvas)) return false;
  return !path.some((target) => {
    const element = target as Element;
    return typeof element.matches === "function" && element.matches(NATIVE_INPUT_SELECTOR);
  });
}

/**
 * Compatibility mouse events lack pointerType on older WebKit. Only the recent
 * consumed touch location is suppressed in that fallback; keyboard activation
 * and explicitly identified real mouse input must always remain available.
 */
export function isTouchCompatibilityEvent(
  event: { type: string; detail: number; clientX: number; clientY: number; pointerType?: string;
    sourceCapabilities?: { firesTouchEvents: boolean } | null },
  recent: { point: GesturePointer; time: number } | undefined,
  now: number,
  active: boolean
): boolean {
  if (event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents) return true;
  if (event.pointerType === "mouse" || event.sourceCapabilities?.firesTouchEvents === false) return false;
  if (event.type !== "contextmenu" && event.detail === 0) return false;
  return Boolean(recent && (active || now - recent.time <= 800)
    && Math.hypot(event.clientX - recent.point.clientX, event.clientY - recent.point.clientY) <= 26);
}

/**
 * Pointer Events recognize gestures; Touch Events only form the host boundary.
 * Capture on the owning window intercepts app-level document/ancestor handlers
 * early, but only for sequences that originated in this particular canvas.
 * No Obsidian private API or global setting is patched.
 */
export class TouchGestureController {
  private readonly disposers = new DisposerBag();
  private readonly machine: TouchGestureMachine;
  private readonly captured = new Set<number>();
  private readonly nativeTouches = new Set<number>();
  private readonly ownerWindow: Window;
  private session?: string;
  private recent?: { point: GesturePointer; time: number };
  private destroyed = false;

  constructor(private readonly canvas: HTMLElement, private readonly actions: TouchControllerActions) {
    this.ownerWindow = canvas.ownerDocument.defaultView!;
    this.machine = new TouchGestureMachine(actions, {
      now: () => this.ownerWindow.performance.now(),
      setTimeout: (callback, delay) => this.ownerWindow.setTimeout(() => {
        if (this.ensureSession()) callback();
      }, delay),
      clearTimeout: (id) => this.ownerWindow.clearTimeout(id)
    });
    const listen = (target: EventTarget, name: string, callback: EventListener, options: AddEventListenerOptions = { capture: true }): void => {
      target.addEventListener(name, callback, options);
      this.disposers.add(() => target.removeEventListener(name, callback, options));
    };
    listen(this.ownerWindow, "pointerdown", ((event: PointerEvent) => this.pointerDown(event)) as EventListener);
    listen(this.ownerWindow, "pointermove", ((event: PointerEvent) => this.pointerMove(event)) as EventListener);
    listen(this.ownerWindow, "pointerup", ((event: PointerEvent) => this.pointerUp(event)) as EventListener);
    for (const name of ["pointercancel", "lostpointercapture"]) listen(this.ownerWindow, name, ((event: PointerEvent) => {
      if (this.captured.has(event.pointerId)) { this.consume(event); this.cancel(); }
    }) as EventListener);
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      listen(this.ownerWindow, name, ((event: TouchEvent) => this.nativeTouch(event)) as EventListener, { capture: true, passive: false });
    }
    for (const name of ["click", "dblclick", "contextmenu"]) listen(this.ownerWindow, name, ((event: MouseEvent) => {
      if (isCanvasTouchPath(event.composedPath(), this.canvas)
        && isTouchCompatibilityEvent(event, this.recent, this.ownerWindow.performance.now(), this.machine.active)) this.consume(event);
    }) as EventListener);
    // Older iOS WebViews can expose native gesture events in addition to PE.
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) listen(this.ownerWindow, name, (event) => {
      if (this.machine.active && isCanvasTouchPath(event.composedPath(), this.canvas)) this.consume(event);
    }, { capture: true, passive: false });
    listen(this.ownerWindow, "blur", () => this.cancel());
    listen(canvas.ownerDocument, "visibilitychange", () => {
      if (canvas.ownerDocument.hidden) this.cancel();
    });
  }

  cancel(): void {
    const captured = [...this.captured];
    this.captured.clear(); // releasePointerCapture may synchronously emit lostcapture.
    this.nativeTouches.clear();
    this.session = undefined;
    this.machine.cancel();
    for (const id of captured) this.release(id);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disposers.dispose();
    this.cancel();
    this.recent = undefined;
  }

  private pointerDown(event: PointerEvent): void {
    if (event.pointerType !== "touch" || !this.eligible(event)) return;
    if (this.machine.active && !this.ensureSession()) return;
    const target = this.targetFor(event);
    this.consume(event);
    if (!this.machine.active) {
      this.actions.prepareGesture();
      this.session = this.actions.sessionToken();
    }
    if (!this.session) return;
    this.captured.add(event.pointerId);
    // Capture on the stable shell: node rendering can replace the original hit.
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Window routing remains available. */ }
    this.remember(event);
    this.machine.down(event, target);
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.captured.has(event.pointerId)) return;
    this.consume(event);
    if (!this.ensureSession()) return;
    this.remember(event);
    this.machine.move(event);
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.captured.has(event.pointerId)) return;
    this.consume(event);
    if (!this.ensureSession()) return;
    this.remember(event);
    this.captured.delete(event.pointerId);
    this.machine.up(event);
    this.release(event.pointerId);
    if (!this.machine.active) this.session = undefined;
  }

  private nativeTouch(event: TouchEvent): void {
    const changed = Array.from(event.changedTouches);
    if (event.type === "touchstart" && this.eligible(event)) {
      for (const point of changed) this.nativeTouches.add(point.identifier);
    }
    if (!changed.some((point) => this.nativeTouches.has(point.identifier))) return;
    this.consume(event);
    if (event.type === "touchend" || event.type === "touchcancel") {
      for (const point of changed) this.nativeTouches.delete(point.identifier);
      if (event.type === "touchcancel") this.cancel();
    }
  }

  private eligible(event: Event): boolean {
    return !this.destroyed && Boolean(this.actions.sessionToken()) && this.canvas.isConnected
      && this.canvas.getClientRects().length > 0 && isCanvasTouchPath(event.composedPath(), this.canvas);
  }

  private targetFor(event: Event): TouchTarget {
    const element = event.composedPath().find((target) => typeof (target as Element).closest === "function") as Element | undefined;
    const node = element?.closest<HTMLElement>(".mtn-node[data-node-id]");
    if (!node?.dataset.nodeId) return { kind: "canvas" };
    const nodeId = node.dataset.nodeId;
    if (element?.closest(".mtn-image-resize-handle")) return { kind: "resize", nodeId };
    if (element?.closest(".mtn-fold-button")) return { kind: "control", nodeId, action: "fold" };
    if (element?.closest(".mtn-resource-open")) return { kind: "control", nodeId, action: "open" };
    return { kind: "node", nodeId, draggable: this.actions.canDragNode(nodeId) };
  }

  private ensureSession(): boolean {
    if (this.destroyed || !this.session || this.actions.sessionToken() !== this.session) {
      this.cancel();
      return false;
    }
    return true;
  }

  private remember(point: GesturePointer): void {
    this.recent = { point: { pointerId: point.pointerId, clientX: point.clientX, clientY: point.clientY }, time: this.ownerWindow.performance.now() };
  }

  private consume(event: Event): void {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  }

  private release(id: number): void {
    try { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); } catch { /* Detached canvas. */ }
  }
}
