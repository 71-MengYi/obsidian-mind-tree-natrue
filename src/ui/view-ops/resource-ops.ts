import {
  FileSystemAdapter,
  Notice,
  Platform,
  type App,
  type TFile,
  type WorkspaceLeaf
} from "obsidian";
import { t } from "../../i18n";
import { fileTitleFromNode, type TitleCommitResult } from "../../format/node-title";
import { linkedFileTitle } from "../../format/resource-id";
import {
  collectBranchIds,
  collectFileReferences,
  getNode,
  updateFileReferencePaths
} from "../../domain/tree";
import type { FileResourceRef, MindTreeDocument, MindTreeNode, NodeId } from "../../types";
import {
  AssociationTargetChangedError,
  isAssociationTargetAvailable,
  isResourceTargetCurrent as isCurrentResourceTarget,
  requireAssociationTarget as requireAvailableTarget,
  type AssociationTarget,
  type ResourceTarget
} from "../association-target";
import { linkableVaultFiles } from "../file-selection";
import {
  FileSuggestModal,
  MoveFilesModal,
  TemplateSuggestModal,
  TextPromptModal
} from "../modals/index";
import { DefaultAppOpener, DefaultAppOpenError, loadDesktopShell } from "../../services/default-app-opener";
import { CreatedNoteAssociationError, type ResourceIndexService } from "../../services/resource-index";
import {
  TemplateCopyRollbackError,
  TemplateTargetChangedError,
  type TemplateFileResult
} from "../../services/template-files";
import type { MindTreeSettings } from "../../settings-model";

/**
 * Everything the resource-association commands need from the view. Getters
 * return live view state so a session switch, node deletion or locked session
 * observed after an `await` still invalidates the command, exactly like the
 * original inline methods.
 */
export interface ResourceOpsHost {
  getDocument(): MindTreeDocument | undefined;
  getFile(): TFile | null;
  getPrimarySelectedId(): NodeId | undefined;
  /** Changes whenever TextFileView replaces the loaded document snapshot. */
  getDocumentSessionToken(): string;
  /** False while the view closes, re-parses or refuses new associations. */
  acceptingAssociations(): boolean;
  viewClosed(): boolean;
  parseFailed(): boolean;
  mutationLocked(): boolean;
  commitVisibleEditorDraft(): TitleCommitResult;
  /** The view's single user-command mutation path: undo step, render, save. */
  commit(mutator: (draft: MindTreeDocument) => void, anchorNodeId?: NodeId): void;
  /** Metadata repair: persisted without an undo step, like before the move. */
  applySystemMutation(
    mutator: (draft: MindTreeDocument) => boolean,
    anchorNodeId?: NodeId,
    schedule?: boolean
  ): boolean;
  /** Single-flight slots still owned by the view's FileAssociationController. */
  createFileOnce(key: string, create: () => Promise<void>): Promise<void>;
  /**
   * The view's observed command entry points. Picker and shortcut callbacks
   * re-enter them so the update-activity instrumentation keeps tracking the
   * whole asynchronous operation, exactly like before the move.
   */
  runMoveFilesCommand(references: FileResourceRef[], destinationFolder: string): void;
  runCreateNoteCommand(nodeId: NodeId): void;
  runCreateFileFromTemplateCommand(target: AssociationTarget, template: TFile): void;
  /** Association/identity error translation shared with the collection layer. */
  describeResourceError(error: unknown): string;
  getApp(): App;
  getLeaf(): WorkspaceLeaf;
  getSettings(): MindTreeSettings;
  getResources(): ResourceIndexService;
  openLinkedFile(file: TFile, destination: () => WorkspaceLeaf): Promise<void>;
}

/**
 * Note/template/URL file association, moving, title sync and opening commands,
 * extracted verbatim from the view. The view keeps thin same-name wrappers so
 * the update-activity instrumentation and menu/event wiring stay in place; the
 * host supplies every state read live and keeps the cache/session tokens
 * checked across `await` boundaries.
 */
export class ResourceOps {
  constructor(private readonly host: ResourceOpsHost) {}

