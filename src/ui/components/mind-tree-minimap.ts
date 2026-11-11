import type { TreeLayout } from "../../render/layout";
import {
  computeMinimapSize,
  createMinimapProjection,
  minimapProjectionForScene,
  projectMinimapPoint,
  projectMinimapRect,
  unprojectMinimapPoint,
  visibleWorldRect,
  type MinimapProjection,
  type MinimapSize
} from "../../render/minimap";
import { branchColorCss } from "../../render/presentation";
import type { ViewportPoint, ViewportRect, ViewportState } from "../../render/viewport";
import type { NodeId } from "../../types";
import { DisposableUiObject } from "./ui-object";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface MindTreeMinimapLabels {
  readonly ariaLabel: string;
}

export interface MindTreeMinimapActions {
  readonly centerOnWorldPoint: (worldX: number, worldY: number) => void;
}

/** Everything the thumbnail draws, supplied by the view on every refresh. */
export interface MindTreeMinimapState {
  readonly layout: TreeLayout;
  readonly branchColorSlots: ReadonlyMap<NodeId, number>;
  readonly viewport: Readonly<ViewportState>;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/**
 * Bottom-right overview of the complete tree plus the visible canvas window.
 *
 * The component is intentionally passive: it reads layout/viewport snapshots
 * and reports click/drag map positions through injected actions. It never
 * touches the document model, so navigation stays session-only. Rendering is
 * split in two layers that use different caching strategies:
 *
 * - Content (nodes/connections) is rebuilt only when the layout, branch colour
 *   map or pixel size changes. A pure pan/zoom must stay cheap for a tree with
 *   thousands of nodes.
 * - The projection depends on the viewport too (see minimapProjectionForScene),
 *   so the live mapping is expressed as a group transform on top of the cached
 *   content instead of re-creating every SVG node.
 */
export class MindTreeMinimap extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly surface: SVGSVGElement;
  private readonly content: SVGGElement;
  private readonly indicator: SVGRectElement;
  private readonly actions: MindTreeMinimapActions;

  private enabled = false;
  private state?: Readonly<MindTreeMinimapState>;
  private size: MinimapSize = { width: 0, height: 0 };
  private liveProjection?: MinimapProjection;
  /**
   * A gesture freezes its projection: the projection domain includes the
   * viewport, so recomputing it from each moved viewport would feed back into
   * the pointer position and make the canvas chase itself.
   */
  private dragProjection?: MinimapProjection;
  private dragPointerId?: number;
  private renderedLayout?: TreeLayout;
  private renderedSlots?: ReadonlyMap<NodeId, number>;
  private renderedWidth = 0;
  private renderedHeight = 0;

  constructor(parent: HTMLElement, labels: MindTreeMinimapLabels, actions: MindTreeMinimapActions) {
    super();
    this.actions = actions;
    const ownerDocument = parent.ownerDocument;

    this.element = ownerDocument.createElement("div");
    this.element.classList.add("mtn-minimap");
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", labels.ariaLabel);
    this.element.hidden = true;

    this.surface = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
    this.surface.classList.add("mtn-minimap-surface");
    this.surface.setAttribute("aria-hidden", "true");
    this.content = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.content.classList.add("mtn-minimap-content");
    this.indicator = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
    this.indicator.classList.add("mtn-minimap-viewport");
    // The content layer is appended first so the indicator always paints above
    // it, independent of z-index support in the host WebView.
    this.surface.appendChild(this.content);
    this.surface.appendChild(this.indicator);
    this.element.appendChild(this.surface);
    parent.appendChild(this.element);

    this.listen(this.element, "pointerdown", this.handlePointerDown as EventListener);
    this.listen(this.element, "pointermove", this.handlePointerMove as EventListener);
    this.listen(this.element, "pointerup", this.handlePointerUp as EventListener);
    this.listen(this.element, "pointercancel", this.handlePointerUp as EventListener);
    this.listen(this.element, "lostpointercapture", this.handlePointerUp as EventListener);
  }

  /** Hide/show the overlay without discarding the last state snapshot. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.clearDrag();
      this.liveProjection = undefined;
      this.element.hidden = true;
      return;
    }
    this.render();
  }

  /**
   * Replace the rendered state. Updates arriving while disabled are stored but
   * deliberately skip DOM work: the hidden overlay is re-fit only once the
   * setting turns it back on.
   */
  update(state: Readonly<MindTreeMinimapState>): void {
    this.state = state;
    if (!this.enabled) return;
    this.render();
  }

