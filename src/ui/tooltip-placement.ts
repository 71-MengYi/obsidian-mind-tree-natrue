export type TooltipSide = "bottom" | "top" | "right" | "left";
export interface TooltipRect { left: number; top: number; right: number; bottom: number }
export interface TooltipSize { width: number; height: number }
export interface TooltipLayout extends TooltipSize {
  side: TooltipSide; left: number; top: number; maxWidth: number; maxHeight: number;
}
export const TOOLTIP_GAP = 8;
export const TOOLTIP_MARGIN = 8;
export const TOOLTIP_MAX_WIDTH = 320;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Each region is wholly outside the trigger, so fitting can never cover it. */
function region(anchor: TooltipRect, viewport: TooltipRect, side: TooltipSide): TooltipRect {
  const bounds = { left: viewport.left + TOOLTIP_MARGIN, right: viewport.right - TOOLTIP_MARGIN,
    top: viewport.top + TOOLTIP_MARGIN, bottom: viewport.bottom - TOOLTIP_MARGIN };
  if (side === "bottom") bounds.top = Math.max(bounds.top, anchor.bottom + TOOLTIP_GAP);
  if (side === "top") bounds.bottom = Math.min(bounds.bottom, anchor.top - TOOLTIP_GAP);
  if (side === "right") bounds.left = Math.max(bounds.left, anchor.right + TOOLTIP_GAP);
  if (side === "left") bounds.right = Math.min(bounds.right, anchor.left - TOOLTIP_GAP);
  return bounds;
}

function ideal(anchor: TooltipRect, size: TooltipSize, side: TooltipSide): { left: number; top: number } {
  const x = (anchor.left + anchor.right - size.width) / 2;
  const y = (anchor.top + anchor.bottom - size.height) / 2;
  if (side === "bottom") return { left: x, top: anchor.bottom + TOOLTIP_GAP };
  if (side === "top") return { left: x, top: anchor.top - TOOLTIP_GAP - size.height };
  if (side === "right") return { left: anchor.right + TOOLTIP_GAP, top: y };
  return { left: anchor.left - TOOLTIP_GAP - size.width, top: y };
}

/** Fit after wrapping, without changing the chosen side or moving toward the trigger. */
export function fitTooltip(anchor: TooltipRect, size: TooltipSize, viewport: TooltipRect, side: TooltipSide): TooltipLayout {
  const bounds = region(anchor, viewport, side);
  const maxWidth = Math.max(0, Math.min(TOOLTIP_MAX_WIDTH, bounds.right - bounds.left));
  const maxHeight = Math.max(0, bounds.bottom - bounds.top);
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const point = ideal(anchor, { width, height }, side);
  // Clamp only across the chosen direction. Its main-axis gap stays intact.
  if (side === "bottom" || side === "top") point.left = clamp(point.left, bounds.left, bounds.right - width);
  else point.top = clamp(point.top, bounds.top, bounds.bottom - height);
  return { side, ...point, width, height, maxWidth, maxHeight };
}

/** Pure geometry: prefer an intact centered placement, then the largest free region. */
export function chooseTooltipPlacement(anchor: TooltipRect, size: TooltipSize, viewport: TooltipRect,
  minimum: TooltipSize = { width: 0, height: 0 }): TooltipLayout {
  const bottom = ideal(anchor, size, "bottom");
  const inward: TooltipSide = (anchor.left + anchor.right) / 2 < (viewport.left + viewport.right) / 2 ? "right" : "left";
  const opposite: TooltipSide = inward === "right" ? "left" : "right";
  const low = bottom.top + size.height > viewport.bottom - TOOLTIP_MARGIN;
  const wide = bottom.left < viewport.left + TOOLTIP_MARGIN || bottom.left + size.width > viewport.right - TOOLTIP_MARGIN;
  const order: TooltipSide[] = low ? ["top", inward, opposite, "bottom"]
    : wide ? [inward, "top", opposite, "bottom"] : ["bottom", "top", inward, opposite];
  for (const side of order) {
    const bounds = region(anchor, viewport, side), point = ideal(anchor, size, side);
    if (point.left >= bounds.left && point.top >= bounds.top
      && point.left + size.width <= bounds.right && point.top + size.height <= bounds.bottom) {
      return fitTooltip(anchor, size, viewport, side);
    }
  }
  const area = (side: TooltipSide): number => {
    const bounds = region(anchor, viewport, side);
    if (bounds.right - bounds.left < minimum.width || bounds.bottom - bounds.top < minimum.height) return 0;
    return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
  };
  const side = order.reduce((best, side) => area(side) > area(best) ? side : best);
  return fitTooltip(anchor, size, viewport, side);
}
