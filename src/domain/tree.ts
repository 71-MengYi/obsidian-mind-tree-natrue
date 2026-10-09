import type {
  BranchClipboardPayload,
  DropPosition,
  FileResourceRef,
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNode,
  MindTreeNodeShape,
  MindTreeTheme,
  NodeId,
  ValidationResult
} from "../types";
import { createDefaultDocumentSettings } from "../document-settings";
import { copySettingsState } from "../document-settings-state";
import { MAX_MIND_TREE_DEPTH, MAX_MIND_TREE_NODES, createSafeRecord } from "../input-limits";
import { normalizeBranchClipboardPayload } from "./clipboard-payload";
import { assertSafeNodeId } from "./runtime-node";
import { getDocumentTreeIndex, invalidateDocumentTreeIndex } from "./tree-index";

const ROOT_TITLE = "新建思维树";
/** Fallback used by non-UI callers; the view supplies the localized equivalent. */
export const DEFAULT_NODE_TITLE = "未命名节点";

export function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const random = Math.random().toString(16).slice(2);
  return `${Date.now().toString(16)}-${random}-${random.slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a document that has never been parsed. The setting arguments are runtime
 * values for immediate layout/render only: they belong to no file until the
 * document is parsed from one or `markSettingsEdited` records an explicit choice.
 */
export function createEmptyDocument(
  title = ROOT_TITLE,
  theme: MindTreeTheme = "vibrant",
  layoutMode: MindTreeLayoutMode = "balanced",
  nodeShape: MindTreeNodeShape = "rounded",
  collectionMode: MindTreeCollectionMode = "ask",
  connectionStyle: MindTreeConnectionStyle = "theme"
): MindTreeDocument {
  const createdAt = nowIso();
  const rootId = createId();
  const root: MindTreeNode = {
    id: rootId,
    title,
    childIds: [],
    createdAt,
    updatedAt: createdAt
  };

  return {
    settings: createDefaultDocumentSettings(theme, layoutMode, nodeShape, collectionMode, connectionStyle),
    title,
    rootId,
    nodes: { [rootId]: root },
    createdAt,
    updatedAt: createdAt
  };
}

export function cloneDocument(document: MindTreeDocument): MindTreeDocument {
  const clone = JSON.parse(JSON.stringify(document)) as MindTreeDocument;
  copySettingsState(document, clone);
  return clone;
}

export function getNode(document: MindTreeDocument, nodeId: NodeId): MindTreeNode {
  const node = document.nodes[nodeId];
  if (!node) {
    throw new Error(`Node does not exist: ${nodeId}`);
  }
  return node;
}

export function findParentId(document: MindTreeDocument, nodeId: NodeId): NodeId | undefined {
  return getDocumentTreeIndex(document).parentById.get(nodeId);
}

export function getDepth(document: MindTreeDocument, nodeId: NodeId): number {
  return getDocumentTreeIndex(document).depthById.get(nodeId) ?? Number.POSITIVE_INFINITY;
}

/** Counts displayed by the view status bar, kept pure for reliable testing. */
export function getTreeStatistics(document: MindTreeDocument): {
  topicCount: number;
  fileCount: number;
  depth: number;
} {
  const nodes = Object.values(document.nodes);
  const fileIds = new Set(nodes
    .map((node) => node.resource?.type === "file" ? node.resource.resourceId : undefined)
    .filter((id): id is string => id !== undefined));
  // Traverse parent-to-child once. Repeated getDepth calls would rescan every
  // parent list and become noticeably expensive on large or deeply nested trees.
  let depth = 0;
  for (const nodeDepth of getDocumentTreeIndex(document).depthById.values()) {
    depth = Math.max(depth, nodeDepth);
  }
  return { topicCount: nodes.length, fileCount: fileIds.size, depth };
}

/**
 * Collect unique vault-file references in the caller-provided node order.
 * URL resources are intentionally excluded because they have no vault path to
 * move. Copies detach the asynchronous file operation from later UI changes.
 */
export function collectFileReferences(
  document: MindTreeDocument,
  nodeIds: Iterable<NodeId>
): FileResourceRef[] {
  const references = new Map<string, FileResourceRef>();
  for (const nodeId of nodeIds) {
    const resource = document.nodes[nodeId]?.resource;
    if (resource?.type !== "file" || references.has(resource.resourceId)) continue;
    references.set(resource.resourceId, { ...resource });
  }
  return [...references.values()];
}

/** Update every node that references a moved file, including duplicates outside the moved branch. */
export function updateFileReferencePaths(
  document: MindTreeDocument,
  movedPaths: ReadonlyMap<string, string>
): boolean {
  let changed = false;
  for (const node of Object.values(document.nodes)) {
    if (node.resource?.type !== "file") continue;
    const path = movedPaths.get(node.resource.resourceId);
    if (!path || node.resource.pathHint === path) continue;
    node.resource.pathHint = path;
    changed = true;
  }
  return changed;
}

export function collectBranchIds(document: MindTreeDocument, nodeId: NodeId): NodeId[] {
  const result: NodeId[] = [];
  const visited = new Set<NodeId>();
  const pending: NodeId[] = [nodeId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    const node = document.nodes[id];
    if (!node) continue;
    visited.add(id);
    result.push(id);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      pending.push(node.childIds[index]!);
    }
  }
  return result;
}

export function isDescendant(document: MindTreeDocument, ancestorId: NodeId, candidateId: NodeId): boolean {
  return collectBranchIds(document, ancestorId).includes(candidateId);
}

export function addNode(
  document: MindTreeDocument,
  parentId: NodeId,
  title = DEFAULT_NODE_TITLE,
  index?: number
): MindTreeNode {
  const parent = getNode(document, parentId);
  if (Object.keys(document.nodes).length >= MAX_MIND_TREE_NODES) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_NODES} nodes.`);
  }
  if (getDepth(document, parentId) + 1 >= MAX_MIND_TREE_DEPTH) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_DEPTH} levels.`);
  }
  const createdAt = nowIso();
  const node: MindTreeNode = {
    id: createId(),
    title,
    childIds: [],
    createdAt,
    updatedAt: createdAt
  };
  document.nodes[node.id] = node;
  const targetIndex = index === undefined
    ? parent.childIds.length
    : Math.max(0, Math.min(index, parent.childIds.length));
  parent.childIds.splice(targetIndex, 0, node.id);
  touch(document, parent);
  invalidateDocumentTreeIndex(document);
  return node;
}

export function addSibling(document: MindTreeDocument, nodeId: NodeId, title = DEFAULT_NODE_TITLE): MindTreeNode {
  if (nodeId === document.rootId) throw new Error("The root node cannot have siblings.");
  const parentId = findParentId(document, nodeId);
  if (!parentId) throw new Error("Cannot find the parent node.");
  const parent = getNode(document, parentId);
  return addNode(document, parentId, title, parent.childIds.indexOf(nodeId) + 1);
}

/** Insert a new node between the selected node and its current parent. */
export function insertParentNode(document: MindTreeDocument, nodeId: NodeId, title = DEFAULT_NODE_TITLE): MindTreeNode {
  const child = getNode(document, nodeId);
  if (Object.keys(document.nodes).length >= MAX_MIND_TREE_NODES) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_NODES} nodes.`);
  }
  if (collectBranchIds(document, nodeId).some((id) => getDepth(document, id) + 1 >= MAX_MIND_TREE_DEPTH)) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_DEPTH} levels.`);
  }
  let oldParent: MindTreeNode | undefined;
  if (nodeId !== document.rootId) {
    const oldParentId = findParentId(document, nodeId);
    if (!oldParentId) throw new Error("Cannot find the parent node.");
    oldParent = getNode(document, oldParentId);
  }
  const createdAt = nowIso();
  const parentNode: MindTreeNode = {
    id: createId(),
    title,
    childIds: [child.id],
    createdAt,
    updatedAt: createdAt
  };
  document.nodes[parentNode.id] = parentNode;

  if (nodeId === document.rootId) {
    document.rootId = parentNode.id;
    document.title = title || ROOT_TITLE;
  } else {
    if (!oldParent) throw new Error("Cannot find the parent node.");
    const index = oldParent.childIds.indexOf(nodeId);
    oldParent.childIds.splice(index, 1, parentNode.id);
    oldParent.updatedAt = createdAt;
  }
  document.updatedAt = createdAt;
  invalidateDocumentTreeIndex(document);
  return parentNode;
}

export function renameNode(document: MindTreeDocument, nodeId: NodeId, title: string): void {
  const node = getNode(document, nodeId);
  node.title = title.trim();
  if (nodeId === document.rootId) document.title = node.title || ROOT_TITLE;
  touch(document, node);
}

export function deleteBranch(document: MindTreeDocument, nodeId: NodeId): NodeId[] {
  if (nodeId === document.rootId) throw new Error("The root node cannot be deleted.");
  const parentId = findParentId(document, nodeId);
  if (!parentId) throw new Error("Cannot find the parent node.");
  const parent = getNode(document, parentId);
  parent.childIds = parent.childIds.filter((id) => id !== nodeId);
  const removed = collectBranchIds(document, nodeId);
  for (const id of removed) delete document.nodes[id];
  touch(document, parent);
  invalidateDocumentTreeIndex(document);
  return removed;
}

/**
 * Reduce an arbitrary multi-selection to the highest selected branch roots.
 * Descendants of another selected node are already covered by that branch and
 * must not be deleted twice. The protected document root is deliberately
 * ignored, while its selected descendants remain eligible.
 */
export function getTopLevelSelectedNodeIds(
  document: MindTreeDocument,
  nodeIds: Iterable<NodeId>
): NodeId[] {
  const selected = new Set([...nodeIds].filter((id) => id !== document.rootId && Boolean(document.nodes[id])));
  const index = getDocumentTreeIndex(document);
  return [...selected]
    .filter((id) => {
      let parentId = index.parentById.get(id);
      while (parentId) {
        if (selected.has(parentId)) return false;
        parentId = index.parentById.get(parentId);
      }
      return true;
    })
    .sort((left, right) => (index.orderById.get(left) ?? Infinity) - (index.orderById.get(right) ?? Infinity));
}

/** Delete every selected branch as one structural operation. */
export function deleteBranches(document: MindTreeDocument, nodeIds: Iterable<NodeId>): NodeId[] {
  const roots = getTopLevelSelectedNodeIds(document, nodeIds);
  const removed: NodeId[] = [];
  for (const rootId of roots) removed.push(...deleteBranch(document, rootId));
  return removed;
}

/**
 * Delete several nodes while promoting each node's children. Deepest-first
 * ordering keeps parent/child multi-selections deterministic.
 */
export function deleteNodesOnly(document: MindTreeDocument, nodeIds: Iterable<NodeId>): NodeId[] {
  const targets = [...new Set(nodeIds)]
    .filter((id) => id !== document.rootId && Boolean(document.nodes[id]))
    .sort((left, right) => getDepth(document, right) - getDepth(document, left));
  for (const nodeId of targets) {
    if (document.nodes[nodeId]) deleteNodeOnly(document, nodeId);
  }
  return targets;
}

export function deleteNodeOnly(document: MindTreeDocument, nodeId: NodeId): void {
  if (nodeId === document.rootId) throw new Error("The root node cannot be deleted.");
  const parentId = findParentId(document, nodeId);
  if (!parentId) throw new Error("Cannot find the parent node.");
  const parent = getNode(document, parentId);
  const node = getNode(document, nodeId);
  const index = parent.childIds.indexOf(nodeId);
  parent.childIds.splice(index, 1, ...node.childIds);
  delete document.nodes[nodeId];
  touch(document, parent);
  invalidateDocumentTreeIndex(document);
}

export function moveNode(
  document: MindTreeDocument,
  nodeId: NodeId,
  targetId: NodeId,
  position: DropPosition
): void {
  moveNodes(document, [nodeId], targetId, position);
}

/**
 * Move an arbitrary selected forest as one ordered group.
 *
 * Selected descendants whose ancestor is also selected stay attached to that
 * ancestor. Every otherwise disconnected selected branch root is detached from
 * its old parent and inserted as a sibling at the destination.
 */
export function moveNodes(
  document: MindTreeDocument,
  nodeIds: Iterable<NodeId>,
  targetId: NodeId,
  position: DropPosition
): NodeId[] {
  const requestedNodeIds = [...nodeIds];
  const roots = getTopLevelSelectedNodeIds(document, requestedNodeIds);
  if (roots.length === 0) {
    if (requestedNodeIds.includes(document.rootId)) throw new Error("The root node cannot be moved.");
    return [];
  }
  if (roots.some((nodeId) => nodeId === targetId || isDescendant(document, nodeId, targetId))) {
    throw new Error("A node cannot be moved into itself or its descendants.");
  }

  let newParentId: NodeId;
  if (position === "inside") {
    getNode(document, targetId);
    newParentId = targetId;
  } else {
    if (targetId === document.rootId) throw new Error("Nodes cannot be placed before or after the root node.");
    const targetParentId = findParentId(document, targetId);
    if (!targetParentId) throw new Error("Cannot find the target parent.");
    newParentId = targetParentId;
  }

  const newRootDepth = getDepth(document, newParentId) + 1;
  for (const rootId of roots) {
    const originalRootDepth = getDepth(document, rootId);
    const relativeHeight = collectBranchIds(document, rootId).reduce((height, id) => (
      Math.max(height, getDepth(document, id) - originalRootDepth)
    ), 0);
    if (newRootDepth + relativeHeight >= MAX_MIND_TREE_DEPTH) {
      throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_DEPTH} levels.`);
    }
  }

  // Resolve every source before mutating anything so an invalid request leaves
  // even the draft passed by non-view callers unchanged.
  const oldParentIds = new Map<NodeId, NodeId>();
  for (const nodeId of roots) {
    const oldParentId = findParentId(document, nodeId);
    if (!oldParentId) throw new Error("Cannot find the source parent.");
    oldParentIds.set(nodeId, oldParentId);
  }

  const touchedParentIds = new Set<NodeId>();
  for (const [nodeId, oldParentId] of oldParentIds) {
    const oldParent = getNode(document, oldParentId);
    oldParent.childIds = oldParent.childIds.filter((id) => id !== nodeId);
    touchedParentIds.add(oldParentId);
  }

  const newParent = getNode(document, newParentId);
  let index: number;
  if (position === "inside") {
    index = newParent.childIds.length;
  } else {
    const targetIndex = newParent.childIds.indexOf(targetId);
    if (targetIndex < 0) throw new Error("Cannot find the target node in its parent.");
    index = targetIndex + (position === "after" ? 1 : 0);
  }

  newParent.childIds.splice(index, 0, ...roots);
  touchedParentIds.add(newParent.id);
  for (const parentId of touchedParentIds) touch(document, getNode(document, parentId));
  invalidateDocumentTreeIndex(document);
  return roots;
}

