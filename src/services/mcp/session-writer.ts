import { addNode, deleteNodeOnly, getDepth, moveNodes, renameNode } from "../../domain/tree";
import { createNodeLink, NodeLinkError, removeNodeLinks } from "../../domain/node-link";
import { parseMindTreeFile, serializeMindTreeFile, type ParseMindTreeOptions } from "../../format/document";
import { isMindTreePath } from "../../format/resource-id";
import { MAX_MIND_TREE_DEPTH, MAX_MIND_TREE_NODES, exceedsDepthBudget, exceedsNodeBudget } from "../../input-limits";
import { t } from "../../i18n";
import type { MindTreeDocument, NodeId, ResourceRef } from "../../types";
import { assessExternalVersion, createManagedMindTreeSnapshot, sameManagedMindTreeSnapshot } from "../document-conflict";
import { SaveConflictError } from "../document-session";
import type { MindTreeSessionRegistry, SharedMindTreeSession } from "../mind-tree-session-registry";
import { canonicalTreePath } from "../pending-conflict-store";
import type { McpCreatedTree } from "./contracts";
import { McpToolError, normalizeToolError, type McpToolErrorCode } from "./tool-error";

/** The identity this writer uses when it publishes a change to a shared session. */
const HEADLESS_ORIGIN = "mcp-headless";

/** Where a new tree comes from. The one creation path lives in tree-creation.ts. */
export interface MindTreeCreatePort {
  create(input: {
    title: string;
    folderPath?: string;
    children?: readonly string[];
    focus?: boolean;
  }): Promise<{ path: string; documentId?: string; rootId: NodeId; childIds: NodeId[] }>;
}

export interface MindTreeSessionWriterPorts {
  /** The same registry open views use, so a canvas and a tool share one history. */
  sessions: MindTreeSessionRegistry;
  fileExists(path: string): boolean;
  read(path: string): Promise<string>;
  /** `Vault.process`: the compare-and-set write, under the vault's per-file lock. */
  process(path: string, transform: (source: string) => string): Promise<unknown>;
  parseOptions(): Readonly<ParseMindTreeOptions>;
  /** Turns one existing vault file into a stable resource reference. */
  fileReference(filePath: string): Promise<ResourceRef>;
  creation: MindTreeCreatePort;
  /** Tells open views for this path to re-read the disk after a refused write. */
  notifyExternalChange(path: string): void;
}

export interface MindTreeWriteOutcome {
  readonly path: string;
  /** The document exactly as it was persisted (external settings merged in). */
  readonly document: MindTreeDocument;
  readonly nodeId: NodeId;
}

export interface MindTreeDeleteOutcome {
  readonly path: string;
  readonly document: MindTreeDocument;
  readonly removedId: NodeId;
  readonly promotedChildIds: NodeId[];
}

/** A refusal recorded inside the compare-and-set callback. */
type Refusal = { readonly kind: "conflict" } | { readonly kind: "error"; readonly error: unknown };

/**
 * Headless document writes for MCP tools.
 *
 * Every write is an ordinary, undoable tree command applied to the *shared*
 * session for that path, inside that session's serial write lane, and persisted
 * through `Vault.process` so the baseline comparison and the write happen under
 * one per-file lock. Three rules are non-negotiable:
 *
 * 1. The in-memory document is only ever published after the persisted bytes
 *    were read back and proved to carry the same machine data.
 * 2. If the disk no longer matches the session baseline — another editor wrote,
 *    the identity changed, or the external data cannot be parsed — the write is
 *    abandoned and reported, never forced.
 * 3. A file that already has a file-level lock the writer cannot see
 *    (`mutationLocked`) is refused, because the user is in the middle of
 *    resolving something and a tool must not decide it for them.
 *
 * When a `MindTreeView` is open for the path, it is deliberately *not* bypassed:
 * the view and this writer share one session, one history and one write lane, so
 * an MCP edit is undoable in the canvas and the canvas repaints from the same
 * document that was persisted. An open inline editor is committed by the session
 * before the command runs, so a draft the user is typing is never lost.
 */
export class MindTreeSessionWriter {
  constructor(private readonly ports: MindTreeSessionWriterPorts) {}

