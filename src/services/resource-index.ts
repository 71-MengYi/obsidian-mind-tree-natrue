import { App, normalizePath, TFile } from "obsidian";
import { createId } from "../domain/tree";
import { classifyFileSubtype } from "../domain/markers";
import { EXTERNAL_FILE_REJECT_BYTES } from "../input-limits";
import {
  appendNonMarkdownResourceId,
  buildLinkedResourcePath,
  classifyFile,
  createShortResourceId,
  DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
  extractNonMarkdownResourceId,
  isMarkdownPath,
  stripNonMarkdownResourceId,
  type NonMarkdownResourceIdSeparator
} from "../format/resource-id";
import type { FileResourceRef, MindTreeDocument, ResourceId } from "../types";
import { buildNewNoteBody } from "./note-content";
import { decideDocumentIdentityWrite, decideDuplicateIdentity } from "./resource-identity";
import { filesInTemplateFolder, TemplateFileService } from "./template-files";

export interface IndexedResource {
  resourceId: ResourceId;
  path: string;
  fileKind: FileResourceRef["fileKind"];
  fileSubtype?: FileResourceRef["fileSubtype"];
}

/** Raised instead of guessing which copied file owns a duplicated stable ID. */
export class DuplicateResourceIdError extends Error {
  constructor(readonly resourceId: ResourceId, readonly paths: string[]) {
    super(`Duplicate resource ID ${resourceId}: ${paths.join(", ")}`);
    this.name = "DuplicateResourceIdError";
  }
}

export interface MindTreeDocumentIdWriteResult {
  file: TFile;
  documentId: ResourceId;
}

export type MindTreeDocumentIdWriter = (
  file: TFile,
  documentId: ResourceId,
  expectedDocumentId?: ResourceId
) => Promise<MindTreeDocumentIdWriteResult>;

export class ResourceIndexService {
  private readonly byId = new Map<ResourceId, IndexedResource>();
  private readonly byPath = new Map<string, IndexedResource>();
  /** Every non-owner path observed with the same ID. Never overwrite silently. */
  private readonly duplicatePathsById = new Map<ResourceId, Set<string>>();
  /** Plugin-data owners predate the current scan and can safely identify copies. */
  private readonly trustedOwnerIds = new Set<ResourceId>();
  /** Concurrent first-link requests for one path must share the same identity write. */
  private readonly pendingReferenceByPath = new Map<string, Promise<FileResourceRef>>();
  /** Rename/move operations for one stable resource must never interleave. */
  private readonly resourceMutationTail = new Map<ResourceId, Promise<void>>();
  /** Suppress redundant full data.json writes when only a read/query occurred. */
  private lastEmittedFingerprint = "";
  private readonly templateFileService: TemplateFileService<TFile>;

  constructor(
    private readonly app: App,
    initialEntries: Record<ResourceId, IndexedResource> = {},
    private readonly onChanged?: (entries: Record<ResourceId, IndexedResource>) => void,
    private readonly getNonMarkdownIdSeparator: () => NonMarkdownResourceIdSeparator =
      () => DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
    private readonly writeMindTreeDocumentId?: MindTreeDocumentIdWriter
  ) {
    for (const entry of Object.values(initialEntries)) {
      if (!entry.resourceId || !entry.path) continue;
      this.byId.set(entry.resourceId, entry);
      this.byPath.set(normalizePath(entry.path), entry);
      this.trustedOwnerIds.add(entry.resourceId);
    }
    this.lastEmittedFingerprint = this.persistedFingerprint();
    this.templateFileService = new TemplateFileService<TFile>({
      exists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
      isCurrentFile: (file) => this.app.vault.getFileByPath(file.path) === file,
      ensureFolder: (path) => this.ensureFolder(path),
      copy: (source, path) => this.app.vault.copy(source, path),
      processFrontMatter: (file, update) => this.app.fileManager.processFrontMatter(file, update),
      createResourceId: (markdown) => markdown ? createId() : createShortResourceId(),
      resourceIdExists: (id) => this.byId.has(id),
      register: (reference) => {
        this.registerIndexedEntry({
          resourceId: reference.resourceId, path: reference.pathHint,
          fileKind: reference.fileKind,
          ...(reference.fileSubtype ? { fileSubtype: reference.fileSubtype } : {})
        }, true);
        this.emitChanged();
      },
      trash: (file) => this.app.fileManager.trashFile(file),
      removePath: (path, resourceId) => {
        this.removePath(path);
        // The service only supplies freshly allocated copy IDs. Unlike a user
        // deletion, rolling back an unlinked copy does not need a tombstone.
        if (this.byId.get(resourceId)?.path === normalizePath(path)) {
          this.byId.delete(resourceId);
          this.trustedOwnerIds.delete(resourceId);
          this.emitChanged();
        }
      }
    });
  }

