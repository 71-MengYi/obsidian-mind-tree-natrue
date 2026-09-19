import { getNodeHighlightColor } from "../../domain/markers";
import type { MindTreeNode } from "../../types";
import { getNodeResourceControls } from "../resource-controls";
import {
  fallbackResourceBadgePresentation,
  getNodeMarkerGeometry,
  type ResourceBadge,
  type ResourceBadgePresentation
} from "../resource-badges";

export interface NodeVisualState {
  readonly hasResourceControls: boolean;
  readonly titleSyncDisabled: boolean;
  readonly markerDisplayWidth: number;
  readonly resourceBadges: readonly ResourceBadge[];
  readonly highlight?: string;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly leaf: boolean;
}

/** Pure mapping from domain node + transient selection to renderer state. */
export function createNodeVisualState(
  node: Readonly<MindTreeNode>,
  selected: boolean,
  editing: boolean,
  resourceBadgePresentation: ResourceBadgePresentation = fallbackResourceBadgePresentation
): NodeVisualState {
  const controls = getNodeResourceControls(node);
  const markerGeometry = getNodeMarkerGeometry(node, resourceBadgePresentation);
  return {
    hasResourceControls: controls.hasOpenButton,
    titleSyncDisabled: controls.titleSyncDisabled,
    markerDisplayWidth: markerGeometry.width,
    resourceBadges: markerGeometry.resourceBadges,
    highlight: getNodeHighlightColor(node),
    selected,
    editing,
    leaf: node.childIds.length === 0
  };
}
