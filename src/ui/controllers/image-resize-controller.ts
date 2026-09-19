import type { NodeId } from "../../types";
import {
  resizeImageFromWidth,
  type ImageDisplaySize
} from "../image-nodes";
import type { GesturePointer } from "./touch-gesture";

export interface ImageResizeStartState {
  readonly nodeId: NodeId;
  readonly size: ImageDisplaySize;
  readonly aspectRatio: number;
  readonly zoom: number;
}

export interface ImageResizeActions {
  readonly preview: (nodeId: NodeId, size: ImageDisplaySize) => void;
  readonly commit: (nodeId: NodeId, size: ImageDisplaySize) => void;
  readonly cancel: (nodeId: NodeId) => void;
}

/** Owner-window pointer lifecycle for one aspect-ratio-locked image resize. */
export class ImageResizeController {
  private activeCleanup?: () => void;
  private activeMove?: (point: GesturePointer) => void;
  private activeEnd?: (point: GesturePointer) => void;

  constructor(
    private readonly ownerWindow: Window,
    private readonly actions: ImageResizeActions
  ) {}

  start(event: GesturePointer, input: ImageResizeStartState, externallyManaged = false): void {
    this.activeCleanup?.();
    const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
    let latest = input.size;
    let changed = false;
    let frame: number | undefined;
    let finished = false;

    const flushPreview = (): void => {
      frame = undefined;
      this.actions.preview(input.nodeId, latest);
    };
    const onMove = (moveEvent: GesturePointer): void => {
      if (moveEvent.pointerId !== event.pointerId || finished) return;
      // A tap on the handle must not enlarge a natural image smaller than the
      // manual 60px minimum. Apply the clamp only after an actual drag starts.
      if (!changed && moveEvent.clientX === event.clientX) return;
      const width = input.size.width + (moveEvent.clientX - event.clientX) / zoom;
      const next = resizeImageFromWidth(width, input.aspectRatio);
      if (next.width === latest.width && next.height === latest.height) return;
      latest = next;
      changed = true;
      if (frame === undefined) frame = this.ownerWindow.requestAnimationFrame(flushPreview);
    };
    const finish = (apply: boolean): void => {
      if (finished) return;
      finished = true;
      this.ownerWindow.removeEventListener("pointermove", onMove);
      this.ownerWindow.removeEventListener("pointerup", onUp);
      this.ownerWindow.removeEventListener("pointercancel", onCancel);
      this.ownerWindow.removeEventListener("lostpointercapture", onCancel);
      this.ownerWindow.removeEventListener("keydown", onKeyDown, true);
      this.ownerWindow.removeEventListener("blur", onBlur);
      this.ownerWindow.document.removeEventListener("visibilitychange", onVisibility);
      if (frame !== undefined) this.ownerWindow.cancelAnimationFrame(frame);
      frame = undefined;
      this.activeCleanup = undefined;
      this.activeMove = undefined;
      this.activeEnd = undefined;
      if (apply && changed) this.actions.commit(input.nodeId, latest);
      else this.actions.cancel(input.nodeId);
    };
    const onUp = (point: GesturePointer): void => {
      if (point.pointerId !== event.pointerId) return;
      onMove(point);
      finish(true);
    };
    const onCancel = (point: GesturePointer): void => {
      if (point.pointerId === event.pointerId) finish(false);
    };
    const onBlur = (): void => finish(false);
    const onVisibility = (): void => { if (this.ownerWindow.document.hidden) finish(false); };
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };

    this.activeCleanup = () => finish(false);
    this.activeMove = onMove;
    this.activeEnd = onUp;
    if (!externallyManaged) {
      this.ownerWindow.addEventListener("pointermove", onMove);
      this.ownerWindow.addEventListener("pointerup", onUp);
      this.ownerWindow.addEventListener("pointercancel", onCancel);
      this.ownerWindow.addEventListener("lostpointercapture", onCancel);
      this.ownerWindow.addEventListener("keydown", onKeyDown, true);
      this.ownerWindow.addEventListener("blur", onBlur);
      this.ownerWindow.document.addEventListener("visibilitychange", onVisibility);
    }
  }

  move(point: GesturePointer): void { this.activeMove?.(point); }
  finish(point: GesturePointer): void { this.activeEnd?.(point); }

  cancel(): void {
    this.activeCleanup?.();
  }

  destroy(): void {
    this.cancel();
  }
}
