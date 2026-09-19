import type { DropPosition, NodeId } from "../../types";
import type { DropPlacement } from "../drop-placement";
import { centerDragGhostAtPointer } from "../drop-placement";
import type { GesturePointer } from "./touch-gesture";

export interface NodeDragStartState {
  readonly nodeId: NodeId;
  readonly draggedRootIds: NodeId[];
  readonly excludedIds: ReadonlySet<NodeId>;
  readonly sourceElement: HTMLElement;
  readonly sourceRect: DOMRect;
}

export interface NodeDragActions {
  readonly resolvePlacement: (clientX: number, clientY: number, excludedIds: ReadonlySet<NodeId>) => DropPlacement | undefined;
  readonly showPlacement: (placement: DropPlacement) => HTMLElement | undefined;
  readonly clearPlacement: () => void;
  readonly moveNodes: (nodeIds: NodeId[], targetId: NodeId, position: DropPosition) => void;
  readonly reportFailure: (error: unknown) => void;
}

/** Floating drag preview, branch visibility and owner-window pointer lifecycle. */
export class NodeDragController {
  private activeCleanup?: () => void;
  private activeMove?: (point: GesturePointer) => void;
  private activeEnd?: (point: GesturePointer) => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly nodes: HTMLElement,
    private readonly connections: SVGSVGElement,
    private readonly actions: NodeDragActions
  ) {}

  start(event: GesturePointer, input: NodeDragStartState, externallyManaged = false): void {
    this.cancel();
    const state = {
      ...input,
      startX: event.clientX,
      startY: event.clientY,
      renderedWidth: input.sourceRect.width,
      renderedHeight: input.sourceRect.height,
      dragging: false,
      targetId: undefined as NodeId | undefined,
      position: undefined as DropPosition | undefined,
      ghost: undefined as HTMLElement | undefined
    };
    const ownerWindow = this.root.ownerDocument.defaultView ?? window;
    let finished = false;
    const onMove = (moveEvent: GesturePointer): void => {
      if (moveEvent.pointerId !== event.pointerId || finished) return;
      const distance = Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY);
      if (!state.dragging && distance < (externallyManaged ? 0 : 5)) return;
      if (!state.dragging) {
        state.dragging = true;
        this.root.addClass("is-dragging-node");
        state.ghost = this.createGhost(state.sourceElement, state.sourceRect);
        this.setBranchVisibility(state.excludedIds, false);
      }
      if (state.ghost) {
        const position = centerDragGhostAtPointer(moveEvent.clientX, moveEvent.clientY,
          state.renderedWidth, state.renderedHeight);
        state.ghost.style.left = `${position.left}px`;
        state.ghost.style.top = `${position.top}px`;
      }
      this.actions.clearPlacement();
      state.targetId = undefined;
      state.position = undefined;
      const placement = this.actions.resolvePlacement(moveEvent.clientX, moveEvent.clientY, state.excludedIds);
      if (!placement || !this.actions.showPlacement(placement)) return;
      state.targetId = placement.targetId;
      state.position = placement.position;
    };
    const finish = (applyMove: boolean): void => {
      if (finished) return;
      finished = true;
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
      ownerWindow.removeEventListener("pointercancel", onCancel);
      ownerWindow.removeEventListener("lostpointercapture", onCancel);
      ownerWindow.removeEventListener("blur", onBlur);
      ownerWindow.removeEventListener("keydown", onKeyDown, true);
      this.root.ownerDocument.removeEventListener("visibilitychange", onVisibility);
      this.activeCleanup = undefined;
      this.activeMove = undefined;
      this.activeEnd = undefined;
      this.root.removeClass("is-dragging-node");
      this.actions.clearPlacement();
      state.ghost?.remove();
      this.setBranchVisibility(state.excludedIds, true);
      if (!applyMove || !state.dragging || !state.targetId || !state.position) return;
      try { this.actions.moveNodes(state.draggedRootIds, state.targetId, state.position); }
      catch (error) { this.actions.reportFailure(error); }
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
    const onVisibility = (): void => { if (this.root.ownerDocument.hidden) finish(false); };
    const onKeyDown = (key: KeyboardEvent): void => {
      if (key.key === "Escape") { key.preventDefault(); finish(false); }
    };
    this.activeCleanup = () => finish(false);
    this.activeMove = onMove;
    this.activeEnd = onUp;
    if (externallyManaged) onMove(event);
    else {
      ownerWindow.addEventListener("pointermove", onMove);
      // Not once: an unrelated finger's up must not consume this subscription.
      ownerWindow.addEventListener("pointerup", onUp);
      ownerWindow.addEventListener("pointercancel", onCancel);
      ownerWindow.addEventListener("lostpointercapture", onCancel);
      ownerWindow.addEventListener("blur", onBlur);
      ownerWindow.addEventListener("keydown", onKeyDown, true);
      this.root.ownerDocument.addEventListener("visibilitychange", onVisibility);
    }
  }

  move(point: GesturePointer): void { this.activeMove?.(point); }
  finish(point: GesturePointer): void { this.activeEnd?.(point); }
  cancel(): void { this.activeCleanup?.(); }

  destroy(): void {
    this.cancel();
    this.activeCleanup = undefined;
  }

  private createGhost(source: HTMLElement, sourceRect: DOMRect): HTMLElement {
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-node-id");
    ghost.classList.remove("is-selected", "is-editing", "is-drop-before", "is-drop-inside", "is-drop-after");
    ghost.classList.add("mtn-node-drag-ghost");
    ghost.querySelector(".mtn-fold-button")?.remove();
    const layoutWidth = Number.parseFloat(source.style.width) || source.offsetWidth;
    const layoutHeight = Number.parseFloat(source.style.height) || source.offsetHeight;
    ghost.style.width = `${layoutWidth}px`;
    ghost.style.height = `${layoutHeight}px`;
    ghost.style.setProperty("--mtn-drag-scale", String(sourceRect.width / Math.max(1, layoutWidth)));
    const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
    for (const property of [
      "--mtn-theme-root-accent", "--mtn-theme-root-text", "--mtn-node-surface", "--mtn-node-accent",
      "--mtn-node-bg", "--mtn-node-text", "--mtn-branch-color", "--mtn-node-title-width",
      "--mtn-node-marker-width", "--mtn-node-control-width"
    ]) {
      const value = computed?.getPropertyValue(property).trim();
      if (value) ghost.style.setProperty(property, value);
    }
    if (computed) {
      ghost.style.background = computed.background; ghost.style.color = computed.color;
      ghost.style.borderColor = computed.borderColor; ghost.style.borderStyle = computed.borderStyle;
      ghost.style.borderWidth = computed.borderWidth; ghost.style.borderRadius = computed.borderRadius;
    }
    source.ownerDocument.body.appendChild(ghost);
    return ghost;
  }

  private setBranchVisibility(nodeIds: ReadonlySet<NodeId>, visible: boolean): void {
    for (const element of this.nodes.querySelectorAll<HTMLElement>(".mtn-node")) {
      const id = element.dataset.nodeId;
      if (id && nodeIds.has(id)) element.toggleClass("is-drag-hidden", !visible);
    }
    for (const path of this.connections.querySelectorAll<SVGPathElement>(".mtn-connection")) {
      const hidden = Boolean((path.dataset.fromNodeId && nodeIds.has(path.dataset.fromNodeId))
        || (path.dataset.toNodeId && nodeIds.has(path.dataset.toNodeId)));
      if (hidden) path.classList.toggle("is-drag-hidden", !visible);
    }
  }
}
