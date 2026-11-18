import type { BacklinkEntries, BacklinkTarget } from "../domain/backlink";
import {
  MAX_BACKLINK_SCAN_BYTES,
  extractBranchReferences,
  type BranchReferenceOccurrence
} from "../domain/branch-reference-scan";
import type { NodeId } from "../types";

/** Structural view of one note; the module itself stays free of Obsidian. */
export interface BacklinkNote {
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

/** Timers stay injectable so batches can be driven without a DOM. */
export interface BacklinkIndexClock {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface BacklinkIndexPorts {
  /** All notes the index may scan. Mind-tree files are the host's business. */
  readonly notes: () => readonly BacklinkNote[];
  /** Current stat for one path, or `undefined` when it is gone or not scannable. */
  readonly noteAt: (path: string) => BacklinkNote | undefined;
  /**
   * Cheap host-cache pre-filter. `false` means the host has a parsed cache for
   * this note and it holds no code section at all; `true` or `undefined` mean
   * the note must be read. The service never assumes the cache knows languages.
   */
  readonly mayContainCodeBlock: (path: string) => boolean | undefined;
  readonly read: (path: string) => Promise<string>;
  readonly clock: BacklinkIndexClock;
  /** Scanning is best effort: failures are reported, never thrown at the UI. */
  readonly reportError?: (error: unknown) => void;
}

interface CachedNote {
  readonly mtime: number;
  readonly size: number;
  /**
   * True when `references` came from reading the note. False means the cheap
   * pre-filter skipped the read, so a later host parse may invalidate the cache.
   */
  readonly verified: boolean;
  readonly references: readonly BranchReferenceOccurrence[];
}

/** Files processed per tick: one batch never monopolizes the event loop. */
const FILES_PER_TICK = 25;
/** A macrotask turn lets rendering and input run between batches. */
const BATCH_DELAY_MS = 0;

const EMPTY_ENTRIES: BacklinkEntries = new Map();

/**
 * Plugin-wide reverse index for note-embedded branch references.
 *
 * A note that contains a `mind-tree-ref` block points at one node of one tree;
 * this service turns the note text into "which notes point at which node" and
 * keeps that answer current through file events. It reads notes in bounded
 * batches, skips unchanged notes by `mtime+size`, and stores no note text.
 */
export class BacklinkIndexService {
  private readonly cache = new Map<string, CachedNote>();
  private readonly byDocument = new Map<string, Map<NodeId, BacklinkTarget[]>>();
  private readonly listeners = new Set<() => void>();
  /** Paths touched by a vault event, processed before the startup snapshot. */
  private readonly urgent = new Set<string>();
  private scanPaths?: string[];
  private scanIndex = 0;
  private tickHandle?: number;
  private runningBatch?: Promise<void>;
  private destroyed = false;

  constructor(private readonly ports: BacklinkIndexPorts) {}

  /** Snapshot the vault and start the batched background scan. */
  start(): void {
    if (this.destroyed) return;
    if (this.scanPaths === undefined) {
      try {
        this.scanPaths = this.ports.notes().map((note) => note.path);
        this.scanIndex = 0;
      } catch (error) {
        // A host that cannot enumerate the vault must not break plugin load.
        this.ports.reportError?.(error);
        return;
      }
    }
    this.scheduleTick();
  }

  /**
   * Note locations for one tree identity, keyed by node id. Entries are ordered
   * by path and then line so a renderer never depends on scan order.
   */
  entriesFor(documentId: string): BacklinkEntries {
    const byNode = this.byDocument.get(documentId);
    if (!byNode || byNode.size === 0) return EMPTY_ENTRIES;
    const entries = new Map<NodeId, readonly BacklinkTarget[]>();
    for (const [nodeId, targets] of byNode) {
      entries.set(nodeId, [...targets].sort(compareTargets));
    }
    return entries;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** One note changed on disk; its next batch re-reads it unless the stat matches. */
  notifyChanged(path: string): void {
    if (this.destroyed) return;
    this.urgent.add(path);
    this.scheduleTick();
  }

  /**
   * The host finished parsing a note. Only a cache that skipped the read through
   * the cheap pre-filter is worth revisiting, and only when the fresh parse now
   * sees code blocks at all; otherwise every startup parse would re-read notes.
   */
  notifyMetadataChanged(path: string): void {
    if (this.destroyed) return;
    const cached = this.cache.get(path);
    if (!cached || cached.verified) return;
    if (this.ports.mayContainCodeBlock(path) !== true) return;
    this.dropFile(path);
    this.urgent.add(path);
    this.scheduleTick();
  }

  /** A note is gone; its backlinks disappear immediately. */
  notifyRemoved(path: string): void {
    if (this.destroyed) return;
    this.urgent.delete(path);
    if (this.dropFile(path)) this.emit();
  }

  /** A note moved; its old path is dropped and the new one is re-read. */
  notifyRenamed(oldPath: string, newPath: string): void {
    if (this.destroyed) return;
    this.urgent.delete(oldPath);
    this.urgent.add(newPath);
    if (this.dropFile(oldPath)) this.emit();
    this.scheduleTick();
  }

  /**
   * Folder rename/delete reports only the folder, so every path below it may be
   * stale. A full rescan is the only correct answer and stays batched.
   */
  invalidateAll(): void {
    if (this.destroyed) return;
    const changed = this.byDocument.size > 0;
    this.cache.clear();
    this.byDocument.clear();
    this.urgent.clear();
    this.scanPaths = undefined;
    this.scanIndex = 0;
    if (this.tickHandle !== undefined) {
      this.ports.clock.clearTimeout(this.tickHandle);
      this.tickHandle = undefined;
    }
    if (changed) this.emit();
    this.start();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.tickHandle !== undefined) this.ports.clock.clearTimeout(this.tickHandle);
    this.tickHandle = undefined;
    this.listeners.clear();
    this.cache.clear();
    this.byDocument.clear();
    this.urgent.clear();
    this.scanPaths = undefined;
    this.scanIndex = 0;
  }

