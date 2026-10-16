/**
 * The frozen boundary between the MCP protocol layer and the Obsidian host.
 *
 * Everything above this file (`json-rpc-core.ts`, `mcp-core.ts`, the tool
 * bodies) is a pure function over these interfaces, so the whole protocol can
 * be tested without an Obsidian runtime; everything below it
 * (`obsidian-tool-host.ts`, `tree-reader.ts`, `session-writer.ts`) is the only
 * part allowed to touch the vault, the sessions and the settings.
 *
 * Read operations never require an open view. Write operations are routed
 * through the shared document session so they share history, undo and the
 * per-file write lane with the canvas.
 */
import type { MindTreeNode, NodeId, ResourceRef } from "../../types";

/** One node rendered for tool output; never a whole document. */
export interface McpNodeView {
  id: NodeId;
  title: string;
  parentId: NodeId | null;
  childIds: NodeId[];
  /** Zero for the tree root. */
  depth: number;
  markers?: MindTreeNode["markers"];
  resource?: ResourceRef;
  /** One-way same-document node reference ("关联节点"). */
  nodeLink?: NodeId;
  collapsed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpTreeSummary {
  path: string;
  documentId?: string;
  title: string;
  nodeCount: number;
}

export interface McpTreeStats {
  path: string;
  documentId?: string;
  title: string;
  nodeCount: number;
  fileCount: number;
  depth: number;
}

/** A flat row used by `read_tree` in `flat` mode and by `find_nodes`. */
export interface McpNodeRow {
  id: NodeId;
  title: string;
  parentId: NodeId | null;
  depth: number;
}

export interface McpTreePage {
  path: string;
  documentId?: string;
  title: string;
  rootId: NodeId;
  nodeCount: number;
  /** Rows actually returned after `maxNodes`/`offset` were applied. */
  returned: number;
  /** Total reachable nodes in the document, for pagination. */
  total: number;
  /** Present when more rows exist beyond this page. */
  nextOffset?: number;
  nodes: McpNodeRow[];
}

export interface McpNodePathEntry {
  id: NodeId;
  title: string;
}

export interface McpLinkedFiles {
  id: NodeId;
  resource?: ResourceRef;
  nodeLink?: NodeId;
}

export interface McpCreatedTree {
  path: string;
  documentId?: string;
  rootId: NodeId;
  childIds: NodeId[];
}

/**
 * Every host operation takes the resolved tree path first.
 *
 * `treePath` is already normalized and proven to address one `.mtn.md`;
 * resolving `documentId`/`treePath`/active-tree intent belongs to the locator,
 * not to the host, so the host never has to guess which tree was meant.
 */
export interface McpReadPort {
  listTrees(): Promise<McpTreeSummary[]>;
  readTree(treePath: string, maxNodes: number, offset: number): Promise<McpTreePage>;
  findNodes(treePath: string, query: string, limit: number): Promise<McpNodeRow[]>;
  getNode(treePath: string, nodeId: NodeId): Promise<McpNodeView>;
  /** `null` when `nodeId` is the tree root. */
  getParent(treePath: string, nodeId: NodeId): Promise<McpNodeView | null>;
  getChildren(treePath: string, nodeId: NodeId, recursive: boolean): Promise<McpNodeView[]>;
  getNodePath(treePath: string, nodeId: NodeId): Promise<McpNodePathEntry[]>;
  getLinkedFiles(treePath: string, nodeId: NodeId): Promise<McpLinkedFiles>;
  getTreeStats(treePath: string): Promise<McpTreeStats>;
}

export interface McpWritePort {
  /** Creates a new `.mtn.md` and returns its identity. Never steals focus. */
  createTree(input: { title: string; folder?: string; children?: string[] }): Promise<McpCreatedTree>;
  /** Moves one node to become a child of `targetId`. */
  moveNode(treePath: string, nodeId: NodeId, targetId: NodeId): Promise<McpNodeView>;
  addNode(treePath: string, parentId: NodeId, title: string, index?: number): Promise<McpNodeView>;
  renameNode(treePath: string, nodeId: NodeId, title: string): Promise<McpNodeView>;
  /** Removes one node and promotes its children; never deletes a branch or a file. */
  deleteNode(treePath: string, nodeId: NodeId): Promise<{ removedId: NodeId; promotedChildIds: NodeId[] }>;
  /** Associates an existing vault file; never creates or moves a file. */
  linkFile(treePath: string, nodeId: NodeId, filePath: string): Promise<McpNodeView>;
  unlinkFile(treePath: string, nodeId: NodeId): Promise<McpNodeView>;
  linkNode(treePath: string, sourceId: NodeId, targetId: NodeId): Promise<McpNodeView>;
  unlinkNode(treePath: string, sourceId: NodeId): Promise<McpNodeView>;
}

/** Resolves the user's tree intent into exactly one path, or fails by name. */
export interface McpTreeLocator {
  /** `documentId` wins over `treePath`; neither falls back to the active tree. */
  resolve(selection: { treePath?: string; documentId?: string }): Promise<string>;
}

export interface McpHostEnvironment {
  /** Only a supported platform may construct or start the transport. */
  isSupported(): boolean;
  /** The persisted edit switch, read at call time so a toggle applies at once. */
  allowsWrites(): boolean;
  /**
   * The persisted whole-tree-creation switch, read at call time.
   *
   * Deliberately separate from `allowsWrites`: creating a new file and editing an
   * existing one are different risks, so a user can let an assistant reorganise
   * a tree they are watching without also letting it create files unattended.
   * Adding a node *inside* an existing tree is editing, not creation.
   */
  allowsTreeCreation(): boolean;
  /** Live configuration for one-click client setup. */
  connection(): { port: number; token: string };
  /**
   * Release version reported in the `initialize` handshake.
   *
   * The protocol layer cannot read `manifest.json`, and a hardcoded copy would
   * silently drift on every release, so the host supplies it. Callers that only
   * exercise protocol behaviour may omit it and get a development marker.
   */
  version?(): string;
  /** Injectable so tests never spawn a real server. */
  logger?: (message: string) => void;
}

export interface McpToolHost {
  readonly read: McpReadPort;
  readonly write: McpWritePort;
  readonly locator: McpTreeLocator;
  readonly environment: McpHostEnvironment;
}
