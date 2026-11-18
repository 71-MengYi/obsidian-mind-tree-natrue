import { Notice, type App } from "obsidian";
import { t } from "../../i18n";
import {
  addNode,
  collectBranchIds,
  deleteBranches,
  deleteNodesOnly,
  findParentId,
  getNode,
  getTopLevelSelectedNodeIds,
  insertParentNode,
  moveNodeAmongSiblings,
  setAllCollapsed
} from "../../domain/tree";
import type { FileResourceRef, MindTreeDocument, NodeId } from "../../types";
import { DeleteBranchModal, type DeleteBranchAction } from "../modals/delete-branch-modal";

/**
 * Everything the node structure/delete commands need from the view. Getters
 * return live view state so a session switch, selection change or node deletion
 * observed after an `await` still invalidates the command, exactly like the
 * original inline methods.
 */
export interface NodeOpsHost {
  getDocument(): MindTreeDocument | undefined;
  getPrimarySelectedId(): NodeId | undefined;
  getSelectedIds(): ReadonlySet<NodeId>;
  /** Changes whenever TextFileView replaces the loaded document snapshot. */
  getDocumentSessionToken(): string;
  mutationLocked(): boolean;
  /**
   * The view's single mutation path: commit the visible editor draft, create
   * one undo step, prune selection, reflow around `anchorNodeId`, mark dirty.
   */
  commit(mutator: (draft: MindTreeDocument) => void, anchorNodeId?: NodeId): void;
  selectOnly(nodeId: NodeId): void;
  beginEdit(nodeId: NodeId): void;
  centerNodeInViewport(nodeId: NodeId): void;
  getApp(): App;
  /** Real file removal stays in the resource service; only success is observed here. */
  trashLinkedFile(resource: FileResourceRef): Promise<unknown>;
}

/**
 * Node structure and delete-dialog commands, extracted verbatim from the view.
 * Every mutation still runs through the host's `commit` callback, so undo
 * anchors, selection pruning, render order and save scheduling are unchanged.
 */
export class NodeOps {
  constructor(private readonly host: NodeOpsHost) {}

