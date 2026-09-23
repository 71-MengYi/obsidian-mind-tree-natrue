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
  draft?: PendingTitleDraft;
  receipt?: { choice: "current" | "external"; source: string; phase: "prepared" | "verified" };
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
  if (record.draft && (typeof record.draft.nodeId !== "string" || !current.document.nodes[record.draft.nodeId]
    || typeof record.draft.value !== "string" || typeof record.draft.originalTitle !== "string")) {
    throw new Error("Invalid pending title draft.");
  }
  if (record.receipt) {
    if (!["current", "external"].includes(record.receipt.choice) || !["prepared", "verified"].includes(record.receipt.phase)
      || typeof record.receipt.source !== "string") throw new Error("Invalid pending commit receipt.");
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
    return records;
  }

  load(path: string): Promise<PendingConflictRecord | undefined> {
    return this.serial(async () => {
      const matches = (await this.records()).filter((record) => record.path === canonicalTreePath(path));
      if (matches.length > 1) throw new Error("Multiple unresolved records refer to this file; none were discarded.");
      return matches[0];
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

  remove(record: PendingConflictRecord): Promise<void> {
    return this.serial(async () => {
      const path = `${this.directory}/${record.id}.json`;
      if (!await this.io.exists(path)) return;
      const stored = validatePendingConflict(JSON.parse(await this.io.read(path)), this.options());
      if (stored.path !== record.path || JSON.stringify(stored.receipt) !== JSON.stringify(record.receipt)
        || stored.currentSource !== record.currentSource) throw new Error("Pending conflict changed before cleanup.");
      await this.io.remove(path);
      if (await this.io.exists(path)) throw new Error("Pending conflict cleanup failed.");
    });
  }
}
