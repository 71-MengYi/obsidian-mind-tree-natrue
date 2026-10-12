import type { MindTreeDocument, MindTreeNode, NodeId } from "../types";
import { DEFAULT_NODE_TITLE, collectBranchIds, findParentId, touch } from "./tree";

/**
 * A one-way node reference inside one document ("关联节点").
 *
 * The source node stores the target in `MindTreeNode.nodeLink`; the target is
 * never modified. This is deliberately not a subtree copy or a two-way mirror:
 * linking and unlinking must leave every `childIds` array untouched, so the
 * whole feature is a navigation pointer plus an outline annotation.
 */
export interface NodeLinkEdge {
  readonly sourceId: NodeId;
  readonly targetId: NodeId;
}

export type NodeLinkErrorCode =
  | "missing-source"
  | "missing-target"
  | "self"
  | "source-linked"
  | "source-has-resource";

export class NodeLinkError extends Error {
  constructor(readonly code: NodeLinkErrorCode) {
    super(`Node link rejected: ${code}`);
    this.name = "NodeLinkError";
  }
}

/** The target a node points at, or `undefined` when it has no outgoing link. */
export function getNodeLinkTargetId(node: Readonly<MindTreeNode> | undefined): NodeId | undefined {
  const targetId = node?.nodeLink;
  return targetId ? targetId : undefined;
}

/** True when the node points at another node or is pointed at by one. */
export function isNodeLinkParticipant(document: Readonly<MindTreeDocument>, nodeId: NodeId): boolean {
  if (getNodeLinkTargetId(document.nodes[nodeId])) return true;
  return Object.values(document.nodes).some((node) => node.nodeLink === nodeId);
}

/**
 * All links in document order (pre-order traversal), so the generated outline
 * and the link field stay deterministic for the same document state.
 */
export function collectNodeLinks(document: Readonly<MindTreeDocument>): NodeLinkEdge[] {
  const edges: NodeLinkEdge[] = [];
  for (const id of collectBranchIds(document, document.rootId)) {
    const targetId = getNodeLinkTargetId(document.nodes[id]);
    if (targetId) edges.push({ sourceId: id, targetId });
  }
  return edges;
}

/**
 * Join a node with another node without touching either subtree. Validation is
 * repeated here (not only in the view) because the picker is asynchronous: the
 * document can change while it is open.
 */
export function createNodeLink(
  document: MindTreeDocument,
  sourceId: NodeId,
  targetId: NodeId
): void {
  const source = document.nodes[sourceId];
  if (!source) throw new NodeLinkError("missing-source");
  if (!document.nodes[targetId]) throw new NodeLinkError("missing-target");
  if (sourceId === targetId) throw new NodeLinkError("self");
  // A resource already owns the node's trailing open control and its title
  // sync; allowing both would make the tail ambiguous.
  if (source.resource) throw new NodeLinkError("source-has-resource");
  if (source.nodeLink) throw new NodeLinkError("source-linked");
  source.nodeLink = targetId;
  touch(document, source);
}

/**
 * Remove every link the node participates in: its own outgoing reference and
 * all incoming references from other nodes. In the ordinary one-to-one case
 * this removes exactly one relation. Returns the number of removed edges.
 * Child nodes are intentionally left exactly as they were.
 */
export function removeNodeLinks(document: MindTreeDocument, nodeId: NodeId): number {
  let removed = 0;
  const source = document.nodes[nodeId];
  if (source?.nodeLink) {
    delete source.nodeLink;
    touch(document, source);
    removed += 1;
  }
  for (const node of Object.values(document.nodes)) {
    if (node.nodeLink !== nodeId) continue;
    delete node.nodeLink;
    touch(document, node);
    removed += 1;
  }
  return removed;
}

/**
 * Human-readable identity of a node for the picker and notices: the
 * root-to-node title chain. The caller supplies the localized placeholder for
 * untitled nodes so this pure module stays independent of the i18n catalog.
 */
export function nodeTitlePath(
  document: Readonly<MindTreeDocument>,
  nodeId: NodeId,
  untitled = DEFAULT_NODE_TITLE
): string {
  const titles: string[] = [];
  const visited = new Set<NodeId>();
  for (let current: NodeId | undefined = nodeId; current && !visited.has(current);) {
    visited.add(current);
    const node = document.nodes[current];
    if (!node) break;
    titles.push(node.title || untitled);
    current = findParentId(document, current);
  }
  return titles.reverse().join(" → ");
}