  async createNoteForNode(nodeId: NodeId): Promise<void> {
    if (this.host.commitVisibleEditorDraft() === "rejected") return;
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    const node = this.host.getDocument()!.nodes[nodeId]!;
    const create = async (source: string): Promise<void> => {
      const title = fileTitleFromNode(source);
      if (title === undefined) { new Notice(t("title.codeOrMath")); return; }
      await this.host.createFileOnce(`${target.documentSessionToken}:${nodeId}`, async () => {
      let created: { file: TFile; reference: FileResourceRef } | undefined;
      try {
        // The optional title dialog may outlive the file or its unlinked node.
        this.requireAssociationTarget(target);
        const treeDirectory = this.host.getFile()?.parent?.isRoot() ? "" : this.host.getFile()?.parent?.path ?? "";
        const directory = this.host.getSettings().newNoteFolder || treeDirectory;
        created = await this.host.getResources().createNote(
          directory,
          title,
          this.host.getSettings().newNoteDefaultContent
        );
        this.associateFileWithTarget(target, created.file, created.reference, created.file.basename);
      } catch (error) {
        const message = this.host.describeResourceError(error instanceof CreatedNoteAssociationError ? error.originalError : error);
        const retainedFile = created?.file ?? (error instanceof CreatedNoteAssociationError ? error.file : undefined);
        if (retainedFile) {
          // Unlike an uncommitted template copy, a normal new note is retained.
          // Report its actual path instead of deleting it or linking a new tree.
          const linked = created && this.isResourceTargetCurrent({ ...target, resource: created.reference });
          new Notice(t(linked ? "notice.createdFileUpdateFailed" : "notice.createdNoteNotLinked", {
            path: retainedFile.path, message
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
    });
    };
    if (node.title.trim()) await create(node.title);
    else new TextPromptModal(this.host.getApp(), t("modal.createNote.title"), "", t("modal.createNote.placeholder"), t("action.create"), (value) => void create(value)).open();
  }

  /** Capture the destination before the picker can outlive its original view. */
  showTemplateFilePicker(nodeId: NodeId): void {
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    const templateFolder = this.host.getSettings().templateFolder.trim();
    if (!templateFolder) {
      new Notice(t("notice.templateFolderNotConfigured"));
      return;
    }
    const templates = this.host.getResources().templateFiles(templateFolder);
    if (templates.length === 0) {
      new Notice(t("notice.noTemplates"));
      return;
    }
    new TemplateSuggestModal(this.host.getApp(), templates, (template) => this.host.runCreateFileFromTemplateCommand(target, template)).open();
  }

  captureAssociationTarget(nodeId: NodeId): AssociationTarget | undefined {
    const target = { nodeId, documentSessionToken: this.host.getDocumentSessionToken() };
    if (this.isAssociationTargetCurrent(target)) return target;
    new Notice(t("notice.associationTargetChanged"));
    return undefined;
  }

  /**
   * The document an association may still mutate. A closed, replaced, error or
   * locked view must never let a stale target write into a new document, so the
   * whole guard lives in one place instead of being repeated per entry point.
   */
  liveDraft(): MindTreeDocument | undefined {
    if (!this.host.acceptingAssociations() || this.host.viewClosed() || this.host.parseFailed() || this.host.mutationLocked()) return undefined;
    return this.host.getDocument();
  }

  isAssociationTargetCurrent(target: AssociationTarget): boolean {
    return isAssociationTargetAvailable(target, this.host.getDocumentSessionToken(), this.liveDraft());
  }

  requireAssociationTarget(target: AssociationTarget, draft = this.host.getDocument()): MindTreeNode {
    return requireAvailableTarget(target, this.host.getDocumentSessionToken(), this.liveDraft() === undefined ? undefined : draft);
  }

  isResourceTargetCurrent(target: ResourceTarget): boolean {
    return isCurrentResourceTarget(target, this.host.getDocumentSessionToken(), this.liveDraft());
  }

  /** A single guarded mutation boundary for every existing/new file association. */
  associateFileWithTarget(target: AssociationTarget, file: TFile, reference: FileResourceRef, title = linkedFileTitle(file.path)): void {
    this.requireAssociationTarget(target);
    this.host.commit((draft) => {
      const node = this.requireAssociationTarget(target, draft);
      node.title = title;
      node.resource = reference;
      node.titleSync = this.host.getSettings().titleSync ? "bidirectional" : "off";
    });
    if (!this.isResourceTargetCurrent({ ...target, resource: reference })) throw new AssociationTargetChangedError();
  }

  /** Copy one file, attach it once, then open through the existing preference. */
  async createFileFromTemplate(target: AssociationTarget, template: TFile): Promise<void> {
    if (!this.isAssociationTargetCurrent(target)) {
      new Notice(t("notice.templateTargetChanged"));
      return;
    }
    let created: TemplateFileResult<TFile> | undefined;
    const isAttached = (): boolean => {
      const resource = this.host.getDocument()?.nodes[target.nodeId]?.resource;
      return Boolean(created && this.host.getDocumentSessionToken() === target.documentSessionToken
        && resource?.type === "file" && resource.resourceId === created.reference.resourceId);
    };
    try {
      const treeDirectory = this.host.getFile()?.parent?.isRoot() ? "" : this.host.getFile()?.parent?.path ?? "";
      const directory = this.host.getSettings().newNoteFolder || treeDirectory;
      const node = this.host.getDocument()!.nodes[target.nodeId]!;
      const result = await this.host.getResources().createFileFromTemplate(
        directory,
        node.title.trim() || t("node.untitled"),
        template,
        () => this.isAssociationTargetCurrent(target)
      );
      created = result;
      this.associateFileWithTarget(target, result.file, result.reference);
      if (!isAttached()) throw new TemplateTargetChangedError();
      this.host.getResources().acceptTemplateFile(result.file);
    } catch (error) {
      if (created) {
        // Rendering may throw after a successful domain commit. Preserve an
        // already-linked file rather than turning that UI failure into data loss.
        if (isAttached()) this.host.getResources().acceptTemplateFile(created.file);
        else {
          try { await this.host.getResources().discardTemplateFile(created.file); }
          catch { error = new TemplateCopyRollbackError(created.file.path, error); }
        }
      }
      if (error instanceof TemplateCopyRollbackError) {
        new Notice(t("notice.templateCopyCleanupFailed", { path: error.path }));
        error = error.originalError;
      }
      const message = error instanceof TemplateTargetChangedError
        ? t("notice.templateTargetChanged") : this.host.describeResourceError(error);
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
  createNoteForSelection(): boolean {
    const nodeId = this.host.getPrimarySelectedId();
    const node = nodeId ? this.host.getDocument()?.nodes[nodeId] : undefined;
    if (!node) return false;
    // Linked nodes intentionally have no second "create note" operation. Give
    // explicit feedback while still consuming Mod+E so Obsidian cannot replace
    // this custom view with its global editing-mode action.
    if (node.resource) {
      new Notice(t("notice.nodeAlreadyLinked"));
      return true;
    }
    this.host.runCreateNoteCommand(node.id);
    return true;
  }

  /** Open a newly created note or template file using the existing preference. */
  async openCreatedFile(file: TFile): Promise<void> {
    const mode = this.host.getSettings().newNoteOpenMode;
    await this.host.openLinkedFile(file, () => mode === "current"
      ? this.host.getLeaf()
      : mode === "split-right"
        ? this.host.getApp().workspace.getLeaf("split", "vertical")
        : this.host.getApp().workspace.getLeaf(mode === "window" ? "window" : "tab"));
  }

  /** Associate any existing vault file except this view's own mind-tree file. */
  linkExistingFile(nodeId: NodeId): void {
    const target = this.captureAssociationTarget(nodeId);
    if (!target) return;
    const files = linkableVaultFiles(this.host.getApp().vault.getFiles(), this.host.getFile()?.path);
    new FileSuggestModal(this.host.getApp(), files, (file) => void (async () => {
      try {
        this.requireAssociationTarget(target);
        const reference = await this.host.getResources().ensureStableReference(file);
        this.associateFileWithTarget(target, this.host.getResources().resolve(reference) ?? file, reference);
      } catch (error) {
        new Notice(t("notice.linkFileFailed", { message: this.host.describeResourceError(error) }));
      }
    })()).open();
  }

  /** Open a searchable vault-folder picker for the current file or its branch. */
  showMoveFilesModal(nodeId: NodeId): void {
    if (this.host.mutationLocked()) return;
    const token = this.host.getDocumentSessionToken();
    const document = this.host.getDocument();
    if (!document?.nodes[nodeId]) return;
    const branchNodeIds = collectBranchIds(document, nodeId);
    const branchReferences = collectFileReferences(document, branchNodeIds);
    const currentResource = document.nodes[nodeId]?.resource;
    const currentReference = currentResource?.type === "file"
      ? { ...currentResource }
      : undefined;
    const folderPaths = this.host.getApp().vault.getAllFolders(true)
      .map((folder) => folder.isRoot() ? "" : folder.path)
      .sort((left, right) => left.localeCompare(right));
    const currentFolderPath = this.host.getFile()?.parent?.isRoot() ? "" : this.host.getFile()?.parent?.path ?? "";
    new MoveFilesModal(
      this.host.getApp(),
      folderPaths,
      currentFolderPath,
      currentReference !== undefined,
      branchReferences.length > 0,
      (folderPath, mode) => {
        if (this.host.mutationLocked() || this.host.getDocumentSessionToken() !== token) return;
        const references = mode === "current" && currentReference
          ? [currentReference]
          : branchReferences;
        this.host.runMoveFilesCommand(references, folderPath);
      }
    ).open();
  }

  /** Move unique linked files and persist every matching path hint in this tree. */
  async moveFilesToFolder(
    references: FileResourceRef[],
    destinationFolder: string
  ): Promise<void> {
    if (this.host.mutationLocked()) return;
    const token = this.host.getDocumentSessionToken();
    const movedPaths = new Map<string, string>();
    const failures: string[] = [];
    for (const reference of references) {
      if (this.host.mutationLocked() || token !== this.host.getDocumentSessionToken()) return;
      try {
        const moved = await this.host.getResources().moveLinkedFile(reference, destinationFolder);
        movedPaths.set(reference.resourceId, moved.path);
      } catch (error) {
        failures.push(`${reference.pathHint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.host.mutationLocked() || token !== this.host.getDocumentSessionToken()) return;
    this.host.applySystemMutation((draft) => updateFileReferencePaths(draft, movedPaths));
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

  async enableTitleSync(nodeId: NodeId): Promise<void> {
    if (this.host.commitVisibleEditorDraft() === "rejected") return;
    if (this.host.mutationLocked()) return;
    const node = this.host.getDocument()?.nodes[nodeId];
    if (node?.resource?.type !== "file") return;
    const resourceId = node.resource.resourceId;
    const title = fileTitleFromNode(node.title);
    if (title === undefined) { new Notice(t("title.codeOrMath")); return; }
    const token = this.host.getDocumentSessionToken();
    const originalTitle = node.title;
    try {
      const file = await this.host.getResources().renameLinkedFile(node.resource, title);
      const current = this.host.getDocument()?.nodes[nodeId];
      if (token !== this.host.getDocumentSessionToken() || current?.resource?.type !== "file" || current.resource.resourceId !== resourceId || current.title !== originalTitle) return;
      this.host.commit((draft) => {
        const draftNode = getNode(draft, nodeId);
        if (draftNode.resource?.type !== "file" || draftNode.resource.resourceId !== resourceId) return;
        draftNode.resource.pathHint = file.path;
        draftNode.title = linkedFileTitle(file.path);
        draftNode.titleSync = "bidirectional";
      });
      new Notice(t("notice.syncEnabled"));
    } catch (error) {
      new Notice(t("notice.renameFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Explicit desktop action only; existing in-app opening remains separate. */
  async openResourceWithDefaultApp(target: ResourceTarget): Promise<void> {
    if (!target.resource) return;
    const opener = new DefaultAppOpener<TFile>({
      isDesktopApp: () => Platform.isDesktopApp,
      loadShell: loadDesktopShell,
      resolveFile: (reference) => this.host.getResources().resolveVerified(reference),
      getFullPath: (file) => {
        const adapter = this.host.getApp().vault.adapter;
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
}