  private scheduleTick(): void {
    if (this.destroyed || this.tickHandle !== undefined) return;
    this.tickHandle = this.ports.clock.setTimeout(() => {
      this.tickHandle = undefined;
      void this.processBatch().catch((error) => this.ports.reportError?.(error));
    }, BATCH_DELAY_MS);
  }

  /** One serialized batch; concurrent ticks would race on the same path. */
  private processBatch(): Promise<void> {
    const previous = this.runningBatch;
    if (previous) return previous;
    const batch = this.runBatch().finally(() => { this.runningBatch = undefined; });
    this.runningBatch = batch;
    return batch;
  }

  private async runBatch(): Promise<void> {
    let changed = false;
    for (let processed = 0; processed < FILES_PER_TICK; processed += 1) {
      const path = this.nextPath();
      if (path === undefined) break;
      if (await this.reconsider(path)) changed = true;
      if (this.destroyed) return;
    }
    if (changed) this.emit();
    if (this.hasPendingWork()) this.scheduleTick();
  }

  private nextPath(): string | undefined {
    for (const path of this.urgent) {
      this.urgent.delete(path);
      return path;
    }
    if (this.scanPaths === undefined) return undefined;
    while (this.scanIndex < this.scanPaths.length) {
      const path = this.scanPaths[this.scanIndex];
      this.scanIndex += 1;
      if (path !== undefined && !this.urgent.has(path)) return path;
    }
    // The startup snapshot is exhausted; later work comes from file events only.
    this.scanPaths = undefined;
    this.scanIndex = 0;
    return undefined;
  }

  private hasPendingWork(): boolean {
    if (this.urgent.size > 0) return true;
    return this.scanPaths !== undefined && this.scanIndex < this.scanPaths.length;
  }

  /** Re-read one path when its stat changed; returns true when entries changed. */
  private async reconsider(path: string): Promise<boolean> {
    try {
      const note = this.ports.noteAt(path);
      if (!note) return this.dropFile(path);
      const cached = this.cache.get(path);
      if (cached && cached.mtime === note.mtime && cached.size === note.size) return false;
      // Size is checked before the pre-filter: an oversized note is never read,
      // even when its cached parse claimed a reference block.
      if (note.size > MAX_BACKLINK_SCAN_BYTES) return this.store(path, note, [], false);
      if (this.ports.mayContainCodeBlock(path) === false) return this.store(path, note, [], false);
      const source = await this.ports.read(path);
      if (this.destroyed) return false;
      // The note may have been deleted or rewritten while the read was in
      // flight. Publishing the stale answer would resurrect a backlink that no
      // longer exists, so the stat must still match the one this read started
      // from; otherwise the queued vault event owns the next attempt.
      const current = this.ports.noteAt(path);
      if (!current || current.mtime !== note.mtime || current.size !== note.size) return false;
      return this.store(path, note, extractBranchReferences(source), true);
    } catch (error) {
      // A transient read failure must not stick to the path: the next event
      // retries it, so a note that was being written is picked up afterwards.
      this.ports.reportError?.(error);
      return false;
    }
  }

  private store(
    path: string,
    note: BacklinkNote,
    references: readonly BranchReferenceOccurrence[],
    verified: boolean
  ): boolean {
    const previous = this.cache.get(path);
    if (previous && sameReferences(previous.references, references)) {
      // Same answer, newer stat: no subscriber needs to hear about it.
      this.cache.set(path, { mtime: note.mtime, size: note.size, verified, references });
      return false;
    }
    this.dropFile(path);
    this.cache.set(path, { mtime: note.mtime, size: note.size, verified, references });
    for (const reference of references) this.addContribution(path, reference);
    return true;
  }

  /** Remove one note's cached answer and every backlink it contributed. */
  private dropFile(path: string): boolean {
    const cached = this.cache.get(path);
    if (!cached) return false;
    this.cache.delete(path);
    if (cached.references.length === 0) return false;
    for (const reference of cached.references) this.removeContribution(path, reference);
    return true;
  }

  private addContribution(path: string, reference: BranchReferenceOccurrence): void {
    let byNode = this.byDocument.get(reference.documentId);
    if (!byNode) {
      byNode = new Map();
      this.byDocument.set(reference.documentId, byNode);
    }
    let targets = byNode.get(reference.nodeId);
    if (!targets) {
      targets = [];
      byNode.set(reference.nodeId, targets);
    }
    targets.push({ path, line: reference.line });
  }

  private removeContribution(path: string, reference: BranchReferenceOccurrence): void {
    const byNode = this.byDocument.get(reference.documentId);
    const targets = byNode?.get(reference.nodeId);
    if (!byNode || !targets) return;
    const index = targets.findIndex((target) => target.path === path && target.line === reference.line);
    if (index >= 0) targets.splice(index, 1);
    if (targets.length === 0) byNode.delete(reference.nodeId);
    if (byNode.size === 0) this.byDocument.delete(reference.documentId);
  }

  private emit(): void {
    if (this.destroyed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.ports.reportError?.(error);
      }
    }
  }
}

function sameReferences(
  left: readonly BranchReferenceOccurrence[],
  right: readonly BranchReferenceOccurrence[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.documentId !== b.documentId || a.nodeId !== b.nodeId || a.line !== b.line) return false;
  }
  return true;
}

/** Path first, then line: independent of scan order and of the host locale. */
function compareTargets(left: BacklinkTarget, right: BacklinkTarget): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.line - right.line;
}