/**
 * Exchange a node with the adjacent sibling above or below it. Returning false
 * for the root and list boundaries lets keyboard callers avoid creating empty
 * undo entries when no visible reordering can occur.
 */
export function moveNodeAmongSiblings(
  document: MindTreeDocument,
  nodeId: NodeId,
  direction: "up" | "down"
): boolean {
  if (nodeId === document.rootId) return false;
  const parentId = findParentId(document, nodeId);
  if (!parentId) return false;
  const parent = getNode(document, parentId);
  const currentIndex = parent.childIds.indexOf(nodeId);
  const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= parent.childIds.length) return false;
  const adjacentId = parent.childIds[targetIndex];
  if (!adjacentId) return false;
  parent.childIds[currentIndex] = adjacentId;
  parent.childIds[targetIndex] = nodeId;
  touch(document, parent);
  invalidateDocumentTreeIndex(document);
  return true;
}

export function toggleCollapsed(document: MindTreeDocument, nodeId: NodeId): void {
  const node = getNode(document, nodeId);
  node.collapsed = !node.collapsed;
  touch(document, node);
}

export function setAllCollapsed(document: MindTreeDocument, nodeId: NodeId, collapsed: boolean): void {
  for (const id of collectBranchIds(document, nodeId)) {
    const node = getNode(document, id);
    if (node.childIds.length > 0) node.collapsed = collapsed;
  }
  document.updatedAt = nowIso();
}

