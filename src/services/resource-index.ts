import { App, normalizePath, TFile } from "obsidian";
import { createId } from "../domain/tree";
import { EXTERNAL_FILE_REJECT_BYTES } from "../input-limits";
import {
  appendNonMarkdownResourceId, buildLinkedResourcePath, classifyFile, createShortResourceId,
  DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR, isMarkdownPath, stripNonMarkdownResourceId,
  type NonMarkdownResourceIdSeparator
} from "../format/resource-id";
import type { FileResourceRef, MindTreeDocument, ResourceId } from "../types";
import { buildNewNoteBody } from "./note-content";
import { decideDocumentIdentityWrite, decideDuplicateIdentity } from "./resource-identity";
import { filesInTemplateFolder, TemplateFileService } from "./template-files";
import { ResourceCatalog, type ResourceIndexProgress, type ResourceIndexReport } from "./resource-catalog";
import type { IndexedResource } from "./local-resource-cache";
import { t } from "../i18n";
export type { IndexedResource } from "./local-resource-cache";
export type { ResourceIndexProgress, ResourceIndexReport } from "./resource-catalog";

/** Duplicates never authorize modifying an existing file's identity. */
export class DuplicateResourceIdError extends Error {
  constructor(readonly resourceId: ResourceId, readonly paths: string[]) {
    super(t("resourceIndex.duplicate", { id: resourceId, paths: paths.join("\n") }));
    this.name = "DuplicateResourceIdError";
  }
}
export interface MindTreeDocumentIdWriteResult { file: TFile; documentId: ResourceId }
export type MindTreeDocumentIdWriter = (
  file: TFile, documentId: ResourceId, expectedDocumentId?: ResourceId
) => Promise<MindTreeDocumentIdWriteResult>;

export interface LinkedFileResult { file: TFile; reference: FileResourceRef }
export interface FileAssociationProgress {
  phase: "verify" | "associate" | "finish";
  completed: number;
  total: number;
}
export interface FileAssociationBatch {
  linked: LinkedFileResult[];
  failures: Array<{ path: string; error: unknown }>;
  cancelled: boolean;
  /** Synchronous last check at the document command boundary, not a cache lease. */
  assertCurrent(): void;
}

/** Creation succeeded; a later association failure must not hide the retained file. */
export class CreatedNoteAssociationError extends Error {
  constructor(readonly file: TFile, readonly originalError: unknown) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "CreatedNoteAssociationError";
  }
}

export class ResourceIndexService {
  private readonly catalog: ResourceCatalog<TFile>;
  private readonly pendingReferenceByPath = new Map<string, Promise<FileResourceRef>>();
  private readonly resourceMutationTail = new Map<ResourceId, Promise<void>>();
  private readonly templateFileService: TemplateFileService<TFile>;

  constructor(
    private readonly app: App,
    initialEntries: readonly IndexedResource[] = [],
    onChanged: (entries: IndexedResource[]) => void = () => undefined,
    private readonly getNonMarkdownIdSeparator: () => NonMarkdownResourceIdSeparator =
      () => DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
    private readonly writeMindTreeDocumentId?: MindTreeDocumentIdWriter
  ) {
    this.catalog = new ResourceCatalog({
      files: () => this.app.vault.getFiles().filter((file) => !this.templateFileService.isPendingPath(file.path)),
      file: (path) => this.app.vault.getFileByPath(path) ?? undefined,
      read: (file) => this.app.vault.read(file),
      changed: onChanged,
      yield: () => new Promise((resolve) => setTimeout(resolve, 0))
    }, initialEntries);
    this.templateFileService = new TemplateFileService<TFile>({
      exists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
      isCurrentFile: (file) => this.app.vault.getFileByPath(file.path) === file,
      ensureFolder: (path) => this.ensureFolder(path),
      copy: (source, path) => this.app.vault.copy(source, path),
      processFrontMatter: (file, update) => this.app.fileManager.processFrontMatter(file, update),
      createResourceId: (markdown) => markdown ? createId() : createShortResourceId(),
      resourceIdExists: (id) => this.catalog.has(id),
      register: async (reference) => {
        const file = this.app.vault.getFileByPath(reference.pathHint);
        if (!file || (await this.catalog.refresh(file))?.resourceId !== reference.resourceId) {
          throw new Error(t("resourceIndex.identityChanged"));
        }
      },
      trash: (file) => this.app.fileManager.trashFile(file),
      removePath: (path) => this.removePath(path)
    });
  }

