import { getNodeHighlightColor } from "../../domain/markers";
import type { MindTreeNode, NodeId } from "../../types";
import {
  fallbackResourceBadgePresentation,
  getNodeMarkerGeometry,
  getNodeResourceControls,
  type ResourceBadge,
  type ResourceBadgePresentation
} from "../../render/resource-badges";

export interface NodeVisualState {
  readonly hasResourceControls: boolean;
  /** The node has a linked resource, so its open control is rendered. */
  readonly hasResource: boolean;
  /** The node is the source of a one-way node link. */
  readonly hasNodeLink: boolean;
  readonly titleSyncDisabled: boolean;
  /** Target of this node's one-way node link, when it has one. */
  readonly nodeLinkTargetId?: NodeId;
  /** The link target no longer exists, so the mark cannot navigate anywhere. */
  readonly nodeLinkMissing: boolean;
  readonly markerDisplayWidth: number;
  /** Ordered trailing items: custom markers and derived resource badges. */
  readonly markers: readonly ResourceBadge[];
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
  resourceBadgePresentation: ResourceBadgePresentation = fallbackResourceBadgePresentation,
  nodeExists?: (nodeId: NodeId) => boolean
): NodeVisualState {
  const controls = getNodeResourceControls(node);
  const markerGeometry = getNodeMarkerGeometry(node, resourceBadgePresentation);
  const nodeLinkTargetId = node.nodeLink;
  return {
    // A node-link-only node still owns the trailing control column, so the gate
    // is the reserved width rather than "has a resource".
    hasResourceControls: controls.width > 0,
    hasResource: controls.hasOpenButton,
    hasNodeLink: controls.hasNodeLink,
    titleSyncDisabled: controls.titleSyncDisabled,
    ...(nodeLinkTargetId ? { nodeLinkTargetId } : {}),
    nodeLinkMissing: Boolean(nodeLinkTargetId && nodeExists && !nodeExists(nodeLinkTargetId)),
    markerDisplayWidth: markerGeometry.width,
    markers: markerGeometry.markers,
    highlight: getNodeHighlightColor(node),
    selected,
    editing,
    leaf: node.childIds.length === 0
  };
}
