import { cloneDocument } from "../domain/tree";
import { serializeMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import type { MindTreeDocument } from "../types";
import { assessExternalVersion, createManagedMindTreeSnapshot, sameManagedMindTreeSnapshot,
  type ManagedMindTreeSnapshot } from "./document-conflict";
import { canonicalTreePath, type PendingConflictRecord, type PendingConflictStore, type PendingTitleDraft } from "./pending-conflict-store";

export interface VersionPreviewState {
  readonly current: MindTreeDocument;
  readonly external?: MindTreeDocument;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly changedAgain: boolean;
}

export interface VersionChoiceResult {
  choice: "current" | "external";
  document: MindTreeDocument;
  source: string;
  draft?: PendingTitleDraft;
}

export interface VersionConflictPorts {
  store: PendingConflictStore;
  options: () => ParseMindTreeOptions;
  path: () => string;
  read: () => Promise<string>;
  process: (transform: (latest: string) => string) => Promise<unknown>;
  beginWrite: (source: string) => void;
  endWrite: (source: string) => void;
  changed: () => void;
  resolved: (result: VersionChoiceResult) => void;
  createId: () => string;
}

/**
 * One coordinator per shared document. It owns no DOM, timers or view closures.
 * Local work is immutable while active. Remote versions are always re-read,
 * never selected from event payloads or a cached modal snapshot.
 */
export class VersionConflictCoordinator {
  private record?: PendingConflictRecord;
  private current?: MindTreeDocument;
  private external?: ManagedMindTreeSnapshot;
  private durable = false;
  private busy = false;
  private error?: string;
  private changedAgain = false;
  private readSequence = 0;
  private readRequested = false;
  private readDrain?: Promise<void>;
  private stage?: Promise<void>;

  constructor(private readonly ports: VersionConflictPorts) {}

  get active(): boolean { return this.current !== undefined; }
  get state(): VersionPreviewState | undefined {
    return this.current ? {
      current: this.current, external: this.external?.document,
      ready: this.durable && Boolean(this.external) && !this.error && !this.busy,
      busy: this.busy, error: this.error, changedAgain: this.changedAgain
    } : undefined;
  }

  async restore(): Promise<boolean> {
    const record = await this.ports.store.load(this.ports.path());
    if (!record) return false;
    this.record = record;
    this.current = createManagedMindTreeSnapshot(record.currentSource, this.ports.options()).document;
    this.durable = true;
    this.ports.changed();
    // A crash after the verified write but before cleanup is not a new choice.
    // A prepared receipt is sufficient only if disk actually matches it.
    if (record.receipt) {
      try {
        const latest = await this.ports.read();
        const actual = createManagedMindTreeSnapshot(latest, this.ports.options());
        const expected = createManagedMindTreeSnapshot(record.receipt.source, this.ports.options());
        if (sameManagedMindTreeSnapshot(actual, expected)) {
          await this.complete(record.receipt.choice, latest, actual.document);
          return true;
        }
      } catch (error) { this.error = message(error); }
      // The receipt is not proof that a later remote version may be discarded.
      delete this.record.receipt;
      await this.persist();
    }
    await this.refresh();
    return true;
  }

  async enter(document: MindTreeDocument, baselineSource: string, draft?: PendingTitleDraft): Promise<void> {
    if (this.active) { await this.refresh(); return; }
    this.current = cloneDocument(document);
    this.record = {
      version: 1, id: this.ports.createId(), path: canonicalTreePath(this.ports.path()), baselineSource,
      currentSource: serializeMindTreeFile(this.current, baselineSource),
      ...(draft ? { draft: { ...draft } } : {})
    };
    this.ports.changed(); // Lock mutation synchronously, before the first await.
    this.stage = this.persist();
    await this.stage;
    await this.refresh();
  }

  private async persist(): Promise<void> {
    if (!this.record) return;
    this.durable = false;
    try {
      await this.ports.store.put(this.record);
      this.durable = true;
    } catch (error) {
      this.error = message(error);
      throw error;
    } finally { this.ports.changed(); }
  }

  /** Coalesce notifications, discard in-flight reads when a newer event arrives. */
  refresh(): Promise<void> {
    this.readRequested = true;
    this.readSequence++;
    if (!this.readDrain) {
      this.readDrain = this.drainReads().finally(() => { this.readDrain = undefined; });
    }
    return this.readDrain;
  }

  private async drainReads(): Promise<void> {
    while (this.readRequested && this.record && this.current) {
      this.readRequested = false;
      const sequence = this.readSequence;
      try {
        const source = await this.ports.read();
        if (sequence !== this.readSequence) continue;
        const result = assessExternalVersion(this.record.baselineSource, this.current, source, this.ports.options());
        this.external = result.kind === "unchanged" ? result.external : result.external;
        this.error = result.kind === "blocked" ? result.message : undefined;
      } catch (error) {
        if (sequence !== this.readSequence) continue;
        this.external = undefined;
        this.error = message(error);
      }
      this.ports.changed();
    }
  }

  /** Retry staging after a disk/permission failure without unfreezing local data. */
  async retry(): Promise<void> {
    this.error = undefined;
    try { await this.persist(); await this.refresh(); }
    catch { /* The error is already visible and the mutation lock stays held. */ }
  }

  async settle(): Promise<void> {
    await this.stage;
    if (this.record && !this.durable) await this.persist();
  }

  async rename(path: string): Promise<void> {
    if (!this.record) return;
    this.record = { ...this.record, path: canonicalTreePath(path) };
    await this.persist();
  }

  /** Called inside the shared save queue, never concurrently with a normal save. */
  async choose(choice: "current" | "external"): Promise<VersionChoiceResult | undefined> {
    const displayed = this.external;
    if (!this.record || !this.current || !displayed || !this.state?.ready) return;
    this.busy = true;
    this.changedAgain = false;
    this.ports.changed();
    let output: string | undefined;
    try {
      const latest = await this.ports.read();
      const checked = this.checkDisplayed(latest, displayed);
      if (!checked) return;
      const selected = choice === "current" ? cloneDocument(this.current) : checked.document;
      // Preserve a safe first identity assigned while the preview was open.
      if (!selected.documentId && checked.documentId) selected.documentId = checked.documentId;
      const proposed = choice === "current" ? serializeMindTreeFile(selected, latest) : latest;
      this.record.receipt = { choice, source: proposed, phase: "prepared" };
      await this.persist();
      let changed = false;
      await this.ports.process((disk) => {
        if (!this.checkDisplayed(disk, displayed)) { changed = true; return disk; }
        // Rebuild against the newest prose/YAML, not the earlier read above.
        output = choice === "current" ? serializeMindTreeFile(selected, disk) : disk;
        this.ports.beginWrite(output);
        return output;
      });
      if (changed || output === undefined) return;
      const verified = await this.ports.read();
      const expected = createManagedMindTreeSnapshot(output, this.ports.options());
      const actual = createManagedMindTreeSnapshot(verified, this.ports.options());
      if (!sameManagedMindTreeSnapshot(expected, actual)) {
        this.changedAgain = true;
        await this.refresh();
        return;
      }
      this.record.receipt = { choice, source: verified, phase: "verified" };
      await this.persist();
      return await this.complete(choice, verified, actual.document);
    } catch (error) {
      this.error = message(error);
    } finally {
      if (output !== undefined) this.ports.endWrite(output);
      this.busy = false;
      this.ports.changed();
    }
  }

  private checkDisplayed(source: string, displayed: ManagedMindTreeSnapshot): ManagedMindTreeSnapshot | undefined {
    const result = assessExternalVersion(this.record!.baselineSource, this.current!, source, this.ports.options());
    if (result.kind === "blocked") {
      this.external = result.external;
      this.error = result.message;
      return;
    }
    if (!sameManagedMindTreeSnapshot(displayed, result.external)) {
      this.external = result.external;
      this.changedAgain = true;
      return;
    }
    return result.external;
  }

  private async complete(choice: "current" | "external", source: string, document: MindTreeDocument): Promise<VersionChoiceResult> {
    const result: VersionChoiceResult = { choice, source, document,
      ...(choice === "current" && this.record?.draft ? { draft: this.record.draft } : {}) };
    await this.ports.store.remove(this.record!);
    this.record = undefined;
    this.current = undefined;
    this.external = undefined;
    this.error = undefined;
    this.ports.resolved(result);
    return result;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