  rebuild(progress?: (value: ResourceIndexProgress) => void): Promise<ResourceIndexReport> {
    return this.catalog.rebuild(true, progress);
  }

  /** Loading a tree may precede onLayoutReady's background scan. Share that work. */
  verifyIndex(): Promise<ResourceIndexReport> { return this.catalog.rebuild(false); }

  /** Identity repair never treats an old cache entry as proof of ownership. */
  async prepareIdentityRestore(resourceId: string, targetPath: string): Promise<() => void> {
    const report = await this.catalog.rebuild(true);
    if (report.failures.length) throw new Error(t("resourceIndex.unverified"));
    const otherPaths = this.catalog.paths(resourceId).filter((path) => normalizePath(path) !== normalizePath(targetPath));
    if (otherPaths.length) throw new DuplicateResourceIdError(resourceId, otherPaths);
    const generation = this.catalog.generation;
    return () => {
      if (generation !== this.catalog.generation || !this.catalog.isFullyVerified()) throw new Error(t("resourceIndex.unverified"));
    };
  }

  entries(): IndexedResource[] { return this.catalog.entries(); }
  destroy(): void { this.catalog.destroy(); }

  async indexFile(file: TFile, event: "file" | "metadata" = "file"): Promise<IndexedResource | undefined> {
    if (this.templateFileService.isPendingPath(file.path)) return undefined;
    // MetadataCache reports a completed parse, not another write. It must still
    // request fresh bytes, but cannot invalidate the foreground read merely by
    // repeating the vault's notification.
    if (event === "file") this.catalog.invalidate(file.path);
    return this.catalog.refresh(file, event === "metadata");
  }

  removePath(path: string): void { this.catalog.invalidate(normalizePath(path)); }

  async handleRename(file: TFile, oldPath: string): Promise<void> {
    this.removePath(oldPath);
    await this.indexFile(file);
  }

  /** Rendering never reads disk or turns unverified persisted hints into identities. */
  resolve(reference: FileResourceRef): TFile | undefined { return this.catalog.resolve(reference); }
  resolveVerified(reference: FileResourceRef): Promise<TFile | undefined> {
    return this.catalog.resolveVerified(reference);
  }

  describe(reference: FileResourceRef, preferredFile?: TFile): Omit<IndexedResource, "resourceId"> | undefined {
    // A rename event's preferred path is subject to the same identity check.
    const file = preferredFile && this.catalog.entry(preferredFile)?.resourceId === reference.resourceId
      ? preferredFile : this.resolve(reference);
    const entry = file ? this.catalog.entry(file) : undefined;
    if (!entry) return undefined;
    return { path: entry.path, fileKind: entry.fileKind,
      ...(entry.fileSubtype ? { fileSubtype: entry.fileSubtype } : {}) };
  }

