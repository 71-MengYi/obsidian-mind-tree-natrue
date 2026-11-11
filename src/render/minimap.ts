import type { ViewportPoint, ViewportRect, ViewportState } from "./viewport";

/**
 * Minimap geometry: pure functions shared by the DOM component and tests.
 *
 * The minimap never mutates session state. It maps world coordinates into a
 * small display box; the view layer turns a click inside that box back into a
 * viewport move. Keeping this file free of DOM and Obsidian imports lets the
 * projection rules be tested as plain arithmetic.
 */
export interface MinimapSize {
  readonly width: number;
  readonly height: number;
}

/** Uniform world -> minimap mapping: screen = world * scale + offset. */
export interface MinimapProjection {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Target 12% of the display resolution, bounded so it stays usable on 4K. */
export const MINIMAP_SCREEN_WIDTH_RATIO = 0.12;
export const MINIMAP_SCREEN_HEIGHT_RATIO = 0.12;
export const MINIMAP_MIN_WIDTH = 150;
export const MINIMAP_MAX_WIDTH = 320;
export const MINIMAP_MIN_HEIGHT = 110;
export const MINIMAP_MAX_HEIGHT = 240;
/** Breathing room between the thumbnail content and the surface edge. */
export const MINIMAP_EDGE_PADDING = 6;
/** Below this the thumbnail stops being readable, so it is hidden instead. */
export const MINIMAP_MIN_USABLE_WIDTH = 96;
export const MINIMAP_MIN_USABLE_HEIGHT = 72;

const EMPTY_MINIMAP_SIZE: MinimapSize = { width: 0, height: 0 };
const FALLBACK_PROJECTION: MinimapProjection = { scale: 1, offsetX: 0, offsetY: 0 };

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Keep size calculations free of floating-point accumulation (and negative zero). */
function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Size the thumbnail from the display resolution and then from the live canvas.
 *
 * The display ratio makes a 1080p screen show a ~230x130 map while a 4K screen
 * grows to the cap instead of becoming a full-screen overlay. The canvas caps
 * are a second, independent limit: a narrow split pane must not have the map
 * cover the tree it is meant to summarise. Returning a zero size tells the
 * caller to hide the surface rather than paint an unusable sliver.
 */
export function computeMinimapSize(
  screenWidth: number,
  screenHeight: number,
  canvasWidth: number,
  canvasHeight: number
): MinimapSize {
  if (
    !isPositiveFinite(screenWidth)
    || !isPositiveFinite(screenHeight)
    || !isPositiveFinite(canvasWidth)
    || !isPositiveFinite(canvasHeight)
  ) {
    return EMPTY_MINIMAP_SIZE;
  }

  const targetWidth = clampSize(
    Math.round(screenWidth * MINIMAP_SCREEN_WIDTH_RATIO),
    MINIMAP_MIN_WIDTH,
    MINIMAP_MAX_WIDTH
  );
  const targetHeight = clampSize(
    Math.round(screenHeight * MINIMAP_SCREEN_HEIGHT_RATIO),
    MINIMAP_MIN_HEIGHT,
    MINIMAP_MAX_HEIGHT
  );

  // Canvas caps are pixel sizes, so floor them: an SVG surface must not inherit
  // floating-point noise such as 220.00000000000003 from `canvas * 0.55`.
  const width = Math.min(targetWidth, Math.floor(canvasWidth * 0.55), Math.floor(canvasWidth - 24));
  const height = Math.min(targetHeight, Math.floor(canvasHeight * 0.45), Math.floor(canvasHeight - 88));
  if (width < MINIMAP_MIN_USABLE_WIDTH || height < MINIMAP_MIN_USABLE_HEIGHT) {
    return EMPTY_MINIMAP_SIZE;
  }
  return { width: normalizeZero(width), height: normalizeZero(height) };
}

/**
 * Convert the canvas-sized viewport into the world rectangle it currently shows.
 * Zoom zero (or a non-finite value from a broken pinch) falls back to 1 so that
 * a bad zoom can never produce an infinite or inverted indicator rectangle.
 */
export function visibleWorldRect(
  viewport: Readonly<ViewportState>,
  canvasWidth: number,
  canvasHeight: number
): ViewportRect {
  const zoom = isPositiveFinite(viewport.zoom) ? viewport.zoom : 1;
  return {
    x: normalizeZero(-viewport.x / zoom),
    y: normalizeZero(-viewport.y / zoom),
    width: normalizeZero(canvasWidth / zoom),
    height: normalizeZero(canvasHeight / zoom)
  };
}

/** Smallest world rectangle containing both inputs; widths may be zero. */
export function unionWorldRects(a: Readonly<ViewportRect>, b: Readonly<ViewportRect>): ViewportRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Fit a world domain into the minimap box with one uniform scale, then center
 * it. A single scale keeps the thumbnail's aspect ratio identical to the
 * canvas; separate X/Y scales would visually distort branches near the edges.
 * Degenerate domains (no layout yet, zero-sized canvas) get an identity mapping
 * so callers can still project without special-casing the result.
 */
export function createMinimapProjection(
  domain: Readonly<ViewportRect>,
  size: Readonly<MinimapSize>,
  padding = MINIMAP_EDGE_PADDING
): MinimapProjection {
  const usablePadding = Number.isFinite(padding) ? Math.max(0, padding) : MINIMAP_EDGE_PADDING;
  const width = size.width - usablePadding * 2;
  const height = size.height - usablePadding * 2;
  if (!isPositiveFinite(size.width) || !isPositiveFinite(size.height) || width <= 0 || height <= 0) {
    return FALLBACK_PROJECTION;
  }
  if (
    !Number.isFinite(domain.x)
    || !Number.isFinite(domain.y)
    || !isPositiveFinite(domain.width)
    || !isPositiveFinite(domain.height)
  ) {
    return FALLBACK_PROJECTION;
  }

  const scale = Math.min(width / Math.max(1, domain.width), height / Math.max(1, domain.height));
  if (!isPositiveFinite(scale)) return FALLBACK_PROJECTION;

  const offsetX = (size.width - domain.width * scale) / 2 - domain.x * scale;
  const offsetY = (size.height - domain.height * scale) / 2 - domain.y * scale;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return FALLBACK_PROJECTION;
  return { scale, offsetX, offsetY };
}

/** World point -> minimap point. */
export function projectMinimapPoint(
  projection: Readonly<MinimapProjection>,
  x: number,
  y: number
): ViewportPoint {
  return {
    x: projection.offsetX + x * projection.scale,
    y: projection.offsetY + y * projection.scale
  };
}

/** World rectangle -> minimap rectangle. Width/height scale with the projection. */
export function projectMinimapRect(
  projection: Readonly<MinimapProjection>,
  rect: Readonly<ViewportRect>
): ViewportRect {
  const topLeft = projectMinimapPoint(projection, rect.x, rect.y);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * projection.scale,
    height: rect.height * projection.scale
  };
}