  private render(): void {
    const state = this.state;
    if (!state) {
      this.element.hidden = true;
      return;
    }

    const view = this.element.ownerDocument.defaultView;
    const size = computeMinimapSize(
      view?.screen?.width ?? 0,
      view?.screen?.height ?? 0,
      state.canvasWidth,
      state.canvasHeight
    );
    this.size = size;
    if (size.width <= 0 || size.height <= 0) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    this.applySurfaceSize(size);

    // Canvas coordinates start at the root, so the content domain is simply the
    // layout extent. Drawing content in this domain keeps its geometry stable.
    const contentDomain: ViewportRect = {
      x: 0,
      y: 0,
      width: Math.max(1, state.layout.width),
      height: Math.max(1, state.layout.height)
    };
    const contentProjection = createMinimapProjection(contentDomain, size);
    // The scene domain also contains the visible world rectangle, which is what
    // keeps the indicator window fully inside the thumbnail.
    const sceneProjection = minimapProjectionForScene(state, size);
    this.liveProjection = sceneProjection;

    if (this.needsContentRebuild(state, size)) this.rebuildContent(state, contentProjection);
    const appliedProjection = this.dragProjection ?? sceneProjection;
    this.applyContentTransform(contentProjection, appliedProjection);
    this.applyIndicator(state, appliedProjection);
  }

  private needsContentRebuild(state: Readonly<MindTreeMinimapState>, size: Readonly<MinimapSize>): boolean {
    return this.renderedLayout !== state.layout
      || this.renderedSlots !== state.branchColorSlots
      || this.renderedWidth !== size.width
      || this.renderedHeight !== size.height;
  }

  /**
   * Build the whole thumbnail in one fragment so the live SVG is swapped in a
   * single DOM operation. Connections are drawn before nodes to keep lines
   * below the node rectangles regardless of node order.
   */
  private rebuildContent(state: Readonly<MindTreeMinimapState>, projection: Readonly<MinimapProjection>): void {
    const ownerDocument = this.element.ownerDocument;
    const nodeById = new Map(state.layout.nodes.map((node) => [node.id, node] as const));
    const rootId = resolveRootId(state.layout);
    const fragment = ownerDocument.createDocumentFragment();

    for (const connection of state.layout.connections) {
      const from = nodeById.get(connection.from);
      const to = nodeById.get(connection.to);
      if (!from || !to) continue;
      const start = projectMinimapPoint(projection, from.x + from.width / 2, from.y + from.height / 2);
      const end = projectMinimapPoint(projection, to.x + to.width / 2, to.y + to.height / 2);
      const line = ownerDocument.createElementNS(SVG_NAMESPACE, "line");
      line.classList.add("mtn-minimap-connection");
      line.setAttribute("x1", formatCoordinate(start.x));
      line.setAttribute("y1", formatCoordinate(start.y));
      line.setAttribute("x2", formatCoordinate(end.x));
      line.setAttribute("y2", formatCoordinate(end.y));
      // Connection colour follows its parent branch, like the canvas connector.
      line.style.stroke = branchColorCss(state.branchColorSlots.get(connection.from));
      fragment.appendChild(line);
    }

    for (const node of state.layout.nodes) {
      const point = projectMinimapPoint(projection, node.x, node.y);
      const rect = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
      rect.classList.add("mtn-minimap-node");
      if (node.id === rootId) rect.classList.add("is-root");
      rect.setAttribute("x", formatCoordinate(point.x));
      rect.setAttribute("y", formatCoordinate(point.y));
      // Sub-pixel nodes still need to be visible as at least one map pixel.
      rect.setAttribute("width", formatCoordinate(Math.max(1, node.width * projection.scale)));
      rect.setAttribute("height", formatCoordinate(Math.max(1, node.height * projection.scale)));
      rect.setAttribute("rx", "1.5");
      rect.style.fill = branchColorCss(state.branchColorSlots.get(node.id));
      fragment.appendChild(rect);
    }

    this.content.replaceChildren(fragment);
    this.renderedLayout = state.layout;
    this.renderedSlots = state.branchColorSlots;
    this.renderedWidth = this.size.width;
    this.renderedHeight = this.size.height;
  }

