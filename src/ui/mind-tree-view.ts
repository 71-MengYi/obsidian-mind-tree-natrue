import {
  FileSystemAdapter,
  normalizePath,
  Notice,
  Platform,
  Scope,
  TextFileView,
  TFile,
  TFolder,
  WorkspaceLeaf
} from "obsidian";
import {
  addNode,
  addSibling,
  cloneDocument,
  collectBranchIds,
  collectFileReferences,
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
  toggleCollapsed,
  updateFileReferencePaths
} from "../domain/tree";
import {
  MindTreeFormatError,
  parseMindTreeFile,
  serializeMindTreeFile,
  type ParseMindTreeOptions
} from "../format/document";
import { buildLinkedResourcePath, linkedFileTitle } from "../format/resource-id";
import { renderBranchMarkdown } from "../format/outline";
import { t } from "../i18n";
import {
  copyBranches,
  resolveMarkdownBranchLinks,
  type ClipboardImageInput,
  type ClipboardPasteContent
} from "../services/clipboard";
import {
  downloadMarkdown,
  exportBranchPng,
  prepareImageExportSource,
  type ExportThemeColors
} from "../services/export";
import { reconcileLinkedFileReferences } from "../services/linked-resource-sync";
import { DuplicateResourceIdError } from "../services/resource-index";
import {
  findSameNameRecoveryPaths,
  isRecoveryReminderContextCurrent,
  recoveryRootPathForFile,
  type RecoveryReminderContext
} from "../services/recovery-reminder";
import {
  createManagedMindTreeSnapshot,
  externalMergeWouldReplaceLocal,
  hasExternalMindTreeRebase,
  mergeMindTreeExternalChange,
  rebaseMindTreeDocument,
  sameManagedMindTreeSnapshot,
  type ManagedMindTreeSnapshot,
  type MindTreeMergeResult
} from "../services/document-conflict";
import {
  DocumentSession,
  SaveConflictError,
  createRecoveryDocument
} from "../services/document-session";
import type {
  SharedMindTreeSession,
  SharedSaveConflictState,
  SharedSessionChangeReason,
  SharedSessionSnapshot
} from "../services/mind-tree-session-registry";
import {
  classifyDirectTextPaste,
  createTextPastePayload,
  parseTextImport,
  type TextImportRule
} from "../services/text-import";
import type {
  BranchClipboardPayload,
  FileResourceRef,
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
  resolveDropPlacement,
  type DropNodeRect,
  type DropPlacement
} from "./drop-placement";
import { extractVaultPathCandidates } from "./file-drop";
import { linkableVaultFiles } from "./file-selection";
import {
  AssociationTargetChangedError, isAssociationTargetAvailable, isResourceTargetCurrent,
  requireAssociationTarget, type AssociationTarget, type ResourceTarget
} from "./association-target";
import { DefaultAppOpener, DefaultAppOpenError, loadDesktopShell } from "../services/default-app-opener";
import { TemplateCopyRollbackError, TemplateTargetChangedError, type TemplateFileResult } from "../services/template-files";
import { resolveFoldDirections, type FoldDirection } from "./fold-direction";
import {
  resolveArrowNavigationTarget,
  type NavigationArrow
} from "./keyboard-navigation";
import { openMarkerPopover, type MarkerPopoverHandle } from "./marker-popover";
import { shouldHandleMindTreePaste } from "./paste-routing";
import { createBottomStatusBarState, MindTreeViewShell } from "./components";
import {
  CanvasInteractionController,
  ClipboardController,
  DragDropController,
  ImageResizeController,
  KeyboardController,
  NodeDragController,
  TouchGestureController,
  KeyboardAvoidanceController,
  type GesturePointer
} from "./controllers";
import {
  layoutTree,
  type TreeLayout
} from "./layout";
import { BrowserNodeTextMeasurer, fallbackNodeTextMeasurer } from "./text-measurer";
import {
  BrowserResourceBadgeMeasurer,
  createResourceBadgePresentation,
  fallbackResourceBadgeMeasurer,
  type ResourceBadgePresentation
} from "./resource-badges";
import {
  BrowserImageNodePresentation,
  fallbackImageNodePresentation,
  type ImageDisplaySize,
  type ImageNodeVisual
} from "./image-nodes";
import {
  getBranchColorSlots,
} from "./presentation";
import { ConnectionRenderer, NodeRenderer } from "./renderers";
import {
  CollapseLevelMenu, CopyMenu, ExportMenu, KeyboardHelpMenu, NodeContextMenu, TreeSettingsMenu
} from "./menus";
import {
  DEFAULT_VIEWPORT,
  centerViewportOnRect,
  panViewportByWheel,
  pinchViewport,
  preserveViewportPointAfterLayout,
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
  MoveFilesModal,
  RecoveryReminderModal,
  SaveConflictModal,
  type CandidateAction,
  type DeleteBranchAction,
  type SaveConflictAction
} from "./modals";

/** A visible node center captured before a layout pass changes world coordinates. */
interface LayoutViewportAnchor {
  nodeId: NodeId;
  x: number;
  y: number;
}

