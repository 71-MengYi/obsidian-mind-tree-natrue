import { createManagedMindTreeSnapshot } from "./document-conflict";
import type { ParseMindTreeOptions } from "../format/document";

export interface PendingTitleDraft {
  nodeId: string;
  originalTitle: string;
  value: string;
}

/** Internal journal, deliberately separate from both vault documents and data.json. */
export interface PendingConflictRecord {
  version: 1;
  id: string;
  path: string;
  baselineSource: string;
  currentSource: string;
  /** Confirmed state before the preview overlaid an uncommitted textarea. */
  confirmedSource?: string;
  draft?: PendingTitleDraft;
  /** Already confirmed titles whose filesystem rename was paused by conflict. */
  titleRenames?: PendingTitleDraft[];
  receipt?: { choice: "current" | "external"; source: string; phase: "prepared" | "verified"; resumeDraft?: boolean };
}

/** A loaded record together with the identity needed to relocate or drop it. */
export interface PendingConflictEntry {
  readonly id: string;
  readonly path: string;
  readonly record: PendingConflictRecord;
}

export type PendingConflictResolution =
  | { kind: "live" }
  | { kind: "rebind"; path: string }
  | { kind: "stale-path" }
  | { kind: "retain" };

/**
 * Decide what an unresolved journal record still refers to, from evidence only.
 * A missing path never authorizes guessing: rebinding needs exactly one live file
 * once the recorded file is gone, and a path proves reuse only when the live file
 * already carries a different established identity. `live` means the record
 * anchors a real disk location and the session may stop blocking; `retain` is
 * reserved for cases that still need a person to decide.
 */
export function resolvePendingConflict(input: {
  /** Identity frozen in the record's baseline. */
  readonly recordDocumentId?: string;
  /** Identity currently stored in the file at the recorded path. */
  readonly recordedPathDocumentId?: string;
  /** Whether the recorded path currently holds a mind-tree file. */
  readonly recordedPathExists: boolean;
  /** Live paths whose indexed identity equals the recorded identity. */
  readonly identityPaths: readonly string[];
  readonly recordPath: string;
}): PendingConflictResolution {
  const { recordDocumentId, recordedPathDocumentId, recordedPathExists, identityPaths, recordPath } = input;
  if (recordedPathExists) {
    // An unreadable identity is not proof of a different document.
    if (!recordDocumentId || !recordedPathDocumentId || recordedPathDocumentId === recordDocumentId) return { kind: "live" };
    return { kind: "stale-path" };
  }
  // The recorded file is gone. Adopt the path only if exactly one live file
  // carries the recorded identity; otherwise the record must wait for a person.
  const candidates = identityPaths.filter((path) => path !== recordPath);
  if (!recordDocumentId) return candidates.length ? { kind: "retain" } : { kind: "live" };
  return candidates.length === 1 ? { kind: "rebind", path: candidates[0]! } : { kind: "retain" };
}

export interface PendingConflictIO {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  process(path: string, fn: (data: string) => string): Promise<unknown>;
  remove(path: string): Promise<void>;
}

export function canonicalTreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}

/** No path guessing: an orphaned/invalid record is retained and reported. */
export function validatePendingConflict(value: unknown, options: ParseMindTreeOptions = {}): PendingConflictRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid pending conflict record.");
  const record = value as PendingConflictRecord;
  if (record.version !== 1 || !safeId(record.id) || typeof record.path !== "string"
    || record.path !== canonicalTreePath(record.path) || record.path.split("/").some((part) => !part || part === ".." || part === ".")
    || !record.path.toLowerCase().endsWith(".mtn.md")
    || typeof record.baselineSource !== "string" || typeof record.currentSource !== "string") {
    throw new Error("Invalid pending conflict locator.");
  }
  createManagedMindTreeSnapshot(record.baselineSource, options);
  const current = createManagedMindTreeSnapshot(record.currentSource, options);
  if (record.confirmedSource !== undefined) {
    if (typeof record.confirmedSource !== "string") throw new Error("Invalid confirmed source.");
    createManagedMindTreeSnapshot(record.confirmedSource, options);
  }
  if (record.draft && (typeof record.draft.nodeId !== "string" || !current.document.nodes[record.draft.nodeId]
    || typeof record.draft.value !== "string" || typeof record.draft.originalTitle !== "string")) {
    throw new Error("Invalid pending title draft.");
  }
  if (record.titleRenames !== undefined && (!Array.isArray(record.titleRenames)
    || record.titleRenames.length > Object.keys(current.document.nodes).length
    || record.titleRenames.some((rename) => !rename || typeof rename.nodeId !== "string"
      || !current.document.nodes[rename.nodeId] || typeof rename.value !== "string" || typeof rename.originalTitle !== "string"))) {
    throw new Error("Invalid pending title renames.");
  }
  if (record.receipt) {
    if (!["current", "external"].includes(record.receipt.choice) || !["prepared", "verified"].includes(record.receipt.phase)
      || typeof record.receipt.source !== "string"
      || (record.receipt.resumeDraft !== undefined && typeof record.receipt.resumeDraft !== "boolean")) throw new Error("Invalid pending commit receipt.");
    createManagedMindTreeSnapshot(record.receipt.source, options);
  }
  return record;
}