  rebuild(): void {
    // Validate historical owners first. Their path is the only safe signal for
    // deciding which later file is a copied duplicate rather than the original.
    const historicalOwners = [...this.byId.values()];
    const historicalTrustedIds = new Set(this.trustedOwnerIds);
    this.byId.clear();
    this.byPath.clear();
    this.duplicatePathsById.clear();
    this.trustedOwnerIds.clear();
    for (const owner of historicalOwners) {
      const file = this.app.vault.getFileByPath(normalizePath(owner.path));
      if (!file || this.readStableId(file) !== owner.resourceId) continue;
      this.registerIndexedEntry(this.createIndexedResource(owner.resourceId, file), historicalTrustedIds.has(owner.resourceId));
    }
    for (const file of this.app.vault.getFiles()) this.indexFile(file, false);
    for (const historicalOwner of historicalOwners) {
      if (!historicalTrustedIds.has(historicalOwner.resourceId)) continue;
      const livePaths = this.livePathsForId(historicalOwner.resourceId);
      const historicalPath = normalizePath(historicalOwner.path);
      // A unique surviving path represents an offline rename. With multiple
      // candidates, trust history only when its exact owner still exists.
      const trustedPath = livePaths.length === 1
        ? livePaths[0]
        : livePaths.includes(historicalPath) ? historicalPath : undefined;
      const trustedEntry = trustedPath ? this.byPath.get(trustedPath) : undefined;
      if (trustedEntry) {
        this.byId.set(historicalOwner.resourceId, trustedEntry);
        this.trustedOwnerIds.add(historicalOwner.resourceId);
      } else {
        this.trustedOwnerIds.delete(historicalOwner.resourceId);
      }
    }
    this.emitChanged();
  }

  indexFile(file: TFile, notify = true): IndexedResource | undefined {
    if (this.templateFileService.isPendingPath(normalizePath(file.path))) return undefined;
    const resourceId = this.readStableId(file);
    if (!resourceId) return undefined;
    const entry = this.createIndexedResource(resourceId, file);
    const previous = this.byPath.get(normalizePath(file.path));
    this.registerIndexedEntry(entry);
    if (notify && !sameIndexedResource(previous, entry)) this.emitChanged();
    return entry;
  }

  removePath(path: string): void {
    const normalized = normalizePath(path);
    const entry = this.byPath.get(normalized);
    this.byPath.delete(normalized);
    if (entry) this.removeDuplicatePath(entry.resourceId, normalized);
    // Keep a canonical tombstone until a rebuild or rename establishes the new
    // owner. Promoting a copied duplicate here would silently rebind old links.
    if (entry) this.emitChanged();
  }

  handleRename(file: TFile, oldPath: string): void {
    const normalizedOldPath = normalizePath(oldPath);
    const previous = this.byPath.get(normalizedOldPath);
    const wasOwner = previous && normalizePath(this.byId.get(previous.resourceId)?.path ?? "") === normalizedOldPath;
    const wasTrustedOwner = Boolean(previous && wasOwner && this.trustedOwnerIds.has(previous.resourceId));
    this.removePath(oldPath);
    const indexed = this.indexFile(file, false);
    if (indexed) {
      if (previous && indexed.resourceId === previous.resourceId && wasOwner) {
        this.byId.set(indexed.resourceId, indexed);
        if (wasTrustedOwner) this.trustedOwnerIds.add(indexed.resourceId);
        this.removeDuplicatePath(indexed.resourceId, normalizedOldPath);
      }
      this.emitChanged();
      return;
    }
    if (!previous) return;
    // MetadataCache can briefly lag behind a Markdown rename. The old indexed
    // identity still belongs to the same Vault file, so carry it to the new path
    // instead of creating a window where open trees cannot resolve the resource.
    const fallback: IndexedResource = {
      ...previous,
      path: file.path,
      fileKind: classifyFile(file.path)
    };
    this.registerIndexedEntry(fallback, wasTrustedOwner);
    if (wasOwner) this.byId.set(fallback.resourceId, fallback);
    this.emitChanged();
  }