  /**
   * Map the cached content projection onto the live scene projection.
   *
   * Both are uniform scales of the same world space, so the mapping is exactly
   * `translate(offset) scale(ratio)`; this is the only DOM write a pure
   * pan/zoom causes. Identity is omitted so the common case stays attribute-
   * free, which also makes the transform easy to assert in tests.
   */
  private applyContentTransform(
    contentProjection: Readonly<MinimapProjection>,
    sceneProjection: Readonly<MinimapProjection>
  ): void {
    const scale = sceneProjection.scale / contentProjection.scale;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const offsetX = sceneProjection.offsetX - contentProjection.offsetX * scale;
    const offsetY = sceneProjection.offsetY - contentProjection.offsetY * scale;
    if (scale === 1 && offsetX === 0 && offsetY === 0) {
      this.content.removeAttribute("transform");
      return;
    }
    this.content.setAttribute(
      "transform",
      `translate(${formatCoordinate(offsetX)} ${formatCoordinate(offsetY)}) scale(${formatCoordinate(scale)})`
    );
  }

  private applySurfaceSize(size: Readonly<MinimapSize>): void {
    const width = formatCoordinate(size.width);
    const height = formatCoordinate(size.height);
    this.surface.setAttribute("width", width);
    this.surface.setAttribute("height", height);
    this.surface.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.surface.style.width = `${width}px`;
    this.surface.style.height = `${height}px`;
  }

  private applyIndicator(
    state: Readonly<MindTreeMinimapState>,
    projection: Readonly<MinimapProjection>
  ): void {
    const visible = visibleWorldRect(state.viewport, state.canvasWidth, state.canvasHeight);
    const rect = projectMinimapRect(projection, visible);
    this.indicator.setAttribute("x", formatCoordinate(rect.x));
    this.indicator.setAttribute("y", formatCoordinate(rect.y));
    // A very zoomed-out viewport can map to less than one pixel; keep the
    // indicator visible instead of letting it disappear entirely.
    this.indicator.setAttribute("width", formatCoordinate(Math.max(1, rect.width)));
    this.indicator.setAttribute("height", formatCoordinate(Math.max(1, rect.height)));
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const projection = this.liveProjection ?? this.dragProjection;
    if (!this.enabled || !projection) return;
    // Only the primary mouse button / first touch pointer drives the canvas.
    if (event.button !== 0 || event.isPrimary === false) return;
    const mapPoint = this.mapPointForEvent(event);
    if (!mapPoint) return;

    event.preventDefault();
    this.dragProjection = projection;
    this.dragPointerId = event.pointerId;
    this.element.classList.add("is-dragging");
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; dragging still works without it.
    }
    this.moveCanvasTo(mapPoint, projection);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const projection = this.dragProjection;
    if (!projection || this.dragPointerId !== event.pointerId) return;
    const mapPoint = this.mapPointForEvent(event);
    if (!mapPoint) return;
    event.preventDefault();
    this.moveCanvasTo(mapPoint, projection);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.dragPointerId !== event.pointerId) return;
    this.clearDrag();
    // The gesture is over, so the indicator must follow the live viewport again
    // (the view may have applied the final center after the last pointermove).
    this.render();
  };

  private moveCanvasTo(mapPoint: Readonly<ViewportPoint>, projection: Readonly<MinimapProjection>): void {
    const world = unprojectMinimapPoint(projection, mapPoint.x, mapPoint.y);
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
    this.actions.centerOnWorldPoint(world.x, world.y);
  }

  private mapPointForEvent(event: PointerEvent): ViewportPoint | undefined {
    if (this.size.width <= 0 || this.size.height <= 0) return undefined;
    const bounds = this.surface.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    return {
      x: Math.min(this.size.width, Math.max(0, x)),
      y: Math.min(this.size.height, Math.max(0, y))
    };
  }

  private clearDrag(): void {
    const pointerId = this.dragPointerId;
    // Clear first: releasePointerCapture may synchronously emit
    // lostpointercapture, and that handler must not restart the cleanup.
    this.dragPointerId = undefined;
    this.dragProjection = undefined;
    this.element.classList.remove("is-dragging");
    if (pointerId === undefined) return;
    try {
      this.element.releasePointerCapture(pointerId);
    } catch {
      // Capture was already released by pointerup/pointercancel.
    }
  }
}

/** The rendered layout's start node is its shallowest node, whatever its absolute depth. */
function resolveRootId(layout: TreeLayout): NodeId | undefined {
  let rootId: NodeId | undefined;
  let rootDepth = Number.POSITIVE_INFINITY;
  for (const node of layout.nodes) {
    if (node.depth < rootDepth) {
      rootDepth = node.depth;
      rootId = node.id;
    }
  }
  return rootId;
}

/** Keep SVG attributes compact and free of floating-point noise. */
function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