  private async assertUnique(resourceId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const report = await this.catalog.rebuild(false);
      this.assertKnownUnique(resourceId);
      if (report.failures.length) throw new Error(t("resourceIndex.unverified"));
      if (this.catalog.isFullyVerified()) return;
    }
    throw new Error(t("resourceIndex.unverified"));
  }

  private assertKnownUnique(resourceId: string): void {
    const paths = this.catalog.paths(resourceId);
    const decision = decideDuplicateIdentity(paths);
    if (decision.action === "reject") throw new DuplicateResourceIdError(resourceId, decision.paths);
  }

  /** File side effects require uniqueness as well as a fresh matching identity. */
  private async requireMutableFile(reference: FileResourceRef): Promise<TFile> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.assertUnique(reference.resourceId);
      const generation = this.catalog.generation;
      const file = await this.resolveVerified(reference);
      if (!file) throw new Error(t("resourceIndex.identityChanged"));
      // A sync event can introduce a duplicate during the final asynchronous
      // read. Repeat the uniqueness check rather than modifying that file.
      if (generation !== this.catalog.generation || !this.catalog.isFullyVerified()) continue;
      const paths = this.catalog.paths(reference.resourceId);
      if (paths.length > 1) throw new DuplicateResourceIdError(reference.resourceId, paths);
      return file;
    }
    throw new Error(t("resourceIndex.unverified"));
  }

  async ensureStableReference(file: TFile): Promise<FileResourceRef> {
    const report = await this.catalog.rebuild(false);
    if (report.failures.length) throw new Error(t("resourceIndex.unverified"));
    const reference = await this.prepareStableReference(file);
    await this.assertUnique(reference.resourceId);
    if (!this.catalog.isFullyVerified()) throw new Error(t("resourceIndex.unverified"));
    this.assertReferenceCurrent(file, reference);
    return reference;
  }

  /** Share identity allocation, not the callers' final uniqueness decisions. */
  private async prepareStableReference(file: TFile): Promise<FileResourceRef> {
    const path = normalizePath(file.path);
    const pending = this.pendingReferenceByPath.get(path);
    if (pending) return pending;
    const operation = this.ensureStableReferenceInternal(file);
    this.pendingReferenceByPath.set(path, operation);
    try { return await operation; }
    finally {
      if (this.pendingReferenceByPath.get(path) === operation) this.pendingReferenceByPath.delete(path);
    }
  }

  private async ensureStableReferenceInternal(file: TFile): Promise<FileResourceRef> {
    // Inspect actual bytes, not a potentially lagging MetadataCache entry.
    let current = await this.catalog.refresh(file);
    let managedFile = file;
    let resourceId = current?.resourceId;
    if (resourceId) this.assertKnownUnique(resourceId);
    else {
      // Another actor may have assigned an ID while the first read was pending.
      // In particular, never append a replacement ID to an already named binary.
      current = await this.catalog.refresh(file);
      if (current) {
        resourceId = current.resourceId;
        this.assertKnownUnique(resourceId);
      } else if (/\.mtn\.md$/i.test(file.path)) {
        const assigned = await this.assignMindTreeDocumentId(file, this.createUniqueResourceId());
        resourceId = assigned.documentId;
        managedFile = assigned.file;
      } else if (isMarkdownPath(file.path)) {
        resourceId = await this.assignMarkdownResourceId(file, this.createUniqueResourceId());
      } else {
        let shortId = createShortResourceId();
        while (this.catalog.has(shortId)) shortId = createShortResourceId();
        const oldPath = file.path;
        const newPath = normalizePath(appendNonMarkdownResourceId(oldPath, shortId, this.getNonMarkdownIdSeparator()));
        if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A file already exists at ${newPath}.`);
        await this.app.fileManager.renameFile(file, newPath);
        const renamed = this.app.vault.getFileByPath(newPath);
        if (!renamed) throw new Error(t("resourceIndex.identityChanged"));
        this.removePath(oldPath);
        this.catalog.invalidate(renamed.path);
        managedFile = renamed;
        resourceId = shortId;
      }
    }
    const entry = await this.catalog.refresh(managedFile);
    if (!entry || entry.resourceId !== resourceId) throw new Error(t("resourceIndex.identityChanged"));
    this.assertKnownUnique(resourceId);
    return { type: "file", resourceId, pathHint: managedFile.path, fileKind: entry.fileKind,
      ...(entry.fileSubtype ? { fileSubtype: entry.fileSubtype } : {}) };
  }

  private assertReferenceCurrent(file: TFile, reference: FileResourceRef): void {
    if (this.app.vault.getFileByPath(reference.pathHint) !== file
      || this.catalog.entry(file)?.resourceId !== reference.resourceId) {
      throw new Error(t("resourceIndex.identityChanged"));
    }
    this.assertKnownUnique(reference.resourceId);
  }

  /**
   * A collection is one transaction in the tree, not N full-vault scans. The
   * opening scan proves the known inventory; the closing scan observes only
   * changed/new paths before checking all results together. Allocated IDs are
   * never rolled back or repeated when a read or the destination later fails.
   */
  async ensureStableReferences(
    files: readonly TFile[],
    progress: (value: FileAssociationProgress) => void = () => undefined,
    isCurrent: () => boolean = () => true
  ): Promise<FileAssociationBatch> {
    const selected = [...new Map(files.map((file) => [file.path, file])).values()];
    const linked: LinkedFileResult[] = [];
    const failures: FileAssociationBatch["failures"] = [];
    const cancelled = (): FileAssociationBatch => ({ linked: [], failures, cancelled: true,
      assertCurrent: () => { throw new Error(t("notice.associationTargetChanged")); } });
    progress({ phase: "verify", completed: 0, total: selected.length });
    if (!isCurrent()) return cancelled();
    const initial = await this.catalog.rebuild(false);
    if (!isCurrent()) return cancelled();
    if (initial.failures.length) throw new Error(t("resourceIndex.unverified"));
    for (const [index, file] of selected.entries()) {
      if (!isCurrent()) return cancelled();
      try { linked.push({ file, reference: await this.prepareStableReference(file) }); }
      catch (error) { failures.push({ path: file.path, error }); }
      if (!isCurrent()) return cancelled();
      progress({ phase: "associate", completed: index + 1, total: selected.length });
      // Real Vault I/O naturally yields; a warm in-memory/WebView cache may not.
      if ((index + 1) % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    progress({ phase: "finish", completed: selected.length, total: selected.length });
    const final = await this.catalog.rebuild(false);
    if (!isCurrent()) return cancelled();
    if (final.failures.length) throw new Error(t("resourceIndex.unverified"));
    const verified = linked.filter(({ file, reference }) => {
      try { this.assertReferenceCurrent(file, reference); return true; }
      catch (error) { failures.push({ path: file.path, error }); return false; }
    });
    const generation = this.catalog.generation;
    return { linked: verified, failures, cancelled: false, assertCurrent: () => {
      if (!isCurrent() || generation !== this.catalog.generation || !this.catalog.isFullyVerified()) {
        throw new Error(t("resourceIndex.unverified"));
      }
      for (const { file, reference } of verified) this.assertReferenceCurrent(file, reference);
    } };
  }

  async createNote(
    directory: string,
    title: string,
    initialContent: string
  ): Promise<{ file: TFile; reference: FileResourceRef }> {
    const cleanedTitle = sanitizeFileName(title);
    if (!cleanedTitle) throw new Error("The note title cannot be empty.");
    const normalizedDirectory = normalizeDirectory(directory);
    if (normalizedDirectory) await this.ensureFolder(normalizedDirectory);
    const basePath = normalizePath(`${normalizedDirectory ? `${normalizedDirectory}/` : ""}${cleanedTitle}.md`);
    const path = this.uniquePath(basePath);
    // The title names the file only. The note body is the global default
    // content verbatim and intentionally never receives an implicit H1.
    const file = await this.app.vault.create(path, buildNewNoteBody(initialContent));
    try {
      const reference = await this.ensureStableReference(file);
      return { file, reference };
    } catch (error) {
      throw new CreatedNoteAssociationError(file, error);
    }
  }

  /**
   * Return every file below the configured template folder. Nested folders
   * are included so the picker represents the complete template collection.
   */
  templateFiles(directory: string): TFile[] {
    const normalizedDirectory = normalizeDirectory(directory);
    return filesInTemplateFolder(this.app.vault.getFiles(), normalizedDirectory);
  }

  /**
   * Copy one opaque template file and replace only the copy's plugin identity.
   * The template service owns rollback until the view accepts the association.
   */
  async createFileFromTemplate(
    directory: string,
    title: string,
    template: TFile,
    isTargetCurrent: () => boolean
  ): Promise<{ file: TFile; reference: FileResourceRef }> {
    const normalizedDirectory = normalizeDirectory(directory);
    const report = await this.catalog.rebuild(false);
    if (report.failures.length) throw new Error(t("resourceIndex.unverified"));
    return this.templateFileService.create(
      template, normalizedDirectory, title, this.getNonMarkdownIdSeparator(), isTargetCurrent
    );
  }

  acceptTemplateFile(file: TFile): void {
    this.templateFileService.accept(file);
  }

  async discardTemplateFile(file: TFile): Promise<void> {
    await this.templateFileService.discard(file);
  }

  /**
   * Copy a native File dropped from the operating-system file manager into the
   * vault's configured attachment destination, then assign normal stable identity.
   */
  async importExternalFile(
    source: File,
    sourceTreePath: string
  ): Promise<{ file: TFile; reference: FileResourceRef }> {
    if (source.size > EXTERNAL_FILE_REJECT_BYTES) {
      throw new Error("The dropped file exceeds the 1 GiB safety limit.");
    }
    const safeName = source.name.replace(/[\\/]/g, " ").trim();
    if (!safeName) throw new Error("The dropped file has no valid name.");
    if (safeName.endsWith(".mtn.md")) {
      throw new Error("Mind-tree source files cannot be imported from outside the vault.");
    }

    // An external copy is a new vault resource. Remove an ID-looking suffix
    // from non-Markdown input so ensureStableReference always generates a fresh
    // identity rather than accidentally sharing the source file's ID.
    const importedName = isMarkdownPath(safeName) ? safeName : stripNonMarkdownResourceId(safeName);
    if (!importedName) throw new Error("The dropped file has no valid name.");
    const targetPath = await this.app.fileManager.getAvailablePathForAttachment(importedName, sourceTreePath);
    let copiedFile: TFile | undefined;
    try {
      copiedFile = await this.app.vault.createBinary(targetPath, await source.arrayBuffer());
      let reference: FileResourceRef;
      if (isMarkdownPath(copiedFile.path)) {
        // Markdown imported from another vault may already carry plugin
        // frontmatter. Overwrite only the resource ID so the copy cannot alias
        // an existing note while all unrelated YAML remains intact.
        const resourceId = this.createUniqueResourceId();
        await this.app.fileManager.processFrontMatter(copiedFile, (frontmatter) => {
          const current = asRecord(frontmatter["mind-tree-nature"]);
          frontmatter["mind-tree-nature"] = { ...(current ?? {}), resourceId };
        });
        const entry = await this.catalog.refresh(copiedFile);
        if (!entry || entry.resourceId !== resourceId) throw new Error(t("resourceIndex.identityChanged"));
        reference = {
          type: "file",
          resourceId,
          pathHint: copiedFile.path,
          fileKind: "note",
          ...(entry.fileSubtype ? { fileSubtype: entry.fileSubtype } : {})
        };
      } else {
        reference = await this.ensureStableReference(copiedFile);
      }
      return { file: this.resolve(reference) ?? copiedFile, reference };
    } catch (error) {
      if (copiedFile && this.app.vault.getFileByPath(copiedFile.path)) {
        try {
          await this.app.fileManager.trashFile(copiedFile);
          this.removePath(copiedFile.path);
        } catch {
          // Report the original import failure; the next index rebuild will
          // reconcile an exceptional rollback failure.
        }
      }
      throw error;
    }
  }

  /**
   * Persist an image captured from the system clipboard into Obsidian's normal
   * attachment destination. This deliberately shares stable identity and
   * rollback behavior with external file drops without requiring a File name.
   */
  async importClipboardImage(
    source: Blob,
    suggestedName: string,
    sourceTreePath: string
  ): Promise<{ file: TFile; reference: FileResourceRef }> {
    if (source.size > EXTERNAL_FILE_REJECT_BYTES) {
      throw new Error("The pasted image exceeds the 1 GiB safety limit.");
    }
    const safeName = suggestedName.replace(/[\\/]/g, " ").trim();
    if (!safeName || classifyFile(safeName) !== "image") {
      throw new Error("The clipboard item is not a supported image.");
    }
    const importedName = stripNonMarkdownResourceId(safeName);
    const targetPath = await this.app.fileManager.getAvailablePathForAttachment(importedName, sourceTreePath);
    let copiedFile: TFile | undefined;
    try {
      copiedFile = await this.app.vault.createBinary(targetPath, await source.arrayBuffer());
      const reference = await this.ensureStableReference(copiedFile);
      if (reference.fileKind !== "image") throw new Error("The imported clipboard file is not an image.");
      return { file: this.resolve(reference) ?? copiedFile, reference };
    } catch (error) {
      if (copiedFile && this.app.vault.getFileByPath(copiedFile.path)) {
        try {
          await this.app.fileManager.trashFile(copiedFile);
          this.removePath(copiedFile.path);
        } catch {
          // Keep the original import error; the next index rebuild repairs an
          // exceptional rollback failure just like external file import.
        }
      }
      throw error;
    }
  }

  async renameLinkedFile(reference: FileResourceRef, title: string): Promise<TFile> {
    return this.runResourceMutation(reference.resourceId, () => this.renameLinkedFileInternal(reference, title));
  }

  private async renameLinkedFileInternal(reference: FileResourceRef, title: string): Promise<TFile> {
    const file = await this.requireMutableFile(reference);
    const newPath = normalizePath(buildLinkedResourcePath(
      file.path,
      title,
      reference.resourceId,
      this.getNonMarkdownIdSeparator()
    ));
    if (newPath === file.path) return file;
    if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A file already exists at ${newPath}.`);
    const oldPath = file.path;
    await this.app.fileManager.renameFile(file, newPath);
    const renamed = this.app.vault.getFileByPath(newPath);
    if (!renamed) throw new Error("The renamed file could not be found.");
    await this.handleRename(renamed, oldPath);
    return renamed;
  }

  /** Move a linked file without changing its name or stable resource identity. */
  async moveLinkedFile(reference: FileResourceRef, destinationDirectory: string): Promise<TFile> {
    return this.runResourceMutation(
      reference.resourceId,
      () => this.moveLinkedFileInternal(reference, destinationDirectory)
    );
  }

  private async moveLinkedFileInternal(reference: FileResourceRef, destinationDirectory: string): Promise<TFile> {
    const file = await this.requireMutableFile(reference);
    const directory = normalizeDirectory(destinationDirectory);
    const newPath = normalizePath(`${directory ? `${directory}/` : ""}${file.name}`);
    if (newPath === file.path) return file;
    if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A file already exists at ${newPath}.`);
    const oldPath = file.path;
    await this.app.fileManager.renameFile(file, newPath);
    const moved = this.app.vault.getFileByPath(newPath);
    if (!moved) throw new Error("The moved file could not be found.");
    await this.handleRename(moved, oldPath);
    return moved;
  }

  /** Move a linked vault file to Trash under the same per-resource lock. */
  async trashLinkedFile(reference: FileResourceRef): Promise<TFile> {
    return this.runResourceMutation(reference.resourceId, async () => {
      const file = await this.requireMutableFile(reference);
      const oldPath = file.path;
      await this.app.fileManager.trashFile(file);
      this.removePath(oldPath);
      return file;
    });
  }

  /** Serialize side effects for one logical file while keeping failures local. */
  private async runResourceMutation<T>(resourceId: ResourceId, task: () => Promise<T>): Promise<T> {
    const previous = this.resourceMutationTail.get(resourceId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    const tail = operation.then(() => undefined, () => undefined);
    this.resourceMutationTail.set(resourceId, tail);
    try {
      return await operation;
    } finally {
      if (this.resourceMutationTail.get(resourceId) === tail) {
        this.resourceMutationTail.delete(resourceId);
      }
    }
  }

  sameDirectoryCandidates(treeFile: TFile, document: MindTreeDocument, recursive: boolean, ignoredPrefixes: string[]): TFile[] {
    const directory = treeFile.parent?.isRoot() ? "" : treeFile.parent?.path ?? "";
    const referencedIds = new Set(Object.values(document.nodes)
      .map((node) => node.resource?.type === "file" ? node.resource.resourceId : undefined)
      .filter((id): id is string => Boolean(id)));
    const referencedPaths = new Set(Object.values(document.nodes)
      .map((node) => node.resource?.type === "file" ? normalizePath(node.resource.pathHint) : undefined)
      .filter((path): path is string => Boolean(path)));
    return this.app.vault.getFiles().filter((file) => {
      if (file.path === treeFile.path || file.path.endsWith(".mtn.md")) return false;
      if (ignoredPrefixes.some((prefix) => file.path.startsWith(normalizePath(prefix)))) return false;
      const parentPath = file.parent?.isRoot() ? "" : file.parent?.path ?? "";
      const inScope = recursive
        ? (directory === "" || parentPath === directory || parentPath.startsWith(`${directory}/`))
        : parentPath === directory;
      if (!inScope) return false;
      const id = this.catalog.entry(file)?.resourceId;
      return !referencedPaths.has(normalizePath(file.path)) && (!id || !referencedIds.has(id));
    });
  }

  /** Persist a lazy or replacement identity without touching the tree payload. */
  private async assignMindTreeDocumentId(
    file: TFile,
    documentId: ResourceId,
    expectedDocumentId?: ResourceId
  ): Promise<MindTreeDocumentIdWriteResult> {
    const path = normalizePath(file.path);
    let persistedDocumentId = documentId;
    if (this.writeMindTreeDocumentId) {
      const result = await this.writeMindTreeDocumentId(file, documentId, expectedDocumentId);
      persistedDocumentId = result.documentId;
    } else {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const currentDocumentId = stringValue(frontmatter["documentId"]);
        // Compare-and-set prevents two concurrent association actions from
        // assigning different identities to the same tree.
        const decision = decideDocumentIdentityWrite(currentDocumentId, documentId, expectedDocumentId);
        persistedDocumentId = decision.documentId;
        if (decision.write) frontmatter["documentId"] = decision.documentId;
      });
    }
    const updated = this.app.vault.getFileByPath(path) ?? file;
    this.catalog.invalidate(updated.path);
    const entry = await this.catalog.refresh(updated);
    if (entry?.resourceId !== persistedDocumentId) throw new Error(t("resourceIndex.identityChanged"));
    return { file: updated, documentId: persistedDocumentId };
  }

  /** Compare-and-set the nested resource ID used by ordinary Markdown notes. */
  private async assignMarkdownResourceId(
    file: TFile,
    proposedResourceId: ResourceId,
    expectedResourceId?: ResourceId
  ): Promise<ResourceId> {
    let persistedResourceId = proposedResourceId;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const current = asRecord(frontmatter["mind-tree-nature"]);
      const currentResourceId = stringValue(current?.["resourceId"]);
      const decision = decideDocumentIdentityWrite(
        currentResourceId,
        proposedResourceId,
        expectedResourceId
      );
      persistedResourceId = decision.documentId;
      if (decision.write) {
        frontmatter["mind-tree-nature"] = {
          ...(current ?? {}),
          resourceId: decision.documentId
        };
      }
    });
    this.catalog.invalidate(file.path);
    return persistedResourceId;
  }

  private uniquePath(basePath: string): string {
    if (!this.app.vault.getAbstractFileByPath(basePath)) return basePath;
    const extensionIndex = basePath.lastIndexOf(".");
    const stem = extensionIndex > 0 ? basePath.slice(0, extensionIndex) : basePath;
    const extension = extensionIndex > 0 ? basePath.slice(extensionIndex) : "";
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(`${stem} ${counter}${extension}`)) counter += 1;
    return `${stem} ${counter}${extension}`;
  }

  private createUniqueResourceId(): ResourceId {
    let resourceId = createId();
    while (this.catalog.has(resourceId)) resourceId = createId();
    return resourceId;
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }


}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeDirectory(value: string): string {
  const normalized = normalizePath(value.trim()).replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Vault folder paths cannot contain '.' or '..' segments.");
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
