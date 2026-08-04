import { OUTLINE_END, OUTLINE_START } from "../format/outline";
import { cloneDocument } from "../domain/tree";
import type { MindTreeDocument } from "../types";

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
  private baselineSource = "";
  private revision = 0;
  private savedRevision = 0;
  private saveRequested = false;
  private saveDrain?: Promise<void>;
  private undoStack: MindTreeDocument[] = [];
  private redoStack: MindTreeDocument[] = [];

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
    const draft = cloneDocument(document);
    mutator(draft);
    this.undoStack.push(document);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    return draft;
  }

  undo(document: MindTreeDocument): MindTreeDocument | undefined {
    const previous = this.undoStack.pop();
    if (!previous) return undefined;
    this.redoStack.push(document);
    return previous;
  }

  redo(document: MindTreeDocument): MindTreeDocument | undefined {
    const next = this.redoStack.pop();
    if (!next) return undefined;
    this.undoStack.push(document);
    return next;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
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
    if (!this.saveDrain) {
      this.saveDrain = this.drain(task).finally(() => { this.saveDrain = undefined; });
    }
    return this.saveDrain;
  }

  private async drain(task: () => Promise<boolean>): Promise<void> {
    while (this.saveRequested) {
      this.saveRequested = false;
      if (await task()) this.saveRequested = true;
    }
  }
}

/** Generated outline edits are disposable and never constitute a data conflict. */
export function changesOnlyGeneratedOutline(baseline: string, external: string): boolean {
  return baseline !== external && withoutGeneratedOutline(baseline) === withoutGeneratedOutline(external);
}

/** Clone local work for recovery without duplicating its linkable document ID. */
export function createRecoveryDocument(document: MindTreeDocument): MindTreeDocument {
  const recovery = cloneDocument(document);
  delete recovery.documentId;
  return recovery;
}

function withoutGeneratedOutline(source: string): string {
  const start = source.indexOf(OUTLINE_START);
  const end = source.indexOf(OUTLINE_END, Math.max(0, start));
  if (start < 0 || end < start) return source;
  return `${source.slice(0, start)}${OUTLINE_START}\n${OUTLINE_END}${source.slice(end + OUTLINE_END.length)}`;
}