/**
 * Show the tree through the requested depth and collapse every deeper branch.
 *
 * The root is depth zero, so a maximum visible depth of one keeps the root and
 * its direct children visible. We still visit descendants hidden by an ancestor
 * and mark their branch nodes as collapsed. This lets the user expand the tree
 * manually one level at a time after applying the command.
 */
export function setCollapsedAfterDepth(document: MindTreeDocument, maxVisibleDepth: number): void {
  const normalizedDepth = Math.max(0, Math.floor(maxVisibleDepth));
  const pending: Array<[NodeId, number]> = [[document.rootId, 0]];
  const visited = new Set<NodeId>();

  while (pending.length > 0) {
    const [nodeId, depth] = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node) continue;
    if (node.childIds.length > 0) node.collapsed = depth >= normalizedDepth;
    for (const childId of node.childIds) pending.push([childId, depth + 1]);
  }

  document.updatedAt = nowIso();
}

export function validateDocument(document: MindTreeDocument): ValidationResult {
  const issues: ValidationResult["issues"] = [];
  const nodeIds = Object.keys(document.nodes);
  if (nodeIds.length > MAX_MIND_TREE_NODES) {
    issues.push({ code: "node-count", message: `Mind Tree exceeds the ${MAX_MIND_TREE_NODES}-node safety limit.` });
    return { valid: false, issues, unreachableNodeIds: nodeIds };
  }
  for (const id of nodeIds) {
    try {
      assertSafeNodeId(id);
    } catch (error) {
      issues.push({ code: "unsafe-node-id", message: error instanceof Error ? error.message : String(error), nodeId: id });
    }
    if (document.nodes[id]?.id !== id) {
      issues.push({ code: "node-id-mismatch", message: `Node map key does not match node ID: ${id}`, nodeId: id });
    }
  }
  if (!document.rootId || !document.nodes[document.rootId]) {
    issues.push({ code: "missing-root", message: "rootId must reference an existing node." });
    return { valid: false, issues, unreachableNodeIds: nodeIds };
  }

  const parentCount = new Map<NodeId, number>();
  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const pending: Array<{ id: NodeId; depth: number; exit: boolean }> = [
    { id: document.rootId, depth: 0, exit: false }
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      visiting.delete(current.id);
      visited.add(current.id);
      continue;
    }
    const node = document.nodes[current.id];
    if (!node) {
      issues.push({ code: "missing-node", message: `Referenced node does not exist: ${current.id}`, nodeId: current.id });
      continue;
    }
    // Depth is zero-based; a maximum of 256 levels permits depths 0..255.
    if (current.depth >= MAX_MIND_TREE_DEPTH) {
      issues.push({ code: "tree-depth", message: `Mind Tree exceeds the ${MAX_MIND_TREE_DEPTH}-level safety limit.`, nodeId: current.id });
      continue;
    }
    if (visiting.has(current.id)) {
      issues.push({ code: "cycle", message: `Cycle detected at node ${current.id}.`, nodeId: current.id });
      continue;
    }
    if (visited.has(current.id)) continue;
    visiting.add(current.id);
    pending.push({ ...current, exit: true });
    const localChildren = new Set<NodeId>();
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index]!;
      if (localChildren.has(childId)) {
        issues.push({ code: "duplicate-child", message: `Duplicate child ${childId}.`, nodeId: current.id });
      }
      localChildren.add(childId);
      parentCount.set(childId, (parentCount.get(childId) ?? 0) + 1);
      pending.push({ id: childId, depth: current.depth + 1, exit: false });
    }
  }

  if ((parentCount.get(document.rootId) ?? 0) > 0) {
    issues.push({ code: "root-has-parent", message: "The root node cannot be a child.", nodeId: document.rootId });
  }
  for (const [id, count] of parentCount) {
    if (id !== document.rootId && count > 1) {
      issues.push({ code: "multiple-parents", message: `Node ${id} has multiple parents.`, nodeId: id });
    }
  }
  const unreachableNodeIds = nodeIds.filter((id) => !visited.has(id));
  return { valid: issues.length === 0, issues, unreachableNodeIds };
}

