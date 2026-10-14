import { collectBranchIds, getTreeStatistics } from "../../domain/tree";
import { getDocumentTreeIndex, type DocumentTreeIndex } from "../../domain/tree-index";
import { parseMindTreeFile, type ParseMindTreeOptions } from "../../format/document";
import { isMindTreePath } from "../../format/resource-id";
import { t } from "../../i18n";
import { evictOldest } from "../../lru-cache";
import { clamp } from "../../numeric";
import type { MindTreeDocument, NodeId } from "../../types";
import { canonicalTreePath } from "../pending-conflict-store";
import {
  DEFAULT_MCP_FIND_LIMIT,
  DEFAULT_MCP_READ_MAX_NODES,
  MAX_MCP_FIND_LIMIT,
  MAX_MCP_READ_MAX_NODES
} from "./connection";
import type {
  McpLinkedFiles,
  McpNodePathEntry,
  McpNodeRow,
  McpNodeView,
  McpReadPort,
  McpTreePage,
  McpTreeStats,
  McpTreeSummary
} from "./contracts";
import { McpToolError } from "./tool-error";

/** Parsed tree plus the lookups every projection needs. */
interface ParsedTree {
  readonly path: string;
  readonly document: MindTreeDocument;
  readonly index: DocumentTreeIndex;
}

/**
 * Project one node for tool output. Pure and exported because a *write* has to
 * return the same shape as a read: the tool host builds write results from the
 * document that was just persisted, and both sides must agree on every field.
 */
export function createMcpNodeView(
  document: MindTreeDocument,
  nodeId: NodeId,
  index: DocumentTreeIndex = getDocumentTreeIndex(document)
): McpNodeView {
  const node = document.nodes[nodeId]!;
  return {
    id: node.id,
    title: node.title,
    parentId: index.parentById.get(nodeId) ?? null,
    childIds: node.childIds.filter((id) => Boolean(document.nodes[id])),
    depth: index.depthById.get(nodeId) ?? 0,
    ...(node.markers ? { markers: structuredClone(node.markers) } : {}),
    ...(node.resource ? { resource: structuredClone(node.resource) } : {}),
    ...(node.nodeLink ? { nodeLink: node.nodeLink } : {}),
    ...(node.collapsed !== undefined ? { collapsed: node.collapsed } : {}),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt
  };
}

/** Project one flat row for `read_tree`/`find_nodes`. */
export function createMcpNodeRow(
  document: MindTreeDocument,
  nodeId: NodeId,
  index: DocumentTreeIndex = getDocumentTreeIndex(document)
): McpNodeRow {
  const node = document.nodes[nodeId]!;
  return {
    id: node.id,
    title: node.title,
    parentId: index.parentById.get(nodeId) ?? null,
    depth: index.depthById.get(nodeId) ?? 0
  };
}

export interface MindTreeReaderPorts {
  /** Every vault file path; used only to enumerate `.mtn.md` files. */
  filePaths(): readonly string[];
  /** Reads one vault file's current text. */
  read(path: string): Promise<string>;
  /** Global defaults are read at call time so a settings change applies at once. */
  parseOptions(): Readonly<ParseMindTreeOptions>;
}

/** Enough parsed trees to answer a burst of tool calls without unbounded memory. */
const DEFAULT_TREE_CACHE_LIMIT = 32;

/**
 * Read-only `.mtn.md` access for the MCP layer.
 *
 * Reading must work with no view open — an AI client can inspect the vault while
 * the user is doing something else entirely — so this class owns parsing and
 * projection and never touches a document session, a history or the vault API's
 * write side. Parsed trees are cached per path because one tool conversation
 * reads the same tree many times, and the cache is dropped on vault modify,
 * delete and rename so a stale document can never be reported as current.
 */
export class MindTreeReader implements McpReadPort {
  private readonly cache = new Map<string, Promise<ParsedTree | undefined>>();

  constructor(
    private readonly ports: MindTreeReaderPorts,
    private readonly cacheLimit: number = DEFAULT_TREE_CACHE_LIMIT
  ) {}

  /** One file changed: only that path's parsed copy is dropped. */
  invalidate(path: string): void {
    this.cache.delete(canonicalTreePath(path));
  }

  /** A folder event or a settings change can affect many trees at once. */
  invalidateAll(): void {
    this.cache.clear();
  }

