import {
  Menu,
  normalizePath,
  Notice,
  Platform,
  Scope,
  setIcon,
  TextFileView,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import {
  addNode,
  addSibling,
  cloneDocument,
  collectBranchIds,
  createId,
  deleteBranches,
  deleteNodesOnly,
  findParentId,
  getNode,
  getTopLevelSelectedNodeIds,
  getTreeStatistics,
  insertBranches,
  insertParentNode,
  moveNodeAmongSiblings,
  moveNodes,
  renameNode,
  setAllCollapsed,
  setCollapsedAfterDepth,
  toggleCollapsed
} from "../domain/tree";
import {
  getNodeHighlightColor,
  getNodeMarkerDisplayWidth,
  getVisibleNodeMarkers,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker
} from "../domain/markers";
import { MindTreeFormatError, parseMindTreeFile, serializeMindTreeFile } from "../format/document";
import { buildLinkedResourcePath, linkedFileTitle } from "../format/resource-id";
import { renderBranchMarkdown } from "../format/outline";
import { t } from "../i18n";
import {
  copyBranches,
  resolveMarkdownBranchLinks,
  type ClipboardPasteContent
} from "../services/clipboard";
import { downloadMarkdown, exportBranchPng, type ExportThemeColors } from "../services/export";
import { reconcileLinkedFileReferences } from "../services/linked-resource-sync";
import { DuplicateResourceIdError } from "../services/resource-index";
import {
  DocumentSession,
  SaveConflictError,
  changesOnlyGeneratedOutline,
  createRecoveryDocument
} from "../services/document-session";
import {
  classifyDirectTextPaste,
  parseTextImport,
  type DirectTextPaste,
  type TextImportRule
} from "../services/text-import";
import type {
  BranchClipboardPayload,
  DropPosition,
  FileResourceRef,
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeDocumentSettings,
  MindTreeLayoutMode,
  MindTreeNode,
  MindTreeNodeShape,
  MindTreeTheme,
  NodeId,
  PositionedNode
} from "../types";
import { MIND_TREE_VIEW_TYPE } from "../view-routing";
import type MindTreeNaturePlugin from "../main";
import {
  centerDragGhostAtPointer,
  resolveDropPlacement,
  type DropNodeRect,
  type DropPlacement
} from "./drop-placement";
import { DragDropController, extractVaultPathCandidates } from "./file-drop";
import { resolveFoldDirections, type FoldDirection } from "./fold-direction";
import { CHAIN_BROKEN_ICON, SHARE_SQUARE_ICON } from "./icons";
import {
  resolveArrowNavigationTarget,
  shouldHandleStructuralCreationKey,
  type NavigationArrow
} from "./keyboard-navigation";
import { openMarkerPopover, type MarkerPopoverHandle } from "./marker-popover";
import { shouldHandleMindTreePaste } from "./paste-routing";
import { ClipboardController } from "./clipboard-controller";
import {
  connectionPath,
  getNodeSizeClass,
  layoutTree,
  type TreeLayout
} from "./layout";
import {
  branchColorCss,
  COLLECTION_MODE_OPTIONS,
  CONNECTION_OPTIONS,
  getBranchColorSlots,
  LAYOUT_OPTIONS,
  NODE_SHAPE_OPTIONS,
  THEME_OPTIONS
} from "./presentation";
import { resolveThemeConnection } from "./theme-presets";
import {
  DEFAULT_VIEWPORT,
  centerViewportOnRect,
  panViewportByWheel,
  preserveViewportPointAfterLayout,
  wheelDeltaToPixels,
  ZOOM_STEP,
  zoomViewportAt,
  viewportToCssPresentation,
  type ViewportState
} from "./viewport";
import {
  DeleteBranchModal,
  confirmLargeExternalFiles,
  FileSuggestModal,
  SameFolderCandidatesModal,
  TextImportModal,
  TextPromptModal,
  TemplateSuggestModal,
  UrlPromptModal,
  MoveNotesModal,
  SaveConflictModal,
  type CandidateAction,
  type DeleteBranchAction,
  type SaveConflictAction
} from "./modals";

interface PointerGesture {
  mode: "marquee" | "pan";
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  additive: boolean;
  moved: boolean;
  /** Snapshot used to make Ctrl/Cmd marquee a live union, not cumulative drift. */
  selectionBeforeMarquee?: Set<NodeId>;
  primaryBeforeMarquee?: NodeId;
}

interface NodeDragState {
  nodeId: NodeId;
  draggedRootIds: NodeId[];
  startX: number;
  startY: number;
  renderedWidth: number;
  renderedHeight: number;
  dragging: boolean;
  targetId?: NodeId;
  position?: DropPosition;
  ghostEl?: HTMLElement;
}

interface ViewSettingChoice<T extends string | number> {
  value: T;
  label: string;
}

/** A visible node center captured before a layout pass changes world coordinates. */
interface LayoutViewportAnchor {
  nodeId: NodeId;
  x: number;
  y: number;
}

interface ViewSaveConflict {
  externalSource: string;
  recoveryPath: string;
}

interface PasteInsertionContext {
  parentId: NodeId;
  documentSessionToken: string;
}

/**
 * Canvas navigation belongs to this view session, not to the mind-tree file.
 * Keeping it outside MindTreeDocument prevents pan and zoom gestures from
 * polluting undo snapshots or making an otherwise unchanged file dirty.
 */
export class MindTreeView extends TextFileView {
  private document?: MindTreeDocument;
  /** Changes whenever TextFileView replaces the loaded document snapshot. */
  private documentSessionToken = createId();
  private sourceData = "";
  private readonly documentSession = new DocumentSession();
  private readonly clipboardController: ClipboardController<PasteInsertionContext>;
  private readonly dragDropController = new DragDropController();
  /** Exact snapshot returned to TextFileView while one queued write is active. */
  private pendingSerializedSource?: string;
  private saveConflict?: ViewSaveConflict;
  private conflictPreparation?: Promise<void>;
  private conflictModal?: SaveConflictModal;
  private acceptingConflictSource = false;
  private parseError?: string;
  private readonly selectedIds = new Set<NodeId>();
  private primarySelectedId?: NodeId;
  private editingNodeId?: NodeId;
  private editingOriginalTitle = "";
  private editingSelectionMode: "all" | "end" = "all";
  private saveTimer?: number;
  private viewport: ViewportState = { ...DEFAULT_VIEWPORT };
  /** Last pointer position over the canvas, used by toolbar +/- zoom actions. */
  private zoomAnchor?: { clientX: number; clientY: number };
  private scannedFilePath?: string;
  /** Current outward fold-control side, derived afresh from each visible layout. */
  private foldDirectionByNodeId = new Map<NodeId, FoldDirection>();

  private rootEl!: HTMLElement;
  private viewMenuEl!: HTMLElement;
  private settingsButtonEl!: HTMLButtonElement;
  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private bottomBarEl!: HTMLElement;
  private topicCountEl!: HTMLElement;
  private noteCountEl!: HTMLElement;
  private treeDepthEl!: HTMLElement;
  private saveButtonEl!: HTMLButtonElement;
  private scanFolderButtonEl!: HTMLButtonElement;
  private undoButtonEl!: HTMLButtonElement;
  private redoButtonEl!: HTMLButtonElement;
  private saveState: "saved" | "dirty" | "error" = "saved";
  private canvasEl!: HTMLElement;
  private panLayerEl!: HTMLElement;
  private worldEl!: HTMLElement;
  private connectionsEl!: SVGSVGElement;
  private nodeLayerEl!: HTMLElement;
  private marqueeEl!: HTMLElement;
  private currentLayout?: TreeLayout;
  /** Cached first-level branch palette assignment shared by nodes and edges. */
  private branchColorSlotByNodeId = new Map<NodeId, number>();
  private pointerGesture?: PointerGesture;
  private editingLayoutFrame?: number;
  private pendingEditingLayout?: { nodeId: NodeId; title: string };
  /** Removes owner-window listeners if the view closes during a node drag. */
  private activePointerCleanup?: () => void;
  private fileDropTargetEl?: HTMLElement;
  private fileDropPlacement?: DropPlacement;
  private markerPopover?: MarkerPopoverHandle;
  private cutInProgress = false;
  private suppressContextMenu = false;
  private dropTargetEl?: HTMLElement;
  /**
   * File path captured at the start of onLoadFile. getDisplayText must never
   * call leaf.getViewState(): Obsidian builds that state by calling the view's
   * display-title methods, so doing so would recurse until the stack overflows.
   */
  private displayFilePath?: string;
  /** Hide the world until a newly opened file has its root-centered viewport. */
  private initialRootCenterPending = true;

  constructor(leaf: WorkspaceLeaf, readonly plugin: MindTreeNaturePlugin) {
    super(leaf);
    this.clipboardController = new ClipboardController(
      async () => {
        const clipboard = this.rootEl.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard?.readText) throw new Error("Clipboard text reading is unavailable.");
        return clipboard.readText();
      },
      () => new Notice(t("notice.clipboardReadFailed"))
    );
    // Obsidian already owns common Mod shortcuts globally. A view scope gets
    // first refusal while this leaf is active, so view-specific commands do not
    // depend on which canvas descendant currently holds DOM focus.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "e", (event) => {
      // Depending on Obsidian's event phase, the canvas handler may already have
      // consumed this same keydown. The guard prevents duplicate notes/notices.
      if (event.defaultPrevented || isTextEditingTarget(event.target) || !this.createNoteForSelection()) return;
      event.preventDefault();
      return false;
    });
    this.scope.register(["Mod"], "s", (event) => {
      // Saving is also allowed while a node title editor has focus. In that
      // case saveImmediately commits the visible draft before serialization.
      if (event.defaultPrevented || !this.document || this.parseError) return;
      event.preventDefault();
      void this.saveImmediately();
      return false;
    });
    this.scope.register(["Mod"], "x", (event) => {
      // Keep native text-field cutting intact. For the focused canvas, copying
      // must finish before the source nodes are removed from the document.
      if (event.defaultPrevented || isTextEditingTarget(event.target) || !this.primarySelectedId) return;
      event.preventDefault();
      void this.cutSelected();
      return false;
    });
  }

  getViewType(): string { return MIND_TREE_VIEW_TYPE; }
  /** Use only view-owned state: querying the leaf here causes host recursion. */
  getDisplayText(): string {
    const path = this.file?.path ?? this.displayFilePath;
    return path ? linkedFileTitle(path) : this.document?.title ?? "";
  }
  getIcon(): string { return "git-fork"; }

  async onOpen(): Promise<void> {
    await super.onOpen();
    this.buildShell();
    this.render();
  }

  async onClose(): Promise<void> {
    this.markerPopover?.close();
    this.conflictModal?.close();
    const ownerWindow = this.ownerWindow();
    if (this.saveTimer !== undefined) ownerWindow.clearTimeout(this.saveTimer);
    if (this.editingLayoutFrame !== undefined) ownerWindow.cancelAnimationFrame(this.editingLayoutFrame);
    this.activePointerCleanup?.();
    // Closing a view that was only panned or zoomed must not rewrite the file.
    if (this.document && this.file && this.documentSession.dirty) {
      try {
        await this.save();
      } catch (error) {
        if (!(error instanceof SaveConflictError)) throw error;
      }
    }
    await super.onClose();
  }

  async onLoadFile(file: TFile): Promise<void> {
    // File loading may render synchronously inside super.onLoadFile. Mark the
    // viewport first so no frame can reuse the previous file's pan/zoom.
    this.displayFilePath = file.path;
    this.initialRootCenterPending = true;
    this.rootEl?.addClass("is-initializing-viewport");
    this.selectedIds.clear();
    this.primarySelectedId = undefined;
    this.editingNodeId = undefined;
    await super.onLoadFile(file);
    // Keep the cache current even if the host replaced the TFile instance while
    // loading. Once attached, this.file remains the authoritative rename source.
    this.displayFilePath = this.file?.path ?? file.path;
    // setViewData normally sees this.file, but synchronizing again here covers
    // host/plugin load orders where the file is attached only after parsing.
    this.applySystemMutation((draft) => this.synchronizeDocumentTitleWithFile(draft, file));
    // setViewData can render before TextFileView attaches this.file. Refresh the
    // manual-scan availability now that the backing file is authoritative.
    this.refreshBottomStatusBar();
    this.ownerWindow().setTimeout(() => void this.scanSameFolder(file), 250);
  }

  override async save(_clear = false): Promise<void> {
    await this.documentSession.requestSave(() => this.performQueuedSave());
  }

  getViewData(): string {
    if (this.pendingSerializedSource !== undefined) return this.pendingSerializedSource;
    if (!this.document || this.parseError) return this.sourceData || this.data;
    return serializeMindTreeFile(this.document, this.documentSession.sourceBaseline || this.sourceData);
  }

  /**
   * Persist exactly one document revision. Vault.process performs the baseline
   * comparison and write under the same per-file lock, closing the race where
   * another editor changes the file between an ordinary read and modify call.
   */
  private async performQueuedSave(): Promise<boolean> {
    let document = this.document;
    const file = this.file;
    if (!document || !file || this.parseError) {
      return false;
    }
    if (this.saveConflict) throw new SaveConflictError();

    // Resource metadata is corrected at the save boundary as well as on file
    // events. Record that mutation as a revision so a concurrent later edit is
    // never accidentally reported as already saved.
    if (this.applySystemMutation(
      (draft) => this.reconcileLinkedResources(draft),
      document.rootId,
      false
    )) document = this.document!;

    const revision = this.documentSession.currentRevision;
    const baseline = this.documentSession.sourceBaseline || this.sourceData;
    const serialized = serializeMindTreeFile(cloneDocument(document), baseline);
    const wasDirty = this.documentSession.dirty;
    let conflictingSource: string | undefined;
    this.pendingSerializedSource = serialized;
    try {
      await this.app.vault.process(file, (diskSource) => {
        if (diskSource !== baseline && !changesOnlyGeneratedOutline(baseline, diskSource)) {
          conflictingSource = diskSource;
          return diskSource;
        }
        return serialized;
      });
    } finally {
      this.pendingSerializedSource = undefined;
    }

    if (conflictingSource !== undefined) {
      // A clean view has nothing to recover or overwrite. Accept the external
      // source directly; conflicts are only meaningful when local work exists.
      if (!wasDirty && !this.documentSession.dirty) {
        this.acceptingConflictSource = true;
        try { this.setViewData(conflictingSource, false); }
        finally { this.acceptingConflictSource = false; }
        return false;
      }
      await this.prepareSaveConflict(conflictingSource);
      throw new SaveConflictError();
    }

    this.sourceData = serialized;
    this.data = serialized;
    this.documentSession.markSaved(revision, serialized);
    if (this.documentSession.dirty) {
      this.setStatus(t("status.unsaved"), "dirty");
      return true;
    }
    this.setStatus(t("status.saved"), "saved");
    return false;
  }

  /** Create one durable recovery copy before exposing conflict choices. */
  private async prepareSaveConflict(externalSource: string): Promise<void> {
    if (this.saveConflict?.externalSource === externalSource) {
      this.openSaveConflictModal();
      return;
    }
    if (this.conflictPreparation) {
      await this.conflictPreparation;
      if (this.saveConflict?.externalSource !== externalSource) {
        this.saveConflict = undefined;
        return this.prepareSaveConflict(externalSource);
      }
      return;
    }
    this.conflictPreparation = (async () => {
      const recoveryPath = await this.createRecoveryCopy();
      this.saveConflict = { externalSource, recoveryPath };
      this.setStatus(t("status.saveConflict"), "warning");
      this.openSaveConflictModal();
    })().finally(() => { this.conflictPreparation = undefined; });
    return this.conflictPreparation;
  }

  /** Recovery files intentionally omit link identity to avoid duplicate owners. */
  private async createRecoveryCopy(): Promise<string> {
    const file = this.file;
    const document = this.document;
    if (!file || !document) throw new Error("No mind tree is available for recovery.");
    const recoveryDocument = createRecoveryDocument(document);
    const source = serializeMindTreeFile(recoveryDocument, this.documentSession.sourceBaseline || this.sourceData);
    const parentPath = file.parent?.path ?? "";
    const recoveryFolder = normalizePath([
      parentPath,
      "_Mind Tree Recovery",
      recoveryTimestamp()
    ].filter(Boolean).join("/"));
    await this.ensureVaultFolder(recoveryFolder);
    let recoveryPath = normalizePath(`${recoveryFolder}/${file.name}`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(recoveryPath)) {
      const extension = file.extension ? `.${file.extension}` : "";
      recoveryPath = normalizePath(`${recoveryFolder}/${file.basename}-${suffix}${extension}`);
      suffix += 1;
    }
    await this.app.vault.create(recoveryPath, source);
    return recoveryPath;
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    let current = "";
    for (const segment of normalizePath(folderPath).split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  private openSaveConflictModal(): void {
    const conflict = this.saveConflict;
    if (!conflict || this.conflictModal) return;
    this.conflictModal = new SaveConflictModal(this.app, conflict.recoveryPath, (action) => {
      this.conflictModal = undefined;
      void this.resolveSaveConflict(action).catch((error: unknown) => {
        if (error instanceof SaveConflictError) {
          this.setStatus(t("status.saveConflict"), "warning");
          return;
        }
        this.setStatus(t("status.saveFailed", {
          message: error instanceof Error ? error.message : String(error)
        }), "error");
      });
    });
    this.conflictModal.open();
  }

  private async resolveSaveConflict(action: SaveConflictAction): Promise<void> {
    const conflict = this.saveConflict;
    if (!conflict) return;
    if (action === "later") {
      this.setStatus(t("status.saveConflict"), "warning");
      return;
    }
    if (action === "open-recovery") {
      const recovery = this.app.vault.getAbstractFileByPath(conflict.recoveryPath);
      if (recovery instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(recovery, { active: true });
      this.setStatus(t("status.saveConflict"), "warning");
      return;
    }
    if (action === "external") {
      this.saveConflict = undefined;
      this.documentSession.clearHistory();
      this.acceptingConflictSource = true;
      try { this.setViewData(conflict.externalSource, false); }
      finally { this.acceptingConflictSource = false; }
      return;
    }

    const file = this.file;
    if (!file) return;
    const latestDiskSource = await this.app.vault.read(file);
    if (latestDiskSource !== conflict.externalSource) {
      this.saveConflict = undefined;
      await this.prepareSaveConflict(latestDiskSource);
      throw new SaveConflictError();
    }
    // The explicit overwrite decision applies only to the version shown by the
    // dialog. Adopt it as the comparison baseline, then enqueue the local state.
    this.saveConflict = undefined;
    this.sourceData = latestDiskSource;
    this.data = latestDiskSource;
    this.documentSession.replaceBaseline(latestDiskSource);
    await this.save();
  }

  setViewData(data: string, clear: boolean): void {
    if (!clear && data === this.documentSession.sourceBaseline) {
      this.sourceData = data;
      this.data = data;
      return;
    }
    if (!clear && this.document && !this.acceptingConflictSource && this.documentSession.dirty) {
      if (data === this.pendingSerializedSource) {
        this.sourceData = data;
        this.data = data;
        this.documentSession.replaceBaseline(data);
        return;
      }
      // A redundant reload of the accepted disk baseline must not replace a
      // newer in-memory document that is still waiting to be saved.
      if (data === this.documentSession.sourceBaseline) return;
      if (changesOnlyGeneratedOutline(this.documentSession.sourceBaseline, data)) {
        this.sourceData = data;
        this.data = data;
        this.documentSession.replaceBaseline(data);
        this.scheduleSave();
        return;
      }
      void this.prepareSaveConflict(data).catch((error: unknown) => {
        this.setStatus(t("status.recoveryFailed", {
          message: error instanceof Error ? error.message : String(error)
        }), "error");
      });
      return;
    }
    // Async link resolution must never use an optional persisted documentId as
    // a view-instance guard: two fresh unlinked trees both have no such ID.
    this.documentSessionToken = createId();
    const layoutAnchor = clear ? undefined : this.captureLayoutViewportAnchor();
    if (clear) this.clear();
    this.sourceData = data;
    this.data = data;
    this.documentSession.load(data);
    try {
      const parsed = parseMindTreeFile(data, {
        defaultLayoutMode: this.plugin.settings.defaultLayoutMode,
        defaultTheme: this.plugin.settings.theme,
        defaultNodeShape: this.plugin.settings.nodeShape,
        defaultCollectionMode: this.plugin.settings.defaultCollectionMode,
        defaultConnectionStyle: this.plugin.settings.connectionStyle
      });
      this.document = parsed.document;
      this.parseError = undefined;
      // File identity is authoritative; pathHint is only a cached fallback.
      // Repairing it here closes the rename/link-rewrite race before rendering.
      const repairedResourceState = this.reconcileLinkedResources(parsed.document);
      const repairedDocumentTitle = this.file
        ? this.synchronizeDocumentTitleWithFile(parsed.document, this.file)
        : false;
      const repairedState = repairedResourceState
        || repairedDocumentTitle
        || parsed.migratedFromSchemaVersion !== undefined
        || parsed.defaultedDocumentSettings === true;
      if (repairedState) this.markDocumentDirty(false);
      else this.setStatus(t("status.saved"), "saved");
      if (repairedState) this.scheduleSave();
      if (!this.primarySelectedId) this.selectOnly(parsed.document.rootId);
    } catch (error) {
      this.document = undefined;
      const message = error instanceof MindTreeFormatError
        ? [error.message, ...error.causes].join("\n")
        : String(error);
      this.parseError = t("status.invalidFile", { message });
      this.saveState = "error";
    }
    this.render(layoutAnchor);
  }

  clear(): void {
    this.markerPopover?.close();
    const conflictModal = this.conflictModal;
    this.conflictModal = undefined;
    conflictModal?.close();
    this.saveConflict = undefined;
    this.conflictPreparation = undefined;
    this.acceptingConflictSource = false;
    this.pendingSerializedSource = undefined;
    this.documentSession.clear();
    this.dragDropController.clear();
    this.clearFileDropFeedback();
    this.document = undefined;
    this.documentSessionToken = createId();
    this.parseError = undefined;
    this.selectedIds.clear();
    this.primarySelectedId = undefined;
    this.editingNodeId = undefined;
    this.currentLayout = undefined;
    this.branchColorSlotByNodeId.clear();
    this.foldDirectionByNodeId.clear();
    if (this.editingLayoutFrame !== undefined) this.ownerWindow().cancelAnimationFrame(this.editingLayoutFrame);
    this.editingLayoutFrame = undefined;
    this.pendingEditingLayout = undefined;
    this.viewport = { ...DEFAULT_VIEWPORT };
    this.initialRootCenterPending = true;
    this.rootEl?.addClass("is-initializing-viewport");
    this.zoomAnchor = undefined;
    this.scannedFilePath = undefined;
    this.saveState = "saved";
    if (this.nodeLayerEl) this.nodeLayerEl.empty();
  }

  getDocument(): MindTreeDocument | undefined { return this.document; }

  /** Save pending edits before another tree assigns this file its first link ID. */
  async flushForDocumentIdentityWrite(expectedPath: string): Promise<void> {
    if (normalizePath(this.file?.path ?? "") !== normalizePath(expectedPath)) return;
    await this.flushPendingSave();
  }

  /** Keep live state and undo history aligned with the atomically written ID. */
  adoptDocumentIdentity(expectedPath: string, documentId: string): void {
    if (normalizePath(this.file?.path ?? "") !== normalizePath(expectedPath) || !this.document) return;
    const identified = cloneDocument(this.document);
    identified.documentId = documentId;
    this.document = identified;
    this.documentSession.adoptDocumentIdentity(documentId);
  }

  /** Refresh cached link targets from the stable resource index. */
  private reconcileLinkedResources(document: MindTreeDocument): boolean {
    return reconcileLinkedFileReferences(document, (reference) => this.plugin.resources.describe(reference));
  }

  /** The .mtn.md filename is authoritative for both document and root titles. */
  private synchronizeDocumentTitleWithFile(document: MindTreeDocument, file: TFile): boolean {
    const title = linkedFileTitle(file.path);
    const root = document.nodes[document.rootId];
    if (!root || (document.title === title && root.title === title)) return false;
    renameNode(document, document.rootId, title);
    return true;
  }

  /** Commands change only the tree displayed by this view. */
  setLayoutMode(layoutMode: MindTreeLayoutMode): void {
    if (!this.document || this.document.settings.layoutMode === layoutMode) return;
    this.updateDocumentSettings((settings) => { settings.layoutMode = layoutMode; });
  }

  /** Recalculate the view after a global appearance preference changes. */
  refreshLayoutFromSettings(): void {
    this.render(this.captureLayoutViewportAnchor());
  }

  addChildNode(): void {
    const document = this.document;
    if (!document) return;
    const parentId = this.primarySelectedId && document.nodes[this.primarySelectedId]
      ? this.primarySelectedId
      : document.rootId;
    let createdId = "";
    this.commit((draft) => { createdId = addNode(draft, parentId, t("node.untitled")).id; });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** Enter variants insert a sibling immediately above or below the selection. */
  private addSiblingNode(position: "before" | "after"): void {
    const document = this.document;
    const nodeId = this.primarySelectedId;
    if (!document || !nodeId || nodeId === document.rootId) return;
    const parentId = findParentId(document, nodeId);
    if (!parentId) return;
    const siblingIndex = getNode(document, parentId).childIds.indexOf(nodeId);
    let createdId = "";
    this.commit((draft) => {
      createdId = addNode(draft, parentId, t("node.untitled"), siblingIndex + (position === "after" ? 1 : 0)).id;
    });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** Shift+Tab inserts a structural parent and also supports replacing the root. */
  private addParentNode(): void {
    const document = this.document;
    const nodeId = this.primarySelectedId;
    if (!document || !nodeId) return;
    let createdId = "";
    this.commit((draft) => { createdId = insertParentNode(draft, nodeId, t("node.untitled")).id; });
    this.finishInteractiveNodeCreation(createdId);
  }

  /** New nodes are the only structural edits that intentionally recenter the canvas. */
  private finishInteractiveNodeCreation(nodeId: NodeId): void {
    if (!this.document?.nodes[nodeId]) return;
    this.selectOnly(nodeId);
    this.beginEdit(nodeId);
    this.centerNodeInViewport(nodeId);
  }

  /** Center one visible node while retaining the user's current zoom level. */
  private centerNodeInViewport(nodeId: NodeId): void {
    const position = this.currentLayout?.nodes.find((node) => node.id === nodeId);
    const width = this.canvasEl?.clientWidth ?? 0;
    const height = this.canvasEl?.clientHeight ?? 0;
    if (!position || width <= 0 || height <= 0) return;
    this.viewport = centerViewportOnRect(width, height, position, this.viewport.zoom);
    this.applyViewport();
  }

  /**
   * Capture a node center before reflow. The root is the neutral default anchor:
   * keeping it fixed prevents ordinary edits, undo and settings changes from
   * looking like an unsolicited canvas pan.
   */
  private captureLayoutViewportAnchor(nodeId = this.document?.rootId): LayoutViewportAnchor | undefined {
    const layout = this.currentLayout;
    const rootId = this.document?.rootId;
    if (!layout || !nodeId) return undefined;
    const position = layout.nodes.find((node) => node.id === nodeId)
      ?? (rootId ? layout.nodes.find((node) => node.id === rootId) : undefined);
    if (!position) return undefined;
    return {
      nodeId: position.id,
      x: position.x + position.width / 2,
      y: position.y + position.height / 2
    };
  }

  /** Apply the inverse layout delta so the captured node stays screen-stationary. */
  private restoreLayoutViewportAnchor(anchor: LayoutViewportAnchor | undefined): void {
    if (!anchor) return;
    const position = this.currentLayout?.nodes.find((node) => node.id === anchor.nodeId);
    if (!position) return;
    this.viewport = preserveViewportPointAfterLayout(
      this.viewport,
      anchor,
      { x: position.x + position.width / 2, y: position.y + position.height / 2 }
    );
  }

  undo(): void {
    if (!this.document || !this.documentSession.canUndo) return;
    const layoutAnchor = this.captureLayoutViewportAnchor();
    const previous = this.documentSession.undo(this.document);
    if (!previous) return;
    this.document = previous;
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty();
  }

  redo(): void {
    if (!this.document || !this.documentSession.canRedo) return;
    const layoutAnchor = this.captureLayoutViewportAnchor();
    const next = this.documentSession.redo(this.document);
    if (!next) return;
    this.document = next;
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty();
  }

  fitCanvas(): void {
    const document = this.document;
    const layout = this.currentLayout;
    if (!document || !layout) return;
    const width = Math.max(1, this.canvasEl.clientWidth - 80);
    const height = Math.max(1, this.canvasEl.clientHeight - 80);
    const zoom = clamp(Math.min(width / layout.width, height / layout.height), 0.25, 1.4);
    this.viewport = {
      zoom,
      x: (this.canvasEl.clientWidth - layout.width * zoom) / 2,
      y: (this.canvasEl.clientHeight - layout.height * zoom) / 2
    };
    this.applyViewport();
  }

  /** Center the root at 100% zoom, unlike fitCanvas which frames the whole tree. */
  private resetCanvasToRoot(): void {
    const document = this.document;
    const root = this.currentLayout?.nodes.find((node) => node.id === document?.rootId);
    if (!document || !root) return;
    this.viewport = centerViewportOnRect(this.canvasEl.clientWidth, this.canvasEl.clientHeight, root);
    this.selectOnly(document.rootId);
    this.applyViewport();
  }

  /** Center and reveal a file exactly once after its first measurable layout. */
  private tryApplyInitialRootCenter(): boolean {
    if (!this.initialRootCenterPending) return false;
    const document = this.document;
    const root = this.currentLayout?.nodes.find((node) => node.id === document?.rootId);
    const width = this.canvasEl?.clientWidth ?? 0;
    const height = this.canvasEl?.clientHeight ?? 0;
    if (!document || !root || width <= 0 || height <= 0) return false;
    this.viewport = centerViewportOnRect(width, height, root);
    this.selectedIds.clear();
    this.selectedIds.add(document.rootId);
    this.primarySelectedId = document.rootId;
    this.initialRootCenterPending = false;
    this.rootEl.removeClass("is-initializing-viewport");
    return true;
  }

  handleResourceRename(file: TFile, oldPath: string): void {
    if (!this.document) return;
    // main.ts has already refreshed the resource index. Reuse the same
    // reconciliation performed at load/save boundaries so an Obsidian link
    // rewrite cannot restore stale compressed titles after this event. The old
    // path is a one-event fallback for a MetadataCache update that arrives late.
    const normalizedOldPath = normalizePath(oldPath);
    this.applySystemMutation((draft) => {
      let changed = reconcileLinkedFileReferences(draft, (reference) => {
        const preferredFile = normalizePath(reference.pathHint) === normalizedOldPath ? file : undefined;
        return this.plugin.resources.describe(reference, preferredFile);
      });
      // A rename of this view's own file must update the root immediately. This
      // also repairs copied trees whose compressed data still contains the source
      // file's title when another plugin renames the copy before it is opened.
      if (this.file === file) changed = this.synchronizeDocumentTitleWithFile(draft, file) || changed;
      return changed;
    });
  }

  private buildShell(): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv("mtn-view");
    this.rootEl.addClass("is-initializing-viewport");
    this.viewMenuEl = this.rootEl.createDiv("mtn-view-menu-bar");
    this.settingsButtonEl = this.viewMenuEl.createEl("button", {
      cls: "clickable-icon mtn-view-menu-button mtn-view-settings-button",
      attr: { type: "button", "aria-label": t("view.settings") }
    });
    setIcon(this.settingsButtonEl, "menu");
    this.settingsButtonEl.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showViewSettingsMenu(event);
    });
    const helpButton = this.viewMenuEl.createEl("button", {
      cls: "clickable-icon mtn-view-menu-button mtn-shortcut-help-button",
      attr: { type: "button", "aria-label": t("shortcut.help") }
    });
    setIcon(helpButton, "circle-help");
    helpButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showKeyboardHelp(event);
    });
    this.toolbarEl = this.rootEl.createDiv("mtn-toolbar");
    this.statusEl = this.rootEl.createDiv("mtn-status");
    this.buildBottomStatusBar();
    this.canvasEl = this.rootEl.createDiv("mtn-canvas");
    this.canvasEl.tabIndex = 0;
    this.canvasEl.setAttribute("role", "application");
    this.canvasEl.setAttribute("aria-label", t("canvas.aria"));
    // Pan and zoom deliberately use separate DOM layers. The outer layer can
    // stay compositor-translated while CSS zoom on the inner layer repaints
    // text at its actual displayed size instead of stretching a cached bitmap.
    this.panLayerEl = this.canvasEl.createDiv("mtn-pan-layer");
    this.worldEl = this.panLayerEl.createDiv("mtn-world");
    this.connectionsEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.connectionsEl.classList.add("mtn-connections");
    this.worldEl.appendChild(this.connectionsEl);
    this.nodeLayerEl = this.worldEl.createDiv("mtn-node-layer");
    this.marqueeEl = this.canvasEl.createDiv("mtn-marquee");
    this.marqueeEl.hide();
    this.buildToolbar();

    this.registerDomEvent(this.canvasEl, "pointerdown", (event) => this.onCanvasPointerDown(event));
    this.registerDomEvent(this.canvasEl, "pointermove", (event) => this.onCanvasPointerMove(event));
    this.registerDomEvent(this.canvasEl, "pointerup", (event) => this.onCanvasPointerUp(event));
    this.registerDomEvent(this.canvasEl, "pointercancel", (event) => this.onCanvasPointerUp(event));
    this.registerDomEvent(this.canvasEl, "contextmenu", (event) => {
      if (this.suppressContextMenu || !(event.target as HTMLElement).closest(".mtn-node")) event.preventDefault();
      this.suppressContextMenu = false;
    });
    this.registerDomEvent(this.canvasEl, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.canvasEl, "dragenter", (event) => this.onCanvasFileDragOver(event));
    this.registerDomEvent(this.canvasEl, "dragover", (event) => this.onCanvasFileDragOver(event));
    this.registerDomEvent(this.canvasEl, "dragleave", (event) => this.onCanvasFileDragLeave(event));
    this.registerDomEvent(this.canvasEl, "drop", (event) => void this.onCanvasFileDrop(event));
    this.registerDomEvent(this.canvasEl, "keydown", (event) => this.onKeyDown(event));

    // Hidden/background leaves can report a zero canvas size during their first
    // render. ResizeObserver centers the root as soon as the leaf becomes visible,
    // before the world layer is revealed.
    const resizeObserver = new ResizeObserver(() => {
      if (this.tryApplyInitialRootCenter()) this.applyViewport();
    });
    resizeObserver.observe(this.canvasEl);
    this.register(() => resizeObserver.disconnect());

    // Internal file drags begin in Obsidian's file explorer, outside this view.
    // Capture its data-path at the document level as a stable fallback when the
    // drag payload varies between Obsidian desktop versions.
    const ownerDocument = this.rootEl.ownerDocument;
    // Paste is captured at the document boundary because a hidden editor from
    // the previously active tab may retain DOM focus. The active-view and
    // visible-editor checks in onDocumentPaste keep native text input intact.
    this.registerDomEvent(ownerDocument, "paste", (event) => this.onDocumentPaste(event), { capture: true });
    this.registerDomEvent(ownerDocument, "dragstart", (event) => this.captureInternalFileDrag(event));
    this.registerDomEvent(ownerDocument, "dragend", () => {
      this.dragDropController.clear();
      this.clearFileDropFeedback();
    });
  }

  private buildToolbar(): void {
    this.toolbarEl.empty();
    this.addToolbarButton("unfold-vertical", t("toolbar.expandAll"), () => this.setSelectedBranchesCollapsed(false));
    this.addToolbarButton("fold-vertical", t("toolbar.collapseAll"), () => this.setSelectedBranchesCollapsed(true));
    this.addToolbarButton("list-tree", t("toolbar.collapseLevel"), (event) => this.showCollapseLevelMenu(event));
    this.addToolbarButton("tags", t("toolbar.markers"), (event) => {
      const nodeId = this.primarySelectedId;
      const button = event.currentTarget as HTMLElement | null;
      if (!nodeId || !button) return;
      const rect = button.getBoundingClientRect();
      this.showMarkerPopover(nodeId, { x: rect.left, y: rect.bottom + 6 });
    });
    this.addToolbarSeparator();
    this.addToolbarButton("maximize", t("toolbar.fit"), () => this.fitCanvas());
    this.addToolbarButton("minus", t("toolbar.zoomOut"), () => this.zoomByStep(-ZOOM_STEP));
    const zoom = this.toolbarEl.createEl("span", { cls: "mtn-zoom-label", text: "100%" });
    zoom.dataset.role = "zoom";
    this.addToolbarButton("plus", t("toolbar.zoomIn"), () => this.zoomByStep(ZOOM_STEP));
    this.addToolbarButton("search", t("toolbar.search"), () => this.searchNodes());
    this.addToolbarSeparator();
    this.addToolbarButton("copy", t("toolbar.copy"), (event) => this.showCopyMenu(event));
    this.addToolbarButton("upload", t("toolbar.import"), () => this.showTextImportModal());
    this.addToolbarButton("download", t("toolbar.export"), (event) => this.showExportMenu(event));
  }

  /** Build the fixed lower-left status group and its two detached history buttons. */
  private buildBottomStatusBar(): void {
    this.bottomBarEl = this.rootEl.createDiv("mtn-bottom-bar");
    const panel = this.bottomBarEl.createDiv("mtn-status-panel");
    this.topicCountEl = panel.createSpan("mtn-status-metric");
    this.noteCountEl = panel.createSpan("mtn-status-metric");
    this.treeDepthEl = panel.createSpan("mtn-status-metric");

    const resetButton = panel.createEl("button", {
      cls: "clickable-icon mtn-status-icon-button",
      attr: { type: "button", "aria-label": t("statusBar.resetCanvas") }
    });
    setIcon(resetButton, "focus");
    resetButton.addEventListener("click", () => this.resetCanvasToRoot());

    this.saveButtonEl = panel.createEl("button", {
      cls: "clickable-icon mtn-status-icon-button mtn-save-button is-saved",
      attr: { type: "button", "aria-label": t("statusBar.save") }
    });
    setIcon(this.saveButtonEl, "save");
    this.saveButtonEl.addEventListener("click", () => void this.saveFromStatusBar());

    this.scanFolderButtonEl = panel.createEl("button", {
      cls: "clickable-icon mtn-status-icon-button mtn-scan-folder-button",
      attr: { type: "button", "aria-label": t("statusBar.scanFolder") }
    });
    setIcon(this.scanFolderButtonEl, "folder-search-2");
    this.scanFolderButtonEl.addEventListener("click", () => void this.scanFolderFromStatusBar());

    this.undoButtonEl = this.bottomBarEl.createEl("button", {
      cls: "clickable-icon mtn-history-button",
      attr: { type: "button", "aria-label": t("toolbar.undo") }
    });
    setIcon(this.undoButtonEl, "undo-2");
    this.undoButtonEl.addEventListener("click", () => this.undo());
    this.redoButtonEl = this.bottomBarEl.createEl("button", {
      cls: "clickable-icon mtn-history-button",
      attr: { type: "button", "aria-label": t("toolbar.redo") }
    });
    setIcon(this.redoButtonEl, "redo-2");
    this.redoButtonEl.addEventListener("click", () => this.redo());
    this.refreshBottomStatusBar();
  }

  /** Refresh counts, history availability, and the persisted/dirty save color. */
  private refreshBottomStatusBar(): void {
    if (!this.bottomBarEl) return;
    const document = this.document;
    if (document) {
      const statistics = getTreeStatistics(document);
      this.topicCountEl.setText(t("statusBar.topics", { count: statistics.topicCount }));
      this.noteCountEl.setText(t("statusBar.notes", { count: statistics.noteCount }));
      this.treeDepthEl.setText(t("statusBar.depth", { count: statistics.depth }));
    } else {
      this.topicCountEl.setText(t("statusBar.topics", { count: 0 }));
      this.noteCountEl.setText(t("statusBar.notes", { count: 0 }));
      this.treeDepthEl.setText(t("statusBar.depth", { count: 0 }));
    }
    this.undoButtonEl.disabled = !this.documentSession.canUndo;
    this.redoButtonEl.disabled = !this.documentSession.canRedo;
    this.saveButtonEl.toggleClass("is-saved", this.saveState === "saved");
    this.saveButtonEl.toggleClass("is-dirty", this.saveState !== "saved");
    this.saveButtonEl.setAttribute("aria-label", this.saveState === "saved" ? t("statusBar.saved") : t("statusBar.unsaved"));
    this.scanFolderButtonEl.disabled = !document || Boolean(this.parseError) || !this.file;
  }

  private async saveFromStatusBar(): Promise<void> {
    if (!this.document || this.parseError) return;
    this.saveButtonEl.disabled = true;
    try {
      await this.flushPendingSave();
    } catch (error) {
      this.reportSaveFailure(error);
    } finally {
      this.saveButtonEl.disabled = false;
      this.refreshBottomStatusBar();
    }
  }

  /** Refresh only views that actually reference the metadata-changed resource. */
  handleResourceMetadataChange(resourceId: string): void {
    const document = this.document;
    if (!document || !Object.values(document.nodes).some((node) =>
      node.resource?.type === "file" && node.resource.resourceId === resourceId)) return;
    this.applySystemMutation((draft) => this.reconcileLinkedResources(draft));
  }

  /**
   * Explicit scanning always invalidates the per-open cache. Automatic scanning
   * may be disabled for a pure mind-map tree, but clicking this button is direct
   * user intent, so `off` falls back to the candidate picker for this one scan.
   */
  private async scanFolderFromStatusBar(): Promise<void> {
    const file = this.file;
    if (!file || !this.document || this.parseError) return;
    this.scanFolderButtonEl.disabled = true;
    try {
      await this.scanSameFolder(file, { force: true, notifyWhenEmpty: true });
    } finally {
      this.scanFolderButtonEl.disabled = false;
    }
  }

  /** Theme changes belong to this document and are persisted in YAML. */
  private setTheme(theme: MindTreeTheme): void {
    if (!this.document || this.document.settings.theme === theme) return;
    this.updateDocumentSettings((settings) => { settings.theme = theme; });
  }

  /** Connection geometry is stored per tree; the plugin setting only initializes it. */
  private setConnectionStyle(connectionStyle: MindTreeConnectionStyle): void {
    if (!this.document || this.document.settings.connectionStyle === connectionStyle) return;
    this.updateDocumentSettings((settings) => { settings.connectionStyle = connectionStyle; });
  }

  /** Node shape is tree-specific; the plugin setting only initializes new trees. */
  private setNodeShape(nodeShape: MindTreeNodeShape): void {
    if (!this.document || this.document.settings.nodeShape === nodeShape) return;
    this.updateDocumentSettings((settings) => { settings.nodeShape = nodeShape; });
  }

  /**
   * Commit an in-place title draft, then force TextFileView to serialize the
   * current document immediately. Serialization regenerates the readable
   * Markdown outline and compressed data from the same document snapshot.
   */
  private async saveImmediately(): Promise<void> {
    if (!this.document || this.parseError) return;
    if (this.editingNodeId) {
      const editor = this.nodeLayerEl.querySelector<HTMLTextAreaElement>(".mtn-title-input");
      this.finishEdit(this.editingNodeId, editor?.value ?? this.editingOriginalTitle);
    }
    await this.saveFromStatusBar();
  }

  /** Only the explicitly per-tree choices are exposed in this menu. */
  private showViewSettingsMenu(event: MouseEvent): void {
    const settings = this.document?.settings;
    if (!settings) return;
    const menu = new Menu();

    this.addSettingsMenuLabel(menu, t("viewSettings.currentTree"));
    this.addChoiceSetting(
      menu,
      t("settings.layout.name"),
      "layout-template",
      LAYOUT_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      settings.layoutMode,
      (value) => this.setLayoutMode(value)
    );
    this.addChoiceSetting(
      menu,
      t("viewSettings.theme"),
      "palette",
      THEME_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      settings.theme,
      (value) => this.setTheme(value)
    );
    this.addChoiceSetting(
      menu,
      t("viewSettings.connectionStyle"),
      "git-branch",
      CONNECTION_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      settings.connectionStyle,
      (value) => this.setConnectionStyle(value)
    );
    this.addChoiceSetting(
      menu,
      t("viewSettings.nodeShape"),
      "shapes",
      NODE_SHAPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      settings.nodeShape,
      (value) => this.setNodeShape(value)
    );
    this.addChoiceSetting<MindTreeCollectionMode>(
      menu,
      t("viewSettings.collectionMode"),
      "folder-input",
      COLLECTION_MODE_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
      settings.collectionMode,
      (value) => this.updateDocumentSettings((draft) => { draft.collectionMode = value; }, true)
    );
    menu.addItem((item) => item
      .setTitle(t("settings.recursive.name"))
      .setIcon("folder-tree")
      .setChecked(settings.recursiveScan)
      .onClick(() => this.updateDocumentSettings((draft) => { draft.recursiveScan = !draft.recursiveScan; }, true)));

    menu.showAtMouseEvent(event);
  }

  /** The help menu mirrors every keyboard branch handled by onKeyDown/onPaste. */
  private showKeyboardHelp(event: MouseEvent): void {
    const menu = new Menu();
    this.addSettingsMenuLabel(menu, t("shortcut.help"));
    const commandKey = Platform.isMacOS ? "Cmd" : "Ctrl";
    const shortcuts: Array<[string, string]> = [
      ["Enter", t("shortcut.addSiblingBelow")],
      ["Shift + Enter", t("shortcut.addSiblingAbove")],
      ["Tab", t("shortcut.addChild")],
      ["Shift + Tab", t("shortcut.addParent")],
      [`${commandKey} + ↑`, t("shortcut.moveSiblingUp")],
      [`${commandKey} + ↓`, t("shortcut.moveSiblingDown")],
      [`${commandKey} + E`, t("shortcut.createNote")],
      [`${commandKey} + S`, t("shortcut.save")],
      ["↑ / ↓", t("shortcut.navigateSiblings")],
      ["← / →", t("shortcut.navigateHierarchy")],
      [t("shortcut.spaceKey"), t("shortcut.editNode")],
      ["Delete / Backspace", t("shortcut.deleteBranch")],
      [`${commandKey} + A`, t("shortcut.selectAll")],
      [`${commandKey} + C`, t("shortcut.copyBranch")],
      [`${commandKey} + X`, t("shortcut.cutBranch")],
      [`${commandKey} + V`, t("shortcut.pasteBranch")],
      [`${commandKey} + Z`, t("shortcut.undo")],
      [`${commandKey} + Shift + Z`, t("shortcut.redo")],
      ["Escape", t("shortcut.cancel")]
    ];
    for (const [keys, action] of shortcuts) {
      const title = document.createDocumentFragment();
      const row = document.createElement("span");
      row.className = "mtn-shortcut-row";
      const key = document.createElement("kbd");
      key.setText(keys);
      const description = document.createElement("span");
      description.setText(action);
      row.append(key, description);
      title.append(row);
      menu.addItem((item) => item.setTitle(title).setIsLabel(true));
    }
    menu.showAtMouseEvent(event);
  }

  private addSettingsMenuLabel(menu: Menu, title: string): void {
    menu.addItem((item) => item.setTitle(title).setIsLabel(true));
  }

  /** Add a first-level setting and display all possible values in a checked menu. */
  private addChoiceSetting<T extends string | number>(
    menu: Menu,
    title: string,
    icon: string,
    choices: ReadonlyArray<ViewSettingChoice<T>>,
    current: T,
    onChange: (value: T) => void
  ): void {
    const currentLabel = choices.find((choice) => choice.value === current)?.label;
    menu.addItem((item) => item
      .setTitle(currentLabel ? `${title}: ${currentLabel}` : title)
      .setIcon(icon)
      .onClick(() => this.showChoiceSettingMenu(title, choices, current, onChange)));
  }

  private showChoiceSettingMenu<T extends string | number>(
    title: string,
    choices: ReadonlyArray<ViewSettingChoice<T>>,
    current: T,
    onChange: (value: T) => void
  ): void {
    const menu = new Menu();
    this.addSettingsMenuLabel(menu, title);
    for (const choice of choices) {
      menu.addItem((item) => item
        .setTitle(choice.label)
        .setChecked(choice.value === current)
        .onClick(() => onChange(choice.value)));
    }
    const rect = this.settingsButtonEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right + 6, y: rect.top });
  }

  /** Commit YAML-backed settings through the same undo/save path as tree edits. */
  private updateDocumentSettings(
    mutator: (settings: MindTreeDocumentSettings) => void,
    rescan = false
  ): void {
    this.commit((draft) => {
      mutator(draft.settings);
      draft.updatedAt = new Date().toISOString();
    });
    if (!rescan) return;
    this.scannedFilePath = undefined;
    const file = this.file;
    if (file) this.ownerWindow().setTimeout(() => void this.scanSameFolder(file));
  }

  private addToolbarButton(icon: string, label: string, action: (event: MouseEvent) => void): void {
    const button = this.toolbarEl.createEl("button", { cls: "clickable-icon mtn-toolbar-button", attr: { "aria-label": label, type: "button" } });
    setIcon(button, icon);
    button.addEventListener("click", action);
  }

  /**
   * Resolve toolbar branch actions against the complete selection. When the
   * root participates it represents the whole tree; otherwise nested selected
   * nodes are removed because their ancestor branch already covers them.
   */
  private getSelectedBranchRoots(): NodeId[] {
    const document = this.document;
    if (!document) return [];
    const selected = [...this.selectedIds].filter((nodeId) => Boolean(document.nodes[nodeId]));
    if (selected.includes(document.rootId)) return [document.rootId];
    const roots = getTopLevelSelectedNodeIds(document, selected);
    return roots.length > 0 ? roots : [document.rootId];
  }

  /** Expand or recursively collapse every selected top-level branch as one undo step. */
  private setSelectedBranchesCollapsed(collapsed: boolean): void {
    const document = this.document;
    if (!document) return;
    const branchRoots = this.getSelectedBranchRoots();
    const anchorNodeId = this.primarySelectedId && document.nodes[this.primarySelectedId]
      ? this.primarySelectedId
      : document.rootId;
    this.commit((draft) => {
      for (const branchRootId of branchRoots) setAllCollapsed(draft, branchRootId, collapsed);
    }, anchorNodeId);
  }

  /** Show the global depth menu; its result is stored only in node collapsed flags. */
  private showCollapseLevelMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (let level = 1; level <= 9; level += 1) {
      menu.addItem((item) => item
        .setTitle(t("toolbar.collapseToLevel", { level }))
        .onClick(() => {
          const document = this.document;
          if (!document) return;
          const anchorNodeId = this.primarySelectedId && document.nodes[this.primarySelectedId]
            ? this.primarySelectedId
            : document.rootId;
          this.commit((draft) => setCollapsedAfterDepth(draft, level), anchorNodeId);
        }));
    }
    menu.showAtMouseEvent(event);
  }

  private addToolbarSeparator(): void { this.toolbarEl.createDiv("mtn-toolbar-separator"); }

  private render(layoutAnchor?: LayoutViewportAnchor): void {
    if (!this.rootEl) return;
    if (this.parseError) {
      this.nodeLayerEl.empty();
      this.connectionsEl.empty();
      this.statusEl.setText(this.parseError);
      this.statusEl.className = "mtn-status is-error";
      this.rootEl.toggleClass("is-readonly", true);
      this.saveState = "error";
      this.refreshBottomStatusBar();
      return;
    }
    const document = this.document;
    if (!document) return;
    // Theme, connection geometry, layout and shape all belong to this document.
    // CSS attributes avoid duplicating rendering branches.
    this.rootEl.dataset.mtnTheme = document.settings.theme;
    this.rootEl.dataset.mtnNodeShape = document.settings.nodeShape;
    this.rootEl.dataset.mtnConnectionStyle = document.settings.connectionStyle;
    this.rootEl.dataset.mtnLayout = document.settings.layoutMode;
    this.rootEl.toggleClass("is-readonly", false);
    this.currentLayout = layoutTree(
      document,
      document.rootId,
      true,
      this.plugin.settings.nodeWrapWidth,
      document.settings.layoutMode,
      this.plugin.settings.nodeAlignment
    );
    this.foldDirectionByNodeId = resolveFoldDirections(
      document,
      this.currentLayout.nodes,
      document.settings.layoutMode
    );
    // Opening a file has an explicit root-centering policy. Every later reflow
    // instead restores its captured anchor and therefore remains visually still.
    const initiallyCentered = this.tryApplyInitialRootCenter();
    if (!initiallyCentered) this.restoreLayoutViewportAnchor(layoutAnchor);
    this.branchColorSlotByNodeId = getBranchColorSlots(document);
    const positionMap = new Map(this.currentLayout.nodes.map((node) => [node.id, node]));
    this.renderConnections(positionMap);
    this.nodeLayerEl.empty();
    this.nodeLayerEl.style.width = `${this.currentLayout.width}px`;
    this.nodeLayerEl.style.height = `${this.currentLayout.height}px`;
    for (const position of this.currentLayout.nodes) this.renderNode(position);
    this.applyViewport();
    const zoomEl = this.toolbarEl.querySelector<HTMLElement>("[data-role='zoom']");
    if (zoomEl) zoomEl.setText(`${Math.round(this.viewport.zoom * 100)}%`);
    this.refreshBottomStatusBar();
  }

  private renderConnections(positionMap: Map<NodeId, PositionedNode>): void {
    const documentSettings = this.document?.settings;
    if (!this.currentLayout || !documentSettings) return;
    this.connectionsEl.empty();
    this.connectionsEl.setAttribute("width", String(this.currentLayout.width));
    this.connectionsEl.setAttribute("height", String(this.currentLayout.height));
    this.connectionsEl.setAttribute("viewBox", `0 0 ${this.currentLayout.width} ${this.currentLayout.height}`);
    for (const connection of this.currentLayout.connections) {
      const from = positionMap.get(connection.from);
      const to = positionMap.get(connection.to);
      if (!from || !to) continue;
      const visual = resolveThemeConnection(
        documentSettings.theme,
        documentSettings.connectionStyle,
        to.depth
      );
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", connectionPath(
        from,
        to,
        documentSettings.layoutMode,
        visual.style
      ));
      path.classList.add("mtn-connection");
      path.dataset.fromNodeId = connection.from;
      path.dataset.toNodeId = connection.to;
      // Set the final path variable on the path itself. Defining a variable on
      // the parent view made its fallback resolve before this child-level branch
      // color existed, which collapsed all neutral-theme lines to one color.
      path.style.setProperty("--mtn-connection-color", branchColorCss(this.branchColorSlotByNodeId.get(connection.to)));
      path.style.setProperty("--mtn-connection-width", `${visual.width}px`);
      path.style.setProperty("--mtn-connection-opacity", String(visual.opacity));
      path.style.setProperty("--mtn-connection-filter", visual.shadow);
      path.style.setProperty("--mtn-connection-linecap", visual.lineCap);
      path.style.setProperty("--mtn-connection-linejoin", visual.lineJoin);
      if (visual.dash) path.style.setProperty("--mtn-connection-dash", visual.dash);
      path.classList.toggle("is-dashed", Boolean(visual.dash));
      this.connectionsEl.appendChild(path);
    }
  }

  /**
   * Coalesce rapid keystrokes to one full layout pass per animation frame. The
   * draft title lives only in a clone, so typing never mutates saved document
   * state before finishEdit commits the final value.
   */
  private scheduleEditingRelayout(nodeId: NodeId, title: string): void {
    this.pendingEditingLayout = { nodeId, title };
    if (this.editingLayoutFrame !== undefined) return;
    this.editingLayoutFrame = this.ownerWindow().requestAnimationFrame(() => {
      this.editingLayoutFrame = undefined;
      const pending = this.pendingEditingLayout;
      this.pendingEditingLayout = undefined;
      if (!pending || this.editingNodeId !== pending.nodeId || !this.document?.nodes[pending.nodeId]) return;

      const preview = cloneDocument(this.document);
      preview.nodes[pending.nodeId]!.title = pending.title.replace(/[\r\n]+/g, " ");
      const layout = layoutTree(
        preview,
        preview.rootId,
        true,
        this.plugin.settings.nodeWrapWidth,
        preview.settings.layoutMode,
        this.plugin.settings.nodeAlignment
      );
      this.applyLiveLayoutGeometry(layout, pending.nodeId);
    });
  }

  /** Update every visible node and connection without replacing the active input. */
  private applyLiveLayoutGeometry(layout: TreeLayout, anchorNodeId: NodeId): void {
    const layoutAnchor = this.captureLayoutViewportAnchor(anchorNodeId);
    this.currentLayout = layout;
    this.restoreLayoutViewportAnchor(layoutAnchor);
    this.nodeLayerEl.style.width = `${layout.width}px`;
    this.nodeLayerEl.style.height = `${layout.height}px`;
    const positionMap = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const position of layout.nodes) {
      const element = this.nodeLayerEl.querySelector<HTMLElement>(
        `.mtn-node[data-node-id="${CSS.escape(position.id)}"]`
      );
      if (!element) continue;
      element.style.left = `${position.x}px`;
      element.style.top = `${position.y}px`;
      element.style.width = `${position.width}px`;
      element.style.height = `${position.height}px`;
    }
    this.renderConnections(positionMap);
    this.applyViewport();
  }

  private renderNode(position: PositionedNode): void {
    const document = this.document;
    const node = document?.nodes[position.id];
    if (!document || !node) return;
    const element = this.nodeLayerEl.createDiv(`mtn-node ${getNodeSizeClass(position.depth)}`);
    element.dataset.nodeId = node.id;
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
    element.style.width = `${position.width}px`;
    element.style.height = `${position.height}px`;
    element.style.setProperty("--mtn-branch-color", branchColorCss(this.branchColorSlotByNodeId.get(node.id)));
    element.toggleClass("is-selected", this.selectedIds.has(node.id));
    element.toggleClass("is-editing", this.editingNodeId === node.id);
    element.toggleClass("is-leaf", node.childIds.length === 0);
    // Only file resources render right-side controls. URL resources therefore keep
    // the same compact single-content geometry as plain text nodes.
    const hasFileControls = node.resource?.type === "file";
    element.toggleClass("has-resource", hasFileControls);
    element.toggleClass("is-title-sync-off", node.resource?.type === "file" && node.titleSync !== "bidirectional");
    const markerDisplayWidth = getNodeMarkerDisplayWidth(node);
    element.toggleClass("has-markers", markerDisplayWidth > 0);
    // Do not leave zero-width marker/control grid tracks on a content-only node.
    // A dedicated class lets CSS use one centered flex item, so Obsidian theme
    // rules cannot turn an invisible trailing track into apparent blank space.
    element.toggleClass("is-content-only", !hasFileControls && markerDisplayWidth === 0);
    element.style.setProperty("--mtn-node-marker-width", `${markerDisplayWidth}px`);
    const highlight = getNodeHighlightColor(node);
    element.toggleClass("has-highlight", Boolean(highlight));
    if (highlight) {
      element.style.setProperty("--mtn-node-bg", highlight);
      element.style.setProperty("--mtn-node-text", readableTextColor(highlight));
    } else if (node.style?.background && CSS.supports("color", node.style.background)) {
      element.style.setProperty("--mtn-node-bg", node.style.background);
    }

    if (this.editingNodeId === node.id) {
      // A textarea can follow the node's normal wrapping behavior. A one-line
      // input would either stay unnecessarily wide or hide most of a long title.
      const input = element.createEl("textarea", {
        cls: "mtn-title-input",
        attr: { rows: "1", spellcheck: "false" }
      });
      input.value = node.title;

      // Recalculate the complete tree instead of resizing only this element.
      // Width changes can move later columns, while height changes can move
      // sibling subtrees; updating one box alone would make nodes overlap.
      const resizeEditor = (): void => this.scheduleEditingRelayout(node.id, input.value);
      input.addEventListener("pointerdown", (event) => event.stopPropagation());
      input.addEventListener("input", resizeEditor);
      input.addEventListener("keydown", (event) => {
        // While composing Chinese/Japanese text, Enter belongs to the IME and
        // must not create another node.
        if (event.isComposing) return;
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          this.finishEdit(node.id, input.value);
          // finishEdit synchronously rerenders and removes the textarea. Move
          // focus to the newly rendered canvas immediately so the next distinct
          // Enter/Tab reaches its structural shortcut instead of being lost on
          // the detached editor/body. Preventing Tab's default action also keeps
          // focus inside the canvas rather than advancing through Obsidian UI.
          this.canvasEl.focus({ preventScroll: true });
          // Do not wait for the asynchronous save or a linked-file rename;
          // neither operation owns keyboard focus. This keydown is now fully
          // consumed, so only a later independent press can create a node.
          void this.saveImmediately();
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); this.cancelEdit(); }
      });
      // Capture node.id in every completion path. A blur from an input removed
      // while another node starts editing must never write into the new node.
      input.addEventListener("blur", () => this.finishEdit(node.id, input.value));
      this.ownerWindow().setTimeout(() => {
        input.focus();
        if (this.editingSelectionMode === "end") {
          const end = input.value.length;
          input.setSelectionRange(end, end);
        } else {
          input.select();
        }
      });
    } else {
      const title = element.createDiv("mtn-node-title");
      title.setText(node.title || t("node.untitled"));
    }

    this.renderNodeMarkers(element, node);
    this.renderFileControls(element, node);

    if (node.childIds.length > 0) {
      const foldDirection = this.foldDirectionByNodeId.get(node.id) ?? "right";
      const fold = element.createEl("button", {
        cls: `mtn-fold-button is-fold-${foldDirection} ${node.collapsed ? "is-expand" : "is-collapse"}`,
        attr: { type: "button", "aria-label": node.collapsed ? t("node.expandBranch") : t("node.collapseBranch") }
      });
      // Expanded branches show a plain minus action. Collapsed branches replace
      // the old chevron-plus-count combination with one fixed-size count circle.
      if (node.collapsed) fold.createSpan({ cls: "mtn-child-count", text: String(node.childIds.length) });
      else setIcon(fold, "minus");
      fold.addEventListener("pointerdown", (event) => event.stopPropagation());
      fold.addEventListener("click", (event) => {
        event.stopPropagation();
        this.commit((draft) => toggleCollapsed(draft, node.id), node.id);
      });
    }

    element.addEventListener("pointerdown", (event) => this.onNodePointerDown(event, node.id));
    element.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.beginEdit(node.id);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.suppressContextMenu) this.showNodeMenu(event, node.id);
      this.suppressContextMenu = false;
    });
  }

  private renderFileControls(element: HTMLElement, node: MindTreeNode): void {
    if (node.resource?.type !== "file") return;
    // Controls use a dedicated right-hand grid slot. Layout adds this slot to the
    // measured title width, so the complete text-and-control group stays compact.
    const controls = element.createDiv("mtn-node-controls");
    if (node.titleSync !== "bidirectional") {
      const syncStatus = controls.createSpan({
        cls: "mtn-title-sync-off",
        attr: { role: "img", "aria-label": t("node.syncDisabled") }
      });
      setIcon(syncStatus, "unlink");
    }
    const openButton = controls.createEl("button", {
      cls: "mtn-resource-open fa-share-square-o",
      attr: { type: "button", "aria-label": t("node.openLinkedFile") }
    });
    setIcon(openButton, SHARE_SQUARE_ICON);
    openButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    openButton.addEventListener("dblclick", (event) => event.stopPropagation());
    openButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openResource(node.id);
    });
  }

  private onNodePointerDown(event: PointerEvent, nodeId: NodeId): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button,input,textarea")) return;
    event.preventDefault();
    event.stopPropagation();
    // Keep canvas shortcuts active after selecting or beginning a drag on a node.
    // preventScroll avoids moving the workspace when the canvas receives focus.
    this.canvasEl.focus({ preventScroll: true });
    const additive = event.ctrlKey || event.metaKey;
    const preserveMultiSelection = !additive && this.selectedIds.size > 1 && this.selectedIds.has(nodeId);
    if (preserveMultiSelection) {
      // Pressing one member of an existing multi-selection chooses the drag
      // anchor without visually cloning or moving the other selected nodes.
      this.primarySelectedId = nodeId;
      this.refreshSelectionStyles();
    } else {
      this.updateSelectionFromPointer(nodeId, additive);
    }
    const document = this.document;
    const sourceElement = (event.currentTarget as HTMLElement | null)
      ?? this.nodeLayerEl.querySelector<HTMLElement>(`.mtn-node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!document || !sourceElement || nodeId === document.rootId) return;
    const sourceRect = sourceElement.getBoundingClientRect();
    const dragSelection = this.selectedIds.has(nodeId) ? this.selectedIds : new Set([nodeId]);
    const draggedRootIds = getTopLevelSelectedNodeIds(document, dragSelection);
    if (draggedRootIds.length === 0) return;
    // Hide and exclude every selected top-level branch. Selected descendants of
    // another selected node remain attached and therefore appear only once.
    const excludedIds = new Set(draggedRootIds.flatMap((id) => collectBranchIds(document, id)));
    const state: NodeDragState = {
      nodeId,
      draggedRootIds,
      startX: event.clientX,
      startY: event.clientY,
      renderedWidth: sourceRect.width,
      renderedHeight: sourceRect.height,
      dragging: false
    };

    const onMove = (moveEvent: PointerEvent): void => {
      const distance = Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY);
      if (!state.dragging && distance < 5) return;
      if (!state.dragging) {
        state.dragging = true;
        this.rootEl.addClass("is-dragging-node");
        state.ghostEl = this.createNodeDragGhost(sourceElement, sourceRect);
        this.setDraggedBranchVisibility(excludedIds, false);
      }
      this.positionNodeDragGhost(state, moveEvent.clientX, moveEvent.clientY);
      this.clearDropTarget();
      state.targetId = undefined;
      state.position = undefined;
      const placement = this.resolveCanvasDropPlacement(moveEvent.clientX, moveEvent.clientY, excludedIds);
      if (!placement) return;
      const target = this.showDropPlacement(placement);
      if (!target) return;
      this.dropTargetEl = target;
      state.targetId = placement.targetId;
      state.position = placement.position;
    };
    const ownerWindow = this.ownerWindow();
    let finished = false;
    const finishDrag = (applyMove: boolean): void => {
      if (finished) return;
      finished = true;
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onUp);
      ownerWindow.removeEventListener("pointercancel", onUp);
      this.activePointerCleanup = undefined;
      this.rootEl.removeClass("is-dragging-node");
      this.clearDropTarget();
      state.ghostEl?.remove();
      this.setDraggedBranchVisibility(excludedIds, true);
      if (applyMove && state.dragging && state.targetId && state.position) {
        try {
          this.commit((draft) => {
            moveNodes(draft, state.draggedRootIds, state.targetId!, state.position!);
          });
        } catch (error) {
          new Notice(t("notice.operationFailed", { message: error instanceof Error ? error.message : String(error) }));
        }
      }
    };
    const onUp = (): void => finishDrag(true);
    this.activePointerCleanup?.();
    this.activePointerCleanup = () => finishDrag(false);
    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onUp, { once: true });
    ownerWindow.addEventListener("pointercancel", onUp, { once: true });
  }

  /** Clone only the pressed node; descendants never enter the floating preview. */
  private createNodeDragGhost(source: HTMLElement, sourceRect: DOMRect): HTMLElement {
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-node-id");
    ghost.classList.remove("is-selected", "is-editing", "is-drop-before", "is-drop-inside", "is-drop-after");
    ghost.classList.add("mtn-node-drag-ghost");
    ghost.querySelector(".mtn-fold-button")?.remove();
    // Keep the node's unscaled layout dimensions and reproduce the exact
    // current canvas/hover scale on the fixed-position clone. Otherwise text
    // would stay full-sized when dragging from a zoomed-out canvas.
    const layoutWidth = Number.parseFloat(source.style.width) || source.offsetWidth;
    const layoutHeight = Number.parseFloat(source.style.height) || source.offsetHeight;
    ghost.style.width = `${layoutWidth}px`;
    ghost.style.height = `${layoutHeight}px`;
    ghost.style.setProperty("--mtn-drag-scale", String(sourceRect.width / Math.max(1, layoutWidth)));

    // A fixed element can still inherit a transformed coordinate system from
    // an ancestor. Mount the preview directly under <body> so clientX/clientY
    // and its CSS position always refer to the same viewport coordinate space.
    // Copy the view-scoped theme variables that the clone no longer inherits.
    const computedStyle = source.ownerDocument.defaultView?.getComputedStyle(source);
    for (const property of [
      "--mtn-theme-root-accent",
      "--mtn-theme-root-text",
      "--mtn-node-surface",
      "--mtn-node-accent",
      "--mtn-node-bg",
      "--mtn-node-text",
      "--mtn-branch-color",
      "--mtn-node-marker-width",
      "--mtn-node-control-width"
    ]) {
      const value = computedStyle?.getPropertyValue(property).trim();
      if (value) ghost.style.setProperty(property, value);
    }
    if (computedStyle) {
      // Shape rules are scoped to the view element, so preserve their resolved
      // values explicitly after moving the clone outside that element.
      ghost.style.background = computedStyle.background;
      ghost.style.color = computedStyle.color;
      ghost.style.borderColor = computedStyle.borderColor;
      ghost.style.borderStyle = computedStyle.borderStyle;
      ghost.style.borderWidth = computedStyle.borderWidth;
      ghost.style.borderRadius = computedStyle.borderRadius;
    }
    source.ownerDocument.body.appendChild(ghost);
    return ghost;
  }

  private positionNodeDragGhost(state: NodeDragState, clientX: number, clientY: number): void {
    if (!state.ghostEl) return;
    const position = centerDragGhostAtPointer(
      clientX,
      clientY,
      state.renderedWidth,
      state.renderedHeight
    );
    state.ghostEl.style.left = `${position.left}px`;
    state.ghostEl.style.top = `${position.top}px`;
  }

  /** Hide the original source branch in place while preserving its geometry. */
  private setDraggedBranchVisibility(nodeIds: ReadonlySet<NodeId>, visible: boolean): void {
    for (const element of this.nodeLayerEl.querySelectorAll<HTMLElement>(".mtn-node")) {
      const id = element.dataset.nodeId;
      if (id && nodeIds.has(id)) element.toggleClass("is-drag-hidden", !visible);
    }
    for (const path of this.connectionsEl.querySelectorAll<SVGPathElement>(".mtn-connection")) {
      const hidden = Boolean(
        (path.dataset.fromNodeId && nodeIds.has(path.dataset.fromNodeId))
        || (path.dataset.toNodeId && nodeIds.has(path.dataset.toNodeId))
      );
      if (hidden) path.classList.toggle("is-drag-hidden", !visible);
    }
  }

  /** Convert rendered nodes to viewport rectangles for shared node/file hit testing. */
  private resolveCanvasDropPlacement(
    clientX: number,
    clientY: number,
    excludedIds: ReadonlySet<NodeId> = new Set()
  ): DropPlacement | undefined {
    const document = this.document;
    if (!document) return undefined;
    const rects: DropNodeRect[] = [];
    for (const element of this.nodeLayerEl.querySelectorAll<HTMLElement>(".mtn-node[data-node-id]")) {
      const id = element.dataset.nodeId;
      if (!id || !document.nodes[id]) continue;
      const rect = element.getBoundingClientRect();
      rects.push({
        id,
        parentId: findParentId(document, id),
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      });
    }
    return resolveDropPlacement(rects, clientX, clientY, document.settings.layoutMode, excludedIds);
  }

  private showDropPlacement(placement: DropPlacement): HTMLElement | undefined {
    const target = this.nodeLayerEl.querySelector<HTMLElement>(
      `.mtn-node[data-node-id="${CSS.escape(placement.targetId)}"]`
    );
    target?.addClass(`is-drop-${placement.position}`);
    return target ?? undefined;
  }

  private onCanvasPointerDown(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest(".mtn-node") || !this.document) return;
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    this.canvasEl.focus();
    const touchPan = event.pointerType === "touch";
    const mode = event.button === 2 || touchPan ? "pan" : "marquee";
    this.pointerGesture = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      additive: event.ctrlKey || event.metaKey,
      moved: false,
      selectionBeforeMarquee: mode === "marquee" ? new Set(this.selectedIds) : undefined,
      primaryBeforeMarquee: mode === "marquee" ? this.primarySelectedId : undefined
    };
    this.canvasEl.setPointerCapture(event.pointerId);
    if (mode === "marquee") this.updateMarquee(event.clientX, event.clientY);
    else this.canvasEl.addClass("is-panning");
  }

  private onCanvasPointerMove(event: PointerEvent): void {
    // Keep this updated even when there is no active drag gesture. Toolbar zoom
    // can then use the user's last meaningful canvas position as its anchor.
    this.zoomAnchor = { clientX: event.clientX, clientY: event.clientY };
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId || !this.document) return;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3) gesture.moved = true;
    if (gesture.mode === "marquee") {
      this.updateMarquee(event.clientX, event.clientY);
    } else {
      this.viewport.x += event.clientX - gesture.lastX;
      this.viewport.y += event.clientY - gesture.lastY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      this.applyViewport();
    }
  }

  private onCanvasPointerUp(event: PointerEvent): void {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "marquee") {
      // Pointer capture can deliver an up position after the final move event.
      // Apply that last rectangle before ending the live selection gesture.
      this.updateMarquee(event.clientX, event.clientY);
      this.finishMarquee();
    }
    else {
      this.canvasEl.removeClass("is-panning");
      this.suppressContextMenu = gesture.moved;
    }
    if (this.canvasEl.hasPointerCapture(event.pointerId)) this.canvasEl.releasePointerCapture(event.pointerId);
    this.pointerGesture = undefined;
  }

  private updateMarquee(clientX: number, clientY: number): void {
    const gesture = this.pointerGesture;
    if (!gesture) return;
    const canvas = this.canvasEl.getBoundingClientRect();
    const left = Math.min(gesture.startX, clientX) - canvas.left;
    const top = Math.min(gesture.startY, clientY) - canvas.top;
    const width = Math.abs(clientX - gesture.startX);
    const height = Math.abs(clientY - gesture.startY);
    this.marqueeEl.show();
    Object.assign(this.marqueeEl.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    this.refreshMarqueeSelection();
  }

  /** Rebuild selection from the current rectangle on every pointer movement. */
  private refreshMarqueeSelection(): void {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.mode !== "marquee") return;
    const marquee = this.marqueeEl.getBoundingClientRect();
    const nextSelection = gesture.additive
      ? new Set(gesture.selectionBeforeMarquee)
      : new Set<NodeId>();
    let lastIntersectedId: NodeId | undefined;
    for (const element of this.nodeLayerEl.querySelectorAll<HTMLElement>(".mtn-node")) {
      const nodeId = element.dataset.nodeId;
      if (!nodeId || !rectsIntersect(marquee, element.getBoundingClientRect())) continue;
      nextSelection.add(nodeId);
      lastIntersectedId = nodeId;
    }

    this.selectedIds.clear();
    for (const nodeId of nextSelection) this.selectedIds.add(nodeId);
    this.primarySelectedId = lastIntersectedId
      ?? (gesture.primaryBeforeMarquee && nextSelection.has(gesture.primaryBeforeMarquee)
        ? gesture.primaryBeforeMarquee
        : nextSelection.values().next().value as NodeId | undefined);
    this.refreshSelectionStyles();
  }

  private finishMarquee(): void {
    const gesture = this.pointerGesture;
    if (!gesture) return;
    this.marqueeEl.hide();
  }

  private onWheel(event: WheelEvent): void {
    if (!this.document) return;
    event.preventDefault();
    const command = event.ctrlKey || event.metaKey;
    if (command) {
      // Ctrl/Cmd is the only wheel modifier that zooms. Prefer the vertical
      // delta, but accept a horizontal delta produced by Shift+wheel drivers.
      const zoomDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (zoomDelta === 0) return;
      this.zoomAnchor = { clientX: event.clientX, clientY: event.clientY };
      this.zoomAtStep(zoomDelta < 0 ? ZOOM_STEP : -ZOOM_STEP, event.clientX, event.clientY);
      return;
    }

    const horizontal = event.shiftKey;
    const rawDelta = horizontal
      ? (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
      : event.deltaY;
    if (rawDelta === 0) return;
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const delta = wheelDeltaToPixels(
      rawDelta,
      event.deltaMode,
      horizontal ? canvasRect.width : canvasRect.height
    );
    this.viewport = panViewportByWheel(this.viewport, delta, horizontal ? "horizontal" : "vertical");
    this.applyViewport();
  }

  /** Remember files dragged from Obsidian navigation/search elements. */
  private captureInternalFileDrag(event: DragEvent): void {
    const target = event.target as HTMLElement | null;
    const path = target?.closest<HTMLElement>("[data-path]")?.dataset.path;
    const file = path ? this.app.vault.getFileByPath(path) : undefined;
    const payloadPaths = this.resolveDroppedVaultFiles(event.dataTransfer).map((item) => item.path);
    this.dragDropController.rememberInternalPaths([
      ...(file ? [file.path] : []),
      ...payloadPaths
    ]);
  }

  /**
   * Accept the drop while leaving Obsidian's native drag ghost untouched.
   * Bubbling must continue because Obsidian positions its floating file label
   * from document-level drag events; stopping propagation makes that label
   * disappear as soon as the pointer enters this custom view.
   */
  private onCanvasFileDragOver(event: DragEvent): void {
    if (!this.document || !event.dataTransfer) return;
    event.preventDefault();
    const placement = this.resolveCanvasDropPlacement(event.clientX, event.clientY);
    if ((!placement && !this.fileDropPlacement)
      || (placement && this.fileDropPlacement
        && placement.targetId === this.fileDropPlacement.targetId
        && placement.position === this.fileDropPlacement.position)) return;
    this.clearFileDropFeedback();
    this.fileDropPlacement = placement;
    if (placement) this.fileDropTargetEl = this.showDropPlacement(placement);
  }

  private onCanvasFileDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && this.canvasEl.contains(related)) return;
    this.clearFileDropFeedback();
  }

  /** Resolve internal files or import external files, then insert at the live target. */
  private async onCanvasFileDrop(event: DragEvent): Promise<void> {
    const document = this.document;
    const transfer = event.dataTransfer;
    if (!document || !transfer) return;
    event.preventDefault();
    event.stopPropagation();
    const placement = this.resolveCanvasDropPlacement(event.clientX, event.clientY) ?? this.fileDropPlacement;
    let parentId = document.rootId;
    let insertionIndex: number | undefined;
    if (placement?.position === "inside" && document.nodes[placement.targetId]) {
      parentId = placement.targetId;
    } else if (placement) {
      const resolvedParentId = findParentId(document, placement.targetId);
      if (resolvedParentId) {
        parentId = resolvedParentId;
        const targetIndex = getNode(document, parentId).childIds.indexOf(placement.targetId);
        insertionIndex = targetIndex + (placement.position === "after" ? 1 : 0);
      }
    }
    const externalFiles = Array.from(transfer.files);
    const payloadFiles = this.resolveDroppedVaultFiles(transfer);
    const capturedFiles = this.dragDropController.takeInternalPaths()
      .map((path) => this.app.vault.getFileByPath(path))
      .filter((file): file is TFile => file !== null);
    const internalFiles = deduplicateFiles([...capturedFiles, ...payloadFiles]);
    this.clearFileDropFeedback();

    const linkedFiles: Array<{ file: TFile; reference: FileResourceRef }> = [];
    const failures: string[] = [];
    if (internalFiles.length > 0) {
      for (const file of internalFiles) {
        // The current document cannot meaningfully link to itself, but other
        // mind-tree documents are valid resources and receive an automatic badge.
        if (file.path === this.file?.path) continue;
        try {
          linkedFiles.push({ file, reference: await this.plugin.resources.ensureStableReference(file) });
        } catch (error) {
          failures.push(`${file.path}: ${this.describeResourceError(error)}`);
        }
      }
    } else {
      const batch = this.dragDropController.classifyExternalFiles(externalFiles);
      for (const source of batch.rejected) failures.push(t("notice.fileTooLarge", { name: source.name }));
      if (batch.needsConfirmation && !await confirmLargeExternalFiles(this.app, batch.importable)) return;
      for (const source of batch.importable) {
        try {
          linkedFiles.push(await this.plugin.resources.importExternalFile(source, this.file?.path ?? ""));
        } catch (error) {
          failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (linkedFiles.length > 0) {
      const createdIds: NodeId[] = [];
      this.commit((draft) => {
        const effectiveParentId = draft.nodes[parentId] ? parentId : draft.rootId;
        const parent = getNode(draft, effectiveParentId);
        parent.collapsed = false;
        let nextIndex = insertionIndex;
        for (const { file, reference } of linkedFiles) {
          const node = addNode(draft, effectiveParentId, linkedFileTitle(file.path), nextIndex);
          node.resource = reference;
          node.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
          createdIds.push(node.id);
          if (nextIndex !== undefined) nextIndex += 1;
        }
      });
      const lastCreatedId = createdIds.at(-1);
      if (lastCreatedId) {
        this.selectOnly(lastCreatedId);
        this.centerNodeInViewport(lastCreatedId);
      }
      new Notice(t("notice.filesDropped", { count: linkedFiles.length }));
    } else if (failures.length === 0) {
      new Notice(t("notice.noDroppedFiles"));
    }
    if (failures.length > 0) {
      new Notice(t("notice.fileDropFailed", { count: failures.length, details: failures.join("; ") }));
    }
  }

  /** Read all string payloads and resolve direct paths, links and Obsidian URIs. */
  private resolveDroppedVaultFiles(transfer: DataTransfer | null): TFile[] {
    if (!transfer) return [];
    const payloads: string[] = [];
    for (const type of Array.from(transfer.types)) {
      if (type === "Files") continue;
      try {
        const value = transfer.getData(type);
        if (value) payloads.push(value);
      } catch { /* Some platform-owned drag formats cannot be read by plugins. */ }
    }
    const sourcePath = this.file?.path ?? "";
    const files: TFile[] = [];
    for (const candidate of extractVaultPathCandidates(payloads, this.app.vault.getName())) {
      const normalized = candidate.replace(/^\/+/, "");
      const direct = this.app.vault.getFileByPath(normalized);
      const linked = direct ?? this.app.metadataCache.getFirstLinkpathDest(normalized, sourcePath);
      if (linked) files.push(linked);
    }
    return deduplicateFiles(files);
  }

  private clearFileDropFeedback(): void {
    this.fileDropTargetEl?.removeClass("is-file-drop-target", "is-drop-before", "is-drop-inside", "is-drop-after");
    this.fileDropTargetEl = undefined;
    this.fileDropPlacement = undefined;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.saveImmediately();
      return;
    }
    if (isTextEditingTarget(event.target)) return;
    if (command && !event.altKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && this.primarySelectedId) {
      event.preventDefault();
      this.moveSelectedAmongSiblings(event.key === "ArrowUp" ? "up" : "down");
      return;
    }
    if (!command
      && !event.altKey
      && !event.shiftKey
      && isNavigationArrow(event.key)
      && this.primarySelectedId) {
      event.preventDefault();
      this.navigateSelection(event.key);
      return;
    }
    if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      for (const position of this.currentLayout?.nodes ?? []) this.selectedIds.add(position.id);
      this.primarySelectedId = this.currentLayout?.nodes.at(-1)?.id;
      this.render();
      return;
    }
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void this.copySelected("branch");
      return;
    }
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      void this.cutSelected();
      return;
    }
    if (command && event.key.toLowerCase() === "e" && this.primarySelectedId) {
      event.preventDefault();
      this.createNoteForSelection();
      return;
    }
    if (event.key === "Tab" && this.primarySelectedId) {
      event.preventDefault();
      // A held Tab must not create a deep chain (or repeatedly insert parents)
      // after an editor hands focus back to the canvas. Distinct presses remain
      // unrestricted because they arrive with repeat=false.
      if (!shouldHandleStructuralCreationKey(event.key, event.repeat)) return;
      if (event.shiftKey) this.addParentNode();
      else this.addChildNode();
      return;
    }
    if (!command && !event.altKey && event.key === " " && this.primarySelectedId) {
      event.preventDefault();
      this.beginEdit(this.primarySelectedId, "end");
    } else if (event.key === "Enter" && this.primarySelectedId) {
      event.preventDefault();
      // Holding Enter produces repeat keydown events after the editor has
      // handed focus back to the canvas. Consume those events without creating
      // branches; quick independent presses still all have repeat=false.
      if (!shouldHandleStructuralCreationKey(event.key, event.repeat)) return;
      this.addSiblingNode(event.shiftKey ? "before" : "after");
    } else if ((event.key === "Delete" || event.key === "Backspace") && this.primarySelectedId) {
      event.preventDefault();
      this.requestDeleteBranch(this.primarySelectedId);
    } else if (event.key === "Escape") {
      this.cancelEdit();
      this.clearDropTarget();
    }
  }

  /** Reorder only the primary selection; other selected nodes remain selected. */
  private moveSelectedAmongSiblings(direction: "up" | "down"): void {
    const document = this.document;
    const nodeId = this.primarySelectedId;
    if (!document || !nodeId || nodeId === document.rootId) return;
    const parentId = findParentId(document, nodeId);
    if (!parentId) return;
    const siblings = getNode(document, parentId).childIds;
    const index = siblings.indexOf(nodeId);
    const targetIndex = index + (direction === "up" ? -1 : 1);
    // Check before commit so hitting a list boundary does not dirty the file or
    // consume an undo slot even though the browser shortcut is still suppressed.
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return;
    this.commit((draft) => { moveNodeAmongSiblings(draft, nodeId, direction); });
  }

  /** Move the single keyboard focus without changing document structure. */
  private navigateSelection(key: NavigationArrow): void {
    const document = this.document;
    const currentId = this.primarySelectedId;
    if (!document || !currentId) return;
    const targetId = resolveArrowNavigationTarget(
      document,
      currentId,
      key,
      document.settings.layoutMode,
      this.currentLayout?.nodes
    );
    if (!targetId || !document.nodes[targetId]) return;
    this.selectOnly(targetId);
    this.centerNodeInViewport(targetId);
    this.canvasEl.focus({ preventScroll: true });
  }

  private onDocumentPaste(event: ClipboardEvent): void {
    if (!this.document || this.parseError || !this.shouldCaptureDocumentPaste(event)) return;
    const context: PasteInsertionContext = {
      parentId: this.resolveInsertionParentId(),
      documentSessionToken: this.documentSessionToken
    };
    this.clipboardController.handlePaste(
      event,
      context,
      (candidate) => Boolean(this.document
        && this.documentSessionToken === candidate.documentSessionToken),
      (content, candidate) => this.applyClipboardPasteContent(content, candidate)
    );
  }

  /** Decide whether document-level capture belongs to this active tree. */
  private shouldCaptureDocumentPaste(event: ClipboardEvent): boolean {
    const ownerWindow = this.rootEl.ownerDocument.defaultView;
    const ElementConstructor = ownerWindow?.Element;
    const path = event.composedPath?.() ?? [event.target].filter((item): item is EventTarget => Boolean(item));
    const elements = ElementConstructor
      ? path.filter((item): item is Element => item instanceof ElementConstructor)
      : [];
    const editable = elements.find((element) => element.matches(
      "input,textarea,[contenteditable='true'],[role='textbox'],.cm-editor"
    ));
    const targetInView = elements.some((element) => element === this.rootEl || this.rootEl.contains(element));
    // Elements under display:none ancestors have no client rects. They are the
    // stale-focus case this document listener exists to recover from.
    const targetVisible = Boolean(editable && editable.getClientRects().length > 0);
    const nativePasteSurfaceVisible = elements.some((element) => element.matches(
      ".modal-container,.modal,.menu,.popover,.suggestion-container,[role='dialog']"
    ) && element.getClientRects().length > 0);
    return shouldHandleMindTreePaste({
      viewActive: this.app.workspace.getMostRecentLeaf()?.view === this,
      targetInView,
      targetEditable: Boolean(editable),
      targetVisible,
      nativePasteSurfaceVisible
    });
  }

  /** Route structured branches, direct text, URLs, and multiline import once. */
  private applyClipboardPasteContent(
    content: ClipboardPasteContent,
    context: PasteInsertionContext
  ): void {
    if (!this.document || this.documentSessionToken !== context.documentSessionToken) return;
    if (content.kind === "structured") {
      void this.insertResolvedBranches(
        content.payload,
        context.parentId,
        context.documentSessionToken,
        "paste"
      );
      return;
    }
    if (content.kind === "empty") return;
    const directPaste = classifyDirectTextPaste(content.text);
    if (directPaste.kind === "empty") return;
    if (directPaste.kind === "multiline") {
      this.showTextImportModal(directPaste.text, context);
      return;
    }
    this.insertDirectTextNode(directPaste, context.parentId);
  }

  /** Resolve imported links before committing the complete forest atomically. */
  private async insertResolvedBranches(
    payload: BranchClipboardPayload,
    requestedParentId: NodeId,
    documentSessionToken: string,
    source: "paste" | "import"
  ): Promise<boolean> {
    let resolution;
    try {
      resolution = await resolveMarkdownBranchLinks(
        payload,
        async (linkPath) => {
          const file = this.resolvePastedFileLink(linkPath);
          return file ? this.plugin.resources.ensureStableReference(file) : undefined;
        },
        this.plugin.settings.titleSync
      );
    } catch (error) {
      new Notice(this.describeResourceError(error));
      return false;
    }
    if (!this.document || this.documentSessionToken !== documentSessionToken) return false;
    if (resolution.unresolvedFileLinks.length > 0) {
      new Notice(t(
        source === "import" ? "notice.importLinksUnresolved" : "notice.pasteLinksUnresolved",
        { count: resolution.unresolvedFileLinks.length }
      ));
    }
    const parentId = this.document.nodes[requestedParentId] ? requestedParentId : this.document.rootId;
    let insertedIds: NodeId[] = [];
    this.commit((draft) => { insertedIds = insertBranches(draft, parentId, resolution.payload); });
    const firstInsertedId = insertedIds[0];
    if (firstInsertedId) {
      this.selectOnly(firstInsertedId);
      this.centerNodeInViewport(firstInsertedId);
    }
    if (source === "import" && insertedIds.length > 0) {
      new Notice(t("notice.textImported", { count: Object.keys(resolution.payload.nodes).length }));
    }
    return insertedIds.length > 0;
  }

  /** Add one external plain-text/URL paste without invoking import heuristics. */
  private insertDirectTextNode(
    paste: Extract<DirectTextPaste, { kind: "text" | "url" }>,
    requestedParentId: NodeId
  ): void {
    let insertedId = "";
    this.commit((draft) => {
      const parentId = draft.nodes[requestedParentId] ? requestedParentId : draft.rootId;
      const node = addNode(draft, parentId, paste.title);
      insertedId = node.id;
      if (paste.kind === "url") {
        node.resource = { type: "url", url: paste.url };
        node.titleSync = "off";
      }
    });
    if (!insertedId) return;
    this.selectOnly(insertedId);
    this.centerNodeInViewport(insertedId);
  }

  /** Open an empty toolbar import or a multiline-paste import with prefilled data. */
  private showTextImportModal(initialText = "", pasteContext?: PasteInsertionContext): void {
    const document = this.document;
    if (!document || this.parseError) return;
    const documentSessionToken = pasteContext?.documentSessionToken ?? this.documentSessionToken;
    if (documentSessionToken !== this.documentSessionToken) return;
    const parentId = pasteContext?.parentId ?? this.resolveInsertionParentId();
    new TextImportModal(this.app, initialText, async ({ text, rule }) => (
      this.importText(text, rule, parentId, documentSessionToken)
    )).open();
  }

  /** Return an error for the open modal, or undefined after one successful commit. */
  private async importText(
    source: string,
    rule: TextImportRule,
    parentId: NodeId,
    documentSessionToken: string
  ): Promise<string | undefined> {
    const payload = parseTextImport(source, rule);
    if (!payload) return t("modal.import.noValidContent");
    const inserted = await this.insertResolvedBranches(payload, parentId, documentSessionToken, "import");
    return inserted ? undefined : t("modal.import.targetChanged");
  }

  private resolveInsertionParentId(): NodeId {
    const document = this.document;
    if (!document) return "";
    return this.primarySelectedId && document.nodes[this.primarySelectedId]
      ? this.primarySelectedId
      : document.rootId;
  }

  /** Resolve Wiki/Markdown targets relative to the current mind-tree file. */
  private resolvePastedFileLink(rawLinkPath: string): TFile | undefined {
    let linkPath = rawLinkPath.trim().replace(/^<|>$/g, "");
    try { linkPath = decodeURIComponent(linkPath); } catch { /* Keep the literal Obsidian path. */ }
    linkPath = linkPath.split("#", 1)[0]?.trim() ?? "";
    if (!linkPath) return undefined;
    const sourcePath = this.file?.path ?? "";
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (resolved) return resolved;
    const directPath = normalizePath(linkPath.replace(/^\/+/, ""));
    return this.app.vault.getFileByPath(directPath) ?? undefined;
  }

  private showNodeMenu(event: MouseEvent, nodeId: NodeId): void {
    const document = this.document;
    const node = document?.nodes[nodeId];
    if (!document || !node) return;
    if (!this.selectedIds.has(nodeId)) this.selectOnly(nodeId);
    const menu = new Menu();
    const linkedFile = node.resource?.type === "file";
    if (linkedFile) {
      const syncing = node.titleSync === "bidirectional";
      menu.addItem((item) => item
        .setTitle(syncing ? t("menu.disableTitleSync") : t("menu.enableTitleSync"))
        .setIcon(syncing ? "unlink" : "refresh-cw")
        .onClick(() => syncing
          ? this.commit((draft) => { getNode(draft, nodeId).titleSync = "off"; })
          : void this.enableTitleSync(nodeId)));
    } else if (!node.resource) {
      menu.addItem((item) => item.setTitle(t("menu.addNote")).setIcon("file-plus-2").onClick(() => void this.createNoteForNode(nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.addNoteFromTemplate")).setIcon("copy-plus").onClick(() => this.showTemplateNotePicker(nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.linkNote")).setIcon("file-search").onClick(() => this.linkExistingNote(nodeId)));
    }
    menu.addItem((item) => item.setTitle(t("menu.linkWeb")).setIcon("link").onClick(() => this.linkUrl(nodeId)));
    if (node.resource) {
      menu.addItem((item) => item.setTitle(t("menu.openResource")).setIcon("external-link").onClick(() => void this.openResource(nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.unlinkResource")).setIcon(CHAIN_BROKEN_ICON).onClick(() => this.commit((draft) => {
        const draftNode = getNode(draft, nodeId);
        delete draftNode.resource;
        delete draftNode.titleSync;
      })));
    }
    menu.addItem((item) => item
      .setTitle(t("menu.markers"))
      .setIcon("tags")
      .onClick(() => this.showMarkerPopover(nodeId, { x: event.clientX, y: event.clientY })));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.addChild")).setIcon("corner-down-right").onClick(() => {
      this.selectOnly(nodeId);
      this.addChildNode();
    }));
    if (nodeId !== document.rootId) {
      menu.addItem((item) => item.setTitle(t("menu.addSibling")).setIcon("list-plus").onClick(() => {
        let createdId = "";
        this.commit((draft) => { createdId = addSibling(draft, nodeId, t("node.untitled")).id; });
        this.finishInteractiveNodeCreation(createdId);
      }));
    }
    if (node.childIds.length > 0) {
      menu.addItem((item) => item.setTitle(node.collapsed ? t("menu.expand") : t("menu.collapse")).setIcon(node.collapsed ? "unfold-vertical" : "fold-vertical").onClick(() => this.commit((draft) => toggleCollapsed(draft, nodeId), nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.expandAll")).setIcon("chevrons-down").onClick(() => this.commit((draft) => setAllCollapsed(draft, nodeId, false), nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.collapseAll")).setIcon("chevrons-up").onClick(() => this.commit((draft) => setAllCollapsed(draft, nodeId, true), nodeId)));
    }
    if (nodeId !== document.rootId) {
      menu.addItem((item) => item.setTitle(t("menu.deleteBranch", { count: this.getSelectedBranchNodeIds(nodeId).length })).setIcon("trash-2").setWarning(true).onClick(() => this.requestDeleteBranch(nodeId)));
      menu.addItem((item) => item.setTitle(t("menu.deleteNodeOnly")).setIcon("git-pull-request-arrow").onClick(() => this.requestDeleteNodeOnly(nodeId)));
    }
    menu.addSeparator();
    const branchHasNotes = collectBranchIds(document, nodeId).some((id) => {
      const resource = document.nodes[id]?.resource;
      return resource?.type === "file" && resource.fileKind === "note";
    });
    menu.addItem((item) => item
      .setTitle(t("menu.moveNotes"))
      .setIcon("folder-input")
      .setDisabled(!branchHasNotes)
      .onClick(() => this.showMoveNotesModal(nodeId)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.copyBranch")).setIcon("copy").onClick(() => void this.copySelected("branch")));
    menu.addItem((item) => item.setTitle(t("menu.copyMarkdown")).setIcon("list-tree").onClick(() => void this.copySelected("markdown")));
    menu.addItem((item) => item.setTitle(t("menu.exportBranchPng")).setIcon("image-down").onClick(() => void this.exportSelectedPng()));
    menu.showAtMouseEvent(event);
  }

  /** Manual icons and the automatic mind-tree badge follow the title visually. */
  private renderNodeMarkers(element: HTMLElement, node: MindTreeNode): void {
    const markers = getVisibleNodeMarkers(node);
    const hasMindTreeMarker = hasMindTreeResourceMarker(node);
    const hasExcalidrawMarker = hasExcalidrawResourceMarker(node);
    if (markers.length === 0 && !hasMindTreeMarker && !hasExcalidrawMarker) return;
    const container = element.createDiv("mtn-node-markers");
    for (const marker of markers) {
      const markerEl = container.createSpan({
        cls: `mtn-node-marker is-${marker.type} is-${marker.value}`,
        attr: { role: "img", "aria-label": nodeMarkerLabel(marker.type, marker.value) }
      });
      if (marker.type === "progress") {
        setIcon(markerEl, marker.value === "todo"
          ? "circle"
          : marker.value === "inprogress"
            ? "loader-circle"
            : marker.value === "done" ? "circle-check" : "circle-x");
      } else {
        setIcon(markerEl, "flag");
      }
    }
    if (hasMindTreeMarker) {
      container.createSpan({
        cls: "mtn-node-marker is-mind-tree",
        text: t("node.mindTreeMarker"),
        attr: { role: "img", "aria-label": t("node.mindTreeMarker") }
      });
    }
    if (hasExcalidrawMarker) {
      container.createSpan({
        cls: "mtn-node-marker is-excalidraw",
        text: t("node.drawingMarker"),
        attr: { role: "img", "aria-label": t("node.drawingMarker") }
      });
    }
  }

  /** Open the shared icon palette for the selected or context-clicked node. */
  private showMarkerPopover(nodeId: NodeId, position: { x: number; y: number }): void {
    if (!this.document?.nodes[nodeId]) return;
    this.markerPopover?.close();
    this.markerPopover = openMarkerPopover({
      ownerDocument: this.rootEl.ownerDocument,
      position,
      readNode: () => this.document?.nodes[nodeId],
      updateNode: (mutator) => this.commit((draft) => {
        const node = getNode(draft, nodeId);
        mutator(node);
        const updatedAt = new Date().toISOString();
        node.updatedAt = updatedAt;
        draft.updatedAt = updatedAt;
      }),
      onClose: () => { this.markerPopover = undefined; }
    });
  }

  private showCopyMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("menu.copyBranch")).setIcon("copy").onClick(() => void this.copySelected("branch")));
    menu.addItem((item) => item.setTitle(t("menu.copyMarkdown")).setIcon("list-tree").onClick(() => void this.copySelected("markdown")));
    menu.showAtMouseEvent(event);
  }

  private showExportMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("menu.exportPng")).setIcon("image-down").onClick(() => void this.exportSelectedPng()));
    menu.addItem((item) => item.setTitle(t("menu.exportMarkdown")).setIcon("file-down").onClick(() => this.exportSelectedMarkdown()));
    menu.showAtMouseEvent(event);
  }

  private async copySelected(mode: "branch" | "markdown"): Promise<void> {
    if (!this.document || !this.primarySelectedId) return;
    try {
      const selected = this.selectedIds.size > 0 ? this.selectedIds : [this.primarySelectedId];
      await copyBranches(this.document, selected, mode);
      new Notice(mode === "branch" ? t("notice.branchCopied") : t("notice.markdownCopied"));
    } catch (error) {
      new Notice(t("notice.copyFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async exportSelectedPng(): Promise<void> {
    if (!this.document || !this.primarySelectedId) return;
    try {
      await exportBranchPng(
        this.document,
        this.primarySelectedId,
        this.plugin.settings.pngScale,
        this.plugin.settings.nodeWrapWidth,
        this.document.settings.layoutMode,
        this.document.settings.connectionStyle,
        this.document.settings.theme,
        this.document.settings.nodeShape,
        this.plugin.settings.nodeAlignment,
        this.resolveExportThemeColors()
      );
    } catch (error) {
      new Notice(t("notice.pngFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  private exportSelectedMarkdown(): void {
    if (!this.document || !this.primarySelectedId) return;
    const node = this.document.nodes[this.primarySelectedId];
    if (!node) return;
    downloadMarkdown(renderBranchMarkdown(this.document, this.primarySelectedId), node.title || "mind-tree");
  }

  private async createNoteForNode(nodeId: NodeId): Promise<void> {
    const document = this.document;
    const node = document?.nodes[nodeId];
    if (!document || !node) return;
    const create = async (title: string): Promise<void> => {
      let createdFile: TFile;
      try {
        const treeDirectory = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
        const directory = this.plugin.settings.newNoteFolder || treeDirectory;
        const { file, reference } = await this.plugin.resources.createNote(
          directory,
          title,
          this.plugin.settings.newNoteDefaultContent
        );
        createdFile = file;
        this.commit((draft) => {
          const draftNode = getNode(draft, nodeId);
          draftNode.title = file.basename;
          draftNode.resource = reference;
          draftNode.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
        });
      } catch (error) {
        new Notice(t("notice.createNoteFailed", { message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      try {
        await this.openCreatedNote(createdFile);
      } catch (error) {
        // The file and node association already exist at this point. Report only
        // the navigation failure instead of incorrectly claiming creation failed.
        new Notice(t("notice.openCreatedNoteFailed", { message: error instanceof Error ? error.message : String(error) }));
      }
    };
    if (node.title.trim()) await create(node.title);
    else new TextPromptModal(this.app, t("modal.createNote.title"), "", t("modal.createNote.placeholder"), t("action.create"), (value) => void create(value)).open();
  }

  /** Open a searchable list containing every Markdown file under Template folder. */
  private showTemplateNotePicker(nodeId: NodeId): void {
    const node = this.document?.nodes[nodeId];
    if (!node || node.resource) return;
    const templateFolder = this.plugin.settings.templateFolder.trim();
    if (!templateFolder) {
      new Notice(t("notice.templateFolderNotConfigured"));
      return;
    }
    const templates = this.plugin.resources.templateFiles(templateFolder);
    if (templates.length === 0) {
      new Notice(t("notice.noTemplates"));
      return;
    }
    new TemplateSuggestModal(
      this.app,
      templates,
      (template) => void this.createNoteFromTemplate(nodeId, template)
    ).open();
  }

  /** Copy the selected template, attach the copy, then use normal note opening. */
  private async createNoteFromTemplate(nodeId: NodeId, template: TFile): Promise<void> {
    const node = this.document?.nodes[nodeId];
    if (!node) return;
    if (node.resource) {
      new Notice(t("notice.nodeAlreadyLinked"));
      return;
    }
    let createdFile: TFile;
    try {
      const treeDirectory = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
      const directory = this.plugin.settings.newNoteFolder || treeDirectory;
      const result = await this.plugin.resources.createNoteFromTemplate(
        directory,
        node.title.trim() || t("node.untitled"),
        template
      );
      createdFile = result.file;
      // The modal can stay open while the tree changes. Do not attach a copied
      // note to a node that has since disappeared or gained another resource.
      const current = this.document?.nodes[nodeId];
      if (!current || current.resource) {
        await this.app.vault.delete(createdFile);
        this.plugin.resources.removePath(createdFile.path);
        throw new Error(t("notice.templateTargetChanged"));
      }
      this.commit((draft) => {
        const draftNode = getNode(draft, nodeId);
        draftNode.title = createdFile.basename;
        draftNode.resource = result.reference;
        draftNode.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
      });
    } catch (error) {
      new Notice(t("notice.createTemplateNoteFailed", { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    try {
      await this.openCreatedNote(createdFile);
    } catch (error) {
      new Notice(t("notice.openCreatedNoteFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Return whether the selected node consumed the create-note shortcut. */
  private createNoteForSelection(): boolean {
    const nodeId = this.primarySelectedId;
    const node = nodeId ? this.document?.nodes[nodeId] : undefined;
    if (!node) return false;
    // Linked nodes intentionally have no second "create note" operation. Give
    // explicit feedback while still consuming Mod+E so Obsidian cannot replace
    // this custom view with its global editing-mode action.
    if (node.resource) {
      new Notice(t("notice.nodeAlreadyLinked"));
      return true;
    }
    void this.createNoteForNode(node.id);
    return true;
  }

  /** Open a newly created note according to the global mind-map preference. */
  private async openCreatedNote(file: TFile): Promise<void> {
    const mode = this.plugin.settings.newNoteOpenMode;
    const leaf = mode === "current"
      ? this.leaf
      : mode === "split-right"
        ? this.app.workspace.getLeaf("split", "vertical")
        : this.app.workspace.getLeaf(mode === "window" ? "window" : "tab");
    await leaf.openFile(file, { active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private linkExistingNote(nodeId: NodeId): void {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path !== this.file?.path);
    new FileSuggestModal(this.app, files, (file) => void (async () => {
      try {
        const reference = await this.plugin.resources.ensureStableReference(file);
        this.commit((draft) => {
          const node = getNode(draft, nodeId);
          node.title = linkedFileTitle(file.path);
          node.resource = reference;
          node.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
        });
      } catch (error) {
        new Notice(t("notice.linkNoteFailed", { message: this.describeResourceError(error) }));
      }
    })()).open();
  }

  private linkUrl(nodeId: NodeId): void {
    new UrlPromptModal(this.app, (url, title) => this.commit((draft) => {
      const node = getNode(draft, nodeId);
      node.title = title;
      node.resource = { type: "url", url };
      node.titleSync = "off";
    })).open();
  }

  /** Open a searchable vault-folder picker for the current note or its branch. */
  private showMoveNotesModal(nodeId: NodeId): void {
    const document = this.document;
    if (!document?.nodes[nodeId]) return;
    const branchNodeIds = collectBranchIds(document, nodeId);
    const branchReferences = new Map<string, FileResourceRef>();
    for (const id of branchNodeIds) {
      const resource = document.nodes[id]?.resource;
      if (resource?.type === "file" && resource.fileKind === "note") {
        branchReferences.set(resource.resourceId, { ...resource });
      }
    }
    const currentResource = document.nodes[nodeId]?.resource;
    const currentReference = currentResource?.type === "file" && currentResource.fileKind === "note"
      ? { ...currentResource }
      : undefined;
    const folderPaths = this.app.vault.getAllFolders(true)
      .map((folder) => folder.isRoot() ? "" : folder.path)
      .sort((left, right) => left.localeCompare(right));
    const currentFolderPath = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
    new MoveNotesModal(
      this.app,
      folderPaths,
      currentFolderPath,
      currentReference !== undefined,
      branchReferences.size > 0,
      (folderPath, mode) => {
        const references = mode === "current" && currentReference
          ? [currentReference]
          : [...branchReferences.values()];
        void this.moveNotesToFolder(references, folderPath);
      }
    ).open();
  }

  /** Move unique note files and persist every matching path hint in this tree. */
  private async moveNotesToFolder(
    references: FileResourceRef[],
    destinationFolder: string
  ): Promise<void> {
    const movedPaths = new Map<string, string>();
    const failures: string[] = [];
    for (const reference of references) {
      try {
        const moved = await this.plugin.resources.moveLinkedFile(reference, destinationFolder);
        movedPaths.set(reference.resourceId, moved.path);
      } catch (error) {
        failures.push(`${reference.pathHint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.applySystemMutation((draft) => {
      let changed = false;
      for (const node of Object.values(draft.nodes)) {
        if (node.resource?.type !== "file") continue;
        const path = movedPaths.get(node.resource.resourceId);
        if (!path || node.resource.pathHint === path) continue;
        node.resource.pathHint = path;
        changed = true;
      }
      return changed;
    });
    if (movedPaths.size > 0) {
      new Notice(t("notice.notesMoved", {
        count: movedPaths.size,
        folder: destinationFolder || "/"
      }));
    }
    if (failures.length > 0) {
      new Notice(t("notice.moveNotesFailed", { count: failures.length, details: failures.join("; ") }));
    }
  }

  private async enableTitleSync(nodeId: NodeId): Promise<void> {
    const node = this.document?.nodes[nodeId];
    if (node?.resource?.type !== "file") return;
    const resourceId = node.resource.resourceId;
    try {
      const file = await this.plugin.resources.renameLinkedFile(node.resource, node.title);
      const current = this.document?.nodes[nodeId];
      if (current?.resource?.type !== "file" || current.resource.resourceId !== resourceId) return;
      this.commit((draft) => {
        const draftNode = getNode(draft, nodeId);
        if (draftNode.resource?.type !== "file" || draftNode.resource.resourceId !== resourceId) return;
        draftNode.resource.pathHint = file.path;
        draftNode.titleSync = "bidirectional";
      });
      new Notice(t("notice.syncEnabled"));
    } catch (error) {
      new Notice(t("notice.renameFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async openResource(nodeId: NodeId): Promise<void> {
    const resource = this.document?.nodes[nodeId]?.resource;
    if (!resource) return;
    if (resource.type === "url") {
      let parsed: URL;
      try { parsed = new URL(resource.url); } catch { new Notice(t("notice.invalidLink")); return; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        new Notice(t("notice.unsafeLink"));
        return;
      }
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
      return;
    }
    const file = this.plugin.resources.resolve(resource);
    if (!file) {
      new Notice(t("notice.fileNotFound", { path: resource.pathHint }));
      return;
    }
    const leaf = this.plugin.settings.resourceOpenMode === "split-right"
      ? this.app.workspace.getLeaf("split", "vertical")
      : this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private requestDeleteBranch(nodeId: NodeId): void {
    const document = this.document;
    if (!document) return;
    const targetNodeIds = getTopLevelSelectedNodeIds(document, this.selectedIds.has(nodeId) ? this.selectedIds : [nodeId]);
    const topicNodeIds = targetNodeIds.flatMap((id) => collectBranchIds(document, id));
    if (targetNodeIds.length > 0) this.openDeleteDialog(targetNodeIds, topicNodeIds, "branch");
  }

  /**
   * Resolve Obsidian CSS variables before handing colors to SVG. Custom
   * properties retain `var(...)` tokens when read directly, so a hidden probe
   * asks the browser for the final computed color in the current light/dark mode.
   */
  private resolveExportThemeColors(): ExportThemeColors | undefined {
    const theme = this.document?.settings.theme;
    if (theme !== "flat" && theme !== "minimal" && theme !== "floating") return undefined;

    const ownerDocument = this.rootEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return undefined;
    const probe = ownerDocument.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    this.rootEl.appendChild(probe);
    const resolve = (property: string, fallback: string): string => {
      probe.style.color = `var(${property}, ${fallback})`;
      return ownerWindow.getComputedStyle(probe).color.trim() || fallback;
    };
    try {
      return {
        canvas: resolve("--mtn-canvas-base", "#F7F3E8"),
        root: resolve("--mtn-theme-root-accent", "#7C3AED"),
        rootText: resolve("--mtn-theme-root-text", "#FFFFFF"),
        levelOne: resolve("--mtn-theme-level-one", "#4A4A4A"),
        levelOneText: resolve("--mtn-theme-level-one-text", "#FFFFFF"),
        descendant: resolve("--mtn-theme-descendant", "#E2E0DB"),
        descendantText: resolve("--mtn-theme-descendant-text", "#2F2F2F")
      };
    } finally {
      probe.remove();
    }
  }

  /** Return the de-duplicated topic union represented by the current selection. */
  private getSelectedBranchNodeIds(nodeId: NodeId): NodeId[] {
    const document = this.document;
    if (!document) return [];
    const roots = getTopLevelSelectedNodeIds(document, this.selectedIds.has(nodeId) ? this.selectedIds : [nodeId]);
    return roots.flatMap((id) => collectBranchIds(document, id));
  }

  /** The node-only menu action uses the same safety dialog but promotes children. */
  private requestDeleteNodeOnly(nodeId: NodeId): void {
    const document = this.document;
    if (!document || nodeId === document.rootId) return;
    const targetNodeIds = [...new Set(this.selectedIds.has(nodeId) ? this.selectedIds : [nodeId])]
      .filter((id) => id !== document.rootId && Boolean(document.nodes[id]));
    if (targetNodeIds.length > 0) this.openDeleteDialog(targetNodeIds, targetNodeIds, "node-only");
  }

  private openDeleteDialog(
    targetNodeIds: NodeId[],
    topicNodeIds: NodeId[],
    structureMode: "branch" | "node-only"
  ): void {
    const document = this.document;
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
    new DeleteBranchModal(
      this.app,
      { topicTitles, filePaths: resources.map((resource) => resource.pathHint) },
      (action) => void this.executeDeleteBranch(targetNodeIds, topicNodeIds, resources, action, structureMode)
    ).open();
  }

  /** Execute the dialog choice; real files are moved through Obsidian's trash. */
  private async executeDeleteBranch(
    targetNodeIds: NodeId[],
    topicNodeIds: NodeId[],
    resources: FileResourceRef[],
    action: DeleteBranchAction,
    structureMode: "branch" | "node-only"
  ): Promise<void> {
    if (action === "topics-only") {
      this.deleteTopics(targetNodeIds, structureMode);
      return;
    }

    const deletedResourceIds = new Set<string>();
    const failedPaths: string[] = [];
    for (const resource of resources) {
      const file = this.plugin.resources.resolve(resource);
      if (!file) {
        failedPaths.push(resource.pathHint);
        continue;
      }
      try {
        await this.app.fileManager.trashFile(file);
        deletedResourceIds.add(resource.resourceId);
      } catch {
        failedPaths.push(resource.pathHint);
      }
    }

    if (action === "topics-and-files") {
      this.deleteTopics(targetNodeIds, structureMode);
    } else if (deletedResourceIds.size > 0) {
      // Keeping topics means their now-deleted files must also be unlinked; a
      // stale resource reference would misleadingly look like a sync failure.
      this.commit((draft) => {
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
  private deleteTopics(targetNodeIds: NodeId[], structureMode: "branch" | "node-only"): void {
    const document = this.document;
    if (!document || targetNodeIds.length === 0) return;
    const anchorId = targetNodeIds.find((id) => id === this.primarySelectedId)
      ?? targetNodeIds.find((id) => this.primarySelectedId && collectBranchIds(document, id).includes(this.primarySelectedId))
      ?? targetNodeIds[0];
    const affected = new Set(structureMode === "branch"
      ? targetNodeIds.flatMap((id) => collectBranchIds(document, id))
      : targetNodeIds);
    let parentId = anchorId ? findParentId(document, anchorId) : undefined;
    while (parentId && affected.has(parentId)) parentId = findParentId(document, parentId);
    const nextSelectionId = parentId ?? document.rootId;
    this.commit((draft) => {
      if (structureMode === "branch") deleteBranches(draft, targetNodeIds);
      else deleteNodesOnly(draft, targetNodeIds);
    });
    const finalSelectionId = this.document?.nodes[nextSelectionId] ? nextSelectionId : this.document?.rootId;
    if (finalSelectionId) this.selectOnly(finalSelectionId);
  }

  private beginEdit(nodeId: NodeId, selectionMode: "all" | "end" = "all"): void {
    if (this.editingNodeId === nodeId) return;
    if (this.editingNodeId) {
      const previousId = this.editingNodeId;
      const previousInput = this.nodeLayerEl.querySelector<HTMLInputElement>(
        `.mtn-node[data-node-id="${CSS.escape(previousId)}"] .mtn-title-input`
      );
      // Commit the previous field before changing editingNodeId. Its later blur
      // event becomes harmless because finishEdit also verifies the captured ID.
      this.finishEdit(previousId, previousInput?.value ?? this.editingOriginalTitle);
    }
    const node = this.document?.nodes[nodeId];
    if (!node) return;
    const layoutAnchor = this.captureLayoutViewportAnchor(nodeId);
    this.editingNodeId = nodeId;
    this.editingOriginalTitle = node.title;
    this.editingSelectionMode = selectionMode;
    this.render(layoutAnchor);
  }

  private finishEdit(nodeId: NodeId, value: string): void {
    const document = this.document;
    if (this.editingNodeId !== nodeId || !document) return;
    this.editingNodeId = undefined;
    // Empty edits become the visible default title instead of silently deleting
    // the node. This makes repeated Tab/Enter creation predictable.
    const title = value.replace(/[\r\n]+/g, " ").trim() || t("node.untitled");
    const node = document.nodes[nodeId];
    if (!node) return;
    if (title === this.editingOriginalTitle) { this.render(); return; }
    const previousTitle = node.title;
    this.commit((draft) => renameNode(draft, nodeId, title));
    const updated = this.document?.nodes[nodeId];
    if (nodeId === this.document?.rootId && this.file) {
      void this.renameTreeFileForEditedRoot(title, previousTitle);
    } else if (updated?.resource?.type === "file" && updated.titleSync === "bidirectional") {
      const reference = updated.resource;
      void this.renameFileForEditedNode(nodeId, title, previousTitle, reference);
    }
  }

  /** Cut every top-level selected branch, but never the protected root node. */
  private async cutSelected(): Promise<void> {
    const document = this.document;
    if (!document || !this.primarySelectedId || this.cutInProgress) return;
    const sourcePath = this.file?.path;
    const documentSessionToken = this.documentSessionToken;
    const selected = this.selectedIds.size > 0 ? this.selectedIds : [this.primarySelectedId];
    const branchRootIds = getTopLevelSelectedNodeIds(document, selected);
    if (branchRootIds.length === 0) return;

    this.cutInProgress = true;
    try {
      // A failed clipboard write must leave the document untouched. This also
      // retains linked-file metadata so a later paste recreates full branches.
      await copyBranches(document, branchRootIds, "branch");
      // Switching files while an asynchronous clipboard write is pending must
      // never delete matching node IDs from the newly active document.
      if (this.documentSessionToken !== documentSessionToken || this.file?.path !== sourcePath) return;
      const survivingIds = branchRootIds.filter((id) => Boolean(this.document?.nodes[id]));
      if (survivingIds.length > 0) this.deleteTopics(survivingIds, "branch");
      new Notice(t("notice.branchCut", { count: survivingIds.length }));
    } catch (error) {
      new Notice(t("notice.cutFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.cutInProgress = false;
    }
  }

  /** Keep the source .mtn.md filename and its root node associated both ways. */
  private async renameTreeFileForEditedRoot(title: string, previousTitle: string): Promise<void> {
    const file = this.file;
    const document = this.document;
    if (!file || !document) return;
    try {
      // Save the new root title and generated H1 before Obsidian broadcasts the
      // rename; a reload during that event must not restore the old title.
      await this.flushPendingSave();
      const newPath = buildLinkedResourcePath(file.path, title, document.documentId ?? document.rootId);
      if (newPath !== file.path) await this.app.fileManager.renameFile(file, newPath);
    } catch (error) {
      const currentDocument = this.document;
      const current = currentDocument?.nodes[currentDocument.rootId];
      if (currentDocument && current?.title === title) {
        this.applySystemMutation((draft) => {
          if (draft.nodes[draft.rootId]?.title !== title) return false;
          renameNode(draft, draft.rootId, previousTitle);
          return true;
        }, currentDocument.rootId);
      }
      new Notice(t("notice.renameFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async renameFileForEditedNode(
    nodeId: NodeId,
    title: string,
    previousTitle: string,
    reference: FileResourceRef
  ): Promise<void> {
    try {
      // Obsidian may rewrite links in the open .mtn.md file during rename and reload this view.
      // Persist the new node title first so that reload cannot restore the old compressed data.
      await this.flushPendingSave();
    } catch (error) {
      this.setStatus(t("status.saveFailed", { message: error instanceof Error ? error.message : String(error) }), "error");
      this.scheduleSave();
      return;
    }

    try {
      const file = await this.plugin.resources.renameLinkedFile(reference, title);
      const current = this.document?.nodes[nodeId];
      if (current?.resource?.type !== "file"
        || current.resource.resourceId !== reference.resourceId
        || current.title !== title) return;
      this.applySystemMutation((draft) => {
        const draftNode = draft.nodes[nodeId];
        if (draftNode?.resource?.type !== "file"
          || draftNode.resource.resourceId !== reference.resourceId
          || draftNode.title !== title
          || draftNode.resource.pathHint === file.path) return false;
        draftNode.resource.pathHint = file.path;
        return true;
      }, nodeId);
    } catch (error) {
      new Notice(t("notice.renameFailed", { message: error instanceof Error ? error.message : String(error) }));
      const current = this.document?.nodes[nodeId];
      if (current?.resource?.type === "file"
        && current.resource.resourceId === reference.resourceId
        && current.title === title) {
        this.applySystemMutation((draft) => {
          const draftNode = draft.nodes[nodeId];
          if (draftNode?.resource?.type !== "file"
            || draftNode.resource.resourceId !== reference.resourceId
            || draftNode.title !== title) return false;
          draftNode.title = previousTitle;
          return true;
        }, nodeId);
      }
    }
  }

  private cancelEdit(): void {
    if (!this.editingNodeId) return;
    const layoutAnchor = this.captureLayoutViewportAnchor(this.editingNodeId);
    this.editingNodeId = undefined;
    this.render(layoutAnchor);
  }

  private searchNodes(): void {
    if (!this.document) return;
    new TextPromptModal(this.app, t("modal.search.title"), "", t("modal.search.placeholder"), t("action.find"), (query) => {
      const result = Object.values(this.document?.nodes ?? {}).find((node) => node.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      if (!result) { new Notice(t("notice.noMatch")); return; }
      // Search changes selection only. It must not pan the canvas implicitly;
      // automatic navigation is reserved for new nodes and arrow-key focus.
      this.selectOnly(result.id);
    }).open();
  }

  private async scanSameFolder(
    file: TFile,
    options: Readonly<{ force?: boolean; notifyWhenEmpty?: boolean }> = {}
  ): Promise<void> {
    const document = this.document;
    if (!document) return;
    if (!options.force && (this.scannedFilePath === file.path || document.settings.collectionMode === "off")) return;
    this.scannedFilePath = file.path;
    const candidates = this.plugin.resources.sameDirectoryCandidates(
      file,
      document,
      document.settings.recursiveScan,
      this.plugin.settings.ignoredPathPrefixes
    );
    if (candidates.length === 0) {
      if (options.notifyWhenEmpty) new Notice(t("notice.noNewFilesToCollect"));
      return;
    }
    if (document.settings.collectionMode === "root") {
      await this.collectCandidates(candidates, "root");
    } else if (document.settings.collectionMode === "collect") {
      await this.collectCandidates(candidates, "collect");
    } else {
      new SameFolderCandidatesModal(this.app, candidates, (selected, action) => void this.collectCandidates(selected, action)).open();
    }
  }

  private async collectCandidates(files: TFile[], action: CandidateAction): Promise<void> {
    if (!this.document) return;
    const references: Array<{ file: TFile; reference: FileResourceRef }> = [];
    for (const file of files) {
      try {
        references.push({ file, reference: await this.plugin.resources.ensureStableReference(file) });
      } catch (error) {
        new Notice(t("notice.skippedFile", { path: file.path, message: this.describeResourceError(error) }));
      }
    }
    if (references.length === 0) return;
    this.commit((draft) => {
      let parentId = draft.rootId;
      if (action === "collect") {
        const root = getNode(draft, draft.rootId);
        const existing = root.childIds.find((id) => ["收集", "Collection"].includes(draft.nodes[id]?.title ?? ""));
        parentId = existing ?? addNode(draft, draft.rootId, t("collection.title")).id;
      }
      for (const { file, reference } of references) {
        const node = addNode(draft, parentId, linkedFileTitle(file.path));
        node.resource = reference;
        node.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
      }
    });
  }

  /** Translate identity conflicts while preserving ordinary error details. */
  private describeResourceError(error: unknown): string {
    if (error instanceof DuplicateResourceIdError) {
      return t("notice.duplicateResourceId", { paths: error.paths.join(", ") });
    }
    return error instanceof Error ? error.message : String(error);
  }

  private commit(mutator: (draft: MindTreeDocument) => void, anchorNodeId = this.document?.rootId): void {
    if (!this.document || this.parseError) return;
    const layoutAnchor = this.captureLayoutViewportAnchor(anchorNodeId);
    this.document = this.documentSession.execute(this.document, mutator);
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty();
  }

  /**
   * Metadata repair is persisted but is not a user command and therefore does
   * not create an undo step. It still replaces the document object so cached
   * tree indexes and prior undo snapshots remain immutable.
   */
  private applySystemMutation(
    mutator: (draft: MindTreeDocument) => boolean,
    anchorNodeId = this.document?.rootId,
    schedule = true
  ): boolean {
    const document = this.document;
    if (!document || this.parseError) return false;
    const draft = cloneDocument(document);
    if (!mutator(draft)) return false;
    const layoutAnchor = this.captureLayoutViewportAnchor(anchorNodeId);
    this.document = draft;
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty(schedule);
    return true;
  }

  /** Mark one semantic document mutation; viewport-only work never calls this. */
  private markDocumentDirty(schedule = true): void {
    this.documentSession.markChanged();
    this.setStatus(t("status.unsaved"), "dirty");
    if (schedule) this.scheduleSave();
  }

  private scheduleSave(): void {
    const ownerWindow = this.ownerWindow();
    if (this.saveTimer !== undefined) ownerWindow.clearTimeout(this.saveTimer);
    this.saveTimer = ownerWindow.setTimeout(() => {
      this.saveTimer = undefined;
      void this.save().catch((error: unknown) => {
        this.reportSaveFailure(error);
      });
    }, this.plugin.settings.autosaveDelayMs);
  }

  private async flushPendingSave(): Promise<void> {
    if (this.saveTimer !== undefined) {
      this.ownerWindow().clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }

  /** Every timer/listener belongs to the document hosting this view. */
  private ownerWindow(): Window {
    return this.contentEl.ownerDocument.defaultView ?? window;
  }

  private reportSaveFailure(error: unknown): void {
    if (error instanceof SaveConflictError) {
      this.setStatus(t("status.saveConflict"), "warning");
      return;
    }
    this.setStatus(t("status.saveFailed", {
      message: error instanceof Error ? error.message : String(error)
    }), "error");
  }

  private applyViewport(): void {
    if (!this.document) return;
    const presentation = viewportToCssPresentation(this.viewport);
    const supportsLayoutZoom = typeof CSS !== "undefined" && CSS.supports("zoom", "1");
    if (supportsLayoutZoom) {
      this.panLayerEl.style.transform = presentation.panTransform;
      this.worldEl.style.transform = "none";
      this.worldEl.style.setProperty("zoom", presentation.contentZoom);
    } else {
      // Compatibility fallback for an older WebView. Current Obsidian desktop
      // and mobile engines support CSS zoom, so normal use takes the crisp path.
      this.panLayerEl.style.transform = "none";
      this.worldEl.style.removeProperty("zoom");
      this.worldEl.style.transform = `translate(${this.viewport.x}px, ${this.viewport.y}px) scale(${this.viewport.zoom})`;
    }
    const zoomEl = this.toolbarEl.querySelector<HTMLElement>("[data-role='zoom']");
    if (zoomEl) zoomEl.setText(`${Math.round(this.viewport.zoom * 100)}%`);
  }

  /** Toolbar zoom follows the last canvas pointer; center is the initial fallback. */
  private zoomByStep(step: number): void {
    const rect = this.canvasEl.getBoundingClientRect();
    const anchor = this.zoomAnchor;
    const anchorIsInsideCanvas = anchor
      && anchor.clientX >= rect.left
      && anchor.clientX <= rect.right
      && anchor.clientY >= rect.top
      && anchor.clientY <= rect.bottom;
    this.zoomAtStep(
      step,
      anchorIsInsideCanvas ? anchor.clientX : rect.left + rect.width / 2,
      anchorIsInsideCanvas ? anchor.clientY : rect.top + rect.height / 2
    );
  }

  private zoomAtStep(step: number, clientX: number, clientY: number): void {
    if (!this.document) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    this.viewport = zoomViewportAt(this.viewport, step, localX, localY);
    this.applyViewport();
  }

  private updateSelectionFromPointer(nodeId: NodeId, additive: boolean): void {
    if (additive) {
      if (this.selectedIds.has(nodeId)) this.selectedIds.delete(nodeId); else this.selectedIds.add(nodeId);
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(nodeId);
    }
    this.primarySelectedId = this.selectedIds.has(nodeId) ? nodeId : this.selectedIds.values().next().value as NodeId | undefined;
    this.refreshSelectionStyles();
  }

  private selectOnly(nodeId: NodeId): void {
    this.selectedIds.clear();
    if (this.document?.nodes[nodeId]) {
      this.selectedIds.add(nodeId);
      this.primarySelectedId = nodeId;
    } else this.primarySelectedId = undefined;
    this.refreshSelectionStyles();
  }

  private refreshSelectionStyles(): void {
    if (!this.nodeLayerEl) return;
    for (const element of this.nodeLayerEl.querySelectorAll<HTMLElement>(".mtn-node")) {
      const nodeId = element.dataset.nodeId;
      element.toggleClass("is-selected", Boolean(nodeId && this.selectedIds.has(nodeId)));
    }
  }

  private pruneSelection(): void {
    if (!this.document) return;
    for (const id of this.selectedIds) if (!this.document.nodes[id]) this.selectedIds.delete(id);
    if (!this.primarySelectedId || !this.document.nodes[this.primarySelectedId]) {
      this.primarySelectedId = this.selectedIds.values().next().value as NodeId | undefined;
    }
    if (!this.primarySelectedId) this.selectOnly(this.document.rootId);
  }

  private clearDropTarget(): void {
    this.dropTargetEl?.removeClass("is-drop-before", "is-drop-inside", "is-drop-after");
    this.dropTargetEl = undefined;
  }

  private setStatus(message: string, kind: "idle" | "dirty" | "saved" | "warning" | "error"): void {
    if (kind === "saved" || kind === "dirty" || kind === "error") this.saveState = kind;
    if (this.statusEl) {
      // Routine saved/dirty state belongs on the save button. The free-floating
      // message is reserved for warnings and errors that need explanatory text.
      const showMessage = kind === "warning" || kind === "error";
      this.statusEl.setText(showMessage ? message : "");
      this.statusEl.className = `mtn-status${showMessage ? ` is-${kind}` : ""}`;
    }
    this.refreshBottomStatusBar();
  }
}

function nodeMarkerLabel(type: "progress" | "priority", value: string): string {
  if (type === "progress") {
    if (value === "todo") return t("marker.progress.todo");
    if (value === "inprogress") return t("marker.progress.inprogress");
    if (value === "done") return t("marker.progress.done");
    return t("marker.progress.cancelled");
  }
  if (value === "red") return t("marker.priority.red");
  if (value === "yellow") return t("marker.priority.yellow");
  return t("marker.priority.blue");
}

/** Choose legible node text without modifying the user's exact highlight color. */
function readableTextColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#1f2937" : "#ffffff";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Filesystem-safe local timestamp; milliseconds avoid collisions on rapid retries. */
function recoveryTimestamp(now = new Date()): string {
  const two = (value: number): string => value.toString().padStart(2, "0");
  const three = (value: number): string => value.toString().padStart(3, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${three(now.getMilliseconds())}`;
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function deduplicateFiles(files: TFile[]): TFile[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

/** Shortcuts must never replace normal typing inside any text editor control. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input,textarea,[contenteditable='true']"));
}

function isNavigationArrow(key: string): key is NavigationArrow {
  return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
}
