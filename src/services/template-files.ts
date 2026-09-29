import { classifyFileSubtype } from "../domain/markers";
import {
  appendNonMarkdownResourceId,
  classifyFile,
  extractNonMarkdownResourceId,
  isMarkdownPath,
  type NonMarkdownResourceIdSeparator
} from "../format/resource-id";
import type { FileResourceRef } from "../types";

export interface TemplateFile {
  readonly path: string;
}

export interface TemplateFileResult<T extends TemplateFile> {
  readonly file: T;
  readonly reference: FileResourceRef;
}

/** Narrow Vault ports keep copy/rollback tests independent of the Obsidian UI. */
export interface TemplateFilePorts<T extends TemplateFile> {
  exists(path: string): boolean;
  isCurrentFile(file: T): boolean;
  ensureFolder(path: string): Promise<void>;
  copy(source: T, destination: string): Promise<T>;
  processFrontMatter(file: T, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  createResourceId(markdown: boolean): string;
  resourceIdExists(id: string): boolean;
  register(reference: FileResourceRef): void | Promise<void>;
  trash(file: T): Promise<void>;
  removePath(path: string, resourceId: string): void;
}

export class TemplateTargetChangedError extends Error {
  constructor() {
    super("The template destination is no longer available.");
    this.name = "TemplateTargetChangedError";
  }
}

/** A failed cleanup must not be presented as if the new file was removed. */
export class TemplateCopyRollbackError extends Error {
  constructor(readonly path: string, readonly originalError: unknown) {
    super(`The template copy could not be moved to trash: ${path}`);
    this.name = "TemplateCopyRollbackError";
  }
}

/** The directory is already normalized/validated by the resource service. */
export function filesInTemplateFolder<T extends TemplateFile>(files: readonly T[], directory: string): T[] {
  if (!directory) return [];
  const prefix = `${directory}/`;
  return files.filter((file) => file.path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Keep the established final-extension rule, except for the compound tree suffix. */
export function templateFileExtension(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").at(-1) ?? path;
  const treeSuffix = name.match(/\.mtn\.md$/i)?.[0];
  if (treeSuffix) return treeSuffix;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/**
 * Copy one opaque file, replacing only its plugin identity. No contents or links
 * are traversed, and no template expansion/default note body is applied.
 * Reservations protect concurrent copies before Vault.copy has created a path.
 */
export class TemplateFileService<T extends TemplateFile> {
  private readonly reservedPaths = new Set<string>();
  private readonly reservedIds = new Set<string>();
  private readonly uncommittedCopies = new WeakMap<T, string>();

  constructor(private readonly ports: TemplateFilePorts<T>) {}

  async create(
    template: T,
    directory: string,
    title: string,
    separator: NonMarkdownResourceIdSeparator,
    isTargetCurrent: () => boolean
  ): Promise<TemplateFileResult<T>> {
    this.requireTarget(isTargetCurrent);
    const cleanedTitle = title.replace(/[\\/:*?"<>|]/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleanedTitle || cleanedTitle === "." || cleanedTitle === "..") throw new Error("The file title cannot be empty or a path segment.");
    const extension = templateFileExtension(template.path);
    const markdown = isMarkdownPath(template.path);
    const mindTree = /\.mtn\.md$/i.test(template.path);
    let resourceId = this.ports.createResourceId(markdown);
    while (this.reservedIds.has(resourceId) || this.ports.resourceIdExists(resourceId)) {
      resourceId = this.ports.createResourceId(markdown);
    }
    // Build from the node's title, not the source filename: a template's current
    // or legacy non-Markdown ID must never enter the copied filename.
    const makePath = (counter: number): string => {
      const filename = `${cleanedTitle}${counter === 1 ? "" : ` ${counter}`}${extension}`;
      const identified = markdown ? filename : appendNonMarkdownResourceId(filename, resourceId, separator);
      return `${directory ? `${directory}/` : ""}${identified}`;
    };
    let counter = 1;
    let path = makePath(counter);
    while (this.ports.exists(path) || this.reservedPaths.has(path)) path = makePath(++counter);
    this.reservedIds.add(resourceId);
    this.reservedPaths.add(path);
    let copied: T | undefined;
    try {
      if (directory) await this.ports.ensureFolder(directory);
      this.requireTarget(isTargetCurrent);
      if (!this.ports.isCurrentFile(template)) throw new Error("The template file is no longer available.");
      copied = await this.ports.copy(template, path);
      if (copied === template) throw new Error("Copy did not create an independent file.");
      this.uncommittedCopies.set(copied, resourceId);
      this.requireTarget(isTargetCurrent);
      this.requireCopy(copied, markdown, mindTree, resourceId);
      let fileSubtype: FileResourceRef["fileSubtype"];
      if (markdown) {
        // Work on the copied file only. Do not use the ordinary ensure-reference
        // path here: it would adopt the template's already-existing stable ID.
        await this.ports.processFrontMatter(copied, (frontmatter) => {
          if (mindTree) {
            frontmatter["documentId"] = resourceId;
          } else {
            const existing = frontmatter["mind-tree-nature"];
            const properties = existing && typeof existing === "object" && !Array.isArray(existing)
              ? existing as Record<string, unknown> : {};
            frontmatter["mind-tree-nature"] = { ...properties, resourceId };
          }
          fileSubtype = classifyFileSubtype(frontmatter);
        });
      }
      this.requireTarget(isTargetCurrent);
      this.requireCopy(copied, markdown, mindTree, resourceId);
      const reference: FileResourceRef = {
        type: "file", resourceId, pathHint: copied.path, fileKind: classifyFile(copied.path),
        ...(fileSubtype ? { fileSubtype } : {})
      };
      await this.ports.register(reference);
      this.requireTarget(isTargetCurrent);
      return { file: copied, reference };
    } catch (error) {
      if (copied) {
        try { await this.discard(copied); }
        catch { throw new TemplateCopyRollbackError(copied.path, error); }
      }
      throw error;
    } finally {
      this.reservedPaths.delete(path);
      this.reservedIds.delete(resourceId);
    }
  }

  /** Successful node association transfers ownership from rollback to the user. */
  accept(file: T): void {
    this.uncommittedCopies.delete(file);
  }

  /** Do not index the brief inherited-identity state between copy and reassignment. */
  isPendingPath(path: string): boolean {
    return this.reservedPaths.has(path);
  }

  /** Never remove a source, an accepted copy, or a replacement at the same path. */
  async discard(file: T): Promise<void> {
    const resourceId = this.uncommittedCopies.get(file);
    if (!resourceId) return;
    if (this.ports.isCurrentFile(file)) {
      const path = file.path;
      await this.ports.trash(file);
      this.ports.removePath(path, resourceId);
    }
    this.uncommittedCopies.delete(file);
  }

  private requireTarget(isTargetCurrent: () => boolean): void {
    if (!isTargetCurrent()) throw new TemplateTargetChangedError();
  }

  /** Other plugins may rename a freshly copied file; never write metadata into a different file type. */
  private requireCopy(file: T, markdown: boolean, mindTree: boolean, resourceId: string): void {
    if (!this.ports.isCurrentFile(file)) throw new TemplateTargetChangedError();
    if (isMarkdownPath(file.path) !== markdown || /\.mtn\.md$/i.test(file.path) !== mindTree
      || (!markdown && extractNonMarkdownResourceId(file.path) !== resourceId)) {
      throw new Error("The copied file's type or identity changed before it could be linked.");
    }
  }
}
