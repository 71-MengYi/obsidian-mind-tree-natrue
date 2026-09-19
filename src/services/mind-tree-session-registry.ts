import type { MindTreeDocument } from "../types";
import type { ManagedMindTreeSnapshot } from "./document-conflict";
import { DocumentSession } from "./document-session";

export type SharedSessionChangeReason =
  | "document"
  | "history"
  | "system"
  | "source"
  | "identity"
  | "status";

export interface SharedSessionSnapshot {
  readonly document?: MindTreeDocument;
  readonly source: string;
  readonly initialized: boolean;
  readonly dirty: boolean;
  readonly parseError?: string;
  readonly hasConflict: boolean;
  readonly reason: SharedSessionChangeReason;
  readonly originId?: string;
}

export interface SharedSessionParticipant {
  /** Refresh view-local rendering without changing its viewport. */
  readonly onSessionChange: (snapshot: SharedSessionSnapshot) => void;
  /** Commit the visible DOM draft before another view claims the editor. */
  readonly commitActiveDraft: () => void;
  readonly refreshConflictRecovery: () => Promise<void>;
  /** Become the sole UI owner if the previous conflict view is closed. */
  readonly adoptSaveConflict: (conflict: SharedSaveConflictState) => void;
}

/** Durable conflict details shared independently of any one leaf's DOM. */
export interface SharedSaveConflictState {
  readonly externalSource: string;
  readonly externalSnapshot?: ManagedMindTreeSnapshot;
  readonly recoveryPath: string;
  readonly recoveredLocalFingerprint: string;
}

export interface SharedTitleDraft {
  readonly ownerId: string;
  readonly nodeId: string;
  readonly originalTitle: string;
  readonly value: string;
}

/**
 * One in-memory document and history for every open view of the same file.
 *
 * The registry deliberately contains no Vault I/O. Disk writes remain behind
 * Vault.process in MindTreeView, while this object removes the more dangerous
 * class of races where two views begin from independent in-memory histories.
 */
export class SharedMindTreeSession {
  readonly history = new DocumentSession();
  private participants = new Map<string, SharedSessionParticipant>();
  private _document?: MindTreeDocument;
  private _source = "";
  private _initialized = false;
  private _parseError?: string;
  private activeEditorId?: string;
  private titleDraft?: SharedTitleDraft;
  private externalSourceInFlight?: string;
  private recoveryOperations = new Map<string, Promise<string>>();
  private recoveryTail: Promise<void> = Promise.resolve();
  private pendingWriteSource?: string;
  private conflictOwnerId?: string;
  private conflictState?: SharedSaveConflictState;
  private fileOperationTail: Promise<void> = Promise.resolve();

  private _path: string;

  constructor(path: string) {
    this._path = normalizeSessionPath(path);
  }

  get path(): string { return this._path; }
  get document(): MindTreeDocument | undefined { return this._document; }
  get source(): string { return this._source; }
  get initialized(): boolean { return this._initialized; }
  get parseError(): string | undefined { return this._parseError; }
  get participantCount(): number { return this.participants.size; }

  attach(id: string, participant: SharedSessionParticipant): void {
    this.participants.set(id, participant);
  }

  detach(id: string): void {
    const wasConflictOwner = this.conflictOwnerId === id;
    this.participants.delete(id);
    let stateChanged = false;
    if (this.activeEditorId === id) {
      this.activeEditorId = undefined;
      if (this.titleDraft?.ownerId === id) this.titleDraft = undefined;
      stateChanged = true;
    }
    if (wasConflictOwner) {
      const nextOwner = this.participants.entries().next().value as
        | [string, SharedSessionParticipant]
        | undefined;
      this.conflictOwnerId = nextOwner?.[0];
      if (nextOwner && this.conflictState) {
        nextOwner[1].adoptSaveConflict(this.conflictState);
      } else if (!nextOwner) {
        this.conflictState = undefined;
      }
      stateChanged = true;
    }
    if (stateChanged) this.notify("status", id);
  }

  rename(path: string): void {
    this._path = normalizeSessionPath(path);
  }

  initialize(document: MindTreeDocument | undefined, source: string, parseError?: string): boolean {
    if (this._initialized) return false;
    this._initialized = true;
    this._document = document;
    this._source = source;
    this._parseError = parseError;
    this.history.load(source);
    return true;
  }

  replaceDocument(
    document: MindTreeDocument | undefined,
    originId: string,
    reason: SharedSessionChangeReason = "document"
  ): void {
    this._document = document;
    this.notify(reason, originId);
  }

  replaceSource(source: string, originId: string): void {
    this._source = source;
    this.notify("source", originId);
  }

  notifyStatus(originId?: string): void {
    this.notify("status", originId);
  }

  /** Only one textarea draft may be authoritative for a shared file. */
  claimEditor(id: string): void {
    if (this.activeEditorId && this.activeEditorId !== id) {
      this.commitEditorOwner(this.activeEditorId);
    }
    this.activeEditorId = id;
  }

  commitEditorBeforeMutation(originId: string): void {
    if (this.activeEditorId && this.activeEditorId !== originId) {
      this.commitEditorOwner(this.activeEditorId);
    }
  }

  updateTitleDraft(
    ownerId: string,
    nodeId: string,
    originalTitle: string,
    value: string
  ): void {
    if (this.activeEditorId !== ownerId) return;
    this.titleDraft = { ownerId, nodeId, originalTitle, value };
    this.notify("status", ownerId);
  }

  get draft(): SharedTitleDraft | undefined {
    return this.titleDraft ? { ...this.titleDraft } : undefined;
  }