export function extractBranch(document: MindTreeDocument, nodeId: NodeId): BranchClipboardPayload {
  return extractBranches(document, [nodeId]);
}

/** Extract one or more independent branches into a single clipboard forest. */
export function extractBranches(document: MindTreeDocument, nodeIds: Iterable<NodeId>): BranchClipboardPayload {
  const selected = new Set([...nodeIds].filter((id) => Boolean(document.nodes[id])));
  const rootIds = selected.has(document.rootId)
    ? [document.rootId]
    : getTopLevelSelectedNodeIds(document, selected);
  if (rootIds.length === 0) throw new Error("No valid branches were selected.");
  const nodes = createSafeRecord<MindTreeNode>();
  for (const rootId of rootIds) {
    for (const id of collectBranchIds(document, rootId)) {
      nodes[id] = JSON.parse(JSON.stringify(getNode(document, id))) as MindTreeNode;
    }
  }
  // Clipboard payloads need a source discriminator, not a persisted resource
  // identity. The root ID is present even before the tree is linked.
  return { sourceDocumentId: document.documentId ?? document.rootId, rootId: rootIds[0]!, rootIds, nodes };
}

export function insertBranch(
  document: MindTreeDocument,
  parentId: NodeId,
  payload: BranchClipboardPayload
): NodeId {
  const inserted = insertBranches(document, parentId, payload);
  if (!inserted[0]) throw new Error("Invalid branch payload.");
  return inserted[0];
}