  async addNode(treePath: string, parentId: NodeId, title: string, index?: number): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      if (!draft.nodes[parentId]) throw this.nodeNotFound(parentId);
      const clean = title.trim();
      if (!clean) throw this.invalidTitle();
      // Checked here, not left to the domain, so the client can branch on
      // node-limit/depth-limit instead of parsing an English sentence.
      if (exceedsNodeBudget(Object.keys(draft.nodes).length, 1)) throw this.nodeLimit();
      if (exceedsDepthBudget(getDepth(draft, parentId) + 1)) throw this.depthLimit();
      return addNode(draft, parentId, clean, index).id;
    });
  }

  async moveNode(treePath: string, nodeId: NodeId, targetId: NodeId): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      if (!draft.nodes[nodeId]) throw this.nodeNotFound(nodeId);
      if (!draft.nodes[targetId]) throw this.nodeNotFound(targetId);
      moveNodes(draft, [nodeId], targetId, "inside");
      return nodeId;
    });
  }

  async renameNode(treePath: string, nodeId: NodeId, title: string): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      if (!draft.nodes[nodeId]) throw this.nodeNotFound(nodeId);
      if (!title.trim()) throw this.invalidTitle();
      renameNode(draft, nodeId, title);
      return nodeId;
    });
  }

  /** Deletes one node and promotes its children; never a branch, never a file. */
  async deleteNode(treePath: string, nodeId: NodeId): Promise<MindTreeDeleteOutcome> {
    let promotedChildIds: NodeId[] = [];
    const outcome = await this.apply(treePath, "invalid-operation", (draft) => {
      const node = draft.nodes[nodeId];
      if (!node) throw this.nodeNotFound(nodeId);
      promotedChildIds = [...node.childIds];
      deleteNodeOnly(draft, nodeId);
      return nodeId;
    });
    return { path: outcome.path, document: outcome.document, removedId: nodeId, promotedChildIds };
  }

  async linkFile(treePath: string, nodeId: NodeId, filePath: string): Promise<MindTreeWriteOutcome> {
    // Identity resolution is vault work, not a document mutation, so it happens
    // before the write lane is entered and before any session is touched.
    const reference = await this.ports.fileReference(filePath);
    return this.apply(treePath, "invalid-operation", (draft) => {
      const node = draft.nodes[nodeId];
      if (!node) throw this.nodeNotFound(nodeId);
      // The interactive association refuses a node that already carries an
      // association; a tool must not stack a second one on top.
      if (node.resource || node.nodeLink) throw this.associationRefused();
      node.resource = structuredClone(reference);
      // Deliberately NOT the interactive default: filename sync can later rename
      // (move) the user's existing file, and a link tool must never schedule a
      // file move the client did not ask for.
      node.titleSync = "off";
      return nodeId;
    });
  }

  async unlinkFile(treePath: string, nodeId: NodeId): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      const node = draft.nodes[nodeId];
      if (!node) throw this.nodeNotFound(nodeId);
      // Removing an absent resource is a no-op, like every other tree command;
      // the returned node view reports the node's real state either way.
      delete node.resource;
      delete node.titleSync;
      return nodeId;
    });
  }

  async linkNode(treePath: string, sourceId: NodeId, targetId: NodeId): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      if (!draft.nodes[sourceId]) throw this.nodeNotFound(sourceId);
      if (!draft.nodes[targetId]) throw this.nodeNotFound(targetId);
      try {
        createNodeLink(draft, sourceId, targetId);
      } catch (error) {
        if (error instanceof NodeLinkError) throw this.describeNodeLinkError(error, sourceId, targetId);
        throw error;
      }
      return sourceId;
    });
  }

  async unlinkNode(treePath: string, sourceId: NodeId): Promise<MindTreeWriteOutcome> {
    return this.apply(treePath, "invalid-operation", (draft) => {
      if (!draft.nodes[sourceId]) throw this.nodeNotFound(sourceId);
      removeNodeLinks(draft, sourceId);
      return sourceId;
    });
  }

  /**
   * Creates a new tree through the one shared creation path, without focus.
   *
   * No permission check here: this class is only ever reachable through the
   * write server, which is not listening unless the user enabled it. The
   * boundary is the server split, not a per-tool switch.
   */
  async createTree(input: { title: string; folder?: string; children?: readonly string[] }): Promise<McpCreatedTree> {
    const created = await this.ports.creation.create({
      title: input.title,
      ...(input.folder !== undefined ? { folderPath: input.folder } : {}),
      ...(input.children ? { children: input.children } : {}),
      // Focus stealing is forbidden for a tool call: the user may be typing.
      focus: false
    });
    return {
      path: created.path,
      ...(created.documentId ? { documentId: created.documentId } : {}),
      rootId: created.rootId,
      childIds: created.childIds
    };
  }

  /**
   * The single guarded write boundary every command goes through.
   *
   * The command runs *inside* the compare-and-set callback: the baseline check,
   * the tree command and the serialisation are one synchronous step, so no view
   * mutation or second writer can slip between them.
   */
  private async apply(
    treePath: string,
    fallback: McpToolErrorCode,
    run: (document: MindTreeDocument) => NodeId
  ): Promise<{ path: string; document: MindTreeDocument; nodeId: NodeId }> {
    const path = canonicalTreePath(treePath);
    if (!isMindTreePath(path) || !this.ports.fileExists(path)) {
      throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target: path }));
    }
    const session = this.ports.sessions.acquire(path);
    try {
      await this.initialize(session, path);
      return await session.history.runExclusiveWrite(async () => {
        if (session.mutationLocked) throw this.conflictLocked();
        if (session.commitEditorBeforeMutation(HEADLESS_ORIGIN) === "rejected") throw this.conflictLocked();
        const current = session.document;
        if (!current) throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target: path }));
        const baseline = session.history.sourceBaseline || session.source;
        const revision = session.history.currentRevision;
        const options = this.ports.parseOptions();

        let serialized: string | undefined;
        let next: MindTreeDocument | undefined;
        let commandNodeId: NodeId | undefined;
        let refusal: Refusal | undefined;
        try {
          await this.ports.process(path, (latest) => {
            const assessment = assessExternalVersion(baseline, session.document ?? current, latest, options);
            if (assessment.kind !== "unchanged") {
              // `choose` means a real external edit, `blocked` means an identity
              // or format problem. Both end the attempt; neither may be forced.
              refusal = { kind: "conflict" };
              return latest;
            }
            try {
              const draft = session.history.execute(assessment.document, (draftDocument) => {
                commandNodeId = run(draftDocument);
              });
              serialized = serializeMindTreeFile(draft, latest);
              next = draft;
              // The vault modify event this write raises must not be mistaken
              // for someone else's edit by an attached view's external check.
              session.beginWrite(serialized);
              return serialized;
            } catch (error) {
              refusal = { kind: "error", error };
              return latest;
            }
          });
        } finally {
          if (serialized !== undefined) session.endWrite(serialized);
        }

        if (refusal?.kind === "conflict") {
          this.ports.notifyExternalChange(path);
          throw new McpToolError("save-conflict", t("mcp.error.saveConflict"));
        }
        if (refusal?.kind === "error") throw this.toToolError(refusal.error, fallback);
        if (serialized === undefined || next === undefined) {
          // Defensive: the callback either produced bytes or recorded a refusal.
          throw new McpToolError("save-conflict", t("mcp.error.saveConflict"));
        }

        const verifiedSource = await this.ports.read(path);
        if (!this.verifies(serialized, verifiedSource, options)) {
          // Someone wrote between our write and our read-back. The in-memory
          // document stays unpublished: never present unverified bytes as saved.
          this.ports.notifyExternalChange(path);
          throw new McpToolError("file-changed", t("mcp.error.fileChanged"));
        }

        // Only now is the write real: publish it to every attached view.
        session.history.markSaved(revision, verifiedSource);
        session.replaceDocument(next, HEADLESS_ORIGIN);
        session.replaceSource(verifiedSource, HEADLESS_ORIGIN);
        return { path, document: next, nodeId: commandNodeId ?? next.rootId };
      });
    } finally {
      // A session nobody else uses is dropped again; a session an open view owns
      // is left alone, and a locked one is kept so its conflict can be resolved.
      this.ports.sessions.releaseSession(session, HEADLESS_ORIGIN);
    }
  }

  /** A tool must not start from a half-loaded session with no document. */
  private async initialize(session: SharedMindTreeSession, path: string): Promise<void> {
    if (session.initialized) return;
    const source = await this.ports.read(path);
    try {
      const document = parseMindTreeFile(source, this.ports.parseOptions()).document;
      session.initialize(document, source);
    } catch (error) {
      session.initialize(undefined, source, error instanceof Error ? error.message : String(error));
      throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target: path }));
    }
  }

  private verifies(serialized: string, verifiedSource: string, options: Readonly<ParseMindTreeOptions>): boolean {
    try {
      return sameManagedMindTreeSnapshot(
        createManagedMindTreeSnapshot(serialized, options),
        createManagedMindTreeSnapshot(verifiedSource, options)
      );
    } catch {
      // Invalid or future data on disk must never count as a verified write.
      return false;
    }
  }

  private toToolError(error: unknown, fallback: McpToolErrorCode): McpToolError {
    if (error instanceof McpToolError) return error;
    // A locked session is never a generic failure: the client has to stop and
    // let the user resolve the pending version first.
    if (error instanceof SaveConflictError) return this.conflictLocked();
    return normalizeToolError(error, fallback);
  }

  private describeNodeLinkError(error: NodeLinkError, sourceId: NodeId, targetId: NodeId): McpToolError {
    switch (error.code) {
      case "missing-source": return this.nodeNotFound(sourceId);
      case "missing-target": return this.nodeNotFound(targetId);
      case "source-has-resource":
        return new McpToolError("invalid-operation", t("notice.nodeLinkBlockedByResource"));
      case "self":
      case "source-linked":
        return new McpToolError("invalid-operation", t("notice.associationTargetChanged"));
    }
  }

  private conflictLocked(): McpToolError {
    return new McpToolError("conflict-locked", t("mcp.error.conflictLocked"));
  }

  private nodeNotFound(nodeId: NodeId): McpToolError {
    return new McpToolError("node-not-found", t("mcp.error.nodeNotFound", { nodeId }));
  }

  private nodeLimit(): McpToolError {
    return new McpToolError("node-limit", t("mcp.error.nodeLimit", { max: MAX_MIND_TREE_NODES }));
  }

  private depthLimit(): McpToolError {
    return new McpToolError("depth-limit", t("mcp.error.depthLimit", { max: MAX_MIND_TREE_DEPTH }));
  }

  private invalidTitle(): McpToolError {
    return new McpToolError("invalid-arguments", t("mcp.error.invalidArguments", { detail: "title" }));
  }

  private associationRefused(): McpToolError {
    return new McpToolError("invalid-operation", t("notice.associationTargetChanged"));
  }
}