  addChildNode(): void {
    if (this.host.mutationLocked()) return;
    const document = this.host.getDocument();
    if (!document) return;
    const primarySelectedId = this.host.getPrimarySelectedId();
    const parentId = primarySelectedId && document.nodes[primarySelectedId]
      ? primarySelectedId
      : document.rootId;
    let createdId = "";
    this.host.commit((draft) => { createdId = addNode(draft, parentId, t("node.untitled")).id; });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** Enter variants insert a sibling immediately above or below the selection. */
  addSiblingNode(position: "before" | "after"): void {
    const document = this.host.getDocument();
    const nodeId = this.host.getPrimarySelectedId();
    if (!document || !nodeId || nodeId === document.rootId) return;
    const parentId = findParentId(document, nodeId);
    if (!parentId) return;
    const siblingIndex = getNode(document, parentId).childIds.indexOf(nodeId);
    let createdId = "";
    this.host.commit((draft) => {
      createdId = addNode(draft, parentId, t("node.untitled"), siblingIndex + (position === "after" ? 1 : 0)).id;
    });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** Shift+Tab inserts a structural parent and also supports replacing the root. */
  addParentNode(): void {
    const document = this.host.getDocument();
    const nodeId = this.host.getPrimarySelectedId();
    if (!document || !nodeId) return;
    let createdId = "";
    this.host.commit((draft) => { createdId = insertParentNode(draft, nodeId, t("node.untitled")).id; });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** New nodes are the only structural edits that intentionally recenter the canvas. */
  finishInteractiveNodeCreation(nodeId: NodeId): void {
    if (!this.host.getDocument()?.nodes[nodeId]) return;
    this.host.selectOnly(nodeId);
    this.host.beginEdit(nodeId);
    this.host.centerNodeInViewport(nodeId);
  }

  /** Reorder only the primary selection; other selected nodes remain selected. */
  moveSelectedAmongSiblings(direction: "up" | "down"): void {
    const document = this.host.getDocument();
    const nodeId = this.host.getPrimarySelectedId();
    if (!document || !nodeId || nodeId === document.rootId) return;
    const parentId = findParentId(document, nodeId);
    if (!parentId) return;
    const siblings = getNode(document, parentId).childIds;
    const index = siblings.indexOf(nodeId);
    const targetIndex = index + (direction === "up" ? -1 : 1);
    // Check before commit so hitting a list boundary does not dirty the file or
    // consume an undo slot even though the browser shortcut is still suppressed.
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    this.host.commit((draft) => { moveNodeAmongSiblings(draft, nodeId, direction); });
  }

  /** Expand or recursively collapse every selected top-level branch as one undo step. */
  setSelectedBranchesCollapsed(collapsed: boolean): void {
    const document = this.host.getDocument();
    if (!document) return;
    const branchRoots = this.getSelectedBranchRoots();
    const primarySelectedId = this.host.getPrimarySelectedId();
    const anchorNodeId = primarySelectedId && document.nodes[primarySelectedId]
      ? primarySelectedId
      : document.rootId;
    this.host.commit((draft) => {
      for (const branchRootId of branchRoots) setAllCollapsed(draft, branchRootId, collapsed);
    }, anchorNodeId);
  }

  requestDeleteBranch(nodeId: NodeId): void {
    if (this.host.mutationLocked()) return;
    const document = this.host.getDocument();
    if (!document) return;
    const selectedIds = this.host.getSelectedIds();
    const targetNodeIds = getTopLevelSelectedNodeIds(document, selectedIds.has(nodeId) ? selectedIds : [nodeId]);
    const topicNodeIds = targetNodeIds.flatMap((id) => collectBranchIds(document, id));
    if (targetNodeIds.length > 0) this.openDeleteDialog(targetNodeIds, topicNodeIds, "branch");
  }

  /** Return the de-duplicated topic union represented by the current selection. */
  getSelectedBranchNodeIds(nodeId: NodeId): NodeId[] {
    const document = this.host.getDocument();
    if (!document) return [];
    const selectedIds = this.host.getSelectedIds();
    const roots = getTopLevelSelectedNodeIds(document, selectedIds.has(nodeId) ? selectedIds : [nodeId]);
    return roots.flatMap((id) => collectBranchIds(document, id));
  }

  /** The node-only menu action uses the same safety dialog but promotes children. */
  requestDeleteNodeOnly(nodeId: NodeId): void {
    const document = this.host.getDocument();
    if (!document || nodeId === document.rootId) return;
    const selectedIds = this.host.getSelectedIds();
    const targetNodeIds = [...new Set(selectedIds.has(nodeId) ? selectedIds : [nodeId])]
      .filter((id) => id !== document.rootId && Boolean(document.nodes[id]));
    if (targetNodeIds.length > 0) this.openDeleteDialog(targetNodeIds, targetNodeIds, "node-only");
  }

  /** Execute the dialog choice; real files are moved through Obsidian's trash. */
  async executeDeleteBranch(
    targetNodeIds: NodeId[],
    topicNodeIds: NodeId[],
    resources: FileResourceRef[],
    action: DeleteBranchAction,
    structureMode: "branch" | "node-only"
  ): Promise<void> {
    if (this.host.mutationLocked()) return;
    const token = this.host.getDocumentSessionToken();
    if (action === "topics-only") {
      this.deleteTopics(targetNodeIds, structureMode);
      return;
    }

    const deletedResourceIds = new Set<string>();
    const failedPaths: string[] = [];
    for (const resource of resources) {
      if (this.host.mutationLocked() || token !== this.host.getDocumentSessionToken()) return;
      try {
        await this.host.trashLinkedFile(resource);
        deletedResourceIds.add(resource.resourceId);
      } catch {
        failedPaths.push(resource.pathHint);
      }
    }

    if (this.host.mutationLocked() || token !== this.host.getDocumentSessionToken()) return;
    if (action === "topics-and-files") {
      this.deleteTopics(targetNodeIds, structureMode);
    } else if (deletedResourceIds.size > 0) {
      // Keeping topics means their now-deleted files must also be unlinked; a
      // stale resource reference would misleadingly look like a sync failure.
      this.host.commit((draft) => {
        for (const id of topicNodeIds) {
          const node = draft.nodes[id];
          if (node?.resource?.type !== "file" || !deletedResourceIds.has(node.resource.resourceId)) continue;
          delete node.resource;
          delete node.titleSync;
        }
      });
    }

    if (failedPaths.length > 0) {
      new Notice(t("notice.deleteFilesFailed", {
        count: failedPaths.length,
        paths: failedPaths.join(", ")
      }));
    }
  }

  /** Delete all selected structures in one undo step and keep a surviving parent selected. */
  deleteTopics(targetNodeIds: NodeId[], structureMode: "branch" | "node-only"): void {
    const document = this.host.getDocument();
    if (!document || targetNodeIds.length === 0) return;
    const primarySelectedId = this.host.getPrimarySelectedId();
    const anchorId = targetNodeIds.find((id) => id === primarySelectedId)
      ?? targetNodeIds.find((id) => primarySelectedId && collectBranchIds(document, id).includes(primarySelectedId))
      ?? targetNodeIds[0];
    const affected = new Set(structureMode === "branch"
      ? targetNodeIds.flatMap((id) => collectBranchIds(document, id))
      : targetNodeIds);
    let parentId = anchorId ? findParentId(document, anchorId) : undefined;
    while (parentId && affected.has(parentId)) parentId = findParentId(document, parentId);
    const nextSelectionId = parentId ?? document.rootId;
    this.host.commit((draft) => {
      if (structureMode === "branch") deleteBranches(draft, targetNodeIds);
      else deleteNodesOnly(draft, targetNodeIds);
    });
    const current = this.host.getDocument();
    const finalSelectionId = current?.nodes[nextSelectionId] ? nextSelectionId : current?.rootId;
    if (finalSelectionId) this.host.selectOnly(finalSelectionId);
  }

  /**
   * Resolve toolbar branch actions against the complete selection. When the
   * root participates it represents the whole tree; otherwise nested selected
   * nodes are removed because their ancestor branch already covers them.
   */
  private getSelectedBranchRoots(): NodeId[] {
    const document = this.host.getDocument();
    if (!document) return [];
    const selected = [...this.host.getSelectedIds()].filter((nodeId) => Boolean(document.nodes[nodeId]));
    if (selected.includes(document.rootId)) return [document.rootId];
    const roots = getTopLevelSelectedNodeIds(document, selected);
    return roots.length > 0 ? roots : [document.rootId];
  }

  private openDeleteDialog(
    targetNodeIds: NodeId[],
    topicNodeIds: NodeId[],
    structureMode: "branch" | "node-only"
  ): void {
    const document = this.host.getDocument();
    if (!document) return;
    const topicTitles = topicNodeIds.map((id) => document.nodes[id]?.title || t("node.untitled"));
    const linkedFiles = new Map<string, FileResourceRef>();
    for (const id of topicNodeIds) {
      const resource = document.nodes[id]?.resource;
      // Count a multiply-linked file once because the vault can only delete it
      // once; all matching node references are still cleared for files-only.
      if (resource?.type === "file") linkedFiles.set(resource.resourceId, { ...resource });
    }
    const resources = [...linkedFiles.values()];
    const token = this.host.getDocumentSessionToken();
    new DeleteBranchModal(
      this.host.getApp(),
      { topicTitles, filePaths: resources.map((resource) => resource.pathHint) },
      (action) => {
        if (token !== this.host.getDocumentSessionToken() || this.host.mutationLocked()) return;
        void this.executeDeleteBranch(targetNodeIds, topicNodeIds, resources, action, structureMode);
      }
    ).open();
  }
}
