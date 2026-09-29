import type { MindTreeDocument } from "../types";
import type { VersionConflictCoordinator, VersionChoiceResult } from "./version-conflict-coordinator";
import { DocumentSession } from "./document-session";
import type { TreeSettingKey } from "../document-settings-state";
import { TREE_SETTING_KEYS } from "../document-settings-state";

export type SharedSessionChangeReason =
  | "document"
  | "history"
  | "system"
  | "source"
  | "identity"
  | "metadata"
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
  private pendingWriteSource?: string;
  conflict?: VersionConflictCoordinator;
  restoring = false;
  restoreError?: string;
  restoreTask?: Promise<void>;
  pendingRestoreChecked = false;
  private resolvedDraft?: VersionChoiceResult["draft"];
  private resumedDraft?: VersionChoiceResult["resumeDraft"];
  private resolvedTitleRenames?: VersionChoiceResult["titleRenames"];
  private fileOperationTail: Promise<void> = Promise.resolve();

  private _path: string;

  constructor(path: string) {
    this._path = normalizeSessionPath(path);
    this.history.isMutationBlocked = () => this.mutationLocked;
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
    this.participants.delete(id);
    if (this.activeEditorId === id) {
      this.activeEditorId = undefined;
      this.titleDraft = undefined;
    }
    this.notify("status", id);
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
    if (this.mutationLocked && reason !== "source") return;
    this._document = document;
    this.notify(reason, originId);
  }

  replaceSource(source: string, originId: string): void {
    this._source = source;
    this.notify("source", originId);
  }

  /** YAML updates are not commands and must not commit an active textarea. */
  acceptMetadata(document: MindTreeDocument, source: string, keys: readonly TreeSettingKey[]): void {
    this._document = document;
    this._source = source;
    this.history.rebaseSettings(document, keys);
    this.history.replaceBaseline(source);
    this.notify("metadata");
  }

  notifyStatus(originId?: string): void {
    this.notify("status", originId);
  }

  /** Only one textarea draft may be authoritative for a shared file. */
  claimEditor(id: string): void {
    if (this.mutationLocked) return;
    if (this.activeEditorId && this.activeEditorId !== id) {
      this.commitEditorOwner(this.activeEditorId);
    }
    this.activeEditorId = id;
  }

  commitEditorBeforeMutation(originId: string): void {
    if (this.mutationLocked) return;
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
    if (this.mutationLocked || this.activeEditorId !== ownerId) return;
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

  get hasConflict(): boolean { return this.conflict?.active === true; }
  get mutationLocked(): boolean { return this.restoring || Boolean(this.restoreError) || this.hasConflict; }

  /** Publish conflict state even to the view that detected it; no focus transfer. */
  notifyConflict(): void { this.notify("status"); }

  /** Restart restoration replaces a disk-loaded cache, never an active edit. */
  restoreFrozenVersion(document: MindTreeDocument, baseline: string): void {
    this._document = document;
    this._source = baseline;
    this._parseError = undefined;
    this._initialized = true;
    this.history.load(baseline);
    this.history.markChanged();
    this.notify("source");
  }

  acceptVersion(result: VersionChoiceResult): void {
    const previous = this._document;
    if (result.choice === "external") this.history.load(result.source);
    else if (previous && result.draft
      && previous.nodes[result.draft.nodeId]?.title !== result.document.nodes[result.draft.nodeId]?.title) {
      // Add the confirmed draft to the existing linear history exactly once.
      this.history.retainConfirmedSnapshot(previous);
      this.history.markChanged();
    }
    this._document = result.document;
    this._source = result.source;
    this._parseError = undefined;
    this._initialized = true;
    this.history.markSaved(this.history.currentRevision, result.source);
    if (result.document.documentId) this.history.adoptDocumentIdentity(result.document.documentId);
    this.history.rebaseSettings(result.document, TREE_SETTING_KEYS);
    this.titleDraft = undefined;
    this.activeEditorId = undefined;
    this.resolvedDraft = result.draft;
    this.resumedDraft = result.resumeDraft;
    this.resolvedTitleRenames = result.titleRenames;
    this.notify("source");
  }

  takeResolvedDraft(): VersionChoiceResult["draft"] {
    const draft = this.resolvedDraft;
    this.resolvedDraft = undefined;
    return draft;
  }

  takeResumedDraft(): VersionChoiceResult["resumeDraft"] {
    const draft = this.resumedDraft;
    this.resumedDraft = undefined;
    return draft;
  }

  /** One winner owns deferred renames; the latest raw draft wins per node. */
  takeResolvedTitleRenames(): NonNullable<VersionChoiceResult["titleRenames"]> {
    const jobs = new Map((this.resolvedTitleRenames ?? []).map((job) => [job.nodeId, job]));
    const draft = this.takeResolvedDraft();
    if (draft) jobs.set(draft.nodeId, draft);
    this.resolvedTitleRenames = undefined;
    return [...jobs.values()];
  }

  /** Serialize root-file rename/identity side effects for every attached leaf. */
  async runFileOperation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.fileOperationTail.catch(() => undefined).then(task);
    this.fileOperationTail = operation.then(() => undefined, () => undefined);
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
    if (session.participantCount === 0 && !session.mutationLocked) this.sessions.delete(normalized);
  }

  releaseSession(session: SharedMindTreeSession, participantId: string): void {
    session.detach(participantId);
    if (session.participantCount > 0 || session.mutationLocked) return;
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
