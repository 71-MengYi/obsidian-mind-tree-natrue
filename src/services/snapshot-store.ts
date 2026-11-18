import { parseMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import { isMindTreePath } from "../format/resource-id";
import { MAX_MIND_TREE_NODES, utf8ByteLength } from "../input-limits";
import type { MindTreeDocument } from "../types";
import { canonicalTreePath } from "./pending-conflict-store";
import { SerialTaskQueue } from "./serial-lane";

/**
 * Local version history for one `.mtn.md` tree.
 *
 * Snapshots live in a dot directory at the vault root, not in plugin data and
 * not in the tree file, so they never become part of the synchronized note
 * content. The store is deliberately pure TypeScript over an injected adapter:
 * Obsidian's mobile runtime has no Node `fs`, and every read of a snapshot is
 * untrusted input that must be validated before it reaches the UI.
 */
export const SNAPSHOT_DIRECTORY = ".mind-tree-nature-data/snapshots";
export const MAX_SNAPSHOT_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOTS_PER_TREE = 30;
const SNAPSHOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const SNAPSHOT_FILE_PATTERN = /^(\d{13})-(\d{4})\.json$/;

export interface SnapshotIO {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Console-shaped sink; tests inject one so failures are observable. */
export interface SnapshotLogger {
  error(message: string, detail?: unknown): void;
  warn(message: string): void;
}

export interface SnapshotStoreOptions {
  /** Milliseconds since the epoch; injectable for deterministic filenames. */
  readonly now?: () => number;
  readonly logger?: SnapshotLogger;
}

export interface SnapshotCaptureInput {
  /** Vault-relative POSIX path of the tree the save wrote. */
  readonly path: string;
  readonly documentId?: string;
  readonly title: string;
  readonly nodeCount: number;
  /** The exact source text that reached disk. */
  readonly source: string;
}

export interface TreeSnapshot {
  readonly version: 1;
  readonly capturedAt: string;
  readonly path: string;
  readonly documentId?: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly source: string;
}

/** Metadata shown before a snapshot's full source is loaded. */
export interface TreeSnapshotEntry {
  /** Basename inside the key directory. */
  readonly file: string;
  readonly capturedAt: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly size: number;
  readonly documentId?: string;
}

export interface SnapshotTreeIdentity {
  readonly path: string;
  readonly documentId?: string;
}

export type SnapshotRestoreResult =
  | { readonly ok: true; readonly document: MindTreeDocument }
  | { readonly ok: false; readonly reason: "invalid" | "mismatch" };

const defaultLogger: SnapshotLogger = {
  error: (message, detail) => console.error(message, detail),
  warn: (message) => console.warn(message)
};

/**
 * Two seeded FNV-1a passes provide a stable 64-bit-shaped directory key without
 * BigInt. The key is a fallback only: a safe document id stays readable.
 */
export function snapshotPathHash(path: string): string {
  const input = canonicalTreePath(path);
  const pass = (basis: number): string => {
    let hash = basis >>> 0;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return `${pass(0x811c9dc5)}${pass(0x01000193)}`;
}

/** Document identity wins; a tree without one is keyed by its canonical path. */
export function snapshotKey(path: string, documentId?: string): string {
  return documentId && SNAPSHOT_KEY_PATTERN.test(documentId)
    ? documentId
    : snapshotPathHash(path);
}

function isSafeTreePath(path: string): boolean {
  return path === canonicalTreePath(path)
    && isMindTreePath(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function snapshotDirectory(key: string): string {
  return `${SNAPSHOT_DIRECTORY}/${key}`;
}

function validCapturedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * Validate a parsed snapshot file. Unknown versions, out-of-range sizes and
 * malformed metadata return `undefined`; a corrupt journal entry is skipped,
 * never surfaced as an exception.
 */
export function validateTreeSnapshot(value: unknown): TreeSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || !validCapturedAt(record["capturedAt"])) return undefined;
  const path = record["path"];
  if (typeof path !== "string" || !isSafeTreePath(path)) return undefined;
  const title = record["title"];
  if (typeof title !== "string") return undefined;
  const nodeCount = record["nodeCount"];
  if (typeof nodeCount !== "number" || !Number.isInteger(nodeCount)
    || nodeCount < 0 || nodeCount > MAX_MIND_TREE_NODES) return undefined;
  const source = record["source"];
  if (typeof source !== "string" || source.length === 0) return undefined;
  if (utf8ByteLength(source) > MAX_SNAPSHOT_SOURCE_BYTES) return undefined;
  const documentId = record["documentId"];
  if (documentId !== undefined
    && (typeof documentId !== "string" || !SNAPSHOT_KEY_PATTERN.test(documentId))) return undefined;
  return {
    version: 1,
    capturedAt: new Date(record["capturedAt"]).toISOString(),
    path,
    ...(typeof documentId === "string" ? { documentId } : {}),
    title,
    nodeCount,
    source
  };
}

/**
 * A restored snapshot must describe the tree that is open now. Document
 * identity wins when both sides have it (a rename keeps the same tree); only an
 * identity-less tree falls back to its vault-relative path. A one-sided
 * identity is a mismatch: restoring an identity-less file over an identified
 * tree (or the reverse) would silently change how other trees find this
 * document.
 */
export function snapshotMatchesTree(snapshot: TreeSnapshot, current: SnapshotTreeIdentity): boolean {
  if (snapshot.documentId === undefined && current.documentId === undefined) {
    return snapshot.path === canonicalTreePath(current.path);
  }
  return snapshot.documentId !== undefined && current.documentId !== undefined
    && snapshot.documentId === current.documentId;
}

/** Parse a validated snapshot only after it proves it belongs to this tree. */
export function restoreSnapshotDocument(
  snapshot: TreeSnapshot,
  current: SnapshotTreeIdentity,
  options: Readonly<ParseMindTreeOptions> = {}
): SnapshotRestoreResult {
  if (!snapshotMatchesTree(snapshot, current)) return { ok: false, reason: "mismatch" };
  let document: MindTreeDocument;
  try {
    document = parseMindTreeFile(snapshot.source, options).document;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // The metadata is what the modal and the identity check saw; content that
  // parses to another identity is not the snapshot the user selected.
  if (document.documentId !== snapshot.documentId) return { ok: false, reason: "invalid" };
  return { ok: true, document };
}

/**
 * One serialized queue owns capture, listing and pruning so two simultaneous
 * saves cannot claim the same sequence number or race the retention pass.
 */
export class TreeSnapshotStore {
  private readonly lane = new SerialTaskQueue();
  private readonly now: () => number;
  private readonly log: SnapshotLogger;

  constructor(private readonly io: SnapshotIO, options: SnapshotStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? defaultLogger;
  }

  /**
   * Append one snapshot. Returns true only when a new file was written. Every
   * failure is swallowed after logging: version history is best-effort and must
   * never delay, retry or reinterpret the save that produced the bytes.
   */
  capture(input: SnapshotCaptureInput): Promise<boolean> {
    // Every task catches its own failure, so the lane tail never rejects even
    // though a later capture may still be appended after an I/O error.
    return this.lane.serial(async () => {
      try {
        return await this.captureUnsafe(input);
      } catch (error) {
        this.log.error("Mind Tree Nature: could not capture a version snapshot.", error);
        return false;
      }
    });
  }

  /** Newest first. Damaged or unknown-version files are skipped, not fatal. */
  list(key: string): Promise<TreeSnapshotEntry[]> {
    return this.lane.serial(async () => {
      try {
        return await this.listUnsafe(key);
      } catch (error) {
        this.log.error("Mind Tree Nature: could not read the version history.", error);
        return [];
      }
    });
  }

  /** Full source for one listed entry; `undefined` when it is damaged. */
  load(key: string, entry: TreeSnapshotEntry): Promise<TreeSnapshot | undefined> {
    return this.lane.serial(async () => {
      try {
        return await this.readSnapshot(key, entry.file);
      } catch (error) {
        this.log.error("Mind Tree Nature: could not read a version snapshot.", error);
        return undefined;
      }
    });
  }

  private async captureUnsafe(input: SnapshotCaptureInput): Promise<boolean> {
    const path = canonicalTreePath(input.path);
    if (!isSafeTreePath(path)) return false;
    const documentId = input.documentId && SNAPSHOT_KEY_PATTERN.test(input.documentId)
      ? input.documentId
      : undefined;
    const source = input.source;
    if (utf8ByteLength(source) > MAX_SNAPSHOT_SOURCE_BYTES) {
      // Deliberately no excerpt: a snapshot failure must never put note text
      // into the console.
      this.log.warn(`Mind Tree Nature: skipped a version snapshot larger than ${MAX_SNAPSHOT_SOURCE_BYTES} bytes.`);
      return false;
    }
    const key = snapshotKey(path, documentId);
    const directory = snapshotDirectory(key);
    // Dedupe is an optimization: an unreadable directory must not block a new
    // snapshot, so a listing failure simply means "nothing to compare".
    const files = await this.snapshotFiles(key).catch(() => [] as string[]);
    // The newest *valid* snapshot decides duplication; damaged files after it
    // are not history and must not make an identical save look new.
    for (const file of files) {
      const latest = await this.readSnapshot(key, file);
      if (!latest) continue;
      if (latest.source === source) return false;
      break;
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) throw new Error("Snapshot clock is invalid.");
    const capturedAt = new Date(timestamp).toISOString();
    await this.ensureDirectory(directory);
    const file = await this.nextFileName(directory, timestamp);
    const snapshot: TreeSnapshot = {
      version: 1,
      capturedAt,
      path,
      ...(documentId ? { documentId } : {}),
      title: input.title,
      nodeCount: Number.isInteger(input.nodeCount) && input.nodeCount >= 0
        ? Math.min(input.nodeCount, MAX_MIND_TREE_NODES)
        : 0,
      source
    };
    await this.io.write(`${directory}/${file}`, JSON.stringify(snapshot));
    await this.prune(key);
    return true;
  }

  private async listUnsafe(key: string): Promise<TreeSnapshotEntry[]> {
    if (!SNAPSHOT_KEY_PATTERN.test(key)) return [];
    const files = await this.snapshotFiles(key);
    const entries: TreeSnapshotEntry[] = [];
    for (const file of files) {
      const snapshot = await this.readSnapshot(key, file);
      if (!snapshot) continue;
      entries.push({
        file,
        capturedAt: snapshot.capturedAt,
        title: snapshot.title,
        nodeCount: snapshot.nodeCount,
        size: utf8ByteLength(snapshot.source),
        ...(snapshot.documentId ? { documentId: snapshot.documentId } : {})
      });
    }
    entries.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)
      || right.file.localeCompare(left.file));
    return entries;
  }

  /** Snapshot basenames newest first; the timestamp prefix is `capturedAt` ms. */
  private async snapshotFiles(key: string): Promise<string[]> {
    if (!SNAPSHOT_KEY_PATTERN.test(key)) return [];
    const directory = snapshotDirectory(key);
    if (!await this.io.exists(directory)) return [];
    const listed = await this.io.list(directory);
    const files: string[] = [];
    for (const path of listed.files) {
      const file = this.fileName(directory, path);
      if (file) files.push(file);
    }
    files.sort((left, right) => right.localeCompare(left));
    return files;
  }

  private async readSnapshot(key: string, file: string): Promise<TreeSnapshot | undefined> {
    if (!SNAPSHOT_KEY_PATTERN.test(key) || !SNAPSHOT_FILE_PATTERN.test(file)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.io.read(`${snapshotDirectory(key)}/${file}`));
    } catch (error) {
      this.log.error("Mind Tree Nature: ignored an unreadable version snapshot.", error);
      return undefined;
    }
    const snapshot = validateTreeSnapshot(parsed);
    if (!snapshot) this.log.error("Mind Tree Nature: ignored an invalid version snapshot.");
    return snapshot;
  }

  /**
   * Keep the newest `MAX_SNAPSHOTS_PER_TREE` entries. Filenames are derived from
   * the same clock as `capturedAt`, so ordering by name prunes in exactly the
   * captured-time order without re-reading every snapshot on each save.
   */
  private async prune(key: string): Promise<void> {
    let files: string[];
    try {
      files = await this.snapshotFiles(key);
    } catch {
      // Listing failure is retention failure only; the new snapshot is durable.
      return;
    }
    if (files.length <= MAX_SNAPSHOTS_PER_TREE) return;
    for (const file of files.slice(MAX_SNAPSHOTS_PER_TREE)) {
      try {
        await this.io.remove(`${snapshotDirectory(key)}/${file}`);
      } catch {
        // Retention is opportunistic: a failed delete must not fail the save
        // or hide the snapshots that were written successfully.
      }
    }
  }

  private fileName(directory: string, path: string): string | undefined {
    const normalized = canonicalTreePath(path);
    if (!normalized.startsWith(`${directory}/`)) return undefined;
    const file = normalized.slice(directory.length + 1);
    return SNAPSHOT_FILE_PATTERN.test(file) ? file : undefined;
  }

  private async ensureDirectory(directory: string): Promise<void> {
    const parts = directory.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const path = parts.slice(0, index).join("/");
      if (!await this.io.exists(path)) await this.io.mkdir(path);
    }
  }

  private async nextFileName(directory: string, timestamp: number): Promise<string> {
    const stamp = String(timestamp).padStart(13, "0");
    const listed = await this.io.list(directory);
    let highest = 0;
    for (const path of listed.files) {
      const match = SNAPSHOT_FILE_PATTERN.exec(this.fileName(directory, path) ?? "");
      if (!match || match[1] !== stamp) continue;
      const sequence = Number(match[2]);
      if (Number.isInteger(sequence) && sequence > highest) highest = sequence;
    }
    for (let sequence = highest + 1; ; sequence += 1) {
      const file = `${stamp}-${String(sequence).padStart(4, "0")}.json`;
      if (!await this.io.exists(`${directory}/${file}`)) return file;
    }
  }
}