  async listTrees(): Promise<McpTreeSummary[]> {
    const paths = [...new Set(this.ports.filePaths().map(canonicalTreePath).filter(isMindTreePath))];
    const summaries: McpTreeSummary[] = [];
    for (const path of paths) {
      const tree = await this.load(path);
      // An unreadable file is not offered as a target: listing it would invite
      // a call that can only fail, and its identity could not be trusted.
      if (!tree) continue;
      summaries.push({
        path,
        ...(tree.document.documentId ? { documentId: tree.document.documentId } : {}),
        title: tree.document.title,
        nodeCount: tree.index.preorderIds.length
      });
    }
    return summaries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async readTree(treePath: string, maxNodes: number, offset: number): Promise<McpTreePage> {
    const tree = await this.requireTree(treePath);
    const limit = clamp(toInteger(maxNodes, DEFAULT_MCP_READ_MAX_NODES), 1, MAX_MCP_READ_MAX_NODES);
    const ids = tree.index.preorderIds;
    const start = clamp(toInteger(offset, 0), 0, ids.length);
    const page = ids.slice(start, start + limit);
    const returned = page.length;
    const nextOffset = start + returned;
    return {
      path: tree.path,
      ...(tree.document.documentId ? { documentId: tree.document.documentId } : {}),
      title: tree.document.title,
      rootId: tree.document.rootId,
      nodeCount: ids.length,
      returned,
      total: ids.length,
      ...(nextOffset < ids.length ? { nextOffset } : {}),
      nodes: page.map((id) => this.row(tree, id))
    };
  }

  async findNodes(treePath: string, query: string, limit: number): Promise<McpNodeRow[]> {
    const tree = await this.requireTree(treePath);
    const effectiveLimit = clamp(toInteger(limit, DEFAULT_MCP_FIND_LIMIT), 1, MAX_MCP_FIND_LIMIT);
    const needle = query.trim().toLowerCase();
    const rows: McpNodeRow[] = [];
    for (const id of tree.index.preorderIds) {
      if (rows.length >= effectiveLimit) break;
      const node = tree.document.nodes[id];
      if (!node) continue;
      // An empty query browses the tree in document order instead of matching
      // nothing, which is what a client that lost its filter expects to see.
      if (needle && !node.title.toLowerCase().includes(needle)) continue;
      rows.push(this.row(tree, id));
    }
    return rows;
  }

  async getNode(treePath: string, nodeId: NodeId): Promise<McpNodeView> {
    const tree = await this.requireTree(treePath);
    this.requireNode(tree, nodeId);
    return this.view(tree, nodeId);
  }

  async getParent(treePath: string, nodeId: NodeId): Promise<McpNodeView | null> {
    const tree = await this.requireTree(treePath);
    this.requireNode(tree, nodeId);
    const parentId = tree.index.parentById.get(nodeId);
    return parentId === undefined ? null : this.view(tree, parentId);
  }

  async getChildren(treePath: string, nodeId: NodeId, recursive: boolean): Promise<McpNodeView[]> {
    const tree = await this.requireTree(treePath);
    this.requireNode(tree, nodeId);
    const ids = recursive
      ? collectBranchIds(tree.document, nodeId).slice(1)
      : this.childIds(tree, nodeId);
    return ids.map((id) => this.view(tree, id));
  }

  async getNodePath(treePath: string, nodeId: NodeId): Promise<McpNodePathEntry[]> {
    const tree = await this.requireTree(treePath);
    this.requireNode(tree, nodeId);
    const path: McpNodePathEntry[] = [];
    const visited = new Set<NodeId>();
    for (let current: NodeId | undefined = nodeId; current !== undefined && !visited.has(current);) {
      visited.add(current);
      const node = tree.document.nodes[current];
      if (!node) break;
      path.push({ id: node.id, title: node.title });
      current = tree.index.parentById.get(current);
    }
    return path.reverse();
  }

  async getLinkedFiles(treePath: string, nodeId: NodeId): Promise<McpLinkedFiles> {
    const tree = await this.requireTree(treePath);
    const node = this.requireNode(tree, nodeId);
    return {
      id: node.id,
      ...(node.resource ? { resource: structuredClone(node.resource) } : {}),
      ...(node.nodeLink ? { nodeLink: node.nodeLink } : {})
    };
  }

  async getTreeStats(treePath: string): Promise<McpTreeStats> {
    const tree = await this.requireTree(treePath);
    const statistics = getTreeStatistics(tree.document);
    return {
      path: tree.path,
      ...(tree.document.documentId ? { documentId: tree.document.documentId } : {}),
      title: tree.document.title,
      nodeCount: tree.index.preorderIds.length,
      fileCount: statistics.fileCount,
      depth: statistics.depth
    };
  }

  private async requireTree(treePath: string): Promise<ParsedTree> {
    const path = canonicalTreePath(treePath);
    if (!isMindTreePath(path)) throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target: path }));
    const tree = await this.load(path);
    // Unreadable data is reported as a missing tree rather than as a partial
    // read: a client must never build on a document nobody could verify.
    if (!tree) throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target: path }));
    return tree;
  }

  private requireNode(tree: ParsedTree, nodeId: NodeId) {
    const node = tree.document.nodes[nodeId];
    if (!node) throw new McpToolError("node-not-found", t("mcp.error.nodeNotFound", { nodeId }));
    return node;
  }

  private load(path: string): Promise<ParsedTree | undefined> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const pending = this.ports.read(path)
      .then((source) => {
        const document = parseMindTreeFile(source, this.ports.parseOptions()).document;
        return { path, document, index: getDocumentTreeIndex(document) };
      })
      .catch(() => {
        // A transient read or parse failure must not stick to the path until the
        // next vault event, so nothing about it is cached.
        this.cache.delete(path);
        return undefined;
      });
    evictOldest(this.cache, Math.max(1, this.cacheLimit));
    this.cache.set(path, pending);
    return pending;
  }

  private childIds(tree: ParsedTree, nodeId: NodeId): NodeId[] {
    const node = tree.document.nodes[nodeId];
    if (!node) return [];
    // A dangling child id is a data defect the tree index already ignores; it
    // must not resurface as a node view the client cannot follow.
    return node.childIds.filter((id) => Boolean(tree.document.nodes[id]));
  }

  private row(tree: ParsedTree, id: NodeId): McpNodeRow {
    return createMcpNodeRow(tree.document, id, tree.index);
  }

  private view(tree: ParsedTree, id: NodeId): McpNodeView {
    return createMcpNodeView(tree.document, id, tree.index);
  }
}

function toInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}
