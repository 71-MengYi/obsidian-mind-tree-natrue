import { findParentId } from "../../domain/tree";
import { parseNodeTitle } from "../../format/node-title";
import { classifyFile, linkedFileTitle } from "../../format/resource-id";
import type { FileResourceRef, MindTreeDocument, NodeId } from "../../types";
import type { FileCandidate, SearchCandidate } from "./search-core";

/**
 * Search payload assembly without any Obsidian or DOM dependency.
 *
 * The search window must not read the vault on every keystroke, so this module
 * owns the two decisions that bound the work: which nodes are searchable, and
 * which of their files may be read as Markdown. Both are pure so the rules stay
 * testable, and so a document edit can rebuild the payload from scratch.
 */

/** Vault paths are `/` separated and the plugin never stores `./` prefixes. */
export function normalizeSearchPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Parent-of relationship for every node, built once in document order.
 *
 * A result card only needs the chain of the nodes it actually shows, so the
 * search payload passes this index (and the lazy accessor below) to the core
 * instead of precomputing a full root-to-node chain for every node in the tree.
 */
export function buildSearchParentIndex(document: MindTreeDocument): ReadonlyMap<NodeId, NodeId> {
  const parents = new Map<NodeId, NodeId>();
  for (const nodeId of Object.keys(document.nodes)) {
    const parentId = findParentId(document, nodeId);
    if (parentId) parents.set(nodeId, parentId);
  }
  return parents;
}

/**
 * Ancestor chain (root first, excluding the node itself) derived from a parent
 * index. The walk is iterative with a visited set so a hand-edited or cycling
 * document cannot hang the search window; an unreachable node simply keeps the
 * chain collected so far. A parentless node is the root and returns an empty
 * chain, while a node the document does not contain returns `undefined` so the
 * core can tell "no ancestry information" from "the root itself".
 */
export function nodeAncestorIds(
  parents: ReadonlyMap<NodeId, NodeId>,
  knownNodeIds?: ReadonlySet<NodeId>
): (nodeId: NodeId) => readonly NodeId[] | undefined {
  return (nodeId: NodeId): readonly NodeId[] | undefined => {
    const isKnown = knownNodeIds ? knownNodeIds.has(nodeId) : parents.has(nodeId);
    if (!isKnown) return undefined;
    const chain: NodeId[] = [];
    const visited = new Set<NodeId>([nodeId]);
    let parentId = parents.get(nodeId);
    while (parentId && !visited.has(parentId)) {
      chain.push(parentId);
      visited.add(parentId);
      parentId = parents.get(parentId);
    }
    return chain.reverse();
  };
}

/**
 * Every node's ancestor chain (root first, **excluding the node itself**), keyed
 * by node id. Prefer `buildSearchParentIndex` + `nodeAncestorIds` for search,
 * which only walks the chains of the cards actually rendered; this eager map is
 * for callers that need every chain at once. It deliberately mirrors
 * `SearchCandidate.ancestorIds`, not `SearchCard.nodePath`, so callers must add
 * the node itself when they need a root-to-self chain.
 */
export function searchedAncestorIds(document: MindTreeDocument): ReadonlyMap<NodeId, readonly NodeId[]> {
  const ancestors = nodeAncestorIds(buildSearchParentIndex(document), new Set(Object.keys(document.nodes)));
  const paths = new Map<NodeId, readonly NodeId[]>();
  for (const nodeId of Object.keys(document.nodes)) paths.set(nodeId, ancestors(nodeId) ?? []);
  return paths;
}

/**
 * Node order is stable, so the read budget always covers the same first files
 * and results do not shuffle between keystrokes. Nodes without a file still
 * match by title; they simply carry no content. A resource claimed by two nodes
 * is listed once, matching the document's stable resource identity.
 */
export function buildSearchCandidates(
  document: MindTreeDocument,
  ownPath: string | undefined,
  ancestorsByNodeId: ReadonlyMap<NodeId, readonly NodeId[]> = new Map()
): readonly SearchCandidate[] {
  const ancestorsOf = (nodeId: NodeId): readonly NodeId[] => ancestorsByNodeId.get(nodeId) ?? [];
  const candidates: SearchCandidate[] = [];
  const seenResourceIds = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.resource?.type !== "file") continue;
    const { resourceId, pathHint } = node.resource;
    if (seenResourceIds.has(resourceId)) continue;
    seenResourceIds.add(resourceId);
    const path = pathHint ? normalizeSearchPath(pathHint) : undefined;
    if (path && path === ownPath) continue;
    candidates.push({
      nodeId: node.id,
      title: node.title,
      plainTitle: parseNodeTitle(node.title).plainText,
      resourceId,
      ancestorIds: ancestorsOf(node.id),
      ...(path ? { path, fileName: linkedFileTitle(path) } : {})
    });
  }
  for (const node of Object.values(document.nodes)) {
    // File nodes were added above; a URL node still matches by title and only
    // lacks content, so it must not fall through both loops.
    if (node.resource?.type === "file") continue;
    candidates.push({
      nodeId: node.id,
      title: node.title,
      plainTitle: parseNodeTitle(node.title).plainText,
      ancestorIds: ancestorsOf(node.id)
    });
  }
  return candidates;
}

/**
 * Only `.md` files are searched. The current mind-tree file is excluded so its
 * compressed payload can never reach the results, and another `.mtn.md` is
 * excluded because reading one would parse a second tree instead of a note.
 * Identity verification is per candidate: one unverifiable reference only drops
 * that candidate.
 */
export function resolveSearchMarkdownFiles<T extends { path: string }>(
  resources: {
    resolveVerified: (reference: FileResourceRef) => Promise<T | undefined>;
  },
  candidates: readonly SearchCandidate[],
  ownPath: string | undefined
): Promise<readonly FileCandidate<T>[]> {
  const seen = new Set<string>();
  const resolved: Array<Promise<FileCandidate<T> | undefined>> = [];
  for (const candidate of candidates) {
    const hint = candidate.path;
    if (!hint || !candidate.resourceId) continue;
    const reference: FileResourceRef = {
      type: "file", resourceId: candidate.resourceId, pathHint: hint, fileKind: classifyFile(hint)
    };
    resolved.push(resources.resolveVerified(reference).then((file) => {
      if (!file || !file.path.toLowerCase().endsWith(".md")) return undefined;
      const path = normalizeSearchPath(file.path);
      if (path === ownPath || path.endsWith(".mtn.md") || seen.has(path)) return undefined;
      seen.add(path);
      return { path, file };
    }).catch(() => undefined));
  }
  return Promise.all(resolved).then((entries) => entries.filter((entry): entry is FileCandidate<T> => entry !== undefined));
}
