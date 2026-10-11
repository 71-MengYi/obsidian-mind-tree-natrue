import type { ParseMindTreeOptions } from "../format/document";
import { isMindTreePath } from "../view-routing";
import { createManagedMindTreeSnapshot } from "./document-conflict";
import {
  canonicalTreePath,
  resolvePendingConflict,
  type PendingConflictEntry
} from "./pending-conflict-store";
import type { SharedMindTreeSession } from "./mind-tree-session-registry";

/** Structural view of a vault file; the module itself stays free of Obsidian. */
export interface PendingConflictTreeFile {
  readonly path: string;
}

/** Journal operations the maintenance pass needs; `PendingConflictStore` implements these. */
export interface PendingConflictJournalPort {
  pendingRecords(): Promise<PendingConflictEntry[]>;
  rekey(entry: PendingConflictEntry, nextPath: string): Promise<void>;
  remove(entry: PendingConflictEntry): Promise<void>;
}

/** Indexed identities; a `resourceId` is evidence of a location, never ownership. */
export interface PendingConflictIndexPort {
  entries(): readonly { readonly resourceId: string; readonly path: string }[];
}

/** Live sessions, so a re-pointed or dropped record also updates its open view. */
export interface PendingConflictSessionPort {
  get(path: string): SharedMindTreeSession | undefined;
}

/** Debounce timers stay injectable so the module can be tested without a DOM. */
export interface PendingConflictMaintenanceClock {
  setTimeout(handler: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface PendingConflictMaintenancePorts<TreeFile extends PendingConflictTreeFile> {
  readonly pendingConflicts: PendingConflictJournalPort;
  readonly resources: PendingConflictIndexPort;
  readonly sessions: PendingConflictSessionPort;
  /** All vault files; canonical path matching picks the file at the recorded path. */
  readonly vaultFiles: () => readonly TreeFile[];
  /** Established frontmatter identity of a live tree; the module never reads the vault. */
  readonly documentIdAt: (file: TreeFile) => string | undefined;
  readonly parseOptions: () => Readonly<ParseMindTreeOptions>;
  /** Re-check one path's open views after its session conflict was discarded. */
  readonly refreshOpenViews: (path: string) => void;
  readonly clock: PendingConflictMaintenanceClock;
  /** Report a failed journal pass; the host owns localization and duration. */
  readonly noticeStorageError: (error: unknown) => void;
  /** Report dropped records once per burst; the host owns wording and ordering. */
  readonly noticeDiscarded: (paths: readonly string[]) => void;
  readonly isUnloading: () => boolean;
}

/**
 * Keep the journal aligned with the vault: a record whose file was deleted (or
 * whose path now holds a different document) is dropped instead of being
 * reported forever, and a uniquely identified move re-points the record rather
 * than turning the moved tree into a permanent conflict.
 */
export class PendingConflictMaintenance<TreeFile extends PendingConflictTreeFile> {
  private scheduledCleanup?: number;
  private readonly discardedPaths = new Set<string>();
  private discardedNotice?: number;

  constructor(private readonly ports: PendingConflictMaintenancePorts<TreeFile>) {}

  /** Delete/rename bursts settle first; the vault index is read afterwards. */
  schedule(): void {
    if (this.ports.isUnloading()) return;
    if (this.scheduledCleanup !== undefined) this.ports.clock.clearTimeout(this.scheduledCleanup);
    this.scheduledCleanup = this.ports.clock.setTimeout(() => {
      this.scheduledCleanup = undefined;
      void this.reportUnlocated();
    }, 800);
  }

  /** Cancel the pending debounce and notice timers, e.g. while unloading. */
  cancel(): void {
    if (this.scheduledCleanup !== undefined) this.ports.clock.clearTimeout(this.scheduledCleanup);
    this.scheduledCleanup = undefined;
    if (this.discardedNotice !== undefined) this.ports.clock.clearTimeout(this.discardedNotice);
    this.discardedNotice = undefined;
  }

  async reportUnlocated(): Promise<void> {
    try {
      const entries = await this.ports.pendingConflicts.pendingRecords();
      if (!entries.length) return;
      const indexed = this.ports.resources.entries();
      const discarded: string[] = [];
      for (const entry of entries) {
        const documentId = this.pendingDocumentId(entry);
        const live = this.vaultTreeAt(entry.path);
        // Indexed identities only: a path that merely exists is not a relocation.
        const identityPaths = documentId
          ? indexed.filter((candidate) => candidate.resourceId === documentId).map((candidate) => canonicalTreePath(candidate.path))
          : [];
        // Same path, different established identity: the record now belongs to a
        // document that no longer exists, so it must not block the live file.
        const decision = resolvePendingConflict({
          ...(documentId ? { recordDocumentId: documentId } : {}),
          ...(live ? { recordedPathDocumentId: this.ports.documentIdAt(live) } : {}),
          recordedPathExists: Boolean(live),
          identityPaths,
          recordPath: entry.path
        });
        if (decision.kind === "live" || decision.kind === "retain") continue;
        if (decision.kind === "rebind") {
          const target = canonicalTreePath(decision.path);
          // Never merge two records onto one locator; leave it for the next pass.
          if (entries.some((other) => other.path === target)) continue;
          await this.ports.pendingConflicts.rekey(entry, target);
          await this.ports.sessions.get(entry.path)?.conflict?.rename(target);
          continue;
        }
        await this.ports.pendingConflicts.remove(entry);
        await this.discardSessionConflict(entry.path);
        discarded.push(entry.path);
      }
      if (discarded.length) this.reportDiscardedVersions(discarded);
    } catch (error) { this.ports.noticeStorageError(error); }
  }

  /** One notice per delete burst instead of one per file. */
  private reportDiscardedVersions(paths: readonly string[]): void {
    for (const path of paths) this.discardedPaths.add(path);
    if (this.discardedNotice !== undefined) this.ports.clock.clearTimeout(this.discardedNotice);
    this.discardedNotice = this.ports.clock.setTimeout(() => {
      this.discardedNotice = undefined;
      const reported = [...this.discardedPaths];
      this.discardedPaths.clear();
      if (reported.length) this.ports.noticeDiscarded(reported);
    }, 800);
  }

  private vaultTreeAt(path: string): TreeFile | undefined {
    const target = canonicalTreePath(path);
    return this.ports.vaultFiles().find((file) => isMindTreePath(file.path) && canonicalTreePath(file.path) === target);
  }

  /** Identity from the frozen baseline: never from the in-memory candidate. */
  private pendingDocumentId(entry: PendingConflictEntry): string | undefined {
    return createManagedMindTreeSnapshot(entry.record.baselineSource, this.ports.parseOptions()).documentId;
  }

  /** Unlock a session whose file is gone so the view stops reporting a conflict. */
  private async discardSessionConflict(path: string): Promise<void> {
    const session = this.ports.sessions.get(path);
    if (!session?.conflict?.active) return;
    await session.conflict.discard();
    if (this.vaultTreeAt(path)) this.ports.refreshOpenViews(session.path);
  }
}
