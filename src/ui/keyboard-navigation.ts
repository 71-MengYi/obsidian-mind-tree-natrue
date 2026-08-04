import { findParentId } from "../domain/tree";
import type { MindTreeDocument, MindTreeLayoutMode, NodeId, PositionedNode } from "../types";

export type NavigationArrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * Accept every deliberate structural key press, regardless of how quickly the
 * user presses again, but reject the browser's auto-repeat events from holding
 * Enter or Tab down. Shift only changes insertion direction/type, so callers do
 * not need to include modifier state in this repeat guard.
 */
export function shouldHandleStructuralCreationKey(key: string, repeat: boolean): boolean {
  return (key === "Enter" || key === "Tab") && !repeat;
}

/**
 * Resolve keyboard navigation without mutating the tree. Up/down always walk
 * sibling order. Left/right walk parent/first-child, reversing on left-facing
 * branches so navigation follows the visible expansion direction.
 */
export function resolveArrowNavigationTarget(
  document: MindTreeDocument,
  currentId: NodeId,
  key: NavigationArrow,
  layoutMode: MindTreeLayoutMode,
  positionedNodes: readonly PositionedNode[] = []
): NodeId | undefined {
  const current = document.nodes[currentId];
  if (!current) return undefined;

  if (key === "ArrowUp" || key === "ArrowDown") {
    const parentId = findParentId(document, currentId);
    if (!parentId) return undefined;
    const siblings = document.nodes[parentId]?.childIds ?? [];
    const index = siblings.indexOf(currentId);
    const targetIndex = index + (key === "ArrowUp" ? -1 : 1);
    return targetIndex >= 0 && targetIndex < siblings.length ? siblings[targetIndex] : undefined;
  }

  const parentId = findParentId(document, currentId);
  const direction = childDirection(document, currentId, layoutMode, positionedNodes);
  if (key === direction) {
    // A collapsed branch has no visible child to focus. Once expanded, the
    // first child in persistent childIds order is always the initial target.
    return current.collapsed ? undefined : current.childIds[0];
  }
  return key === opposite(direction) ? parentId : undefined;
}

function childDirection(
  document: MindTreeDocument,
  currentId: NodeId,
  layoutMode: MindTreeLayoutMode,
  positionedNodes: readonly PositionedNode[]
): "ArrowLeft" | "ArrowRight" {
  if (layoutMode === "left") return "ArrowLeft";
  if (layoutMode !== "balanced" && layoutMode !== "radial") return "ArrowRight";

  // Balanced and radial trees contain branches on both sides. Determine the
  // side from the persistent first-level ancestor, not the current node, so a
  // winding descendant never reverses its parent/child keys unexpectedly.
  const firstLevelId = firstLevelAncestor(document, currentId);
  if (!firstLevelId) return "ArrowRight";
  const positions = new Map(positionedNodes.map((node) => [node.id, node]));
  const root = positions.get(document.rootId);
  const branch = positions.get(firstLevelId);
  if (!root || !branch) return "ArrowRight";
  return centerX(branch) < centerX(root) ? "ArrowLeft" : "ArrowRight";
}

function firstLevelAncestor(document: MindTreeDocument, nodeId: NodeId): NodeId | undefined {
  if (nodeId === document.rootId) return undefined;
  let currentId = nodeId;
  let parentId = findParentId(document, currentId);
  while (parentId && parentId !== document.rootId) {
    currentId = parentId;
    parentId = findParentId(document, currentId);
  }
  return parentId === document.rootId ? currentId : undefined;
}

function opposite(direction: "ArrowLeft" | "ArrowRight"): "ArrowLeft" | "ArrowRight" {
  return direction === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
}

function centerX(node: PositionedNode): number {
  return node.x + node.width / 2;
}
