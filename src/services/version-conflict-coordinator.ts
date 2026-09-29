import { cloneDocument } from "../domain/tree";
import { serializeMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import type { MindTreeDocument } from "../types";
import { assessExternalVersion, createManagedMindTreeSnapshot, sameManagedMindTreeSnapshot,
  type ManagedMindTreeSnapshot } from "./document-conflict";
import { canonicalTreePath, type PendingConflictRecord, type PendingConflictStore, type PendingTitleDraft } from "./pending-conflict-store";
import { rebaseTreeSettings, TREE_SETTING_KEYS } from "../document-settings-state";
import { restoreDocumentIdentity } from "../format/document-identity";

export interface VersionPreviewState {
  readonly mode: "comparison" | "identity" | "invalid" | "metadata";
  readonly current: MindTreeDocument;
  readonly external?: MindTreeDocument;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorDetails?: string;
  readonly changedAgain: boolean;
  readonly originalId?: string;
  readonly currentId?: string;
  readonly canRestoreIdentity: boolean;
}

export interface VersionChoiceResult {
  choice: "current" | "external";
  document: MindTreeDocument;
  source: string;
  draft?: PendingTitleDraft;
  titleRenames?: PendingTitleDraft[];
  /** Return to the editor without confirming/renaming its uncommitted title. */
  resumeDraft?: PendingTitleDraft;
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
  restored: (document: MindTreeDocument, baseline: string) => void;
  createId: () => string;
  /** Verify all candidates, then return a synchronous race guard for Vault.process. */
  checkIdentityAvailable?: (id: string) => Promise<() => void>;
  scheduleResume?: () => void;
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
  private errorDetails?: string;
  private storageError?: string;
  private operationError?: string;
  private changedAgain = false;
  private readSequence = 0;
  private readRequested = false;
  private readDrain?: Promise<void>;
  private stage?: Promise<void>;
  private operationTail: Promise<unknown> = Promise.resolve();
  private assessmentKind: "comparison" | "identity" | "invalid" | "metadata" = "metadata";
  private originalId?: string;

  constructor(private readonly ports: VersionConflictPorts) {}

  get active(): boolean { return this.current !== undefined; }
  get state(): VersionPreviewState | undefined {
    return this.current ? {
      mode: this.assessmentKind,
      current: this.external ? rebaseTreeSettings(this.current, this.external.document, TREE_SETTING_KEYS) : this.current,
      external: this.external?.document,
      ready: this.durable && Boolean(this.external) && !this.error && !this.storageError && !this.operationError && !this.busy,
      busy: this.busy, error: this.storageError ?? this.operationError ?? this.error, changedAgain: this.changedAgain,
      errorDetails: this.errorDetails,
      originalId: this.originalId, currentId: this.external?.documentId,
      canRestoreIdentity: this.assessmentKind === "identity" && Boolean(this.originalId) && Boolean(this.external)
        && this.durable && !this.storageError && !this.busy && Boolean(this.ports.checkIdentityAvailable)
    } : undefined;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operationTail.catch(() => undefined).then(task);
    this.operationTail = next;
    return next;
  }

  /** Capture at the user click, before waiting for another file write. */
  captureDisplayedVersion(): ManagedMindTreeSnapshot | undefined {
    return this.state?.ready && this.assessmentKind === "comparison" ? this.external : undefined;
  }

  restore(): Promise<boolean> { return this.serial(() => this.restoreRecord()); }

  private async restoreRecord(): Promise<boolean> {
    const record = await this.ports.store.load(this.ports.path());
    if (!record) return false;
    this.record = record;
    this.current = createManagedMindTreeSnapshot(record.currentSource, this.ports.options()).document;
    this.originalId = createManagedMindTreeSnapshot(record.baselineSource, this.ports.options()).documentId;
    this.durable = true;
    this.ports.restored(cloneDocument(this.current), record.baselineSource);
    this.ports.changed();
    // A crash after the verified write but before cleanup is not a new choice.
    // A prepared receipt is sufficient only if disk actually matches it.
    try { if (await this.finishReceipt()) return true; }
    catch (error) { this.operationError = message(error); }
    await this.refresh();
    return true;
  }

  async enter(document: MindTreeDocument, baselineSource: string, draft?: PendingTitleDraft,
    titleRenames: readonly PendingTitleDraft[] = [], confirmedDocument?: MindTreeDocument): Promise<void> {
    if (this.active) { await this.refresh(); return; }
    this.current = cloneDocument(document);
    this.originalId = createManagedMindTreeSnapshot(baselineSource, this.ports.options()).documentId;
    this.record = {
      version: 1, id: this.ports.createId(), path: canonicalTreePath(this.ports.path()), baselineSource,
      currentSource: serializeMindTreeFile(this.current, baselineSource),
      ...(confirmedDocument ? { confirmedSource: serializeMindTreeFile(confirmedDocument, baselineSource) } : {}),
      ...(draft ? { draft: { ...draft } } : {}),
      ...(titleRenames.length ? { titleRenames: titleRenames.map((rename) => ({ ...rename })) } : {})
    };
    this.ports.changed(); // Lock mutation synchronously, before the first await.
    this.stage = this.serial(async () => { await this.persist(); await this.refresh(); });
    await this.stage;
  }

  private async persist(): Promise<void> {
    if (!this.record) return;
    this.durable = false;
    try {
      await this.ports.store.put(this.record);
      this.durable = true;
      this.storageError = undefined;
    } catch (error) {
      this.storageError = message(error);
      throw error;
    } finally { this.ports.changed(); }
  }

  /** Coalesce notifications, discard in-flight reads when a newer event arrives. */
  refresh(): Promise<void> {
    this.readRequested = true;
    this.readSequence++;
    if (!this.readDrain) {
      this.readDrain = this.drainReads().finally(() => {
        this.readDrain = undefined;
        if (this.assessmentKind === "metadata" && this.state?.ready) this.ports.scheduleResume?.();
      });
    }
    return this.readDrain;
  }

  private async drainReads(): Promise<void> {
    while (this.readRequested && this.record && this.current) {
      this.readRequested = false;
      const sequence = this.readSequence;
      const record = this.record;
      try {
        const source = await this.ports.read();
        if (sequence !== this.readSequence || this.record !== record || !this.current) continue;
        const result = assessExternalVersion(this.record.baselineSource, this.current, source, this.ports.options());
        this.external = result.external;
        this.assessmentKind = result.kind === "blocked" ? result.message === "identity" ? "identity" : "invalid"
          : result.kind === "choose" ? "comparison" : "metadata";
        this.error = result.kind === "blocked" ? result.message : undefined;
        this.errorDetails = result.kind === "blocked" ? result.details : undefined;
      } catch (error) {
        if (sequence !== this.readSequence || this.record !== record) continue;
        this.external = undefined;
        this.assessmentKind = "invalid";
        this.error = message(error);
      }
      this.ports.changed();
    }
  }

  /** Retry staging after a disk/permission failure without unfreezing local data. */
  retry(): Promise<void> {
    return this.serial(async () => {
      this.operationError = undefined;
      try {
        await this.persist();
        if (!await this.finishReceipt()) await this.refresh();
      } catch (error) { this.operationError = message(error); }
      finally { this.ports.changed(); }
    });
  }

  async settle(): Promise<void> {
    await this.stage?.catch(() => undefined);
    await this.operationTail.catch(() => undefined);
    if (this.record && !this.durable) await this.persist();
  }

  rename(path: string): Promise<void> {
    this.readSequence++;
    return this.serial(async () => {
      if (!this.record) return;
      this.record = { ...this.record, path: canonicalTreePath(path) };
      await this.persist();
      await this.refresh();
    });
  }

  /** Called inside the shared save queue, never concurrently with a normal save. */
  choose(choice: "current" | "external", displayed = this.captureDisplayedVersion()): Promise<VersionChoiceResult | undefined> {
    return this.serial(() => this.commitChoice(choice, displayed));
  }

  /** Called by the shared file queue after metadata-only legacy conflicts become harmless. */
  resumeUnchanged(): Promise<VersionChoiceResult | undefined> {
    return this.serial(async () => {
      if (this.assessmentKind !== "metadata" || !this.state?.ready) return;
      return this.commitChoice("current", this.external, true);
    });
  }

  /** Repair identity only. A concurrent machine-data change is still presented afterward. */
  restoreIdentity(expected: string | undefined): Promise<void> {
    return this.serial(async () => {
      if (!this.state?.canRestoreIdentity || !this.originalId || !this.ports.checkIdentityAvailable) return;
      this.busy = true;
      this.operationError = undefined;
      this.ports.changed();
      let output: string | undefined;
      try {
        const guard = await this.ports.checkIdentityAvailable(this.originalId);
        const path = this.ports.path();
        await this.ports.process((source) => {
          guard();
          if (this.ports.path() !== path) throw new Error("The file moved. Recheck before restoring its identity.");
          output = restoreDocumentIdentity(source, expected, this.originalId!, this.ports.options());
          this.ports.beginWrite(output);
          return output;
        });
        const actual = await this.ports.read();
        if (!output || !sameManagedMindTreeSnapshot(createManagedMindTreeSnapshot(output, this.ports.options()),
          createManagedMindTreeSnapshot(actual, this.ports.options()))) throw new Error("Identity restoration could not be verified. Recheck the latest file.");
      } catch (error) { this.operationError = message(error); }
      finally {
        if (output !== undefined) this.ports.endWrite(output);
        this.busy = false;
        await this.refresh();
        this.ports.changed();
      }
    });
  }

  private confirmedDocument(): MindTreeDocument {
    if (this.record?.confirmedSource) return createManagedMindTreeSnapshot(this.record.confirmedSource, this.ports.options()).document;
    // Old pending records contained only the preview and the original draft title.
    const document = cloneDocument(this.current!);
    const draft = this.record?.draft;
    if (draft && document.nodes[draft.nodeId]) {
      document.nodes[draft.nodeId]!.title = draft.originalTitle;
      if (draft.nodeId === document.rootId) document.title = draft.originalTitle;
    }
    return document;
  }

  private async commitChoice(choice: "current" | "external", displayed?: ManagedMindTreeSnapshot, resumeDraft = false): Promise<VersionChoiceResult | undefined> {
    if (!this.record || !this.current || !displayed || !this.state?.ready) return;
    this.busy = true;
    this.changedAgain = false;
    this.ports.changed();
    let output: string | undefined;
    try {
      const latest = await this.ports.read();
      const checked = this.checkDisplayed(latest, displayed);
      if (!checked) return;
      if (resumeDraft && assessExternalVersion(this.record.baselineSource, this.current, latest, this.ports.options()).kind !== "unchanged") return;
      const matchesFrozen = resumeDraft && checked.machineFingerprint !== createManagedMindTreeSnapshot(this.record.baselineSource, this.ports.options()).machineFingerprint;
      const selected = rebaseTreeSettings(choice === "current" ? resumeDraft
        ? matchesFrozen ? checked.document : this.confirmedDocument() : cloneDocument(this.current) : checked.document,
        checked.document, TREE_SETTING_KEYS);
      // Preserve a safe first identity assigned while the preview was open.
      if (!selected.documentId && checked.documentId) selected.documentId = checked.documentId;
      const proposed = choice === "current" ? serializeMindTreeFile(selected, latest) : latest;
      this.record.receipt = { choice, source: proposed, phase: "prepared", ...(resumeDraft ? { resumeDraft: true } : {}) };
      await this.persist();
      let changed = false;
      await this.ports.process((disk) => {
        if (!this.checkDisplayed(disk, displayed)) { changed = true; return disk; }
        // Rebuild against the newest prose/YAML, not the earlier read above.
        const diskDocument = createManagedMindTreeSnapshot(disk, this.ports.options()).document;
        output = choice === "current" ? serializeMindTreeFile(rebaseTreeSettings(selected, diskDocument, TREE_SETTING_KEYS), disk) : disk;
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
      this.record.receipt = { choice, source: verified, phase: "verified", ...(resumeDraft ? { resumeDraft: true } : {}) };
      await this.persist();
      // Journal verification itself is asynchronous. A sync arriving during
      // that time still requires another choice, not silent acceptance.
      const finalSource = await this.ports.read();
      const finalSnapshot = createManagedMindTreeSnapshot(finalSource, this.ports.options());
      if (!sameManagedMindTreeSnapshot(actual, finalSnapshot)) {
        this.changedAgain = true;
        await this.refresh();
        return;
      }
      return await this.complete(choice, finalSource, finalSnapshot.document);
    } catch (error) {
      this.operationError = message(error);
    } finally {
      if (output !== undefined) this.ports.endWrite(output);
      this.busy = false;
      this.ports.changed();
    }
  }

  /** A receipt is proof only when the current disk still matches it. */
  private async finishReceipt(): Promise<boolean> {
    if (!this.record?.receipt) return false;
    const latest = await this.ports.read();
    const actual = createManagedMindTreeSnapshot(latest, this.ports.options());
    const expected = createManagedMindTreeSnapshot(this.record.receipt.source, this.ports.options());
    if (sameManagedMindTreeSnapshot(actual, expected)) {
      // Keep the receipt if cleanup fails: a restart/retry may finish cleanup
      // without writing again or asking the user to make the same choice.
      await this.complete(this.record.receipt.choice, latest, actual.document);
      return true;
    }
    delete this.record.receipt;
    await this.persist();
    return false;
  }

  private checkDisplayed(source: string, displayed: ManagedMindTreeSnapshot): ManagedMindTreeSnapshot | undefined {
    const result = assessExternalVersion(this.record!.baselineSource, this.current!, source, this.ports.options());
    if (result.kind === "blocked") {
      this.external = result.external;
      this.error = result.message;
      this.assessmentKind = result.message === "identity" ? "identity" : "invalid";
      return;
    }
    if (!sameManagedMindTreeSnapshot(displayed, result.external)) {
      this.external = result.external;
      this.changedAgain = true;
      this.assessmentKind = result.kind === "choose" ? "comparison" : "metadata";
      return;
    }
    return result.external;
  }

  private async complete(choice: "current" | "external", source: string, document: MindTreeDocument): Promise<VersionChoiceResult> {
    const result: VersionChoiceResult = { choice, source, document,
      ...(choice === "current" && this.record?.draft ? this.record.receipt?.resumeDraft
        ? { resumeDraft: this.record.draft } : { draft: this.record.draft } : {}),
      ...(choice === "current" && this.record?.titleRenames ? { titleRenames: this.record.titleRenames } : {}) };
    await this.ports.store.remove(this.record!);
    this.record = undefined;
    this.current = undefined;
    this.external = undefined;
    this.error = undefined;
    this.errorDetails = undefined;
    this.storageError = undefined;
    this.operationError = undefined;
    this.readSequence++;
    this.ports.resolved(result);
    return result;
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