/** All journal operations are serialized, verified, and restricted to this client. */
export class PendingConflictStore {
  private tail: Promise<unknown> = Promise.resolve();
  readonly directory: string;

  constructor(private readonly io: PendingConflictIO, pluginDirectory: string, clientId: string,
    private readonly options: () => ParseMindTreeOptions = () => ({})) {
    if (!safeId(clientId)) throw new Error("Invalid local conflict client ID.");
    this.directory = `${canonicalTreePath(pluginDirectory)}/pending-conflicts/${clientId}`;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(task);
    this.tail = next;
    return next;
  }

  private async records(): Promise<PendingConflictRecord[]> {
    if (!await this.io.exists(this.directory)) return [];
    const entries = await this.io.list(this.directory);
    const records: PendingConflictRecord[] = [];
    for (const path of entries.files) {
      if (!path.endsWith(".json")) continue;
      if (canonicalTreePath(path).split("/").slice(0, -1).join("/") !== this.directory) throw new Error("Invalid journal path.");
      const record = validatePendingConflict(JSON.parse(await this.io.read(path)), this.options());
      if (path !== `${this.directory}/${record.id}.json`) throw new Error("Pending conflict filename mismatch.");
      records.push(record);
    }
    // Two records on one path must never be reduced to one by ordering.
    const byPath = new Map<string, string>();
    for (const record of records) {
      const seen = byPath.get(record.path);
      if (seen !== undefined && seen !== record.id) throw new Error("Multiple unresolved records refer to this file; none were discarded.");
      byPath.set(record.path, record.id);
    }
    return records;
  }

  load(path: string): Promise<PendingConflictRecord | undefined> {
    return this.serial(async () => {
      const matches = (await this.records()).filter((record) => record.path === canonicalTreePath(path));
      if (matches.length > 1) throw new Error("Multiple unresolved records refer to this file; none were discarded.");
      return matches[0];
    });
  }

  /** Startup diagnostics report orphans; they never infer a replacement path. */
  pendingPaths(): Promise<string[]> {
    return this.serial(async () => (await this.records()).map((record) => record.path));
  }

  /** Relocation cleanup needs the record id, not only the locator. */
  pendingRecords(): Promise<PendingConflictEntry[]> {
    return this.serial(async () => (await this.records()).map((record) => ({ id: record.id, path: record.path, record })));
  }

  /**
   * Re-point one record at a moved file. The journal file is keyed by record id,
   * so relocation rewrites that one file in place: the previous locator can never
   * survive as a second record, and a failed rewrite leaves the original path.
   */
  rekey(entry: PendingConflictEntry, nextPath: string): Promise<void> {
    const target = canonicalTreePath(nextPath);
    const next: PendingConflictRecord = { ...entry.record, path: target };
    validatePendingConflict(next, this.options());
    const text = JSON.stringify(next);
    return this.serial(async () => {
      const from = `${this.directory}/${entry.id}.json`;
      if (!await this.io.exists(from)) return;
      const stored = validatePendingConflict(JSON.parse(await this.io.read(from)), this.options());
      if (stored.path !== entry.path || stored.currentSource !== entry.record.currentSource) {
        throw new Error("Pending conflict changed before relocation.");
      }
      await this.io.process(from, () => text);
      if (await this.io.read(from) !== text) throw new Error("Pending conflict relocation failed.");
    });
  }

  put(record: PendingConflictRecord): Promise<void> {
    // Capture immutable serialized bytes before queuing: callers cannot change
    // the meaning of an in-flight write by modifying the record afterwards.
    validatePendingConflict(record, this.options());
    const text = JSON.stringify(record);
    return this.serial(async () => {
      const parts = this.directory.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join("/");
        if (!await this.io.exists(path)) await this.io.mkdir(path);
      }
      const path = `${this.directory}/${record.id}.json`;
      if (await this.io.exists(path)) await this.io.process(path, () => text);
      else await this.io.write(path, text);
      if (await this.io.read(path) !== text) throw new Error("Pending conflict write verification failed.");
    });
  }

  /** Moves are handled by `rekey`; cleanup only proves the record is unchanged. */
  remove(entry: PendingConflictEntry): Promise<void> {
    const { record } = entry;
    return this.serial(async () => {
      const path = `${this.directory}/${record.id}.json`;
      if (!await this.io.exists(path)) return;
      const stored = validatePendingConflict(JSON.parse(await this.io.read(path)), this.options());
      if (stored.path !== record.path || stored.path !== entry.path
        || JSON.stringify(stored.receipt) !== JSON.stringify(record.receipt)
        || stored.currentSource !== record.currentSource) throw new Error("Pending conflict changed before cleanup.");
      await this.io.remove(path);
      if (await this.io.exists(path)) throw new Error("Pending conflict cleanup failed.");
    });
  }
}
