import type { FileResourceRef } from "../types";

/** Device-local hints only. Neither a path nor a previously seen ID proves ownership. */
export interface IndexedResource {
  resourceId: string;
  path: string;
  fileKind: FileResourceRef["fileKind"];
  fileSubtype?: FileResourceRef["fileSubtype"];
}

export interface LocalStoragePort {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export function normalizeLocalResourceCache(value: unknown): IndexedResource[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as { version?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) return [];
  const paths = new Set<string>();
  const result: IndexedResource[] = [];
  for (const candidate of raw.entries) {
    if (!candidate || typeof candidate !== "object") return [];
    const entry = candidate as IndexedResource;
    if (typeof entry.resourceId !== "string" || !entry.resourceId || entry.resourceId.length > 512
      || typeof entry.path !== "string" || !entry.path || entry.path.length > 4096
      || /[\\\x00]/.test(entry.path) || /^(?:\/|[A-Za-z]:)/.test(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..")
      || paths.has(entry.path) || !["note", "image", "attachment"].includes(entry.fileKind)
      || (entry.fileSubtype !== undefined && entry.fileSubtype !== "excalidraw")) return [];
    paths.add(entry.path);
    result.push({ resourceId: entry.resourceId, path: entry.path, fileKind: entry.fileKind,
      ...(entry.fileSubtype ? { fileSubtype: entry.fileSubtype } : {}) });
  }
  return result;
}

/** localStorage is vault-scoped by App, not a JSON file inside the synced vault. */
export class LocalResourceCache {
  readonly key: string;
  private reportedFailure = false;

  constructor(pluginId: string, private readonly storage: LocalStoragePort,
    private readonly onFailure: (error: unknown) => void) {
    this.key = `${pluginId}:resource-index:v1`;
  }

  load(): IndexedResource[] {
    try { return normalizeLocalResourceCache(this.storage.load(this.key)); }
    catch (error) { this.failed(error); return []; }
  }

  save(entries: readonly IndexedResource[]): boolean {
    try {
      this.storage.save(this.key, { version: 1, entries });
      return true;
    } catch (error) { this.failed(error); return false; }
  }

  private failed(error: unknown): void {
    // Quota/storage failures must never fall back to writing settings or files.
    if (!this.reportedFailure) this.onFailure(error);
    this.reportedFailure = true;
  }
}
