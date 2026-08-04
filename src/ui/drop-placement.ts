import type { DropPosition, MindTreeLayoutMode, NodeId } from "../types";

export interface DropNodeRect {
  id: NodeId;
  parentId?: NodeId;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropPlacement {
  targetId: NodeId;
  position: DropPosition;
}

export interface DragGhostPosition {
  left: number;
  top: number;
}

const CROSS_AXIS_TOLERANCE = 30;
const DEFAULT_EDGE_EXTENT = 30;

/**
 * Position the rendered drag preview around the pointer itself. The dimensions
 * passed here are viewport dimensions (after canvas zoom), so this calculation
 * stays correct regardless of node depth, node size, or the current zoom.
 */
export function centerDragGhostAtPointer(
  clientX: number,
  clientY: number,
  renderedWidth: number,
  renderedHeight: number
): DragGhostPosition {
  return {
    left: clientX - renderedWidth / 2,
    top: clientY - renderedHeight / 2
  };
}

/**
 * Resolve a pointer to either a node body (insert as child) or a gap between
 * visible siblings (insert before/after). Body hits always win, which makes the
 * interaction predictable even for very short gaps around compact nodes.
 */
export function resolveDropPlacement(
  rects: readonly DropNodeRect[],
  clientX: number,
  clientY: number,
  layoutMode: MindTreeLayoutMode,
  excludedIds: ReadonlySet<NodeId> = new Set()
): DropPlacement | undefined {
  const eligible = rects.filter((rect) => !excludedIds.has(rect.id));
  const body = eligible
    .filter((rect) => pointInside(rect, clientX, clientY))
    .sort((left, right) => area(left) - area(right))[0];
  if (body) return { targetId: body.id, position: "inside" };

  const rectById = new Map(rects.map((rect) => [rect.id, rect]));
  const horizontal = layoutMode === "tree";
  const groups = new Map<string, DropNodeRect[]>();
  for (const rect of eligible) {
    if (!rect.parentId) continue;
    // Balanced root branches live on two independent sides. Keeping their gap
    // zones separate prevents the empty space through the root from becoming
    // one enormous insertion target.
    const parent = rectById.get(rect.parentId);
    const side = layoutMode === "balanced" && parent
      ? (centerX(rect) < centerX(parent) ? "left" : "right")
      : "all";
    const key = `${rect.parentId}:${side}`;
    const group = groups.get(key) ?? [];
    group.push(rect);
    groups.set(key, group);
  }

  let best: { placement: DropPlacement; score: number } | undefined;
  const consider = (
    placement: DropPlacement,
    axisStart: number,
    axisEnd: number,
    crossStart: number,
    crossEnd: number
  ): void => {
    if (axisEnd <= axisStart) return;
    const axisValue = horizontal ? clientX : clientY;
    const crossValue = horizontal ? clientY : clientX;
    if (axisValue < axisStart || axisValue > axisEnd) return;
    const crossDistance = distanceToInterval(crossValue, crossStart, crossEnd);
    if (crossDistance > CROSS_AXIS_TOLERANCE) return;
    const axisMiddle = (axisStart + axisEnd) / 2;
    const score = crossDistance * 4 + Math.abs(axisValue - axisMiddle) / Math.max(1, axisEnd - axisStart);
    if (!best || score < best.score) best = { placement, score };
  };

  for (const group of groups.values()) {
    group.sort((left, right) => axisStart(left, horizontal) - axisStart(right, horizontal));
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;

    const firstExtent = edgeExtent(group, 0, horizontal);
    consider(
      { targetId: first.id, position: "before" },
      axisStart(first, horizontal) - firstExtent,
      axisStart(first, horizontal),
      crossStart(first, horizontal),
      crossEnd(first, horizontal)
    );

    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!;
      const next = group[index]!;
      consider(
        { targetId: next.id, position: "before" },
        axisEnd(previous, horizontal),
        axisStart(next, horizontal),
        Math.min(crossStart(previous, horizontal), crossStart(next, horizontal)),
        Math.max(crossEnd(previous, horizontal), crossEnd(next, horizontal))
      );
    }

    const lastExtent = edgeExtent(group, group.length - 1, horizontal);
    consider(
      { targetId: last.id, position: "after" },
      axisEnd(last, horizontal),
      axisEnd(last, horizontal) + lastExtent,
      crossStart(last, horizontal),
      crossEnd(last, horizontal)
    );
  }
  return best?.placement;
}

function edgeExtent(group: readonly DropNodeRect[], index: number, horizontal: boolean): number {
  const neighborIndex = index === 0 ? 1 : index - 1;
  const node = group[index];
  const neighbor = group[neighborIndex];
  if (!node || !neighbor) return DEFAULT_EDGE_EXTENT;
  const gap = index === 0
    ? axisStart(neighbor, horizontal) - axisEnd(node, horizontal)
    : axisStart(node, horizontal) - axisEnd(neighbor, horizontal);
  return Math.min(48, Math.max(18, gap > 0 ? gap : DEFAULT_EDGE_EXTENT));
}

function pointInside(rect: DropNodeRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function area(rect: DropNodeRect): number {
  return Math.max(1, rect.right - rect.left) * Math.max(1, rect.bottom - rect.top);
}

function centerX(rect: DropNodeRect): number { return (rect.left + rect.right) / 2; }
function axisStart(rect: DropNodeRect, horizontal: boolean): number { return horizontal ? rect.left : rect.top; }
function axisEnd(rect: DropNodeRect, horizontal: boolean): number { return horizontal ? rect.right : rect.bottom; }
function crossStart(rect: DropNodeRect, horizontal: boolean): number { return horizontal ? rect.top : rect.left; }
function crossEnd(rect: DropNodeRect, horizontal: boolean): number { return horizontal ? rect.bottom : rect.right; }

function distanceToInterval(value: number, start: number, end: number): number {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}
