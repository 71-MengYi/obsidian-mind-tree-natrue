import type { MindTreeDocument, MindTreeNode, NodeId, ResourceRef } from "../types";

/** Capture before opening any dialog or starting asynchronous file operations. */
export interface AssociationTarget {
  readonly documentSessionToken: string;
  readonly nodeId: NodeId;
}

export function isAssociationTargetAvailable(
  target: AssociationTarget,
  currentSessionToken: string,
  document: Readonly<MindTreeDocument> | undefined
): boolean {
  const node = document?.nodes[target.nodeId];
  return currentSessionToken === target.documentSessionToken && Boolean(node && !node.resource);
}

export class AssociationTargetChangedError extends Error {
  constructor() {
    super("The association target changed or already has a resource.");
    this.name = "AssociationTargetChangedError";
  }
}

/** Also used inside the command's draft, after other views have committed editors. */
export function requireAssociationTarget(
  target: AssociationTarget,
  currentSessionToken: string,
  document: MindTreeDocument | undefined
): MindTreeNode {
  if (!isAssociationTargetAvailable(target, currentSessionToken, document)) throw new AssociationTargetChangedError();
  return document!.nodes[target.nodeId]!;
}

/** Menu snapshots compare logical identity, not paths that may change on rename. */
export interface ResourceTarget extends AssociationTarget {
  readonly resource: Readonly<ResourceRef> | undefined;
}

export function isResourceTargetCurrent(
  target: ResourceTarget,
  currentSessionToken: string,
  document: Readonly<MindTreeDocument> | undefined
): boolean {
  if (target.documentSessionToken !== currentSessionToken) return false;
  const node = document?.nodes[target.nodeId];
  if (!node) return false;
  const resource = node.resource;
  const captured = target.resource;
  if (!captured || !resource) return captured === resource;
  return resource.type === "file" && captured.type === "file"
    ? resource.resourceId === captured.resourceId
    : resource.type === "url" && captured.type === "url" && resource.url === captured.url;
}