  resolve(reference: FileResourceRef): TFile | undefined {
    // An exact live hint with the expected ID is stronger than a global map
    // when copied files temporarily share identity.
    const hinted = this.app.vault.getFileByPath(normalizePath(reference.pathHint));
    if (hinted) {
      const hintedId = this.readStableId(hinted)
        ?? this.byPath.get(normalizePath(hinted.path))?.resourceId;
      if (hintedId === reference.resourceId) {
        return hinted;
      }
    }
    const indexed = this.byId.get(reference.resourceId);
    if (indexed) {
      const hasUntrustedConflict = (this.duplicatePathsById.get(reference.resourceId)?.size ?? 0) > 1
        && !this.trustedOwnerIds.has(reference.resourceId);
      const file = this.app.vault.getFileByPath(indexed.path);
      if (file && !hasUntrustedConflict) return file;
    }
    return undefined;
  }

  /**
   * Resolve the live path plus external-format metadata used to repair a
   * persisted file reference. If MetadataCache is not ready, retain the last
   * indexed/reference value instead of incorrectly clearing a valid badge.
   */
  describe(reference: FileResourceRef, preferredFile?: TFile): Omit<IndexedResource, "resourceId"> | undefined {
    const file = preferredFile ?? this.resolve(reference);
    if (!file) return undefined;
    const indexed = this.byPath.get(normalizePath(file.path));
    const cache = this.app.metadataCache.getFileCache(file);
    const fileSubtype = cache
      ? classifyFileSubtype(cache.frontmatter)
      : indexed?.fileSubtype ?? reference.fileSubtype;
    return {
      path: file.path,
      fileKind: classifyFile(file.path),
      ...(fileSubtype ? { fileSubtype } : {})
    };
  }

