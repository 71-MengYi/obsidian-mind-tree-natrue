import { cloneDocument } from "../domain/tree";
import type { MindTreeDocument } from "../types";
import { rebaseTreeSettings, restoreTreeSettingsHistory, type TreeSettingKey } from "../document-settings-state";

export class SaveConflictError extends Error {
  constructor() {
    super("The mind tree has unresolved external changes.");
    this.name = "SaveConflictError";
  }
}

/**
 * Owns the state that makes view saves deterministic. The view still performs
 * actual Vault I/O, while this class serializes requests and tracks which
 * document revision a successful write represented.
 */
export class DocumentSession {
  /** Shared-session safety gate; not merely a disabled toolbar. */
  isMutationBlocked: () => boolean = () => false;
  private baselineSource = "";
  private revision = 0;
  private savedRevision = 0;
  private saveRequested = false;
  private saveDrain?: Promise<void>;
  /**
   * The newest caller supplies the next save pass. This matters when one
   * DocumentSession is shared by several views: a view may detach while a
   * write is in flight, so a queued follow-up must not keep calling the stale
   * view's closure.
   */
  private saveTask?: () => Promise<boolean>;
  private undoStack: MindTreeDocument[] = [];
  private redoStack: MindTreeDocument[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();

  load(source: string): void {
    this.baselineSource = source;
    this.revision = 0;
    this.savedRevision = 0;
    this.clearHistory();
  }

  clear(): void {
    this.load("");
  }

  markChanged(): number {
    this.revision += 1;
    return this.revision;
  }

  get currentRevision(): number { return this.revision; }
  get sourceBaseline(): string { return this.baselineSource; }
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Accept a disk source without claiming the current document was written. */
  replaceBaseline(source: string): void {
    this.baselineSource = source;
  }

  markSaved(revision: number, source: string): void {
    this.baselineSource = source;
    this.savedRevision = revision;
  }

  /** Execute one user command with one clone and retain the old immutable state. */
  execute(document: MindTreeDocument, mutator: (draft: MindTreeDocument) => void): MindTreeDocument {
    if (this.isMutationBlocked()) throw new SaveConflictError();
    const draft = cloneDocument(document);
    mutator(draft);
    this.retainConfirmedSnapshot(document);
    return draft;
  }

  /** Only version acceptance may retain a frozen draft while the session is locked. */
  retainConfirmedSnapshot(document: MindTreeDocument): void {
    this.undoStack.push(document);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Saves, explicit version choices and identity writes share one atomic lane. */
  runExclusiveWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeTail.catch(() => undefined).then(task);
    this.writeTail = next;
    return next;
  }

  undo(document: MindTreeDocument): MindTreeDocument | undefined {
    if (this.isMutationBlocked()) return undefined;
    const previous = this.undoStack.pop();
    if (!previous) return undefined;
    this.redoStack.push(document);
    return restoreTreeSettingsHistory(previous, document);
  }

  redo(document: MindTreeDocument): MindTreeDocument | undefined {
    if (this.isMutationBlocked()) return undefined;
    const next = this.redoStack.pop();
    if (!next) return undefined;
    this.undoStack.push(document);
    return restoreTreeSettingsHistory(next, document);
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** External YAML must not be resurrected by an unrelated node undo. */
  rebaseSettings(external: MindTreeDocument, keys: readonly TreeSettingKey[]): void {
    if (!keys.length) return;
    this.undoStack = this.undoStack.map((document) => rebaseTreeSettings(document, external, keys));
    this.redoStack = this.redoStack.map((document) => rebaseTreeSettings(document, external, keys));
  }

  /** A lazily assigned tree identity must survive undo/redo snapshots. */
  adoptDocumentIdentity(documentId: string): void {
    for (const snapshot of this.undoStack) snapshot.documentId = documentId;
    for (const snapshot of this.redoStack) snapshot.documentId = documentId;
  }

  /**
   * Coalesce simultaneous calls. A task returns true when a mutation occurred
   * during its write and the latest revision needs one more pass.
   */
  requestSave(task: () => Promise<boolean>): Promise<void> {
    this.saveRequested = true;
    this.saveTask = task;
    if (!this.saveDrain) {
      this.saveDrain = this.drain().finally(() => {
        this.saveDrain = undefined;
        if (!this.saveRequested) this.saveTask = undefined;
      });
    }
    return this.saveDrain;
  }

  private async drain(): Promise<void> {
    while (this.saveRequested) {
      this.saveRequested = false;
      const task = this.saveTask;
      if (!task) return;
      if (await this.runExclusiveWrite(task)) this.saveRequested = true;
    }
  }
}
