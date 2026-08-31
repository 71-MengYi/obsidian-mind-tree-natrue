import type { NodeId } from "../../types";
import { wheelDeltaToPixels, ZOOM_STEP } from "../viewport";

interface PointerGesture {
  readonly mode: "marquee" | "pan";
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  readonly additive: boolean;
  moved: boolean;
  readonly selectionBeforeMarquee?: Set<NodeId>;
  readonly primaryBeforeMarquee?: NodeId;
}

export interface CanvasSelectionSnapshot {
  readonly ids: ReadonlySet<NodeId>;
  readonly primaryId?: NodeId;
}

export interface CanvasInteractionActions {
  readonly hasDocument: () => boolean;
  readonly readSelection: () => CanvasSelectionSnapshot;
  readonly replaceSelection: (ids: ReadonlySet<NodeId>, primaryId?: NodeId) => void;
  readonly panBy: (deltaX: number, deltaY: number) => void;
  readonly panWheel: (delta: number, direction: "horizontal" | "vertical") => void;
  readonly zoomAtStep: (step: number, clientX: number, clientY: number) => void;
  readonly rememberZoomAnchor: (clientX: number, clientY: number) => void;
  readonly suppressNextContextMenu: (suppress: boolean) => void;
}

/** Marquee, canvas pan and wheel semantics, independent from document commands. */
export class CanvasInteractionController {
  private gesture?: PointerGesture;

  constructor(
    private readonly canvas: HTMLElement,
    private readonly nodeLayer: HTMLElement,
    private readonly marquee: HTMLElement,
    private readonly actions: CanvasInteractionActions
  ) {}

  pointerDown(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest(".mtn-node") || !this.actions.hasDocument()) return;
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    this.canvas.focus();
    const mode = event.button === 2 || event.pointerType === "touch" ? "pan" : "marquee";
    const selection = this.actions.readSelection();
    this.gesture = {
      mode, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
      additive: event.ctrlKey || event.metaKey, moved: false,
      selectionBeforeMarquee: mode === "marquee" ? new Set(selection.ids) : undefined,
      primaryBeforeMarquee: mode === "marquee" ? selection.primaryId : undefined
    };
    this.canvas.setPointerCapture(event.pointerId);
    if (mode === "marquee") this.updateMarquee(event.clientX, event.clientY);
    else this.canvas.addClass("is-panning");
  }

  pointerMove(event: PointerEvent): void {
    this.actions.rememberZoomAnchor(event.clientX, event.clientY);
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId || !this.actions.hasDocument()) return;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3) gesture.moved = true;
    if (gesture.mode === "marquee") this.updateMarquee(event.clientX, event.clientY);
    else {
      this.actions.panBy(event.clientX - gesture.lastX, event.clientY - gesture.lastY);
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
    }
  }

  pointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "marquee") {
      this.updateMarquee(event.clientX, event.clientY);
      this.marquee.hide();
    } else {
      this.canvas.removeClass("is-panning");
      this.actions.suppressNextContextMenu(gesture.moved);
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.gesture = undefined;
  }

  wheel(event: WheelEvent): void {
    if (!this.actions.hasDocument()) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const zoomDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (zoomDelta === 0) return;
      this.actions.rememberZoomAnchor(event.clientX, event.clientY);
      this.actions.zoomAtStep(zoomDelta < 0 ? ZOOM_STEP : -ZOOM_STEP, event.clientX, event.clientY);
      return;
    }
    const horizontal = event.shiftKey;
    const rawDelta = horizontal
      ? (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
      : event.deltaY;
    if (rawDelta === 0) return;
    const canvasRect = this.canvas.getBoundingClientRect();
    const delta = wheelDeltaToPixels(rawDelta, event.deltaMode, horizontal ? canvasRect.width : canvasRect.height);
    this.actions.panWheel(delta, horizontal ? "horizontal" : "vertical");
  }

  destroy(): void {
    this.marquee.hide();
    this.canvas.removeClass("is-panning");
    this.gesture = undefined;
  }

  private updateMarquee(clientX: number, clientY: number): void {
    const gesture = this.gesture;
    if (!gesture || gesture.mode !== "marquee") return;
    const canvasRect = this.canvas.getBoundingClientRect();
    Object.assign(this.marquee.style, {
      left: `${Math.min(gesture.startX, clientX) - canvasRect.left}px`,
      top: `${Math.min(gesture.startY, clientY) - canvasRect.top}px`,
      width: `${Math.abs(clientX - gesture.startX)}px`,
      height: `${Math.abs(clientY - gesture.startY)}px`
    });
    this.marquee.show();
    const marqueeRect = this.marquee.getBoundingClientRect();
    const next = gesture.additive ? new Set(gesture.selectionBeforeMarquee) : new Set<NodeId>();
    let lastIntersectedId: NodeId | undefined;
    for (const element of this.nodeLayer.querySelectorAll<HTMLElement>(".mtn-node")) {
      const nodeId = element.dataset.nodeId;
      if (!nodeId || !rectsIntersect(marqueeRect, element.getBoundingClientRect())) continue;
      next.add(nodeId);
      lastIntersectedId = nodeId;
    }
    const primary = lastIntersectedId
      ?? (gesture.primaryBeforeMarquee && next.has(gesture.primaryBeforeMarquee)
        ? gesture.primaryBeforeMarquee : next.values().next().value as NodeId | undefined);
    this.actions.replaceSelection(next, primary);
  }
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}
