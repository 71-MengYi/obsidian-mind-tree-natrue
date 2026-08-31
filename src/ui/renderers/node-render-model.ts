import { getNodeHighlightColor, getNodeMarkerDisplayWidth } from "../../domain/markers";
import type { MindTreeNode } from "../../types";

export interface NodeVisualState {
  readonly hasFileControls: boolean;
  readonly titleSyncDisabled: boolean;
  readonly markerDisplayWidth: number;
  readonly highlight?: string;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly leaf: boolean;
}

/** Pure mapping from domain node + transient selection to renderer state. */
export function createNodeVisualState(node: Readonly<MindTreeNode>, selected: boolean, editing: boolean): NodeVisualState {
  const hasFileControls = node.resource?.type === "file";
  const markerDisplayWidth = getNodeMarkerDisplayWidth(node);
  return {
    hasFileControls,
    titleSyncDisabled: hasFileControls && node.titleSync !== "bidirectional",
    markerDisplayWidth,
    highlight: getNodeHighlightColor(node),
    selected,
    editing,
    leaf: node.childIds.length === 0
  };
}