type ViewSaveConflict = SharedSaveConflictState;

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
  /** Stable participant identity used by the plugin-wide per-file session. */
  private readonly sharedParticipantId = createId();
  private sharedSession?: SharedMindTreeSession;
  private sharedSessionPath?: string;
  private applyingSharedSessionUpdate = false;
  /** Changes whenever TextFileView replaces the loaded document snapshot. */
  private documentSessionToken = createId();
  private sourceData = "";
  private documentSession = new DocumentSession();
  private readonly clipboardController: ClipboardController<PasteInsertionContext>;
  private readonly dragDropController = new DragDropController();
  /** Exact snapshot returned to TextFileView while one queued write is active. */
  private pendingSerializedSource?: string;
  private saveConflict?: ViewSaveConflict;
  private conflictPreparation?: Promise<void>;
  private conflictModal?: SaveConflictModal;
  private recoveryReminderModal?: RecoveryReminderModal;
  /** Guards delayed load work after this view has been detached. */
  private viewClosed = false;
  private parseError?: string;
  private readonly selectedIds = new Set<NodeId>();
  private primarySelectedId?: NodeId;
  private editingNodeId?: NodeId;
  private editingOriginalTitle = "";
  private editingDraftValue = "";
  private editingSelectionMode: "all" | "end" = "all";
  /** File renames triggered by a committed title must finish before detaching. */
  private pendingTitleFileOperation?: Promise<void>;
  private saveTimer?: number;
  private viewport: ViewportState = { ...DEFAULT_VIEWPORT };
  /** Last pointer position over the canvas, used by toolbar +/- zoom actions. */
  private zoomAnchor?: { clientX: number; clientY: number };
  private scannedFilePath?: string;
  /** Current outward fold-control side, derived afresh from each visible layout. */
  private foldDirectionByNodeId = new Map<NodeId, FoldDirection>();

  private rootEl!: HTMLElement;
  private saveState: "saved" | "dirty" | "error" = "saved";
  private saveButtonBusy = false;
  private scanButtonBusy = false;
  private canvasEl!: HTMLElement;
  private panLayerEl!: HTMLElement;
  private worldEl!: HTMLElement;
  private connectionsEl!: SVGSVGElement;
  private connectionRenderer?: ConnectionRenderer;
  private nodeLayerEl!: HTMLElement;
  private nodeRenderer?: NodeRenderer;
  private canvasInteractionController?: CanvasInteractionController;
  private nodeDragController?: NodeDragController;
  private imageResizeController?: ImageResizeController;
  private keyboardController?: KeyboardController;
  private touchGestureController?: TouchGestureController;
  private keyboardAvoidanceController?: KeyboardAvoidanceController;
  private touchViewportFrame?: number;
  private currentLayout?: TreeLayout;
  /** Cached first-level branch palette assignment shared by nodes and edges. */
  private branchColorSlotByNodeId = new Map<NodeId, number>();
  /** Resolves the actual Obsidian font used by each visual node tier. */
  private textMeasurer?: BrowserNodeTextMeasurer;
  /** Measures compact resource badges with the active Obsidian theme CSS. */
  private resourceBadgeMeasurer?: BrowserResourceBadgeMeasurer;
  /** Resolves image dimensions and transient resize previews for this view. */
  private imageNodePresentation?: BrowserImageNodePresentation;
  private textMetricRefreshFrame?: number;
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
  /** Fixed chrome and layered canvas; view logic only supplies state/actions. */
  private shell?: MindTreeViewShell;

  constructor(leaf: WorkspaceLeaf, readonly plugin: MindTreeNaturePlugin) {
    super(leaf);
    this.clipboardController = new ClipboardController(
      async () => {
        const clipboard = this.rootEl.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard?.readText) throw new Error("Clipboard text reading is unavailable.");
        return clipboard.readText();
      },
      () => new Notice(t("notice.clipboardReadFailed")),
      async () => {
        const clipboard = this.rootEl.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard?.read) throw new Error("Clipboard item reading is unavailable.");
        return clipboard.read();
      }
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
    this.viewClosed = false;
    this.buildShell();
    this.registerEvent(this.app.workspace.on("css-change", () => this.onTextMetricsInvalidated()));
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelCanvasGestures();
    // The title textarea is intentionally not part of the document while the
    // user types. Capture it before destroying DOM and wait for the shared save
    // queue, otherwise closing a clean-looking leaf can lose the visible draft.
    await this.flushViewBeforeDetach();
    this.viewClosed = true;
    this.touchGestureController?.destroy();
    this.touchGestureController = undefined;
    this.keyboardAvoidanceController?.destroy();
    this.keyboardAvoidanceController = undefined;
    this.markerPopover?.close();
    // Closing a leaf is not the user's "later" decision. Dismiss the DOM only;
    // detachSharedSession transfers the verified conflict to another leaf.
    this.conflictModal?.dismiss();
    this.conflictModal = undefined;
    this.dismissRecoveryReminder();
    const ownerWindow = this.ownerWindow();
    if (this.saveTimer !== undefined) ownerWindow.clearTimeout(this.saveTimer);
    if (this.textMetricRefreshFrame !== undefined) ownerWindow.cancelAnimationFrame(this.textMetricRefreshFrame);
    this.textMeasurer?.destroy();
    this.textMeasurer = undefined;
    this.resourceBadgeMeasurer?.destroy();
    this.resourceBadgeMeasurer = undefined;
    this.imageResizeController?.destroy();
    this.imageResizeController = undefined;
    this.imageNodePresentation?.destroy();
    this.imageNodePresentation = undefined;
    this.nodeDragController?.destroy();
    this.nodeDragController = undefined;
    this.keyboardController = undefined;
    this.nodeRenderer?.destroy();
    this.nodeRenderer = undefined;
    this.connectionRenderer?.destroy();
    this.connectionRenderer = undefined;
    this.canvasInteractionController?.destroy();
    this.canvasInteractionController = undefined;
    this.shell?.destroy();
    this.shell = undefined;
    await super.onClose();
    this.detachSharedSession();
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.cancelCanvasGestures();
    this.keyboardAvoidanceController?.reset();
    if (this.sharedSession && this.sharedSessionPath !== normalizePath(file.path)) {
      await this.flushViewBeforeDetach();
      this.detachSharedSession();
    }
    // File loading may render synchronously inside super.onLoadFile. Mark the
    // viewport first so no frame can reuse the previous file's pan/zoom.
    this.displayFilePath = file.path;
    this.dismissRecoveryReminder();
    this.initialRootCenterPending = true;
    this.rootEl?.addClass("is-initializing-viewport");
    this.selectedIds.clear();
    this.primarySelectedId = undefined;
    this.editingNodeId = undefined;
    this.editingDraftValue = "";
    this.attachSharedSession(file.path);
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
    const recoveryReminderContext: RecoveryReminderContext = {
      filePath: normalizePath(file.path),
      sessionToken: this.documentSessionToken
    };
    this.ownerWindow().setTimeout(() => this.showRecoveryReminder(recoveryReminderContext));
    this.ownerWindow().setTimeout(() => void this.scanSameFolder(file), 250);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.cancelCanvasGestures();
    await this.flushViewBeforeDetach(file.path);
    await super.onUnloadFile(file);
    this.detachSharedSession();
  }

  /** Attach this leaf to the single live document/history for a vault path. */
  private attachSharedSession(path: string): void {
    const normalized = normalizePath(path);
    if (this.sharedSession && this.sharedSessionPath === normalized) return;
    if (this.sharedSession) {
      this.plugin.mindTreeSessions.releaseSession(this.sharedSession, this.sharedParticipantId);
    }
    const session = this.plugin.mindTreeSessions.acquire(normalized);
    this.sharedSession = session;
    this.sharedSessionPath = normalized;
    this.documentSession = session.history;
    session.attach(this.sharedParticipantId, {
      onSessionChange: (snapshot) => this.applySharedSessionSnapshot(snapshot),
      commitActiveDraft: () => this.commitVisibleEditorDraft(),
      refreshConflictRecovery: async () => {
        if (this.saveConflict) {
          await this.prepareSaveConflict(
            this.saveConflict.externalSource,
            this.saveConflict.externalSnapshot
          );
        }
      },
      adoptSaveConflict: (conflict) => {
        this.saveConflict = { ...conflict };
        this.setStatus(t("status.saveConflict"), "warning");
        this.openSaveConflictModal();
      }
    });
  }

  /**
   * Commit and durably save before a file switch or normal leaf close. The
   * method is idempotent because Obsidian may call onUnloadFile during onClose.
   */
  private async flushViewBeforeDetach(expectedPath = this.sharedSessionPath): Promise<void> {
    if (!expectedPath || !this.sharedSession || this.sharedSessionPath !== normalizePath(expectedPath)) return;
    this.commitVisibleEditorDraft();
    try {
      await this.pendingTitleFileOperation;
    } catch (error) {
      // A failed linked-file side effect must not prevent the committed tree
      // title from reaching disk during the remainder of lifecycle cleanup.
      this.reportSaveFailure(error);
    }
    if (this.document && this.file && this.documentSession.dirty) {
      try {
        await this.save();
      } catch (error) {
        if (!(error instanceof SaveConflictError)) throw error;
      }
    }
  }

  private detachSharedSession(): void {
    const session = this.sharedSession;
    if (!session) return;
    session.releaseEditor(this.sharedParticipantId);
    this.plugin.mindTreeSessions.releaseSession(session, this.sharedParticipantId);
    this.saveConflict = undefined;
    this.conflictPreparation = undefined;
    this.conflictModal?.dismiss();
    this.conflictModal = undefined;
    this.sharedSession = undefined;
    this.sharedSessionPath = undefined;
    this.documentSession = new DocumentSession();
  }

  /** Receive immutable shared state while preserving this leaf's own canvas. */
  private applySharedSessionSnapshot(snapshot: Readonly<SharedSessionSnapshot>): void {
    if (this.viewClosed || !snapshot.initialized) return;
    const needsRender = this.document !== snapshot.document
      || this.parseError !== snapshot.parseError;
    if (needsRender) this.cancelCanvasGestures();
    const layoutAnchor = needsRender ? this.captureLayoutViewportAnchor() : undefined;
    this.applyingSharedSessionUpdate = true;
    try {
      this.document = snapshot.document;
      this.sourceData = snapshot.source;
      this.data = snapshot.source;
      this.parseError = snapshot.parseError;
      if (this.editingNodeId && !snapshot.document?.nodes[this.editingNodeId]) {
        this.keyboardAvoidanceController?.end();
        this.sharedSession?.releaseEditor(this.sharedParticipantId);
        this.editingNodeId = undefined;
        this.editingDraftValue = "";
      }
      if (needsRender) {
        this.pruneSelection();
        this.render(layoutAnchor);
      }
      if (snapshot.parseError) this.setStatus(snapshot.parseError, "error");
      else if (snapshot.hasConflict) this.setStatus(t("status.saveConflict"), "warning");
      else this.setStatus(
          snapshot.dirty ? t("status.unsaved") : t("status.saved"),
          snapshot.dirty ? "dirty" : "saved"
        );
    } finally {
      this.applyingSharedSessionUpdate = false;
    }
  }

  /**
   * Remind only about exact same-name copies beside the file that initiated
   * this load. A session/path guard prevents a delayed dialog leaking into the
   * next file when one leaf is switched quickly.
   */
  private showRecoveryReminder(context: Readonly<RecoveryReminderContext>): void {
    if (this.viewClosed || !isRecoveryReminderContextCurrent(
      context,
      this.displayFilePath ?? this.file?.path,
      this.documentSessionToken
    )) return;

    const recoveryRootPath = recoveryRootPathForFile(context.filePath);
    if (!recoveryRootPath) return;
    const recoveryRoot = this.app.vault.getAbstractFileByPath(recoveryRootPath);
    if (!(recoveryRoot instanceof TFolder)) return;

    const candidatePaths: string[] = [];
    for (const timestampFolder of recoveryRoot.children) {
      if (!(timestampFolder instanceof TFolder)) continue;
      for (const candidate of timestampFolder.children) {
        if (candidate instanceof TFile) candidatePaths.push(candidate.path);
      }
    }
    const recoveryPaths = findSameNameRecoveryPaths(context.filePath, candidatePaths);
    if (recoveryPaths.length === 0 || !isRecoveryReminderContextCurrent(
      context,
      this.displayFilePath ?? this.file?.path,
      this.documentSessionToken
    )) return;

    this.dismissRecoveryReminder();
    const reminder = new RecoveryReminderModal(this.app, recoveryPaths, () => {
      if (this.recoveryReminderModal === reminder) this.recoveryReminderModal = undefined;
    });
    this.recoveryReminderModal = reminder;
    reminder.open();
  }

  private dismissRecoveryReminder(): void {
    const reminder = this.recoveryReminderModal;
    this.recoveryReminderModal = undefined;
    reminder?.close();
  }

  override async save(_clear = false): Promise<void> {
    await this.documentSession.requestSave(() => this.performQueuedSave());
  }

  getViewData(): string {
    if (this.pendingSerializedSource !== undefined) return this.pendingSerializedSource;
    if (!this.document || this.parseError) return this.sourceData || this.data;
    return serializeMindTreeFile(this.document, this.documentSession.sourceBaseline || this.sourceData);
  }

  /** Global preferences only fill YAML properties absent from the file. */
  private parseOptions(): Readonly<ParseMindTreeOptions> {
    return {
      defaultLayoutMode: this.plugin.settings.defaultLayoutMode,
      defaultTheme: this.plugin.settings.theme,
      defaultNodeShape: this.plugin.settings.nodeShape,
      defaultCollectionMode: this.plugin.settings.defaultCollectionMode,
      defaultConnectionStyle: this.plugin.settings.connectionStyle
    };
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
    if (this.sharedSession?.hasConflict && !this.saveConflict) {
      await this.sharedSession.refreshConflictRecovery();
      throw new SaveConflictError();
    }
    if (this.saveConflict) {
      // The user may continue editing after choosing “later”. Refresh the
      // durable Recovery before rejecting another save so closing the last
      // view cannot strand newer work only in memory.
      await this.prepareSaveConflict(
        this.saveConflict.externalSource,
        this.saveConflict.externalSnapshot
      );
      throw new SaveConflictError();
    }

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
    const localDocument = cloneDocument(document);
    let mergeResult: MindTreeMergeResult | undefined;
    let serialized: string | undefined;
    let deferredExternalAcceptance = false;
    try {
      await this.app.vault.process(file, (diskSource) => {
        mergeResult = mergeMindTreeExternalChange(
          baseline,
          localDocument,
          diskSource,
          this.parseOptions()
        );
        if (mergeResult.kind === "conflict") {
          return diskSource;
        }
        if (hasExternalMindTreeRebase(mergeResult.rebase)
          && this.externalResultDiffersFromLocal(mergeResult)) {
          // Recovery creation is asynchronous and therefore cannot run inside
          // Vault.process's synchronous callback. Leave the disk untouched and
          // complete the verified Recovery transition immediately afterward.
          deferredExternalAcceptance = true;
          return diskSource;
        }
        // Preserve the latest external prose and unknown Frontmatter. Only the
        // generated heading, outline and managed YAML/data regions are rebuilt.
        serialized = serializeMindTreeFile(mergeResult.document, diskSource);
        this.pendingSerializedSource = serialized;
        this.sharedSession?.beginWrite(serialized);
        return serialized;
      });
    } catch (error) {
      if (serialized !== undefined) this.sharedSession?.endWrite(serialized);
      throw error;
    } finally {
      this.pendingSerializedSource = undefined;
    }

    try {
      if (deferredExternalAcceptance && mergeResult?.kind === "merged") {
        await this.processExternalSource(await this.app.vault.read(file));
        return false;
      }

      if (!mergeResult || mergeResult.kind === "conflict" || serialized === undefined) {
        const conflictingSource = await this.app.vault.read(file);
        const latestMerge = mergeMindTreeExternalChange(
          baseline,
          localDocument,
          conflictingSource,
          this.parseOptions()
        );
        // The source may have changed again after the locked comparison. If its
        // newest managed state is now mergeable, let the save queue retry under
        // Vault.process instead of presenting a stale conflict.
        if (latestMerge.kind === "merged") return true;
        // A clean in-memory view can still represent the newest local version
        // while Sync delivers an older but valid file. It therefore receives the
        // same verified Recovery protection as an unsaved view.
        await this.prepareSaveConflict(conflictingSource, latestMerge.externalSnapshot);
        throw new SaveConflictError();
      }

      if (mergeResult.rebase.machineDocument
        && this.documentSession.currentRevision !== revision) {
        // A user command landed after the locked merge had already selected an
        // external machine tree. Replaying an arbitrary structural delta onto
        // that tree is unsafe, so retain the newer local state and ask explicitly
        // instead of replacing either side in memory.
        this.sourceData = serialized;
        this.data = serialized;
        this.documentSession.markSaved(revision, serialized);
        this.sharedSession?.replaceSource(serialized, this.sharedParticipantId);
        await this.prepareSaveConflict(serialized, createManagedMindTreeSnapshot(serialized, this.parseOptions()));
        throw new SaveConflictError();
      }

      if (hasExternalMindTreeRebase(mergeResult.rebase)) {
        const externalRebase = mergeResult.rebase;
        const layoutAnchor = this.captureLayoutViewportAnchor();
        // Identity and per-tree settings can be safely overlaid onto a command
        // that landed while the write was active. Machine-tree replacement was
        // handled above and reaches here only for the captured revision.
        this.document = this.documentSession.currentRevision === revision
          ? mergeResult.document
          : rebaseMindTreeDocument(this.document!, externalRebase);
        this.documentSession.rebaseHistory((snapshot) => rebaseMindTreeDocument(snapshot, externalRebase));
        this.sharedSession?.replaceDocument(this.document, this.sharedParticipantId, "source");
        this.pruneSelection();
        this.render(layoutAnchor);
      }

      // Vault.process protects the read/modify pair inside Obsidian. A sync
      // provider can still replace the file immediately afterward, so do not
      // report green until the managed logical state is read back and verified.
      const persistedSource = await this.app.vault.read(file);
      const expectedSnapshot = createManagedMindTreeSnapshot(serialized, this.parseOptions());
      const persistedSnapshot = this.tryCreateManagedSnapshot(persistedSource);
      if (!persistedSnapshot || !sameManagedMindTreeSnapshot(expectedSnapshot, persistedSnapshot)) {
        await this.prepareSaveConflict(
          persistedSource,
          persistedSnapshot,
          undefined,
          this.documentWithPendingDraft()
        );
        throw new SaveConflictError();
      }

      this.sourceData = persistedSource;
      this.data = persistedSource;
      this.documentSession.markSaved(revision, persistedSource);
      this.sharedSession?.replaceSource(persistedSource, this.sharedParticipantId);
      if (this.hasUnsavedState()) {
        this.setStatus(t("status.unsaved"), "dirty");
        // A raw active title draft is intentionally not autosaved into the tree.
        // Only a newer committed revision should request another write pass.
        return this.documentSession.dirty;
      }
      this.setStatus(t("status.saved"), "saved");
      return false;
    } finally {
      if (serialized !== undefined) this.sharedSession?.endWrite(serialized);
    }
  }

  /** Create one durable recovery copy before exposing conflict choices. */
  private async prepareSaveConflict(
    externalSource: string,
    externalSnapshot = this.tryCreateManagedSnapshot(externalSource),
    recoveryPath?: string,
    recoveryDocument = this.documentWithPendingDraft()
  ): Promise<void> {
    const expectedSession = this.sharedSession;
    const expectedToken = this.documentSessionToken;
    if (this.saveConflict) {
      const localFingerprint = this.recoveryDocumentFingerprint(recoveryDocument);
      const recoveryStillValid = localFingerprint === this.saveConflict.recoveredLocalFingerprint
        && await this.isRecoveryCopyValid(this.saveConflict.recoveryPath, recoveryDocument);
      if (!recoveryStillValid) {
        const transitionKey = externalSnapshot
          ? this.recoveryTransitionKey(
              this.documentSession.sourceBaseline || this.sourceData,
              externalSnapshot,
              recoveryDocument
            )
          : `invalid|${localFingerprint}|${sourceFingerprint(externalSource)}`;
        const nextRecoveryPath = await (
          this.sharedSession?.recoveryForTransition(
            transitionKey,
            () => this.createRecoveryCopy(recoveryDocument, externalSource)
          ) ?? this.createRecoveryCopy(recoveryDocument, externalSource)
        );
        if (!this.isAsyncSessionCurrent(expectedSession, expectedToken)) return;
        this.saveConflict = {
          ...this.saveConflict,
          recoveryPath: nextRecoveryPath,
          recoveredLocalFingerprint: localFingerprint
        };
        // The existing modal contains the old path. Re-open it with the newest
        // verified copy rather than presenting misleading recovery metadata.
        this.conflictModal?.dismiss();
        this.conflictModal = undefined;
      }
      this.saveConflict = {
        ...this.saveConflict,
        externalSource,
        externalSnapshot
      };
      this.sharedSession?.updateConflict(this.sharedParticipantId, this.saveConflict);
      this.openSaveConflictModal();
      return;
    }
    if (this.conflictPreparation) {
      await this.conflictPreparation;
      return this.prepareSaveConflict(externalSource, externalSnapshot, recoveryPath, recoveryDocument);
    }
    this.conflictPreparation = (async () => {
      const transitionKey = externalSnapshot
        ? this.recoveryTransitionKey(
            this.documentSession.sourceBaseline || this.sourceData,
            externalSnapshot,
            recoveryDocument
          )
        : `invalid|${sourceFingerprint(externalSource)}`;
      const verifiedRecoveryPath = recoveryPath ?? await (
        this.sharedSession?.recoveryForTransition(
          transitionKey,
          () => this.createRecoveryCopy(recoveryDocument, externalSource)
        ) ?? this.createRecoveryCopy(recoveryDocument, externalSource)
      );
      if (!this.isAsyncSessionCurrent(expectedSession, expectedToken)) return;
      const nextConflict: ViewSaveConflict = {
        externalSource,
        externalSnapshot,
        recoveryPath: verifiedRecoveryPath,
        recoveredLocalFingerprint: this.recoveryDocumentFingerprint(recoveryDocument)
      };
      if (this.sharedSession && !this.sharedSession.claimConflict(this.sharedParticipantId, nextConflict)) return;
      this.saveConflict = nextConflict;
      this.setStatus(t("status.saveConflict"), "warning");
      this.openSaveConflictModal();
    })().finally(() => { this.conflictPreparation = undefined; });
    return this.conflictPreparation;
  }

  private tryCreateManagedSnapshot(source: string): ManagedMindTreeSnapshot | undefined {
    try {
      return createManagedMindTreeSnapshot(source, this.parseOptions());
    } catch {
      return undefined;
    }
  }

  private sameConflictExternal(
    conflict: Readonly<ViewSaveConflict>,
    source: string,
    snapshot: ManagedMindTreeSnapshot | undefined
  ): boolean {
    if (conflict.externalSnapshot && snapshot) {
      return sameManagedMindTreeSnapshot(conflict.externalSnapshot, snapshot);
    }
    // Invalid data has no logical snapshot. Exact equality is the only safe
    // equivalence rule until a valid file appears on disk again.
    return !conflict.externalSnapshot && !snapshot && conflict.externalSource === source;
  }

  private dismissSaveConflict(): void {
    this.saveConflict = undefined;
    this.sharedSession?.clearConflict(this.sharedParticipantId);
    this.conflictModal?.dismiss();
    this.conflictModal = undefined;
  }

  /** Recovery files intentionally omit link identity to avoid duplicate owners. */
  private async createRecoveryCopy(
    sourceDocument = this.documentWithPendingDraft(),
    latestExternalSource?: string
  ): Promise<string> {
    const file = this.file;
    if (!file) throw new Error("No mind tree is available for recovery.");
    const recoveryDocument = createRecoveryDocument(sourceDocument);
    // A valid newest source preserves external prose/unknown Frontmatter. If
    // the external file is damaged, use the last valid baseline as the safe
    // serialization template instead of propagating the corruption.
    const template = latestExternalSource && this.tryCreateManagedSnapshot(latestExternalSource)
      ? latestExternalSource
      : this.documentSession.sourceBaseline || this.sourceData;
    const source = serializeMindTreeFile(recoveryDocument, template);
    const expectedSnapshot = createManagedMindTreeSnapshot(source, this.parseOptions());
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
    const recoveryFile = await this.app.vault.create(recoveryPath, source);
    if (!await this.isRecoveryCopyValid(recoveryFile.path, recoveryDocument, expectedSnapshot)) {
      throw new Error("Recovery verification failed; external data was not accepted.");
    }
    return recoveryPath;
  }

  /** Re-read a Recovery before trusting it as the durable local counterpart. */
  private async isRecoveryCopyValid(
    recoveryPath: string,
    sourceDocument: MindTreeDocument,
    expectedSnapshot?: ManagedMindTreeSnapshot
  ): Promise<boolean> {
    const recoveryFile = this.app.vault.getFileByPath(normalizePath(recoveryPath));
    if (!recoveryFile) return false;
    try {
      const verifiedSource = await this.app.vault.read(recoveryFile);
      const verifiedSnapshot = createManagedMindTreeSnapshot(verifiedSource, this.parseOptions());
      const expected = expectedSnapshot ?? createManagedMindTreeSnapshot(
        serializeMindTreeFile(
          createRecoveryDocument(sourceDocument),
          this.documentSession.sourceBaseline || this.sourceData
        ),
        this.parseOptions()
      );
      return verifiedSnapshot.documentId === undefined
        && sameManagedMindTreeSnapshot(expected, verifiedSnapshot);
    } catch {
      return false;
    }
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
      const file = this.file;
      if (!file) return;
      const latestDiskSource = await this.app.vault.read(file);
      let parsed: ReturnType<typeof parseMindTreeFile>;
      try {
        parsed = parseMindTreeFile(latestDiskSource, this.parseOptions());
      } catch {
        await this.prepareSaveConflict(latestDiskSource, undefined);
        throw new SaveConflictError();
      }
      // The dialog may have remained open while the user continued editing.
      // Never accept the disk version until Recovery contains that newest work.
      const recoveryDocument = this.documentWithPendingDraft();
      if (this.recoveryDocumentFingerprint(recoveryDocument)
          !== conflict.recoveredLocalFingerprint
        || !await this.isRecoveryCopyValid(conflict.recoveryPath, recoveryDocument)) {
        await this.prepareSaveConflict(
          latestDiskSource,
          this.tryCreateManagedSnapshot(latestDiskSource),
          undefined,
          recoveryDocument
        );
        throw new SaveConflictError();
      }
      const layoutAnchor = this.captureLayoutViewportAnchor();
      const repairedResources = this.reconcileLinkedResources(parsed.document);
      const repairedTitle = this.synchronizeDocumentTitleWithFile(parsed.document, file);
      const repaired = repairedResources
        || repairedTitle
        || parsed.migratedFromSchemaVersion !== undefined
        || parsed.defaultedDocumentSettings === true;
      this.dismissSaveConflict();
      this.sharedSession?.releaseEditor(this.sharedParticipantId);
      this.editingNodeId = undefined;
      this.editingDraftValue = "";
      this.document = parsed.document;
      this.sourceData = latestDiskSource;
      this.data = latestDiskSource;
      this.documentSession.load(latestDiskSource);
      if (repaired) this.documentSession.markChanged();
      this.sharedSession?.replaceDocument(this.document, this.sharedParticipantId, "source");
      this.sharedSession?.replaceSource(latestDiskSource, this.sharedParticipantId);
      this.pruneSelection();
      this.render(layoutAnchor);
      if (repaired) {
        this.setStatus(t("status.unsaved"), "dirty");
        this.scheduleSave();
      } else {
        this.setStatus(t("status.saved"), "saved");
      }
      return;
    }

    const file = this.file;
    if (!file) return;
    const latestDiskSource = await this.app.vault.read(file);
    const latestSnapshot = this.tryCreateManagedSnapshot(latestDiskSource);
    if (!this.sameConflictExternal(conflict, latestDiskSource, latestSnapshot)) {
      this.dismissSaveConflict();
      await this.prepareSaveConflict(latestDiskSource, latestSnapshot);
      throw new SaveConflictError();
    }
    // The explicit overwrite decision applies only to the version shown by the
    // dialog. Adopt it as the comparison baseline, then enqueue the local state.
    this.dismissSaveConflict();
    this.sourceData = latestDiskSource;
    this.data = latestDiskSource;
    this.documentSession.replaceBaseline(latestDiskSource);
    this.sharedSession?.replaceSource(latestDiskSource, this.sharedParticipantId);
    await this.save();
  }

  setViewData(data: string, clear: boolean): void {
    // A second leaf must adopt the already-live shared document instead of
    // resetting its history from a potentially stale TextFileView payload.
    if (clear && this.sharedSession?.initialized) {
      this.document = this.sharedSession.document;
      this.sourceData = this.sharedSession.source;
      this.data = this.sharedSession.source;
      this.parseError = this.sharedSession.parseError;
      if (!this.primarySelectedId && this.document) this.selectOnly(this.document.rootId);
      this.render();
      if (data === this.documentSession.sourceBaseline || data === this.sharedSession.source) return;
      clear = false;
    }

    if (!clear && data === this.documentSession.sourceBaseline) {
      this.sourceData = data;
      this.data = data;
      return;
    }
    if (!clear && this.document) {
      if (data === this.pendingSerializedSource || this.sharedSession?.isPendingWrite(data)) {
        this.sourceData = data;
        this.data = data;
        this.documentSession.replaceBaseline(data);
        this.sharedSession?.replaceSource(data, this.sharedParticipantId);
        return;
      }
      if (data === this.documentSession.sourceBaseline) return;
      // TextFileView can deliver the same filesystem event to every leaf. Only
      // one participant performs the merge/Recovery transition; it publishes
      // the accepted result back to all other leaves.
      const sharedSession = this.sharedSession;
      if (sharedSession && !sharedSession.claimExternalSource(data)) return;
      const sessionToken = this.documentSessionToken;
      void this.processExternalSource(data, sharedSession, sessionToken).catch((error: unknown) => {
        this.setStatus(t("status.recoveryFailed", {
          message: error instanceof Error ? error.message : String(error)
        }), "error");
      }).finally(() => sharedSession?.releaseExternalSource(data));
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
      const parsed = parseMindTreeFile(data, this.parseOptions());
      this.document = parsed.document;
      this.parseError = undefined;
      this.sharedSession?.initialize(parsed.document, data);
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
      this.sharedSession?.initialize(undefined, data, this.parseError);
      this.saveState = "error";
    }
    this.render(layoutAnchor);
  }

  /**
   * Process one observable external source against the shared baseline. Any
   * externally-owned logical replacement is preceded by a verified Recovery;
   * generated Markdown/prose-only changes simply refresh the serialization
   * template because they cannot erase tree state.
   */
  private async processExternalSource(
    data: string,
    expectedSession = this.sharedSession,
    expectedToken = this.documentSessionToken
  ): Promise<void> {
    if (!this.isAsyncSessionCurrent(expectedSession, expectedToken)) return;
    const document = this.document;
    if (!document || data === this.documentSession.sourceBaseline) return;
    const baseline = this.documentSession.sourceBaseline || this.sourceData;
    const mergeResult = mergeMindTreeExternalChange(baseline, document, data, this.parseOptions());

    if (mergeResult.kind === "conflict") {
      await this.prepareSaveConflict(
        data,
        mergeResult.externalSnapshot,
        undefined,
        this.documentWithPendingDraft()
      );
      return;
    }

    const hasExternalManagedChange = hasExternalMindTreeRebase(mergeResult.rebase);
    const draft = this.sharedSession?.draft;
    if (draft && mergeResult.rebase.machineDocument) {
      // A textarea draft is local work even though it intentionally has not
      // entered the layout document. Never let a remote machine tree silently
      // replace it.
      await this.prepareSaveConflict(
        data,
        mergeResult.externalSnapshot,
        undefined,
        this.documentWithPendingDraft()
      );
      return;
    }

    if (hasExternalManagedChange && this.externalResultDiffersFromLocal(mergeResult)) {
      const recoveryDocument = this.documentWithPendingDraft();
      const transitionKey = this.recoveryTransitionKey(
        baseline,
        mergeResult.externalSnapshot,
        recoveryDocument
      );
      await (this.sharedSession?.recoveryForTransition(
        transitionKey,
        () => this.createRecoveryCopy(recoveryDocument, data)
      ) ?? this.createRecoveryCopy(recoveryDocument, data));
      if (!this.isAsyncSessionCurrent(expectedSession, expectedToken)) return;

      // A local command may have landed while Recovery I/O was pending. Repeat
      // the complete transition so the next Recovery contains that newer work;
      // a merely mergeable result is not enough because the verified copy we
      // just wrote belongs to the previous in-memory revision.
      if (!this.document || this.document !== document) {
        await this.processExternalSource(data, expectedSession, expectedToken);
        return;
      }
    }

    this.applyMergedExternalSource(data, mergeResult);
  }

  private isAsyncSessionCurrent(
    expectedSession: SharedMindTreeSession | undefined,
    expectedToken: string
  ): boolean {
    return !this.viewClosed
      && this.sharedSession === expectedSession
      && this.documentSessionToken === expectedToken;
  }

  /** Apply a previously verified external merge and broadcast it to all leaves. */
  private applyMergedExternalSource(data: string, mergeResult: Extract<MindTreeMergeResult, { kind: "merged" }>): void {
    const hasManagedRebase = hasExternalMindTreeRebase(mergeResult.rebase);
    const layoutAnchor = hasManagedRebase ? this.captureLayoutViewportAnchor() : undefined;
    if (hasManagedRebase) {
      this.document = mergeResult.document;
      this.documentSession.rebaseHistory((snapshot) => rebaseMindTreeDocument(snapshot, mergeResult.rebase));
    }
    this.dismissSaveConflict();
    this.sourceData = data;
    this.data = data;
    this.documentSession.replaceBaseline(data);
    if (hasManagedRebase) {
      this.sharedSession?.replaceDocument(this.document, this.sharedParticipantId, "source");
    }
    this.sharedSession?.replaceSource(data, this.sharedParticipantId);
    if (layoutAnchor) {
      this.pruneSelection();
      this.render(layoutAnchor);
    }
    if (this.hasUnsavedState()) {
      this.setStatus(t("status.unsaved"), "dirty");
      if (this.documentSession.dirty) this.scheduleSave();
    } else {
      this.setStatus(t("status.saved"), "saved");
    }
  }

  /** Compare the external logical result with the current local document. */
  private externalResultDiffersFromLocal(mergeResult: Extract<MindTreeMergeResult, { kind: "merged" }>): boolean {
    return externalMergeWouldReplaceLocal(mergeResult, this.documentWithPendingDraft());
  }

  /** Overlay the raw textarea value only for safety comparison/Recovery. */
  private documentWithPendingDraft(): MindTreeDocument {
    const document = this.document;
    if (!document) throw new Error("No mind tree is loaded.");
    const draftState = this.sharedSession?.draft;
    if (!draftState || !document.nodes[draftState.nodeId]) return document;
    const overlaid = cloneDocument(document);
    const title = draftState.value.replace(/[\r\n]+/g, " ").trim() || t("node.untitled");
    renameNode(overlaid, draftState.nodeId, title);
    return overlaid;
  }

  private recoveryTransitionKey(
    baselineSource: string,
    externalSnapshot: ManagedMindTreeSnapshot,
    localDocument = this.documentWithPendingDraft()
  ): string {
    const baseline = this.tryCreateManagedSnapshot(baselineSource);
    const local = this.tryCreateManagedSnapshot(serializeMindTreeFile(localDocument, baselineSource));
    return [
      baseline?.machineFingerprint ?? "invalid",
      baseline?.documentId ?? "",
      JSON.stringify(baseline?.settings ?? {}),
      local?.machineFingerprint ?? "invalid-local",
      local?.documentId ?? "",
      JSON.stringify(local?.settings ?? {}),
      externalSnapshot.machineFingerprint,
      externalSnapshot.documentId ?? "",
      JSON.stringify(externalSnapshot.settings)
    ].join("|");
  }

  private recoveryDocumentFingerprint(document: MindTreeDocument): string {
    const snapshot = createManagedMindTreeSnapshot(
      serializeMindTreeFile(createRecoveryDocument(document), this.documentSession.sourceBaseline || this.sourceData),
      this.parseOptions()
    );
    return [
      snapshot.machineFingerprint,
      JSON.stringify(snapshot.settings)
    ].join("|");
  }

  clear(): void {
    this.cancelCanvasGestures();
    this.keyboardAvoidanceController?.reset();
    this.sharedSession?.releaseEditor(this.sharedParticipantId);
    this.markerPopover?.close();
    this.dismissRecoveryReminder();
    if (!this.sharedSession?.initialized) {
      this.dismissSaveConflict();
    } else {
      // TextFileView can clear a closing leaf before detach transfers the
      // shared conflict. Remove only this leaf's DOM, not the session state.
      this.conflictModal?.dismiss();
      this.conflictModal = undefined;
    }
    this.conflictPreparation = undefined;
    this.pendingSerializedSource = undefined;
    // TextFileView may call clear while another leaf still owns this shared
    // history. Only an uninitialized/new session (or detached fallback) may
    // reset DocumentSession here.
    if (!this.sharedSession?.initialized) this.documentSession.clear();
    this.dragDropController.clear();
    this.imageResizeController?.cancel();
    this.imageNodePresentation?.invalidate();
    this.clearFileDropFeedback();
    this.document = undefined;
    this.documentSessionToken = createId();
    this.parseError = undefined;
    this.selectedIds.clear();
    this.primarySelectedId = undefined;
    this.editingNodeId = undefined;
    this.editingDraftValue = "";
    this.currentLayout = undefined;
    this.branchColorSlotByNodeId.clear();
    this.foldDirectionByNodeId.clear();
    if (this.textMetricRefreshFrame !== undefined) this.ownerWindow().cancelAnimationFrame(this.textMetricRefreshFrame);
    this.textMetricRefreshFrame = undefined;
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
    this.commitVisibleEditorDraft();
    await this.pendingTitleFileOperation;
    await this.flushPendingSave();
  }

  /** Keep live state and undo history aligned with the atomically written ID. */
  adoptDocumentIdentity(expectedPath: string, documentId: string): void {
    if (normalizePath(this.file?.path ?? "") !== normalizePath(expectedPath) || !this.document) return;
    const identified = cloneDocument(this.document);
    identified.documentId = documentId;
    this.document = identified;
    this.documentSession.adoptDocumentIdentity(documentId);
    this.sharedSession?.replaceDocument(identified, this.sharedParticipantId, "identity");
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
    this.keyboardAvoidanceController?.userNavigated();
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
    this.sharedSession?.commitEditorBeforeMutation(this.sharedParticipantId);
    if (!this.document || !this.documentSession.canUndo) return;
    const layoutAnchor = this.captureLayoutViewportAnchor();
    const previous = this.documentSession.undo(this.document);
    if (!previous) return;
    this.document = previous;
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty(true, "history");
  }

  redo(): void {
    this.sharedSession?.commitEditorBeforeMutation(this.sharedParticipantId);
    if (!this.document || !this.documentSession.canRedo) return;
    const layoutAnchor = this.captureLayoutViewportAnchor();
    const next = this.documentSession.redo(this.document);
    if (!next) return;
    this.document = next;
    this.pruneSelection();
    this.render(layoutAnchor);
    this.markDocumentDirty(true, "history");
  }

  fitCanvas(): void {
    this.keyboardAvoidanceController?.userNavigated();
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
    this.keyboardAvoidanceController?.userNavigated();
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
    if (this.sharedSession && normalizePath(this.sharedSessionPath ?? "") === normalizePath(oldPath)) {
      this.sharedSessionPath = normalizePath(file.path);
    }
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
    this.cancelCanvasGestures();
    this.touchGestureController?.destroy();
    this.keyboardAvoidanceController?.destroy();
    this.canvasInteractionController?.destroy();
    this.nodeDragController?.destroy();
    this.imageResizeController?.destroy();
    this.textMeasurer?.destroy();
    this.textMeasurer = undefined;
    this.resourceBadgeMeasurer?.destroy();
    this.resourceBadgeMeasurer = undefined;
    this.shell?.destroy();
    this.shell = new MindTreeViewShell(this.contentEl, {
      menu: { settings: t("view.settings"), keyboardHelp: t("shortcut.help") },
      toolbar: {
        expandAll: t("toolbar.expandAll"), collapseAll: t("toolbar.collapseAll"),
        collapseLevel: t("toolbar.collapseLevel"), markers: t("toolbar.markers"),
        fit: t("toolbar.fit"), zoomOut: t("toolbar.zoomOut"), zoomIn: t("toolbar.zoomIn"),
        search: t("toolbar.search"), copy: t("toolbar.copy"),
        importText: t("toolbar.import"), exportTree: t("toolbar.export")
      },
      bottom: {
        resetCanvas: t("statusBar.resetCanvas"), save: t("statusBar.save"),
        scanFolder: t("statusBar.scanFolder"), undo: t("toolbar.undo"), redo: t("toolbar.redo")
      },
      canvas: { ariaLabel: t("canvas.aria") }
    }, {
      menu: {
        showSettings: (event) => this.showViewSettingsMenu(event),
        showKeyboardHelp: (event) => this.showKeyboardHelp(event)
      },
      toolbar: {
        expandAll: () => this.setSelectedBranchesCollapsed(false),
        collapseAll: () => this.setSelectedBranchesCollapsed(true),
        showCollapseLevel: (event) => this.showCollapseLevelMenu(event),
        showMarkers: (button) => {
          const nodeId = this.primarySelectedId;
          if (!nodeId) return;
          const rect = button.getBoundingClientRect();
          this.showMarkerPopover(nodeId, { x: rect.left, y: rect.bottom + 6 });
        },
        fit: () => this.fitCanvas(),
        zoomOut: () => this.zoomByStep(-ZOOM_STEP),
        zoomIn: () => this.zoomByStep(ZOOM_STEP),
        search: () => this.searchNodes(),
        showCopyMenu: (event) => this.showCopyMenu(event),
        importText: () => this.showTextImportModal(),
        showExportMenu: (event) => this.showExportMenu(event)
      },
      bottom: {
        resetCanvas: () => this.resetCanvasToRoot(),
        save: () => void this.saveFromStatusBar(),
        scanFolder: () => void this.scanFolderFromStatusBar(),
        undo: () => this.undo(),
        redo: () => this.redo()
      },
      canvas: {
        pointerDown: (event) => this.canvasInteractionController?.pointerDown(event),
        pointerMove: (event) => this.canvasInteractionController?.pointerMove(event),
        pointerUp: (event) => this.canvasInteractionController?.pointerUp(event),
        pointerCancel: (event) => this.canvasInteractionController?.pointerCancel(event),
        cancelGesture: () => this.cancelCanvasGestures(),
        contextMenu: (event) => {
          if (this.suppressContextMenu || !(event.target as HTMLElement).closest(".mtn-node")) event.preventDefault();
          this.suppressContextMenu = false;
        },
        wheel: (event) => this.canvasInteractionController?.wheel(event),
        dragEnter: (event) => this.onCanvasFileDragOver(event),
        dragOver: (event) => this.onCanvasFileDragOver(event),
        dragLeave: (event) => this.onCanvasFileDragLeave(event),
        drop: (event) => void this.onCanvasFileDrop(event),
        keyDown: (event) => this.keyboardController?.keyDown(event),
        paste: (event) => this.onDocumentPaste(event),
        documentDragStart: (event) => this.captureInternalFileDrag(event),
        documentDragEnd: () => {
          this.dragDropController.clear();
          this.clearFileDropFeedback();
        },
        resize: () => {
          if (this.tryApplyInitialRootCenter()) this.applyViewport();
        }
      }
    });
    this.rootEl = this.shell.element;
    this.canvasEl = this.shell.canvas.element;
    this.panLayerEl = this.shell.canvas.panLayer;
    this.worldEl = this.shell.canvas.world;
    this.connectionsEl = this.shell.canvas.connections;
    this.connectionRenderer = new ConnectionRenderer(this.connectionsEl);
    this.nodeLayerEl = this.shell.canvas.nodeLayer;
    this.nodeRenderer = new NodeRenderer(this.nodeLayerEl);
    this.textMeasurer = new BrowserNodeTextMeasurer(this.rootEl, () => this.onTextMetricsInvalidated());
    this.resourceBadgeMeasurer = new BrowserResourceBadgeMeasurer(this.rootEl);
    this.imageNodePresentation = new BrowserImageNodePresentation(
      this.ownerWindow(),
      (node) => node.resource?.type === "file" ? this.plugin.resources.resolve(node.resource) : undefined,
      (file) => this.app.vault.getResourcePath(file),
      (resourceId) => this.onImagePresentationChanged(resourceId)
    );
    this.imageResizeController = new ImageResizeController(this.ownerWindow(), {
      preview: (nodeId, size) => this.previewImageSize(nodeId, size),
      commit: (nodeId, size) => this.commitImageSize(nodeId, size),
      cancel: (nodeId) => this.cancelImageSizePreview(nodeId)
    });
    this.canvasInteractionController = new CanvasInteractionController(
      this.canvasEl,
      this.nodeLayerEl,
      this.shell.canvas.marquee,
      {
        hasDocument: () => Boolean(this.document),
        readSelection: () => ({ ids: this.selectedIds, primaryId: this.primarySelectedId }),
        replaceSelection: (ids, primaryId) => {
          this.selectedIds.clear();
          for (const nodeId of ids) this.selectedIds.add(nodeId);
          this.primarySelectedId = primaryId;
          this.refreshSelectionStyles();
        },
        panBy: (deltaX, deltaY) => {
          this.keyboardAvoidanceController?.userNavigated();
          this.viewport.x += deltaX;
          this.viewport.y += deltaY;
          this.applyViewport();
        },
        panWheel: (delta, direction) => {
          this.keyboardAvoidanceController?.userNavigated();
          this.viewport = panViewportByWheel(this.viewport, delta, direction);
          this.applyViewport();
        },
        zoomAtStep: (step, clientX, clientY) => this.zoomAtStep(step, clientX, clientY),
        rememberZoomAnchor: (clientX, clientY) => { this.zoomAnchor = { clientX, clientY }; },
        suppressNextContextMenu: (suppress) => { this.suppressContextMenu = suppress; }
      }
    );
    this.nodeDragController = new NodeDragController(
      this.rootEl,
      this.nodeLayerEl,
      this.connectionsEl,
      {
        resolvePlacement: (clientX, clientY, excludedIds) =>
          this.resolveCanvasDropPlacement(clientX, clientY, excludedIds),
        showPlacement: (placement) => {
          const target = this.showDropPlacement(placement);
          this.dropTargetEl = target;
          return target;
        },
        clearPlacement: () => this.clearDropTarget(),
        moveNodes: (nodeIds, targetId, position) => this.commit((draft) => {
          moveNodes(draft, nodeIds, targetId, position);
        }),
        reportFailure: (error) => new Notice(t("notice.operationFailed", {
          message: error instanceof Error ? error.message : String(error)
        }))
      }
    );
    this.keyboardAvoidanceController = new KeyboardAvoidanceController(this.canvasEl, (x, y) => {
      this.viewport.x += x;
      this.viewport.y += y;
      this.applyViewport();
    });
    this.touchGestureController = new TouchGestureController(this.canvasEl, {
      sessionToken: () => !this.viewClosed && this.document && !this.parseError ? this.documentSessionToken : undefined,
      prepareGesture: () => {
        this.commitVisibleEditorDraft();
        this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
        this.canvasEl.focus({ preventScroll: true });
      },
      canDragNode: (id) => Boolean(this.document?.nodes[id] && id !== this.document.rootId),
      selectNode: (id) => {
        // Preserve a multi-selection made with an attached hardware keyboard.
        if (this.selectedIds.has(id)) { this.primarySelectedId = id; this.refreshSelectionStyles(); }
        else this.selectOnly(id);
      },
      editNode: (id) => this.beginEdit(id),
      showNodeMenu: (id, point) => this.showNodeMenu(point, id),
      activateControl: (id, action) => {
        if (!this.document?.nodes[id]) return;
        if (action === "fold") this.commit((draft) => toggleCollapsed(draft, id), id);
        else void this.openResource(id);
      },
      panBy: (x, y) => {
        this.keyboardAvoidanceController?.userNavigated();
        this.viewport.x += x;
        this.viewport.y += y;
        this.scheduleTouchViewportUpdate();
      },
      pinch: (before, after) => {
        this.keyboardAvoidanceController?.userNavigated();
        const rect = this.canvasEl.getBoundingClientRect();
        const local = (point: GesturePointer) => ({ x: point.clientX - rect.left, y: point.clientY - rect.top });
        this.viewport = pinchViewport(this.viewport, [local(before[0]), local(before[1])], [local(after[0]), local(after[1])]);
        this.zoomAnchor = { clientX: (after[0].clientX + after[1].clientX) / 2, clientY: (after[0].clientY + after[1].clientY) / 2 };
        this.scheduleTouchViewportUpdate();
      },
      startNodeDrag: (id, point) => this.startNodeDrag(point, id, true),
      moveNodeDrag: (point) => this.nodeDragController?.move(point),
      finishNodeDrag: (point) => this.nodeDragController?.finish(point),
      cancelNodeDrag: () => this.nodeDragController?.cancel(),
      startImageResize: (id, point) => {
        const node = this.document?.nodes[id];
        const image = node && this.imageNodePresentation?.resolve(node);
        if (image) this.beginImageResize(point, id, image, true);
      },
      moveImageResize: (point) => this.imageResizeController?.move(point),
      finishImageResize: (point) => this.imageResizeController?.finish(point),
      cancelImageResize: () => this.imageResizeController?.cancel()
    });
    this.keyboardController = new KeyboardController({
      hasPrimarySelection: () => Boolean(this.primarySelectedId),
      save: () => void this.saveImmediately(),
      moveSibling: (direction) => this.moveSelectedAmongSiblings(direction),
      navigate: (key) => this.navigateSelection(key),
      selectAll: () => {
        for (const position of this.currentLayout?.nodes ?? []) this.selectedIds.add(position.id);
        this.primarySelectedId = this.currentLayout?.nodes.at(-1)?.id;
        this.render();
      },
      undo: () => this.undo(),
      redo: () => this.redo(),
      copy: () => void this.copySelected("branch"),
      cut: () => void this.cutSelected(),
      createNote: () => { this.createNoteForSelection(); },
      addParent: () => this.addParentNode(),
      addChild: () => this.addChildNode(),
      editAtEnd: () => { if (this.primarySelectedId) this.beginEdit(this.primarySelectedId, "end"); },
      addSibling: (position) => this.addSiblingNode(position),
      deleteSelection: () => { if (this.primarySelectedId) this.requestDeleteBranch(this.primarySelectedId); },
      cancel: () => { this.cancelCanvasGestures(); this.cancelEdit(); this.clearDropTarget(); }
    });
    this.refreshBottomStatusBar();
  }

  /** Refresh counts, history availability, and the persisted/dirty save color. */
  private refreshBottomStatusBar(): void {
    const bottom = this.shell?.bottom;
    if (!bottom) return;
    const document = this.document;
    const statistics = document ? getTreeStatistics(document) : { topicCount: 0, fileCount: 0, depth: 0 };
    bottom.update(createBottomStatusBarState({
      topicCount: statistics.topicCount,
      fileCount: statistics.fileCount,
      depth: statistics.depth,
      saveState: this.saveState,
      saveBusy: this.saveButtonBusy,
      scanBusy: this.scanButtonBusy,
      scanEnabled: Boolean(document && !this.parseError && this.file),
      canUndo: this.documentSession.canUndo,
      canRedo: this.documentSession.canRedo,
      text: {
        topics: (count) => t("statusBar.topics", { count }),
        files: (count) => t("statusBar.files", { count }),
        depth: (count) => t("statusBar.depth", { count }),
        saved: t("statusBar.saved"),
        unsaved: t("statusBar.unsaved")
      }
    }));
  }

  private async saveFromStatusBar(): Promise<void> {
    if (!this.document || this.parseError) return;
    this.commitVisibleEditorDraft();
    this.sharedSession?.commitEditorBeforeMutation(this.sharedParticipantId);
    this.saveButtonBusy = true;
    this.refreshBottomStatusBar();
    try {
      await this.flushPendingSave();
    } catch (error) {
      this.reportSaveFailure(error);
    } finally {
      this.saveButtonBusy = false;
      this.refreshBottomStatusBar();
    }
  }

  /** Refresh only views that actually reference the metadata-changed resource. */
  handleResourceMetadataChange(resourceId: string): void {
    const document = this.document;
    if (!document || !Object.values(document.nodes).some((node) =>
      node.resource?.type === "file" && node.resource.resourceId === resourceId)) return;
    this.imageNodePresentation?.invalidate(resourceId);
    const anchor = this.captureLayoutViewportAnchor();
    const changed = this.applySystemMutation((draft) => this.reconcileLinkedResources(draft));
    if (!changed) this.render(anchor);
  }

  /**
   * Explicit scanning always invalidates the per-open cache. Automatic scanning
   * may be disabled for a pure mind-map tree, but clicking this button is direct
   * user intent, so `off` falls back to the candidate picker for this one scan.
   */
  private async scanFolderFromStatusBar(): Promise<void> {
    const file = this.file;
    if (!file || !this.document || this.parseError) return;
    this.scanButtonBusy = true;
    this.refreshBottomStatusBar();
    try {
      await this.scanSameFolder(file, { force: true, notifyWhenEmpty: true });
    } finally {
      this.scanButtonBusy = false;
      this.refreshBottomStatusBar();
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
    this.commitVisibleEditorDraft();
    await this.pendingTitleFileOperation;
    await this.saveFromStatusBar();
  }

  /** Only the explicitly per-tree choices are exposed in this menu. */
  private showViewSettingsMenu(event: MouseEvent): void {
    const settings = this.document?.settings;
    const anchor = this.shell?.menu.settingsButton;
    if (!settings || !anchor) return;
    new TreeSettingsMenu(settings, anchor, {
      setLayout: (value) => this.setLayoutMode(value),
      setTheme: (value) => this.setTheme(value),
      setConnectionStyle: (value) => this.setConnectionStyle(value),
      setNodeShape: (value) => this.setNodeShape(value),
      setCollectionMode: (value) => this.updateDocumentSettings((draft) => { draft.collectionMode = value; }, true),
      toggleRecursiveScan: () => this.updateDocumentSettings((draft) => { draft.recursiveScan = !draft.recursiveScan; }, true)
    }).show(event);
  }

  /** The help menu mirrors every keyboard branch handled by onKeyDown/onPaste. */
  private showKeyboardHelp(event: MouseEvent): void {
    new KeyboardHelpMenu(this.rootEl.ownerDocument).show(event);
  }

  /** Commit YAML-backed settings through the same undo/save path as tree edits. */
  private updateDocumentSettings(
    mutator: (settings: MindTreeDocumentSettings) => void,
    rescan = false
  ): void {
    this.commit((draft) => {
      mutator(draft.settings);
    });
    if (!rescan) return;
    this.scannedFilePath = undefined;
    const file = this.file;
    if (file) this.ownerWindow().setTimeout(() => void this.scanSameFolder(file));
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
    new CollapseLevelMenu((level) => {
      const document = this.document;
      if (!document) return;
      const anchorNodeId = this.primarySelectedId && document.nodes[this.primarySelectedId]
        ? this.primarySelectedId : document.rootId;
      this.commit((draft) => setCollapsedAfterDepth(draft, level), anchorNodeId);
    }).show(event);
  }

  private render(layoutAnchor?: LayoutViewportAnchor): void {
    if (!this.rootEl) return;
    if (this.parseError) {
      this.nodeLayerEl.empty();
      this.connectionsEl.empty();
      this.shell?.status.update({ message: this.parseError, kind: "error" });
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
    // Theme attributes must be present before reading computed typography.
    this.textMeasurer?.refreshStyles();
    const textMeasurer = this.textMeasurer ?? fallbackNodeTextMeasurer;
    const resourceBadgePresentation = this.getResourceBadgePresentation();
    this.currentLayout = layoutTree(
      document,
      document.rootId,
      true,
      this.plugin.settings.nodeWrapWidth,
      document.settings.layoutMode,
      this.plugin.settings.nodeAlignment,
      textMeasurer,
      resourceBadgePresentation,
      this.imageNodePresentation ?? fallbackImageNodePresentation
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
    this.nodeRenderer?.render({
      document,
      positions: this.currentLayout.nodes,
      width: this.currentLayout.width,
      height: this.currentLayout.height,
      selectedIds: this.selectedIds,
      editingNodeId: this.editingNodeId,
      editingDraftValue: this.editingNodeId ? this.editingDraftValue : undefined,
      editingSelectionMode: this.editingSelectionMode,
      branchColorSlots: this.branchColorSlotByNodeId,
      foldDirections: this.foldDirectionByNodeId,
      nodeWrapWidth: this.plugin.settings.nodeWrapWidth,
      textMeasurer,
      resourceBadgePresentation,
      imageNodePresentation: this.imageNodePresentation ?? fallbackImageNodePresentation
    }, {
      finishEdit: (nodeId, title) => this.finishEdit(nodeId, title),
      updateEditDraft: (nodeId, title) => this.updateEditDraft(nodeId, title),
      cancelEdit: () => this.cancelEdit(),
      saveImmediately: () => void this.saveImmediately(),
      focusCanvas: () => this.canvasEl.focus({ preventScroll: true }),
      toggleCollapsed: (nodeId) => this.commit((draft) => toggleCollapsed(draft, nodeId), nodeId),
      nodePointerDown: (event, nodeId) => this.onNodePointerDown(event, nodeId),
      beginEdit: (nodeId) => this.beginEdit(nodeId),
      showContextMenu: (event, nodeId) => {
        if (!this.suppressContextMenu) this.showNodeMenu(event, nodeId);
        this.suppressContextMenu = false;
      },
      openResource: (nodeId) => void this.openResource(nodeId),
      beginImageResize: (event, nodeId, image) => this.beginImageResize(event, nodeId, image),
      editorReady: (editor) => this.keyboardAvoidanceController?.watch(editor)
    });
    this.applyViewport();
    this.shell?.toolbar.update({ zoom: this.viewport.zoom });
    this.refreshBottomStatusBar();
  }

  private renderConnections(positionMap: Map<NodeId, PositionedNode>): void {
    const documentSettings = this.document?.settings;
    if (!this.currentLayout || !documentSettings || !this.connectionRenderer) return;
    this.connectionRenderer.render({
      layout: this.currentLayout,
      settings: documentSettings,
      positions: positionMap,
      branchColorSlots: this.branchColorSlotByNodeId
    });
  }

  /** Reflow an asynchronously decoded image without changing canvas location. */
  private onImagePresentationChanged(resourceId: string): void {
    const document = this.document;
    if (!document || this.viewClosed || this.editingNodeId) return;
    if (!Object.values(document.nodes).some((node) =>
      node.resource?.type === "file"
      && node.resource.fileKind === "image"
      && node.resource.resourceId === resourceId)) return;
    this.render(this.captureLayoutViewportAnchor());
  }

  private beginImageResize(event: GesturePointer, nodeId: NodeId, image: ImageNodeVisual, externallyManaged = false): void {
    const node = this.document?.nodes[nodeId];
    if (!node || node.resource?.type !== "file" || node.resource.fileKind !== "image") return;
    this.selectOnly(nodeId);
    this.canvasEl.focus({ preventScroll: true });
    const aspectRatio = image.naturalWidth && image.naturalHeight
      ? image.naturalWidth / image.naturalHeight
      : image.width / image.height;
    this.imageResizeController?.start(event, {
      nodeId,
      size: { width: image.width, height: image.height },
      aspectRatio,
      zoom: this.viewport.zoom
    }, externallyManaged);
  }

  /** Pointer movement changes only transient presentation, never history/save state. */
  private previewImageSize(nodeId: NodeId, size: ImageDisplaySize): void {
    const node = this.document?.nodes[nodeId];
    if (!node || node.resource?.type !== "file" || node.resource.fileKind !== "image") return;
    const anchor = this.captureLayoutViewportAnchor(nodeId);
    this.imageNodePresentation?.setTransientSize(nodeId, size);
    this.render(anchor);
  }

  /** Pointer-up stores the final box as one normal undoable document command. */
  private commitImageSize(nodeId: NodeId, size: ImageDisplaySize): void {
    const node = this.document?.nodes[nodeId];
    if (!node || node.resource?.type !== "file" || node.resource.fileKind !== "image") {
      this.imageNodePresentation?.clearTransientSize(nodeId);
      return;
    }
    this.imageNodePresentation?.clearTransientSize(nodeId);
    this.commit((draft) => {
      const resized = draft.nodes[nodeId];
      if (!resized) return;
      resized.style = {
        ...(resized.style ?? {}),
        imageWidth: size.width,
        imageHeight: size.height
      };
      const updatedAt = new Date().toISOString();
      resized.updatedAt = updatedAt;
      draft.updatedAt = updatedAt;
    }, nodeId);
  }

  private cancelImageSizePreview(nodeId: NodeId): void {
    const anchor = this.captureLayoutViewportAnchor(nodeId);
    this.imageNodePresentation?.clearTransientSize(nodeId);
    if (!this.viewClosed && this.document?.nodes[nodeId]) this.render(anchor);
  }

  /**
   * Theme/snippet/font changes invalidate actual glyph metrics. During title
   * editing the draft exists only in the textarea, so defer tree rendering to
   * avoid replacing it; confirmation will naturally use the refreshed metrics.
   */
  private onTextMetricsInvalidated(): void {
    this.textMeasurer?.invalidate();
    this.textMeasurer?.refreshStyles();
    this.resourceBadgeMeasurer?.invalidate();
    if (!this.document || this.editingNodeId || this.textMetricRefreshFrame !== undefined) return;
    const layoutAnchor = this.captureLayoutViewportAnchor();
    this.textMetricRefreshFrame = this.ownerWindow().requestAnimationFrame(() => {
      this.textMetricRefreshFrame = undefined;
      if (!this.document || this.editingNodeId) return;
      this.render(layoutAnchor);
    });
  }

  private onNodePointerDown(event: PointerEvent, nodeId: NodeId): void {
    if (event.pointerType === "touch") return;
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
    this.startNodeDrag(event, nodeId);
  }

  /** Both input routes reuse the existing domain move and drag preview. */
  private startNodeDrag(event: GesturePointer, nodeId: NodeId, externallyManaged = false): void {
    const document = this.document;
    const sourceElement = this.nodeLayerEl.querySelector<HTMLElement>(`.mtn-node[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!document || !sourceElement || nodeId === document.rootId) return;
    const sourceRect = sourceElement.getBoundingClientRect();
    const dragSelection = this.selectedIds.has(nodeId) ? this.selectedIds : new Set([nodeId]);
    const draggedRootIds = getTopLevelSelectedNodeIds(document, dragSelection);
    if (draggedRootIds.length === 0) return;
    // Hide and exclude every selected top-level branch. Selected descendants of
    // another selected node remain attached and therefore appear only once.
    const excludedIds = new Set(draggedRootIds.flatMap((id) => collectBranchIds(document, id)));
    this.nodeDragController?.start(event, {
      nodeId, draggedRootIds, excludedIds, sourceElement, sourceRect
    }, externallyManaged);
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
    if (content.kind === "images") {
      void this.insertClipboardImages(content.images, context);
      return;
    }
    if (content.kind === "empty") return;
    try {
      const directPaste = classifyDirectTextPaste(content.text);
      if (directPaste.kind === "empty") return;
      if (directPaste.kind === "multiline") {
        this.showTextImportModal(directPaste.text, context);
        return;
      }
      const payload = createTextPastePayload(directPaste.nodes);
      if (payload) void this.insertResolvedBranches(
        payload, context.parentId, context.documentSessionToken, "paste"
      );
    } catch (error) {
      new Notice(t("notice.operationFailed", { message: this.describeResourceError(error) }));
    }
  }

  /** Copy pasted image blobs into the vault, then insert one linked sibling per image. */
  private async insertClipboardImages(
    images: readonly ClipboardImageInput[],
    context: PasteInsertionContext
  ): Promise<void> {
    if (!this.document || this.documentSessionToken !== context.documentSessionToken) return;
    const nativeFiles = images.map((image) => new File([image.blob], image.name, {
      type: image.mimeType,
      lastModified: Date.now()
    }));
    const batch = this.dragDropController.classifyExternalFiles(nativeFiles);
    const failures = batch.rejected.map((file) => t("notice.fileTooLarge", { name: file.name }));
    if (batch.needsConfirmation && !await confirmLargeExternalFiles(this.app, batch.importable)) return;

    const acceptedFiles = new Set(batch.importable);
    const imported: Array<{ file: TFile; reference: FileResourceRef }> = [];
    for (const [index, image] of images.entries()) {
      if (!acceptedFiles.has(nativeFiles[index]!)) continue;
      if (!this.document || this.documentSessionToken !== context.documentSessionToken) {
        await this.rollbackClipboardImages(imported);
        return;
      }
      try {
        imported.push(await this.plugin.resources.importClipboardImage(
          image.blob,
          image.name,
          this.file?.path ?? ""
        ));
      } catch (error) {
        failures.push(`${image.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!this.document || this.documentSessionToken !== context.documentSessionToken) {
      await this.rollbackClipboardImages(imported);
      return;
    }

    const createdIds: NodeId[] = [];
    if (imported.length > 0) {
      this.commit((draft) => {
        const parentId = draft.nodes[context.parentId] ? context.parentId : draft.rootId;
        const parent = getNode(draft, parentId);
        parent.collapsed = false;
        for (const { file, reference } of imported) {
          const node = addNode(draft, parentId, linkedFileTitle(file.path));
          node.resource = reference;
          node.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
          createdIds.push(node.id);
        }
      });
      const lastId = createdIds.at(-1);
      if (lastId) {
        this.selectOnly(lastId);
        this.centerNodeInViewport(lastId);
      }
      new Notice(t("notice.imagesPasted", { count: imported.length }));
    }
    if (failures.length > 0) {
      new Notice(t("notice.imagePasteFailed", { count: failures.length, details: failures.join("; ") }));
    }
  }

  /** Remove only files created by a paste whose originating view was replaced. */
  private async rollbackClipboardImages(
    imported: readonly { file: TFile; reference: FileResourceRef }[]
  ): Promise<void> {
    for (const { file } of [...imported].reverse()) {
      const current = this.app.vault.getFileByPath(file.path);
      if (!current) continue;
      try {
        await this.app.fileManager.trashFile(current);
        this.plugin.resources.removePath(current.path);
      } catch {
        // A failed rollback leaves an ordinary unattached vault file; never
        // risk deleting another file later by retrying against a stale path.
      }
    }
  }

  /** Resolve imported links before committing the complete forest atomically. */
  private async insertResolvedBranches(
    payload: BranchClipboardPayload,
    requestedParentId: NodeId,
    documentSessionToken: string,
    source: "paste" | "import"
  ): Promise<boolean> {
    const isCurrent = (): boolean => Boolean(this.document && !this.parseError
      && this.documentSessionToken === documentSessionToken);
    if (!isCurrent()) return false;
    try {
      // Capture every lookup before identity allocation can rename an unmanaged
      // attachment. Different aliases/relative paths may point to the same TFile;
      // the live file object remains valid after its first ID suffix is assigned.
      const sourcePath = this.file?.path ?? "";
      const files = new Map<string, TFile | undefined>();
      for (const target of Object.values(payload.linkTargets ?? {})) {
        if (target.type !== "file" || files.has(target.linkPath)) continue;
        try { files.set(target.linkPath, this.resolvePastedFileLink(target.linkPath, sourcePath)); }
        catch { files.set(target.linkPath, undefined); }
      }
      const resolution = await resolveMarkdownBranchLinks(
        payload,
        async (linkPath) => {
          const file = files.get(linkPath);
          return file ? this.plugin.resources.ensureStableReference(file) : undefined;
        },
        this.plugin.settings.titleSync,
        isCurrent
      );
      if (resolution.cancelled || !isCurrent()) return false;
      let insertedIds: NodeId[] = [];
      this.commit((draft) => {
        const parentId = draft.nodes[requestedParentId] ? requestedParentId : draft.rootId;
        insertedIds = insertBranches(draft, parentId, resolution.payload);
      });
      if (resolution.unresolvedFileLinks.length > 0) {
        new Notice(t(
          source === "import" ? "notice.importLinksUnresolved" : "notice.pasteLinksUnresolved",
          { count: resolution.unresolvedFileLinks.length }
        ));
      }
      const firstInsertedId = insertedIds[0];
      if (firstInsertedId) {
        this.selectOnly(firstInsertedId);
        this.centerNodeInViewport(firstInsertedId);
      }
      if (source === "import" && insertedIds.length > 0) {
        new Notice(t("notice.textImported", { count: Object.keys(resolution.payload.nodes).length }));
      }
      return insertedIds.length > 0;
    } catch (error) {
      // Late failures from an abandoned view must not disturb the new document.
      if (isCurrent()) new Notice(t("notice.operationFailed", { message: this.describeResourceError(error) }));
      return false;
    }
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
  private resolvePastedFileLink(rawLinkPath: string, sourcePath: string): TFile | undefined {
    let linkPath = rawLinkPath.trim().replace(/^<|>$/g, "");
    try { linkPath = decodeURIComponent(linkPath); } catch { /* Keep the literal Obsidian path. */ }
    linkPath = linkPath.split("#", 1)[0]?.trim() ?? "";
    if (!linkPath) return undefined;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (resolved) return resolved;
    const directPath = normalizePath(linkPath.replace(/^\/+/, ""));
    return this.app.vault.getFileByPath(directPath) ?? undefined;
  }

  private showNodeMenu(event: Pick<MouseEvent, "clientX" | "clientY">, nodeId: NodeId): void {
    const document = this.document;
    const node = document?.nodes[nodeId];
    if (!document || !node) return;
    if (!this.selectedIds.has(nodeId)) this.selectOnly(nodeId);
    const linkedFile = node.resource?.type === "file";
    const branchHasFiles = collectFileReferences(document, collectBranchIds(document, nodeId)).length > 0;
    const syncing = node.titleSync === "bidirectional";
    const menuTarget: ResourceTarget = {
      documentSessionToken: this.documentSessionToken, nodeId,
      resource: node.resource ? { ...node.resource } : undefined
    };
    new NodeContextMenu({
      hasFileResource: linkedFile,
      hasResource: Boolean(node.resource),
      isDesktopApp: Platform.isDesktopApp,
      titleSyncEnabled: syncing,
      isRoot: nodeId === document.rootId,
      hasChildren: node.childIds.length > 0,
      collapsed: Boolean(node.collapsed),
      deleteCount: this.getSelectedBranchNodeIds(nodeId).length,
      branchHasFiles
    }, {
      isCurrent: () => {
        if (this.isResourceTargetCurrent(menuTarget)) return true;
        new Notice(t("notice.resourceTargetChanged"));
        return false;
      },
      toggleTitleSync: () => syncing
        ? this.commit((draft) => { getNode(draft, nodeId).titleSync = "off"; })
        : void this.enableTitleSync(nodeId),
      addNote: () => void this.createNoteForNode(nodeId),
      addFileFromTemplate: () => this.showTemplateFilePicker(nodeId),
      linkFile: () => this.linkExistingFile(nodeId),
      linkWeb: () => this.linkUrl(nodeId),
      openResource: () => void this.openResource(nodeId),
      openDefaultApp: () => void this.openResourceWithDefaultApp(menuTarget),
      unlinkResource: () => this.commit((draft) => {
        const draftNode = getNode(draft, nodeId);
        delete draftNode.resource;
        delete draftNode.titleSync;
      }),
      showMarkers: () => this.showMarkerPopover(nodeId, { x: event.clientX, y: event.clientY }),
      addChild: () => { this.selectOnly(nodeId); this.addChildNode(); },
      addSibling: () => {
        let createdId = "";
        this.commit((draft) => { createdId = addSibling(draft, nodeId, t("node.untitled")).id; });
        this.finishInteractiveNodeCreation(createdId);
      },
      toggleCollapsed: () => this.commit((draft) => toggleCollapsed(draft, nodeId), nodeId),
      expandAll: () => this.commit((draft) => setAllCollapsed(draft, nodeId, false), nodeId),
      collapseAll: () => this.commit((draft) => setAllCollapsed(draft, nodeId, true), nodeId),
      deleteBranch: () => this.requestDeleteBranch(nodeId),
      deleteNodeOnly: () => this.requestDeleteNodeOnly(nodeId),
      moveFiles: () => this.showMoveFilesModal(nodeId),
      copyBranch: () => void this.copySelected("branch"),
      copyMarkdown: () => void this.copySelected("markdown"),
      exportBranchPng: () => void this.exportSelectedPng()
    }).show(event, this.rootEl.ownerDocument);
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
    new CopyMenu(
      () => void this.copySelected("branch"),
      () => void this.copySelected("markdown")
    ).show(event);
  }

  private showExportMenu(event: MouseEvent): void {
    new ExportMenu(
      () => void this.exportSelectedPng(),
      () => this.exportSelectedMarkdown()
    ).show(event);
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
        this.resolveExportThemeColors(),
        this.textMeasurer ?? fallbackNodeTextMeasurer,
        this.getResourceBadgePresentation(),
        async (node) => {
          if (node.resource?.type !== "file" || node.resource.fileKind !== "image") return undefined;
          const file = this.plugin.resources.resolve(node.resource);
          if (!file) return undefined;
          return prepareImageExportSource(await this.app.vault.readBinary(file), file.path);
        }
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
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    const node = this.document!.nodes[nodeId]!;
    const create = async (title: string): Promise<void> => {
      let created: { file: TFile; reference: FileResourceRef } | undefined;
      try {
        // The optional title dialog may outlive the file or its unlinked node.
        this.requireAssociationTarget(target);
        const treeDirectory = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
        const directory = this.plugin.settings.newNoteFolder || treeDirectory;
        created = await this.plugin.resources.createNote(
          directory,
          title,
          this.plugin.settings.newNoteDefaultContent
        );
        this.associateFileWithTarget(target, created.file, created.reference, created.file.basename);
      } catch (error) {
        const message = this.describeResourceError(error);
        if (created) {
          // Unlike an uncommitted template copy, a normal new note is retained.
          // Report its actual path instead of deleting it or linking a new tree.
          const linked = this.isResourceTargetCurrent({ ...target, resource: created.reference });
          new Notice(t(linked ? "notice.createdFileUpdateFailed" : "notice.createdNoteNotLinked", {
            path: created.file.path, message
          }));
        } else new Notice(t("notice.createNoteFailed", { message }));
        return;
      }
      try {
        await this.openCreatedFile(created.file);
      } catch (error) {
        // The file and node association already exist at this point. Report only
        // the navigation failure instead of incorrectly claiming creation failed.
        new Notice(t("notice.openCreatedFileFailed", { message: error instanceof Error ? error.message : String(error) }));
      }
    };
    if (node.title.trim()) await create(node.title);
    else new TextPromptModal(this.app, t("modal.createNote.title"), "", t("modal.createNote.placeholder"), t("action.create"), (value) => void create(value)).open();
  }

  /** Capture the destination before the picker can outlive its original view. */
  private showTemplateFilePicker(nodeId: NodeId): void {
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
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
      (template) => void this.createFileFromTemplate(target, template)
    ).open();
  }

  private captureAssociationTarget(nodeId: NodeId): AssociationTarget | undefined {
    const target = { nodeId, documentSessionToken: this.documentSessionToken };
    if (this.isAssociationTargetCurrent(target)) return target;
    new Notice(t("notice.associationTargetChanged"));
    return undefined;
  }

  private isAssociationTargetCurrent(target: AssociationTarget): boolean {
    return isAssociationTargetAvailable(
      target, this.documentSessionToken, this.viewClosed || this.parseError ? undefined : this.document
    );
  }

  private requireAssociationTarget(target: AssociationTarget, draft = this.document): MindTreeNode {
    return requireAssociationTarget(target, this.documentSessionToken, this.viewClosed || this.parseError ? undefined : draft);
  }

  private isResourceTargetCurrent(target: ResourceTarget): boolean {
    return isResourceTargetCurrent(target, this.documentSessionToken, this.viewClosed || this.parseError ? undefined : this.document);
  }

  /** A single guarded mutation boundary for every existing/new file association. */
  private associateFileWithTarget(target: AssociationTarget, file: TFile, reference: FileResourceRef, title = linkedFileTitle(file.path)): void {
    this.requireAssociationTarget(target);
    this.commit((draft) => {
      const node = this.requireAssociationTarget(target, draft);
      node.title = title;
      node.resource = reference;
      node.titleSync = this.plugin.settings.titleSync ? "bidirectional" : "off";
    });
    if (!this.isResourceTargetCurrent({ ...target, resource: reference })) throw new AssociationTargetChangedError();
  }

  /** Copy one file, attach it once, then open through the existing preference. */
  private async createFileFromTemplate(target: AssociationTarget, template: TFile): Promise<void> {
    if (!this.isAssociationTargetCurrent(target)) {
      new Notice(t("notice.templateTargetChanged"));
      return;
    }
    let created: TemplateFileResult<TFile> | undefined;
    const isAttached = (): boolean => {
      const resource = this.document?.nodes[target.nodeId]?.resource;
      return Boolean(created && this.documentSessionToken === target.documentSessionToken
        && resource?.type === "file" && resource.resourceId === created.reference.resourceId);
    };
    try {
      const treeDirectory = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
      const directory = this.plugin.settings.newNoteFolder || treeDirectory;
      const node = this.document!.nodes[target.nodeId]!;
      const result = await this.plugin.resources.createFileFromTemplate(
        directory,
        node.title.trim() || t("node.untitled"),
        template,
        () => this.isAssociationTargetCurrent(target)
      );
      created = result;
      this.associateFileWithTarget(target, result.file, result.reference);
      if (!isAttached()) throw new TemplateTargetChangedError();
      this.plugin.resources.acceptTemplateFile(result.file);
    } catch (error) {
      if (created) {
        // Rendering may throw after a successful domain commit. Preserve an
        // already-linked file rather than turning that UI failure into data loss.
        if (isAttached()) this.plugin.resources.acceptTemplateFile(created.file);
        else {
          try { await this.plugin.resources.discardTemplateFile(created.file); }
          catch { error = new TemplateCopyRollbackError(created.file.path, error); }
        }
      }
      if (error instanceof TemplateCopyRollbackError) {
        new Notice(t("notice.templateCopyCleanupFailed", { path: error.path }));
        error = error.originalError;
      }
      const message = error instanceof TemplateTargetChangedError
        ? t("notice.templateTargetChanged") : this.describeResourceError(error);
      new Notice(t("notice.createTemplateFileFailed", { message }));
      return;
    }
    try {
      await this.openCreatedFile(created!.file);
    } catch (error) {
      new Notice(t("notice.openCreatedFileFailed", { message: error instanceof Error ? error.message : String(error) }));
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

  /** Open a newly created note or template file using the existing preference. */
  private async openCreatedFile(file: TFile): Promise<void> {
    const mode = this.plugin.settings.newNoteOpenMode;
    const leaf = mode === "current"
      ? this.leaf
      : mode === "split-right"
        ? this.app.workspace.getLeaf("split", "vertical")
        : this.app.workspace.getLeaf(mode === "window" ? "window" : "tab");
    await leaf.openFile(file, { active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Associate any existing vault file except this view's own mind-tree file. */
  private linkExistingFile(nodeId: NodeId): void {
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    const files = linkableVaultFiles(this.app.vault.getFiles(), this.file?.path);
    new FileSuggestModal(this.app, files, (file) => void (async () => {
      try {
        this.requireAssociationTarget(target);
        const reference = await this.plugin.resources.ensureStableReference(file);
        this.associateFileWithTarget(target, this.plugin.resources.resolve(reference) ?? file, reference);
      } catch (error) {
        new Notice(t("notice.linkFileFailed", { message: this.describeResourceError(error) }));
      }
    })()).open();
  }

  private linkUrl(nodeId: NodeId): void {
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    new UrlPromptModal(this.app, (url, title) => {
      try {
        this.requireAssociationTarget(target);
        this.commit((draft) => {
          const node = this.requireAssociationTarget(target, draft);
          node.title = title;
          node.resource = { type: "url", url };
          node.titleSync = "off";
        });
        if (!this.isResourceTargetCurrent({ ...target, resource: { type: "url", url } })) throw new AssociationTargetChangedError();
      } catch (error) {
        new Notice(t("notice.operationFailed", { message: this.describeResourceError(error) }));
      }
    }).open();
  }

  /** Open a searchable vault-folder picker for the current file or its branch. */
  private showMoveFilesModal(nodeId: NodeId): void {
    const document = this.document;
    if (!document?.nodes[nodeId]) return;
    const branchNodeIds = collectBranchIds(document, nodeId);
    const branchReferences = collectFileReferences(document, branchNodeIds);
    const currentResource = document.nodes[nodeId]?.resource;
    const currentReference = currentResource?.type === "file"
      ? { ...currentResource }
      : undefined;
    const folderPaths = this.app.vault.getAllFolders(true)
      .map((folder) => folder.isRoot() ? "" : folder.path)
      .sort((left, right) => left.localeCompare(right));
    const currentFolderPath = this.file?.parent?.isRoot() ? "" : this.file?.parent?.path ?? "";
    new MoveFilesModal(
      this.app,
      folderPaths,
      currentFolderPath,
      currentReference !== undefined,
      branchReferences.length > 0,
      (folderPath, mode) => {
        const references = mode === "current" && currentReference
          ? [currentReference]
          : branchReferences;
        void this.moveFilesToFolder(references, folderPath);
      }
    ).open();
  }

  /** Move unique linked files and persist every matching path hint in this tree. */
  private async moveFilesToFolder(
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

    this.applySystemMutation((draft) => updateFileReferencePaths(draft, movedPaths));
    if (movedPaths.size > 0) {
      new Notice(t("notice.filesMoved", {
        count: movedPaths.size,
        folder: destinationFolder || "/"
      }));
    }
    if (failures.length > 0) {
      new Notice(t("notice.moveFilesFailed", { count: failures.length, details: failures.join("; ") }));
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

  /** Explicit desktop action only; existing in-app opening remains separate. */
  private async openResourceWithDefaultApp(target: ResourceTarget): Promise<void> {
    if (!target.resource) return;
    const opener = new DefaultAppOpener<TFile>({
      isDesktopApp: () => Platform.isDesktopApp,
      loadShell: loadDesktopShell,
      resolveFile: (reference) => this.plugin.resources.resolve(reference),
      getFullPath: (file) => {
        const adapter = this.app.vault.adapter;
        return adapter instanceof FileSystemAdapter ? adapter.getFullPath(file.path) : undefined;
      }
    });
    try {
      await opener.open(target.resource, () => this.isResourceTargetCurrent(target));
    } catch (error) {
      if (error instanceof DefaultAppOpenError) {
        switch (error.code) {
          case "desktop-only": new Notice(t("notice.defaultAppDesktopOnly")); return;
          case "target-changed": new Notice(t("notice.resourceTargetChanged")); return;
          case "file-not-found": new Notice(t("notice.fileNotFound", { path: error.detail })); return;
          case "unsupported-adapter": new Notice(t("notice.defaultAppUnsupportedAdapter")); return;
          case "invalid-url": new Notice(t("notice.invalidLink")); return;
          case "unsafe-url": new Notice(t("notice.unsafeLink")); return;
        }
      }
      new Notice(t("notice.defaultAppOpenFailed", { message: error instanceof Error ? error.message : String(error) }));
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

  /** Build one immutable badge rule set for the current render/export pass. */
  private getResourceBadgePresentation(): ResourceBadgePresentation {
    this.resourceBadgeMeasurer?.refreshStyles();
    return createResourceBadgePresentation(
      this.plugin.settings,
      { mindTree: t("node.mindTreeMarker"), drawing: t("node.drawingMarker") },
      this.resourceBadgeMeasurer ?? fallbackResourceBadgeMeasurer
    );
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
      try {
        await this.plugin.resources.trashLinkedFile(resource);
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
    this.sharedSession?.claimEditor(this.sharedParticipantId);
    const layoutAnchor = this.captureLayoutViewportAnchor(nodeId);
    this.editingNodeId = nodeId;
    this.editingOriginalTitle = node.title;
    this.editingDraftValue = node.title;
    this.editingSelectionMode = selectionMode;
    this.sharedSession?.updateTitleDraft(
      this.sharedParticipantId,
      nodeId,
      node.title,
      node.title
    );
    this.render(layoutAnchor);
  }

  /** Keep the authoritative in-memory draft current without relaying out. */
  private updateEditDraft(nodeId: NodeId, value: string): void {
    if (this.editingNodeId !== nodeId) return;
    this.editingDraftValue = value;
    this.sharedSession?.updateTitleDraft(
      this.sharedParticipantId,
      nodeId,
      this.editingOriginalTitle,
      value
    );
    this.setStatus(t("status.unsaved"), "dirty");
  }

  /** Read the DOM value before a lifecycle operation destroys the textarea. */
  private commitVisibleEditorDraft(): void {
    const nodeId = this.editingNodeId;
    if (!nodeId) return;
    const editor = this.nodeLayerEl?.querySelector<HTMLTextAreaElement>(
      `.mtn-node[data-node-id="${CSS.escape(nodeId)}"] .mtn-title-input`
    );
    this.finishEdit(nodeId, editor?.value ?? this.sharedSession?.draft?.value ?? this.editingOriginalTitle);
  }

  private finishEdit(nodeId: NodeId, value: string): void {
    const document = this.document;
    if (this.editingNodeId !== nodeId || !document) return;
    this.keyboardAvoidanceController?.end();
    this.editingNodeId = undefined;
    this.editingDraftValue = "";
    this.sharedSession?.releaseEditor(this.sharedParticipantId);
    // Empty edits become the visible default title instead of silently deleting
    // the node. This makes repeated Tab/Enter creation predictable.
    const title = value.replace(/[\r\n]+/g, " ").trim() || t("node.untitled");
    const node = document.nodes[nodeId];
    if (!node) return;
    if (title === this.editingOriginalTitle) {
      this.render();
      const dirty = this.documentSession.dirty;
      this.setStatus(dirty ? t("status.unsaved") : t("status.saved"), dirty ? "dirty" : "saved");
      this.sharedSession?.notifyStatus(this.sharedParticipantId);
      return;
    }
    const previousTitle = node.title;
    this.commit((draft) => renameNode(draft, nodeId, title));
    const updated = this.document?.nodes[nodeId];
    if (nodeId === this.document?.rootId && this.file) {
      this.trackTitleFileOperation(() => this.renameTreeFileForEditedRoot(title, previousTitle));
    } else if (updated?.resource?.type === "file" && updated.titleSync === "bidirectional") {
      const reference = updated.resource;
      this.trackTitleFileOperation(() => this.renameFileForEditedNode(nodeId, title, previousTitle, reference));
    }
  }

  private trackTitleFileOperation(operation: () => Promise<void>): void {
    const previous = this.pendingTitleFileOperation ?? Promise.resolve();
    const session = this.sharedSession;
    const tracked = previous.catch(() => undefined).then(() => (
      session ? session.runFileOperation(operation) : operation()
    ));
    const completed = tracked.finally(() => {
      if (this.pendingTitleFileOperation === completed) this.pendingTitleFileOperation = undefined;
    });
    this.pendingTitleFileOperation = completed;
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
    this.keyboardAvoidanceController?.end();
    const layoutAnchor = this.captureLayoutViewportAnchor(this.editingNodeId);
    this.editingNodeId = undefined;
    this.editingDraftValue = "";
    this.sharedSession?.releaseEditor(this.sharedParticipantId);
    this.render(layoutAnchor);
    const dirty = this.documentSession.dirty;
    this.setStatus(dirty ? t("status.unsaved") : t("status.saved"), dirty ? "dirty" : "saved");
    this.sharedSession?.notifyStatus(this.sharedParticipantId);
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

  /** Translate association/identity failures while preserving ordinary error details. */
  private describeResourceError(error: unknown): string {
    if (error instanceof AssociationTargetChangedError) return t("notice.associationTargetChanged");
    if (error instanceof DuplicateResourceIdError) {
      return t("notice.duplicateResourceId", { paths: error.paths.join(", ") });
    }
    return error instanceof Error ? error.message : String(error);
  }

  private commit(mutator: (draft: MindTreeDocument) => void, anchorNodeId = this.document?.rootId): void {
    this.sharedSession?.commitEditorBeforeMutation(this.sharedParticipantId);
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
    this.markDocumentDirty(schedule, "system");
    return true;
  }

  /** Mark one semantic document mutation; viewport-only work never calls this. */
  private markDocumentDirty(
    schedule = true,
    reason: SharedSessionChangeReason = "document"
  ): void {
    this.documentSession.markChanged();
    if (!this.applyingSharedSessionUpdate) {
      this.sharedSession?.replaceDocument(this.document, this.sharedParticipantId, reason);
    }
    this.setStatus(t("status.unsaved"), "dirty");
    if (schedule) this.scheduleSave();
  }

  private hasUnsavedState(): boolean {
    return this.documentSession.dirty || this.sharedSession?.draft !== undefined;
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
    const presentation = viewportToCssPresentation(this.viewport, this.ownerWindow().devicePixelRatio);
    this.panLayerEl.style.left = presentation.panLeft;
    this.panLayerEl.style.top = presentation.panTop;
    this.panLayerEl.style.transform = "none";
    const supportsLayoutZoom = typeof CSS !== "undefined" && CSS.supports("zoom", "1");
    if (supportsLayoutZoom) {
      this.worldEl.style.transform = "none";
      this.worldEl.style.setProperty("zoom", presentation.contentZoom);
    } else {
      // Compatibility fallback for an older WebView. Current Obsidian desktop
      // and mobile engines support CSS zoom, so normal use takes the crisp path.
      this.worldEl.style.removeProperty("zoom");
      this.worldEl.style.transform = `scale(${this.viewport.zoom})`;
    }
    this.shell?.toolbar.update({ zoom: this.viewport.zoom });
  }

  /** Coalesce touch samples without delaying the authoritative view-only position. */
  private scheduleTouchViewportUpdate(): void {
    if (this.touchViewportFrame !== undefined) return;
    this.touchViewportFrame = this.ownerWindow().requestAnimationFrame(() => {
      this.touchViewportFrame = undefined;
      if (!this.viewClosed) this.applyViewport();
    });
  }

  private cancelCanvasGestures(): void {
    this.touchGestureController?.cancel();
    this.canvasInteractionController?.cancel();
    this.nodeDragController?.cancel();
    this.imageResizeController?.cancel();
    if (this.touchViewportFrame !== undefined) {
      this.ownerWindow().cancelAnimationFrame(this.touchViewportFrame);
      this.touchViewportFrame = undefined;
      if (this.canvasEl && !this.viewClosed) this.applyViewport();
    }
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
    this.keyboardAvoidanceController?.userNavigated();
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
    // Routine saved/dirty state belongs on the save button. The free-floating
    // message is reserved for warnings and errors that need explanatory text.
    const showMessage = kind === "warning" || kind === "error";
    this.shell?.status.update({
      message: showMessage ? message : "",
      kind: kind === "warning" ? "warning" : kind === "error" ? "error" : "normal"
    });
    this.refreshBottomStatusBar();
  }
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

/** Bounded key for de-duplicating invalid external payloads without retaining them. */
function sourceFingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${source.length}:${(hash >>> 0).toString(16)}`;
}

function deduplicateFiles(files: TFile[]): TFile[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

/** Shortcuts must never replace normal typing inside any text editor control. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input,textarea,[contenteditable='true']"));
}