  releaseEditor(id: string): void {
    if (this.activeEditorId === id) {
      this.activeEditorId = undefined;
      if (this.titleDraft?.ownerId === id) this.titleDraft = undefined;
    }
  }

  /** Clear stale draft ownership even if a participant omits its own cleanup. */
  private commitEditorOwner(ownerId: string): void {
    this.participants.get(ownerId)?.commitActiveDraft();
    if (this.activeEditorId === ownerId) this.activeEditorId = undefined;
    if (this.titleDraft?.ownerId === ownerId) this.titleDraft = undefined;
  }

  /** De-duplicate the same TextFileView reload delivered to several leaves. */
  claimExternalSource(source: string): boolean {
    if (this.externalSourceInFlight === source) return false;
    this.externalSourceInFlight = source;
    return true;
  }

  releaseExternalSource(source: string): void {
    if (this.externalSourceInFlight === source) this.externalSourceInFlight = undefined;
  }

  beginWrite(source: string): void {
    this.pendingWriteSource = source;
  }

  endWrite(source: string): void {
    if (this.pendingWriteSource === source) this.pendingWriteSource = undefined;
  }

  isPendingWrite(source: string): boolean {
    return this.pendingWriteSource === source;
  }

  get hasConflict(): boolean { return this.conflictOwnerId !== undefined; }

  claimConflict(ownerId: string, state: SharedSaveConflictState): boolean {
    if (this.conflictOwnerId && this.conflictOwnerId !== ownerId) return false;
    this.conflictOwnerId = ownerId;
    this.conflictState = state;
    this.notify("status", ownerId);
    return true;
  }

  updateConflict(ownerId: string, state: SharedSaveConflictState): void {
    if (this.conflictOwnerId !== ownerId) return;
    this.conflictState = state;
  }

  clearConflict(ownerId: string): void {
    if (this.conflictOwnerId !== ownerId) return;
    this.conflictOwnerId = undefined;
    this.conflictState = undefined;
    this.notify("status", ownerId);
  }

  async refreshConflictRecovery(): Promise<void> {
    if (!this.conflictOwnerId) return;
    await this.participants.get(this.conflictOwnerId)?.refreshConflictRecovery();
  }

  /** Serialize root-file rename/identity side effects for every attached leaf. */
  async runFileOperation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.fileOperationTail.catch(() => undefined).then(task);
    this.fileOperationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * A logical baseline transition creates at most one Recovery even when all
   * open leaves observe the same external filesystem event.
   */
  recoveryForTransition(key: string, create: () => Promise<string>): Promise<string> {
    const existing = this.recoveryOperations.get(key);
    if (existing) return existing;
    const operation = this.recoveryTail.catch(() => undefined).then(create);
    this.recoveryTail = operation.then(() => undefined, () => undefined);
    this.recoveryOperations.set(key, operation);
    void operation.then(
      () => { if (this.recoveryOperations.get(key) === operation) this.recoveryOperations.delete(key); },
      () => { if (this.recoveryOperations.get(key) === operation) this.recoveryOperations.delete(key); }
    );
    return operation;
  }

  private notify(reason: SharedSessionChangeReason, originId?: string): void {
    const snapshot: SharedSessionSnapshot = {
      document: this._document,
      source: this._source,
      initialized: this._initialized,
      dirty: this.history.dirty || this.titleDraft !== undefined,
      parseError: this._parseError,
      hasConflict: this.hasConflict,
      reason,
      originId
    };
    for (const [id, participant] of this.participants) {
      if (id !== originId) participant.onSessionChange(snapshot);
    }
  }
}

/** Owns shared sessions for one loaded plugin/vault process. */
export class MindTreeSessionRegistry {
  private sessions = new Map<string, SharedMindTreeSession>();

  acquire(path: string): SharedMindTreeSession {
    const normalized = normalizeSessionPath(path);
    let session = this.sessions.get(normalized);
    if (!session) {
      session = new SharedMindTreeSession(normalized);
      this.sessions.set(normalized, session);
    }
    return session;
  }

  release(path: string, participantId: string): void {
    const normalized = normalizeSessionPath(path);
    const session = this.sessions.get(normalized);
    if (!session) return;
    session.detach(participantId);
    if (session.participantCount === 0) this.sessions.delete(normalized);
  }

  releaseSession(session: SharedMindTreeSession, participantId: string): void {
    session.detach(participantId);
    if (session.participantCount > 0) return;
    for (const [path, candidate] of this.sessions) {
      if (candidate === session) this.sessions.delete(path);
    }
  }

  rename(oldPath: string, newPath: string): void {
    const oldNormalized = normalizeSessionPath(oldPath);
    const newNormalized = normalizeSessionPath(newPath);
    const session = this.sessions.get(oldNormalized);
    if (!session || oldNormalized === newNormalized) return;
    const collision = this.sessions.get(newNormalized);
    if (collision && collision !== session) {
      // Never merge two independently loaded histories. The destination entry
      // is retained and the renamed session remains reachable by its members;
      // a subsequent load will resolve the disk conflict normally.
      session.rename(newNormalized);
      this.sessions.delete(oldNormalized);
      return;
    }
    this.sessions.delete(oldNormalized);
    session.rename(newNormalized);
    this.sessions.set(newNormalized, session);
  }

  get(path: string): SharedMindTreeSession | undefined {
    return this.sessions.get(normalizeSessionPath(path));
  }
}

/** Keep this coordination primitive usable in tests without Obsidian runtime. */
function normalizeSessionPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
