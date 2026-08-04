/** Canvas navigation is session state and is never serialized into an .mtn.md file. */
export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export const DEFAULT_VIEWPORT: Readonly<ViewportState> = { x: 56, y: 120, zoom: 1 };
export const ZOOM_STEP = 0.1;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 3;
const WHEEL_LINE_HEIGHT = 16;

export interface ViewportCssPresentation {
  /** Screen-space pan only; keeping scale out avoids stretching cached text. */
  panTransform: string;
  /** Layout-aware content zoom makes Chromium rasterize glyphs at the new size. */
  contentZoom: string;
}

/**
 * Split navigation into a translated outer layer and a zoomed inner layer.
 * `transform: scale()` on the same long-lived composited layer tends to reuse a
 * low-resolution glyph texture after repeated zoom changes in Electron.
 */
export function viewportToCssPresentation(
  viewport: Readonly<ViewportState>
): ViewportCssPresentation {
  return {
    panTransform: `translate3d(${viewport.x}px, ${viewport.y}px, 0)`,
    contentZoom: String(viewport.zoom)
  };
}

/** Convert line/page wheel units to CSS pixels before moving the canvas. */
export function wheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT;
  if (deltaMode === 2) return delta * Math.max(1, pageSize);
  return delta;
}

/**
 * Wheel scrolling moves the world opposite the scroll direction, matching a
 * normal document viewport. This changes session-only navigation state and is
 * deliberately independent from document commits and persistence.
 */
export function panViewportByWheel(
  viewport: Readonly<ViewportState>,
  delta: number,
  axis: "horizontal" | "vertical"
): ViewportState {
  return axis === "horizontal"
    ? { ...viewport, x: viewport.x - delta }
    : { ...viewport, y: viewport.y - delta };
}

/** Place a world-space rectangle at the exact center of the visible canvas. */
export function centerViewportOnRect(
  canvasWidth: number,
  canvasHeight: number,
  rect: Readonly<ViewportRect>,
  zoom = 1
): ViewportState {
  return {
    zoom,
    x: canvasWidth / 2 - (rect.x + rect.width / 2) * zoom,
    y: canvasHeight / 2 - (rect.y + rect.height / 2) * zoom
  };
}

/**
 * Compensate for a layout reflow without producing a visible canvas jump.
 *
 * Tree layouts normalize their output bounds, so expanding a branch can change
 * a node's world-space coordinates even though the user never panned. Moving
 * the viewport by the opposite scaled delta keeps that node at precisely the
 * same screen coordinate. Zoom is session state and must remain untouched.
 */
export function preserveViewportPointAfterLayout(
  viewport: Readonly<ViewportState>,
  before: Readonly<ViewportPoint>,
  after: Readonly<ViewportPoint>
): ViewportState {
  return {
    x: viewport.x + (before.x - after.x) * viewport.zoom,
    y: viewport.y + (before.y - after.y) * viewport.zoom,
    zoom: viewport.zoom
  };
}

/**
 * Apply an additive zoom step while keeping the world point below the anchor
 * at the same screen coordinate. An additive step makes every wheel notch and
 * toolbar click change the displayed scale by exactly ten percentage points.
 */
export function zoomViewportAt(
  viewport: Readonly<ViewportState>,
  step: number,
  anchorX: number,
  anchorY: number
): ViewportState {
  const oldZoom = viewport.zoom;
  const newZoom = clamp(Number((oldZoom + step).toFixed(6)), MIN_ZOOM, MAX_ZOOM);
  if (newZoom === oldZoom) return { ...viewport };
  return {
    x: anchorX - ((anchorX - viewport.x) / oldZoom) * newZoom,
    y: anchorY - ((anchorY - viewport.y) / oldZoom) * newZoom,
    zoom: newZoom
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
