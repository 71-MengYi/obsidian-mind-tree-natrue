import type { MindTreeDocument, MindTreeLayoutMode, NodeId, PositionedNode } from "../types";

export type FoldDirection = "left" | "right" | "up" | "down";

/**
 * Resolve the outward side of every visible node's external fold control.
 * This is presentation-only state: directions come from the current layout and
 * must never be serialized into a mind-tree document.
 */
export function resolveFoldDirections(
  document: MindTreeDocument,
  positionedNodes: readonly PositionedNode[],
  layoutMode: MindTreeLayoutMode
): Map<NodeId, FoldDirection> {
  const result = new Map<NodeId, FoldDirection>();
  if (positionedNodes.length === 0) return result;

  if (layoutMode === "right" || layoutMode === "left" || layoutMode === "tree") {
    const direction: FoldDirection = layoutMode === "tree" ? "down" : layoutMode;
    for (const node of positionedNodes) result.set(node.id, direction);
    return result;
  }

  const positionById = new Map(positionedNodes.map((node) => [node.id, node]));
  const root = positionById.get(document.rootId);
  if (!root) return result;
  result.set(document.rootId, "right");

  if (layoutMode === "radial") {
    const rootCenter = center(root);
    for (const node of positionedNodes) {
      if (node.id === document.rootId) continue;
      const nodeCenter = center(node);
      const deltaX = nodeCenter.x - rootCenter.x;
      const deltaY = nodeCenter.y - rootCenter.y;
      // Horizontal wins exact ties to keep diagonal branches visually stable.
      result.set(node.id, Math.abs(deltaX) >= Math.abs(deltaY)
        ? (deltaX < 0 ? "left" : "right")
        : (deltaY < 0 ? "up" : "down"));
    }
    return result;
  }

  // Balanced mode assigns a side once at the first level and carries it through
  // the whole branch. Descendant widths or compact placement cannot flip a
  // control inward toward the root.
  const rootCenterX = center(root).x;
  const visibleIds = new Set(positionById.keys());
  for (const childId of document.nodes[document.rootId]?.childIds ?? []) {
    const childPosition = positionById.get(childId);
    if (!childPosition) continue;
    const direction: FoldDirection = center(childPosition).x < rootCenterX ? "left" : "right";
    const pending = [childId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (!visibleIds.has(nodeId) || result.has(nodeId)) continue;
      result.set(nodeId, direction);
      for (const descendantId of document.nodes[nodeId]?.childIds ?? []) pending.push(descendantId);
    }
  }

  // Malformed/unreachable visible nodes should still receive a deterministic
  // external side instead of falling back to an inward CSS default.
  for (const node of positionedNodes) {
    if (!result.has(node.id)) result.set(node.id, center(node).x < rootCenterX ? "left" : "right");
  }
  return result;
}

function center(node: PositionedNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