  async ensureStableReference(file: TFile): Promise<FileResourceRef> {
    const path = normalizePath(file.path);
    const pending = this.pendingReferenceByPath.get(path);
    if (pending) return pending;
    const operation = this.ensureStableReferenceInternal(file);
    this.pendingReferenceByPath.set(path, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingReferenceByPath.get(path) === operation) this.pendingReferenceByPath.delete(path);
    }
  }

  private async ensureStableReferenceInternal(file: TFile): Promise<FileResourceRef> {
    let managedFile = file;
    let resourceId = this.readStableId(file);
    let fileSubtype = this.readFileSubtype(file);
    if (file.path.endsWith(".mtn.md")) {
      if (resourceId) {
        this.indexMatchingResourceId(resourceId);
        this.reconcileHistoricalOwner(resourceId);
        const livePaths = this.livePathsForId(resourceId);
        const owner = this.byId.get(resourceId);
        const decision = decideDuplicateIdentity(
          normalizePath(file.path),
          owner ? normalizePath(owner.path) : undefined,
          this.trustedOwnerIds.has(resourceId),
          livePaths
        );
        if (decision.action === "reject") {
          throw new DuplicateResourceIdError(resourceId, decision.paths);
        }
        if (decision.action === "reassign") {
          const assigned = await this.assignMindTreeDocumentId(file, createId(), resourceId);
          resourceId = assigned.documentId;
          managedFile = assigned.file;
        }
      } else {
        const assigned = await this.assignMindTreeDocumentId(file, createId());
        resourceId = assigned.documentId;
        managedFile = assigned.file;
      }
    } else if (isMarkdownPath(file.path)) {
      if (resourceId) {
        this.indexMatchingResourceId(resourceId);
        this.reconcileHistoricalOwner(resourceId);
        const owner = this.byId.get(resourceId);
        const decision = decideDuplicateIdentity(
          normalizePath(file.path),
          owner ? normalizePath(owner.path) : undefined,
          this.trustedOwnerIds.has(resourceId),
          this.livePathsForId(resourceId)
        );
        if (decision.action === "reject") throw new DuplicateResourceIdError(resourceId, decision.paths);
        if (decision.action === "reassign") {
          resourceId = await this.assignMarkdownResourceId(file, this.createUniqueResourceId(), resourceId);
          fileSubtype = this.readFileSubtype(file);
        }
      } else {
        resourceId = await this.assignMarkdownResourceId(file, this.createUniqueResourceId());
        fileSubtype = this.readFileSubtype(file);
      }
    } else if (!resourceId) {
      let shortId = createShortResourceId();
      while (this.byId.has(shortId)) shortId = createShortResourceId();
      const newPath = normalizePath(appendNonMarkdownResourceId(file.path, shortId, this.getNonMarkdownIdSeparator()));
      if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A file already exists at ${newPath}.`);
      await this.app.fileManager.renameFile(file, newPath);
      const renamed = this.app.vault.getFileByPath(newPath);
      if (!renamed) throw new Error("The renamed resource could not be found.");
      managedFile = renamed;
      resourceId = shortId;
    }
    if (!resourceId) throw new Error("Unable to assign a stable resource ID.");
    const entry = this.createIndexedResource(resourceId, managedFile, fileSubtype);
    this.registerIndexedEntry(entry, true);
    this.emitChanged();
    return {
      type: "file",
      resourceId,
      pathHint: managedFile.path,
      fileKind: entry.fileKind,
      ...(entry.fileSubtype ? { fileSubtype: entry.fileSubtype } : {})
    };
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
    const reference = await this.ensureStableReference(file);
    return { file, reference };
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
        let fileSubtype: FileResourceRef["fileSubtype"];
        await this.app.fileManager.processFrontMatter(copiedFile, (frontmatter) => {
          fileSubtype = classifyFileSubtype(frontmatter);
          const current = asRecord(frontmatter["mind-tree-nature"]);
          frontmatter["mind-tree-nature"] = { ...(current ?? {}), resourceId };
        });
        const entry = this.createIndexedResource(resourceId, copiedFile, fileSubtype);
        this.registerIndexedEntry(entry, true);
        this.emitChanged();
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
    const file = this.resolve(reference);
    if (!file) throw new Error("The linked file could not be found.");
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
    this.handleRename(renamed, oldPath);
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
    const file = this.resolve(reference);
    if (!file) throw new Error("The linked file could not be found.");
    const directory = normalizeDirectory(destinationDirectory);
    const newPath = normalizePath(`${directory ? `${directory}/` : ""}${file.name}`);
    if (newPath === file.path) return file;
    if (this.app.vault.getAbstractFileByPath(newPath)) throw new Error(`A file already exists at ${newPath}.`);
    const oldPath = file.path;
    await this.app.fileManager.renameFile(file, newPath);
    const moved = this.app.vault.getFileByPath(newPath);
    if (!moved) throw new Error("The moved file could not be found.");
    this.handleRename(moved, oldPath);
    return moved;
  }

  /** Move a linked vault file to Trash under the same per-resource lock. */
  async trashLinkedFile(reference: FileResourceRef): Promise<TFile> {
    return this.runResourceMutation(reference.resourceId, async () => {
      const file = this.resolve(reference);
      if (!file) throw new Error("The linked file could not be found.");
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
      const id = this.readStableId(file);
      return !referencedPaths.has(normalizePath(file.path)) && (!id || !referencedIds.has(id));
    });
  }

  private readStableId(file: TFile): string | undefined {
    if (!isMarkdownPath(file.path)) return extractNonMarkdownResourceId(file.path);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (file.path.endsWith(".mtn.md")) {
      const directDocumentId = stringValue(frontmatter?.["documentId"]);
      if (directDocumentId) return directDocumentId;
    }
    const machine = asRecord(frontmatter?.["mind-tree-nature"]);
    if (file.path.endsWith(".mtn.md")) return stringValue(machine?.["documentId"]);
    return stringValue(machine?.["resourceId"]);
  }

  private readFileSubtype(file: TFile): FileResourceRef["fileSubtype"] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache) return classifyFileSubtype(cache.frontmatter);
    return this.byPath.get(normalizePath(file.path))?.fileSubtype;
  }

  /** Build one canonical index entry so every association path classifies alike. */
  private createIndexedResource(
    resourceId: ResourceId,
    file: TFile,
    fallbackSubtype?: FileResourceRef["fileSubtype"]
  ): IndexedResource {
    const fileSubtype = this.readFileSubtype(file) ?? fallbackSubtype;
    return {
      resourceId,
      path: file.path,
      fileKind: classifyFile(file.path),
      ...(fileSubtype ? { fileSubtype } : {})
    };
  }

  /** Register a path without allowing it to replace a different ID owner. */
  private registerIndexedEntry(entry: IndexedResource, trustedOwner = false): void {
    const path = normalizePath(entry.path);
    const previousAtPath = this.byPath.get(path);
    if (previousAtPath && previousAtPath.resourceId !== entry.resourceId) {
      this.removeDuplicatePath(previousAtPath.resourceId, path);
      if (normalizePath(this.byId.get(previousAtPath.resourceId)?.path ?? "") === path) {
        this.byId.delete(previousAtPath.resourceId);
        this.trustedOwnerIds.delete(previousAtPath.resourceId);
      }
    }
    this.byPath.set(path, entry);
    const owner = this.byId.get(entry.resourceId);
    if (!owner) {
      this.byId.set(entry.resourceId, entry);
      if (trustedOwner) this.trustedOwnerIds.add(entry.resourceId);
      return;
    }
    if (normalizePath(owner.path) === path) {
      this.byId.set(entry.resourceId, entry);
      if (trustedOwner) this.trustedOwnerIds.add(entry.resourceId);
      return;
    }
    const duplicates = this.duplicatePathsById.get(entry.resourceId) ?? new Set<string>();
    duplicates.add(normalizePath(owner.path));
    duplicates.add(path);
    this.duplicatePathsById.set(entry.resourceId, duplicates);
  }

  private removeDuplicatePath(resourceId: ResourceId, path: string): void {
    const duplicates = this.duplicatePathsById.get(resourceId);
    if (!duplicates) return;
    duplicates.delete(normalizePath(path));
    if (duplicates.size <= 1) this.duplicatePathsById.delete(resourceId);
  }

  /** Discover every current candidate before deciding whether an ID is safe. */
  private indexMatchingResourceId(resourceId: ResourceId): void {
    for (const candidate of this.app.vault.getFiles()) {
      if (this.readStableId(candidate) === resourceId) this.indexFile(candidate, false);
    }
  }

  private livePathsForId(resourceId: ResourceId): string[] {
    const paths = new Set<string>();
    const owner = this.byId.get(resourceId);
    if (owner) {
      const file = this.app.vault.getFileByPath(normalizePath(owner.path));
      if (file && this.readStableId(file) === resourceId) paths.add(normalizePath(file.path));
    }
    for (const path of this.duplicatePathsById.get(resourceId) ?? []) {
      const file = this.app.vault.getFileByPath(path);
      if (file && this.readStableId(file) === resourceId) paths.add(normalizePath(file.path));
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }

  /** Move a trusted owner after an offline rename only when exactly one file remains. */
  private reconcileHistoricalOwner(resourceId: ResourceId): void {
    if (!this.trustedOwnerIds.has(resourceId)) return;
    const livePaths = this.livePathsForId(resourceId);
    if (livePaths.length !== 1) return;
    const onlyPath = livePaths[0];
    if (!onlyPath) return;
    const entry = this.byPath.get(onlyPath);
    if (entry) this.byId.set(resourceId, entry);
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
    const previous = this.byPath.get(path);
    if (previous) {
      this.byPath.delete(path);
      this.removeDuplicatePath(previous.resourceId, path);
      if (normalizePath(this.byId.get(previous.resourceId)?.path ?? "") === path) {
        this.byId.delete(previous.resourceId);
        this.trustedOwnerIds.delete(previous.resourceId);
      }
    }
    const entry = this.createIndexedResource(persistedDocumentId, updated);
    this.registerIndexedEntry(entry, true);
    this.byId.set(persistedDocumentId, entry);
    this.trustedOwnerIds.add(persistedDocumentId);
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
    while (this.byId.has(resourceId)) resourceId = createId();
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

  private emitChanged(): void {
    if (!this.onChanged) return;
    const fingerprint = this.persistedFingerprint();
    if (fingerprint === this.lastEmittedFingerprint) return;
    this.lastEmittedFingerprint = fingerprint;
    this.onChanged(Object.fromEntries(this.byId.entries()));
  }

  private persistedFingerprint(): string {
    return JSON.stringify([...this.byId.entries()]
      .sort(([left], [right]) => left.localeCompare(right)));
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

function sameIndexedResource(left: IndexedResource | undefined, right: IndexedResource): boolean {
  return Boolean(left
    && left.resourceId === right.resourceId
    && normalizePath(left.path) === normalizePath(right.path)
    && left.fileKind === right.fileKind
    && left.fileSubtype === right.fileSubtype);
}