/** Minimap point -> world point, the exact inverse of projectMinimapPoint. */
export function unprojectMinimapPoint(
  projection: Readonly<MinimapProjection>,
  x: number,
  y: number
): ViewportPoint {
  const scale = isPositiveFinite(projection.scale) ? projection.scale : 1;
  return {
    x: (x - projection.offsetX) / scale,
    y: (y - projection.offsetY) / scale
  };
}

export interface MinimapSceneInput {
  readonly layout: { readonly width: number; readonly height: number };
  readonly viewport: Readonly<ViewportState>;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/**
 * Scene projection = the whole tree plus whatever the canvas currently shows.
 *
 * The visible rectangle is not always inside the layout bounds (the user can
 * pan past the tree, and a tall viewport on a short tree extends above/below
 * it). Unioning both domains is what guarantees the indicator window is always
 * fully inside the minimap instead of being clipped at an edge.
 */
export function minimapProjectionForScene(
  input: Readonly<MinimapSceneInput>,
  size: Readonly<MinimapSize>
): MinimapProjection {
  const content: ViewportRect = {
    x: 0,
    y: 0,
    width: Math.max(1, input.layout.width),
    height: Math.max(1, input.layout.height)
  };
  const visible = visibleWorldRect(input.viewport, input.canvasWidth, input.canvasHeight);
  return createMinimapProjection(unionWorldRects(content, visible), size);
}
