import type { MindTreeDocument, NodeId } from "../types";

export interface DocumentTreeIndex {
  readonly parentById: ReadonlyMap<NodeId, NodeId>;
  readonly depthById: ReadonlyMap<NodeId, number>;
  readonly orderById: ReadonlyMap<NodeId, number>;
  readonly preorderIds: readonly NodeId[];
}

const cache = new WeakMap<MindTreeDocument, DocumentTreeIndex>();

/**
 * Build parent, depth, and document-order lookups in one iterative pass. View
 * commands treat a document object as immutable, so every new draft naturally
 * gets a separate cache entry without version counters on the persisted model.
 */
export function getDocumentTreeIndex(document: MindTreeDocument): DocumentTreeIndex {
  const cached = cache.get(document);
  if (cached) return cached;
  const parentById = new Map<NodeId, NodeId>();
  const depthById = new Map<NodeId, number>();
  const orderById = new Map<NodeId, number>();
  const preorderIds: NodeId[] = [];
  const visited = new Set<NodeId>();
  const pending: Array<{ id: NodeId; depth: number; parentId?: NodeId }> = [
    { id: document.rootId, depth: 0 }
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.id) || !document.nodes[current.id]) continue;
    visited.add(current.id);
    if (current.parentId) parentById.set(current.id, current.parentId);
    depthById.set(current.id, current.depth);
    orderById.set(current.id, preorderIds.length);
    preorderIds.push(current.id);
    const childIds = document.nodes[current.id]!.childIds;
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      pending.push({ id: childIds[index]!, depth: current.depth + 1, parentId: current.id });
    }
  }
  const result = { parentById, depthById, orderById, preorderIds };
  cache.set(document, result);
  return result;
}

/** Domain mutators invalidate a draft after changing parent/child structure. */
export function invalidateDocumentTreeIndex(document: MindTreeDocument): void {
  cache.delete(document);
}
