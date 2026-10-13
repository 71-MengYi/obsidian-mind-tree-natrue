import { parseMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import { isMindTreePath } from "../format/resource-id";
import type { BranchReference } from "../domain/branch-reference";
import type { MindTreeDocument } from "../types";

/**
 * Every outcome a note embed must be able to render. Failures are data, not
 * exceptions: a reference can become invalid while its note stays open, and
 * Obsidian's renderer must never be interrupted by a throw.
 */
export type BranchReferenceResolution =
  | { readonly kind: "ready"; readonly path: string; readonly document: MindTreeDocument }
  | { readonly kind: "missing-tree" }
  | { readonly kind: "missing-node"; readonly path: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unreadable" };

export interface MindTreeReferencePorts {
  readonly fileExists: (path: string) => boolean;
  readonly read: (path: string) => Promise<string>;
  readonly parseOptions: () => Readonly<ParseMindTreeOptions>;
  /** Vault-relative `.mtn.md` paths currently indexed for one tree identity. */
  readonly indexedTreePaths: (documentId: string) => readonly string[];
}

/**
 * Resolves a note-embedded branch reference against the live vault.
 *
 * A reference stores the tree identity (`documentId`) and the node id, so it
 * survives node moves inside the tree and file renames. Resolution only accepts
 * a candidate file whose parsed identity matches, which is what makes "the path
 * was reused by another tree" fail closed instead of showing the wrong tree.
 */
export class MindTreeReferenceService {
  private readonly cache = new Map<string, Promise<MindTreeDocument | undefined>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly ports: MindTreeReferencePorts) {}

  async resolve(reference: BranchReference): Promise<BranchReferenceResolution> {
    const matches: Array<{ path: string; document: MindTreeDocument }> = [];
    let unreadable = false;
    for (const path of this.candidates(reference)) {
      const document = await this.load(path);
      if (!document) {
        unreadable = true;
        continue;
      }
      if (document.documentId !== reference.documentId) continue;
      matches.push({ path, document });
    }
    if (matches.length === 0) return unreadable ? { kind: "unreadable" } : { kind: "missing-tree" };
    // Two files with one identity can never be told apart without guessing.
    if (matches.length > 1) return { kind: "ambiguous" };
    const match = matches[0]!;
    if (!match.document.nodes[reference.nodeId]) return { kind: "missing-node", path: match.path };
    return { kind: "ready", path: match.path, document: match.document };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A file event: only that path's parsed copy is dropped. */
  notifyChanged(path?: string): void {
    this.invalidate(path);
    this.emit();
  }

  notifyRemoved(path: string): void {
    this.invalidate(path);
    this.emit();
  }

  notifyRenamed(oldPath: string, newPath: string): void {
    this.invalidate(oldPath);
    this.invalidate(newPath);
    this.emit();
  }

  destroy(): void {
    this.disposed = true;
    this.cache.clear();
    this.listeners.clear();
  }

  private candidates(reference: BranchReference): string[] {
    const paths: string[] = [];
    const add = (path: string): void => {
      if (!isMindTreePath(path) || !this.ports.fileExists(path) || paths.includes(path)) return;
      paths.push(path);
    };
    // The hint is tried first because it needs no index and is the common case.
    if (reference.pathHint) add(reference.pathHint);
    for (const path of this.ports.indexedTreePaths(reference.documentId)) add(path);
    return paths;
  }

  private load(path: string): Promise<MindTreeDocument | undefined> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const pending = this.ports.read(path)
      .then((source) => parseMindTreeFile(source, this.ports.parseOptions()).document)
      .catch(() => {
        // A transient read failure must not stick to the path until the next
        // vault event, so failures are never cached.
        this.cache.delete(path);
        return undefined;
      });
    this.cache.set(path, pending);
    return pending;
  }

  private invalidate(path?: string): void {
    if (path === undefined) this.cache.clear();
    else this.cache.delete(path);
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("Mind Tree Nature: branch reference refresh failed", error);
      }
    }
  }
}