/** Insert every top-level root in a clipboard forest as siblings. */
export function insertBranches(
  document: MindTreeDocument,
  parentId: NodeId,
  payload: BranchClipboardPayload
): NodeId[] {
  const safePayload = normalizeBranchClipboardPayload(payload);
  const rootIds = [...new Set(safePayload.rootIds?.length ? safePayload.rootIds : [safePayload.rootId])]
    .filter((id) => Boolean(safePayload.nodes[id]));
  if (rootIds.length === 0) throw new Error("Invalid branch payload.");

  // Only import nodes reachable from a declared root. This prevents malformed
  // custom clipboard data from introducing unattached nodes into the document.
  const ids: NodeId[] = [];
  const visited = new Set<NodeId>();
  const pending = [...rootIds].reverse();
  while (pending.length > 0) {
    const id = pending.pop()!;
    const source = safePayload.nodes[id];
    if (!source || visited.has(id)) continue;
    visited.add(id);
    ids.push(id);
    for (let index = source.childIds.length - 1; index >= 0; index -= 1) pending.push(source.childIds[index]!);
  }
  if (Object.keys(document.nodes).length + ids.length > MAX_MIND_TREE_NODES) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_NODES} nodes.`);
  }
  const parentDepth = getDepth(document, parentId);
  const payloadDepths = new Map<NodeId, number>();
  const depthPending = rootIds.map((id) => ({ id, depth: 0 }));
  let maximumPayloadDepth = 0;
  while (depthPending.length > 0) {
    const current = depthPending.pop()!;
    if (payloadDepths.has(current.id)) continue;
    payloadDepths.set(current.id, current.depth);
    maximumPayloadDepth = Math.max(maximumPayloadDepth, current.depth);
    for (const childId of safePayload.nodes[current.id]?.childIds ?? []) {
      depthPending.push({ id: childId, depth: current.depth + 1 });
    }
  }
  if (parentDepth + 1 + maximumPayloadDepth >= MAX_MIND_TREE_DEPTH) {
    throw new Error(`Mind Tree cannot exceed ${MAX_MIND_TREE_DEPTH} levels.`);
  }
  const idMap = new Map(ids.map((id) => [id, createId()]));
  for (const oldId of ids) {
    const source = safePayload.nodes[oldId];
    if (!source) continue;
    const id = idMap.get(oldId)!;
    const createdAt = nowIso();
    const resource = source.resource?.type === "url" && !isSafeHttpUrl(source.resource.url)
      ? undefined
      : source.resource;
    document.nodes[id] = {
      ...JSON.parse(JSON.stringify(source)) as MindTreeNode,
      id,
      childIds: source.childIds.map((childId) => idMap.get(childId)).filter((value): value is string => Boolean(value)),
      ...(resource ? { resource: JSON.parse(JSON.stringify(resource)) } : { resource: undefined }),
      createdAt,
      updatedAt: createdAt
    };
  }
  const newRootIds = rootIds.map((id) => idMap.get(id)).filter((id): id is NodeId => Boolean(id));
  getNode(document, parentId).childIds.push(...newRootIds);
  document.updatedAt = nowIso();
  invalidateDocumentTreeIndex(document);
  return newRootIds;
}

export function touch(document: MindTreeDocument, node?: MindTreeNode): void {
  const updatedAt = nowIso();
  document.updatedAt = updatedAt;
  if (node) node.updatedAt = updatedAt;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
