import { DisposableUiObject } from "./ui-object";

let canvasLabelSequence = 0;

/** Create a document-wide unique accessible-name target for each open canvas. */
export function createCanvasLabelId(): string {
  canvasLabelSequence += 1;
  return `mtn-canvas-label-${canvasLabelSequence}`;
}

export interface CanvasShellActions {
  readonly pointerDown: (event: PointerEvent) => void;
  readonly pointerMove: (event: PointerEvent) => void;
  readonly pointerUp: (event: PointerEvent) => void;
  readonly contextMenu: (event: MouseEvent) => void;
  readonly wheel: (event: WheelEvent) => void;
  readonly dragEnter: (event: DragEvent) => void;
  readonly dragOver: (event: DragEvent) => void;
  readonly dragLeave: (event: DragEvent) => void;
  readonly drop: (event: DragEvent) => void;
  readonly keyDown: (event: KeyboardEvent) => void;
  readonly paste: (event: ClipboardEvent) => void;
  readonly documentDragStart: (event: DragEvent) => void;
  readonly documentDragEnd: (event: DragEvent) => void;
  readonly resize: () => void;
}

export interface CanvasShellLabels {
  readonly ariaLabel: string;
}

/**
 * Owns the layered canvas DOM and every canvas/document listener. Geometry and
 * domain decisions stay in the callbacks supplied by the view coordinator.
 */
export class CanvasShell extends DisposableUiObject {
  readonly element: HTMLElement;
  readonly panLayer: HTMLElement;
  readonly world: HTMLElement;
  readonly connections: SVGSVGElement;
  readonly nodeLayer: HTMLElement;
  readonly marquee: HTMLElement;

  constructor(parent: HTMLElement, labels: CanvasShellLabels, actions: CanvasShellActions) {
    super();
    this.element = parent.createDiv("mtn-canvas");
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "application");
    // Obsidian turns aria-label into a hover tooltip. A hidden labelled-by
    // target preserves the screen-reader name without covering the canvas with
    // a persistent "Mind Tree canvas" pointer tooltip.
    const accessibleLabel = this.element.createSpan({
      cls: "mtn-visually-hidden",
      text: labels.ariaLabel
    });
    accessibleLabel.id = createCanvasLabelId();
    this.element.setAttribute("aria-labelledby", accessibleLabel.id);
    this.panLayer = this.element.createDiv("mtn-pan-layer");
    this.world = this.panLayer.createDiv("mtn-world");
    this.connections = this.element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.connections.classList.add("mtn-connections");
    this.world.appendChild(this.connections);
    this.nodeLayer = this.world.createDiv("mtn-node-layer");
    this.marquee = this.element.createDiv("mtn-marquee");
    this.marquee.hide();

    this.listen(this.element, "pointerdown", actions.pointerDown as EventListener);
    this.listen(this.element, "pointermove", actions.pointerMove as EventListener);
    this.listen(this.element, "pointerup", actions.pointerUp as EventListener);
    this.listen(this.element, "pointercancel", actions.pointerUp as EventListener);
    this.listen(this.element, "contextmenu", actions.contextMenu as EventListener);
    this.listen(this.element, "wheel", actions.wheel as EventListener, { passive: false });
    this.listen(this.element, "dragenter", actions.dragEnter as EventListener);
    this.listen(this.element, "dragover", actions.dragOver as EventListener);
    this.listen(this.element, "dragleave", actions.dragLeave as EventListener);
    this.listen(this.element, "drop", actions.drop as EventListener);
    this.listen(this.element, "keydown", actions.keyDown as EventListener);

    const ownerDocument = this.element.ownerDocument;
    this.listen(ownerDocument, "paste", actions.paste as EventListener, { capture: true });
    this.listen(ownerDocument, "dragstart", actions.documentDragStart as EventListener);
    this.listen(ownerDocument, "dragend", actions.documentDragEnd as EventListener);

    const OwnerResizeObserver = ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    const resizeObserver = new OwnerResizeObserver(actions.resize);
    resizeObserver.observe(this.element);
    this.own(() => resizeObserver.disconnect());
  }
}
