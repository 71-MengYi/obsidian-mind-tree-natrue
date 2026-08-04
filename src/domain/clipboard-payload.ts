import {
  MAX_MIND_TREE_DEPTH,
  MAX_MIND_TREE_NODES,
  assertJsonContainerDepth,
  createSafeRecord
} from "../input-limits";
import type { BranchClipboardPayload, ClipboardLinkTarget, MindTreeNode, NodeId } from "../types";
import { asRecord, assertSafeNodeId, normalizeRuntimeNode, stringValue } from "./runtime-node";

export class ClipboardPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipboardPayloadError";
  }
}

/**
 * Convert custom MIME or an internal import payload into a bounded forest.
 * Only nodes reachable from declared roots survive normalization.
 */
export function normalizeBranchClipboardPayload(value: unknown): BranchClipboardPayload {
  assertJsonContainerDepth(value);
  const record = asRecord(value);
  if (!record) throw new ClipboardPayloadError("Structured clipboard data must be an object.");
  const rawNodes = asRecord(record["nodes"]);
  if (!rawNodes) throw new ClipboardPayloadError("Structured clipboard nodes must be an object.");
  const nodeEntries = Object.entries(rawNodes);
  if (nodeEntries.length > MAX_MIND_TREE_NODES) {
    throw new ClipboardPayloadError(`Structured clipboard data exceeds ${MAX_MIND_TREE_NODES} nodes.`);
  }

  const normalizedNodes = createSafeRecord<MindTreeNode>();
  for (const [id, node] of nodeEntries) normalizedNodes[id] = normalizeRuntimeNode(id, node);
  const rootId = requiredString(record, "rootId");
  const requestedRoots = Array.isArray(record["rootIds"]) ? record["rootIds"] : [rootId];
  if (!requestedRoots.every((id) => typeof id === "string" && id.length > 0)) {
    throw new ClipboardPayloadError("Structured clipboard roots must be non-empty strings.");
  }
  const rootIds = [...new Set(requestedRoots as string[])];
  if (rootIds.length === 0) throw new ClipboardPayloadError("Structured clipboard data has no roots.");
  for (const id of rootIds) {
    assertSafeNodeId(id);
    if (!normalizedNodes[id]) throw new ClipboardPayloadError(`Structured clipboard root does not exist: ${id}`);
  }

  const reachable = validateForest(normalizedNodes, rootIds);
  const nodes = createSafeRecord<MindTreeNode>();
  for (const id of reachable) nodes[id] = normalizedNodes[id]!;
  const linkTargets = normalizeLinkTargets(record["linkTargets"], reachable);
  return {
    sourceDocumentId: stringValue(record["sourceDocumentId"]) ?? rootId,
    rootId,
    ...(rootIds.length > 1 || record["rootIds"] !== undefined ? { rootIds } : {}),
    nodes,
    ...(Object.keys(linkTargets).length > 0 ? { linkTargets } : {})
  };
}

function validateForest(nodes: Record<NodeId, MindTreeNode>, rootIds: NodeId[]): Set<NodeId> {
  const roots = new Set(rootIds);
  const parentCount = new Map<NodeId, number>();
  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const pending: Array<{ id: NodeId; depth: number; exit: boolean }> = [];
  for (let index = rootIds.length - 1; index >= 0; index -= 1) {
    pending.push({ id: rootIds[index]!, depth: 0, exit: false });
  }
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      visiting.delete(current.id);
      visited.add(current.id);
      continue;
    }
    // Depth is zero-based; a maximum of 256 levels permits depths 0..255.
    if (current.depth >= MAX_MIND_TREE_DEPTH) {
      throw new ClipboardPayloadError(`Structured clipboard tree exceeds ${MAX_MIND_TREE_DEPTH} levels.`);
    }
    if (visiting.has(current.id)) throw new ClipboardPayloadError(`Structured clipboard cycle at ${current.id}.`);
    if (visited.has(current.id)) continue;
    const node = nodes[current.id];
    if (!node) throw new ClipboardPayloadError(`Structured clipboard node does not exist: ${current.id}`);
    visiting.add(current.id);
    pending.push({ ...current, exit: true });
    const localChildren = new Set<NodeId>();
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index]!;
      if (localChildren.has(childId)) throw new ClipboardPayloadError(`Duplicate child ${childId}.`);
      localChildren.add(childId);
      if (!nodes[childId]) throw new ClipboardPayloadError(`Structured clipboard node does not exist: ${childId}`);
      const count = (parentCount.get(childId) ?? 0) + 1;
      parentCount.set(childId, count);
      if (count > 1) throw new ClipboardPayloadError(`Structured clipboard node has multiple parents: ${childId}`);
      if (roots.has(childId)) throw new ClipboardPayloadError(`Structured clipboard root cannot be a child: ${childId}`);
      pending.push({ id: childId, depth: current.depth + 1, exit: false });
    }
  }
  return visited;
}

function normalizeLinkTargets(value: unknown, reachable: ReadonlySet<NodeId>): Record<NodeId, ClipboardLinkTarget> {
  const result = createSafeRecord<ClipboardLinkTarget>();
  const record = asRecord(value);
  if (!record) return result;
  for (const [id, rawTarget] of Object.entries(record)) {
    if (!reachable.has(id)) continue;
    const target = asRecord(rawTarget);
    if (!target) throw new ClipboardPayloadError(`Clipboard link target ${id} must be an object.`);
    if (target["type"] === "file") {
      const linkPath = requiredString(target, "linkPath");
      result[id] = { type: "file", linkPath };
    } else if (target["type"] === "url") {
      const url = requiredString(target, "url");
      const parsed = safeHttpUrl(url);
      if (!parsed) throw new ClipboardPayloadError(`Clipboard URL is unsafe: ${url}`);
      result[id] = { type: "url", url: parsed };
    } else {
      throw new ClipboardPayloadError(`Clipboard link target ${id} has an invalid type.`);
    }
  }
  return result;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = stringValue(record[key]);
  if (!value) throw new ClipboardPayloadError(`Missing required string property: ${key}`);
  return value;
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
