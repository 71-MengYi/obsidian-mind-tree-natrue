import { parse as parseYaml } from "yaml";
import { classifyFileSubtype } from "../domain/markers";
import { classifyFile, extractNonMarkdownResourceId, isMarkdownPath } from "../format/resource-id";
import type { FileResourceRef } from "../types";
import type { IndexedResource } from "./local-resource-cache";

export interface ResourceFile {
  path: string;
  stat: { mtime: number; size: number; ctime: number };
}
export interface ResourceIndexProgress { completed: number; total: number }
export interface ResourceIndexReport {
  indexedFiles: number;
  conflicts: Array<{ resourceId: string; paths: string[] }>;
  failures: Array<{ path: string; message: string }>;
  persisted?: boolean;
}
interface Observation<F> {
  file: F;
  stamp: string;
  revision: number;
  readSequence: number;
  entry?: IndexedResource;
}

/** A transient read race, not evidence that an ID belongs to another file. */
export class ResourceVerificationChangedError extends Error {
  constructor(readonly path: string, readonly exhausted = false) {
    super("File changed during identity verification");
    this.name = "ResourceVerificationChangedError";
  }
}

interface IdentityRead<F> {
  file: F;
  recheck: boolean;
  promise: Promise<Observation<F>>;
}

/** Parse only the identity header; rebuilding never inflates a tree's payload. */
export function readResourceIdentity(path: string, source = ""): IndexedResource | undefined {
  let resourceId: unknown;
  let fileSubtype: FileResourceRef["fileSubtype"];
  if (!isMarkdownPath(path)) resourceId = extractNonMarkdownResourceId(path);
  else {
    const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (/^\uFEFF?---\r?\n/.test(source) && !header) throw new Error("Unclosed Frontmatter");
    const value: unknown = header ? parseYaml(header[1]!, { maxAliasCount: 100 }) : undefined;
    if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
      throw new Error("Invalid Frontmatter");
    }
    const frontmatter = value as Record<string, unknown> | undefined;
    const nested = frontmatter?.["mind-tree-nature"];
    const metadata = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown> : undefined;
    resourceId = path.toLowerCase().endsWith(".mtn.md")
      ? frontmatter?.["documentId"] ?? metadata?.["documentId"] : metadata?.["resourceId"];
    fileSubtype = classifyFileSubtype(frontmatter);
  }
  if (resourceId === undefined || resourceId === null || resourceId === "") return undefined;
  if (typeof resourceId !== "string" || resourceId.length > 512 || !resourceId.trim()) {
    throw new Error("Invalid resource identity");
  }
  return { resourceId, path, fileKind: classifyFile(path), ...(fileSubtype ? { fileSubtype } : {}) };
}

/**
 * Verified, disposable index. Disk/localStorage entries are only scan-order hints.
 * Every authoritative observation comes from current file bytes (or a binary
 * file's current name). Failed/changed observations never resolve a reference.
 */
export class ResourceCatalog<F extends ResourceFile> {
  private observations = new Map<string, Observation<F>>();
  private byId = new Map<string, Set<string>>();
  private revisions = new Map<string, number>();
  private epoch = 0;
  private complete = false;
  private coverageKnown = false;
  private readonly unverifiedPaths = new Set<string>();
  private readonly reads = new Map<string, IdentityRead<F>>();
  private readonly refreshes = new Map<string, number>();
  private readSequence = 0;
  private disposed = false;
  private scan?: Promise<ResourceIndexReport>;
  private scanForced = false;
  private readonly progressListeners = new Set<(value: ResourceIndexProgress) => void>();
  private fingerprint = "";

  constructor(private readonly ports: {
    files(): F[];
    file(path: string): F | undefined;
    read(file: F): Promise<string>;
    changed(entries: IndexedResource[]): void;
    yield(): Promise<void>;
  }, private readonly hints: readonly IndexedResource[] = []) {}

  private stamp(file: F): string { return `${file.path}:${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`; }
  private revision(path: string): number { return this.revisions.get(path) ?? 0; }
  private valid(path: string, observation: Observation<F> | undefined): observation is Observation<F> {
    return Boolean(observation && this.ports.file(path) === observation.file
      && observation.stamp === this.stamp(observation.file) && observation.revision === this.revision(path)
      && observation.readSequence >= (this.observations.get(path)?.readSequence ?? 0));
  }

  private sameObservation(left: Observation<F> | undefined, right: Observation<F>): boolean {
    return Boolean(left && left.file === right.file && left.stamp === right.stamp && left.revision === right.revision
      && left.entry?.resourceId === right.entry?.resourceId && left.entry?.fileKind === right.entry?.fileKind
      && left.entry?.fileSubtype === right.entry?.fileSubtype && left.entry?.path === right.entry?.path);
  }

  invalidate(path: string): void {
    this.epoch++;
    this.revisions.set(path, this.revision(path) + 1);
    if (this.ports.file(path)) this.unverifiedPaths.add(path);
    else this.unverifiedPaths.delete(path);
    this.complete = this.coverageKnown && this.unverifiedPaths.size === 0;
    this.removeObservation(path);
  }

  private async observe(file: F): Promise<Observation<F>> {
    if (this.disposed) throw new Error("Resource index closed");
    const path = file.path;
    const stamp = this.stamp(file);
    const revision = this.revision(path);
    const readSequence = ++this.readSequence;
    const entry = readResourceIdentity(path, isMarkdownPath(path) ? await this.ports.read(file) : "");
    const observation = { file, stamp, revision, readSequence, entry };
    if (this.disposed) throw new Error("Resource index closed");
    if (!this.valid(path, observation)) throw new ResourceVerificationChangedError(path);
    return observation;
  }

  /**
   * Foreground association, scans and host events share the same actual read.
   * A metadata notification requests a trailing read without inventing a file
   * revision. Real writes invalidate the revision and retry only the read, never
   * the caller's create/rename/identity side effects.
   */
  private readCurrent(file: F, recheck = false): Promise<Observation<F>> {
    const path = file.path;
    const pending = this.reads.get(path);
    if (pending) {
      if (pending.file !== file) {
        return pending.promise.catch(() => undefined).then(() => this.readCurrent(file, recheck));
      }
      if (recheck) pending.recheck = true;
      return pending.promise;
    }
    const task: IdentityRead<F> = { file, recheck: false, promise: undefined! };
    // Defer the first read until the task is registered: host mocks and real
    // plugins can synchronously deliver an event as the read starts.
    task.promise = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        task.recheck = false;
        if (file.path !== path || this.ports.file(path) !== file) throw new ResourceVerificationChangedError(path);
        try {
          const observation = await this.observe(file);
          if (!task.recheck) return observation;
        } catch (error) {
          if (!(error instanceof ResourceVerificationChangedError)) throw error;
        }
      }
      throw new ResourceVerificationChangedError(path, true);
    }).finally(() => { if (this.reads.get(path) === task) this.reads.delete(path); });
    this.reads.set(path, task);
    return task.promise;
  }

  async refresh(file: F, recheck = false): Promise<IndexedResource | undefined> {
    const path = file.path;
    const revision = this.revision(path);
    const before = this.observations.get(path);
    this.refreshes.set(path, (this.refreshes.get(path) ?? 0) + 1);
    try {
      const observation = await this.readCurrent(file, recheck);
      if (!this.valid(path, observation)) throw new ResourceVerificationChangedError(path);
      // A direct read can discover sync bytes before the host emits modify.
      // Invalidate outstanding uniqueness guards even if stat values lag.
      if (!this.sameObservation(this.observations.get(path), observation)) this.epoch++;
      this.removeObservation(path);
      this.observations.set(path, observation);
      this.unverifiedPaths.delete(path);
      this.complete = this.coverageKnown && this.unverifiedPaths.size === 0;
      if (observation.entry) {
        const paths = this.byId.get(observation.entry.resourceId) ?? new Set<string>();
        paths.add(path);
        this.byId.set(observation.entry.resourceId, paths);
      }
      this.emit();
      return observation.entry;
    } catch (error) {
      this.complete = false;
      // Do not let an older failed read delete a newer successful observation.
      if (revision === this.revision(path) && this.observations.get(path) === before) {
        this.removeObservation(path);
        if (this.ports.file(path)) this.unverifiedPaths.add(path);
      }
      throw error;
    } finally {
      const remaining = (this.refreshes.get(path) ?? 1) - 1;
      if (remaining) this.refreshes.set(path, remaining);
      else this.refreshes.delete(path);
    }
  }

  rebuild(force = true, progress?: (value: ResourceIndexProgress) => void): Promise<ResourceIndexReport> {
    if (progress) this.progressListeners.add(progress);
    if (this.scan) {
      // An explicit rebuild must not silently turn into a cached verification.
      if (force && !this.scanForced) return this.scan.then(() => this.rebuild(true, progress))
        .finally(() => { if (progress) this.progressListeners.delete(progress); });
      return this.scan.finally(() => { if (progress) this.progressListeners.delete(progress); });
    }
    if (!force && this.isFullyVerified()) {
      if (progress) this.progressListeners.delete(progress);
      return Promise.resolve({ indexedFiles: this.entries().length, conflicts: this.conflicts(), failures: [] });
    }
    this.scanForced = force;
    const operation = this.scanFiles(force);
    this.scan = operation;
    return operation.finally(() => {
      if (this.scan === operation) this.scan = undefined;
      if (progress) this.progressListeners.delete(progress);
    });
  }

  private async scanFiles(force: boolean): Promise<ResourceIndexReport> {
    let next = new Map<string, Observation<F>>();
    const failures = new Map<string, string>();
    const exhaustedReads = new Set<string>();
    const priority = new Set(this.hints.map((entry) => entry.path));
    // Retry changed paths, not the entire vault; never publish a mixed-time map.
    for (let pass = 0; pass < 3; pass++) {
      if (this.disposed) throw new Error("Resource index closed");
      const epoch = this.epoch;
      const files = this.ports.files().sort((a, b) => Number(priority.has(b.path)) - Number(priority.has(a.path)));
      const paths = new Set(files.map((file) => file.path));
      next = new Map([...next].filter(([path]) => paths.has(path)));
      for (const path of failures.keys()) if (!paths.has(path)) failures.delete(path);
      let completed = 0;
      let readsSinceYield = 0;
      for (const file of files) {
        if (this.disposed) throw new Error("Resource index closed");
        const path = file.path;
        const previous = next.get(path) ?? (!force ? this.observations.get(path) : undefined);
        if (!this.valid(path, previous) || this.reads.has(path) || this.refreshes.has(path)) {
          if (exhaustedReads.has(path)) { completed++; continue; }
          try { next.set(path, await this.readCurrent(file)); failures.delete(path); }
          catch (error) {
            next.delete(path); failures.set(path, String(error));
            // Retrying the inventory must not multiply a path's three-read
            // budget. A later explicit operation/event can try again.
            if (error instanceof ResourceVerificationChangedError && error.exhausted) exhaustedReads.add(path);
          }
          // Cached entries do not perform I/O and must not incur a timer per
          // 32 files. That made each association wait through the whole vault.
          if (++readsSinceYield === 32) { await this.ports.yield(); readsSinceYield = 0; }
        } else next.set(path, previous);
        completed++;
        for (const listener of this.progressListeners) listener({ completed, total: files.length });
      }
      const live = this.ports.files();
      const stable = epoch === this.epoch && this.reads.size === 0 && this.refreshes.size === 0 && live.length === paths.size
        && live.every((file) => paths.has(file.path)
          && (failures.has(file.path) || this.valid(file.path, next.get(file.path))));
      if (this.disposed) throw new Error("Resource index closed");
      if (!stable) continue;
      if (next.size !== this.observations.size
        || [...next].some(([path, observation]) => !this.sameObservation(this.observations.get(path), observation))) this.epoch++;
      this.observations = next;
      this.coverageKnown = true;
      this.unverifiedPaths.clear();
      for (const path of failures.keys()) this.unverifiedPaths.add(path);
      this.complete = failures.size === 0;
      this.reindex();
      this.emit();
      return { indexedFiles: this.entries().length, conflicts: this.conflicts(),
        failures: [...failures].map(([path, message]) => ({ path, message })) };
    }
    throw new ResourceVerificationChangedError("");
  }

  entries(): IndexedResource[] {
    return [...this.observations].flatMap(([path, observation]) =>
      this.valid(path, observation) && observation.entry ? [{ ...observation.entry }] : []);
  }

  entry(file: F): IndexedResource | undefined {
    const observation = this.observations.get(file.path);
    return this.valid(file.path, observation) ? observation.entry : undefined;
  }

  paths(resourceId: string): string[] {
    return [...(this.byId.get(resourceId) ?? [])]
      .filter((path) => this.valid(path, this.observations.get(path))).sort();
  }

  conflicts(): ResourceIndexReport["conflicts"] {
    return [...this.byId.keys()].flatMap((resourceId) => {
      const paths = this.paths(resourceId);
      return paths.length > 1 ? [{ resourceId, paths }] : [];
    });
  }

  resolve(reference: FileResourceRef): F | undefined {
    const hinted = this.ports.file(reference.pathHint);
    if (hinted && this.entry(hinted)?.resourceId === reference.resourceId) return hinted;
    // Unknown files might contain another copy of the same ID.
    if (!this.complete || this.reads.size || this.refreshes.size) return undefined;
    const paths = this.paths(reference.resourceId);
    return paths.length === 1 ? this.ports.file(paths[0]!) : undefined;
  }

  async resolveVerified(reference: FileResourceRef): Promise<F | undefined> {
    const hinted = this.ports.file(reference.pathHint);
    if (hinted) {
      try { if ((await this.refresh(hinted))?.resourceId === reference.resourceId) return hinted; }
      catch { /* Never use an old hint after a failed verification. */ }
    }
    await this.rebuild(false);
    const file = this.resolve(reference);
    if (!file) return undefined;
    // Re-read the selected file immediately before handing it to an operation.
    return (await this.refresh(file))?.resourceId === reference.resourceId ? file : undefined;
  }

  has(resourceId: string): boolean { return this.byId.has(resourceId); }

  get generation(): number { return this.epoch; }

  /** Mutations cannot proceed while newly arrived/modified files are unverified. */
  isFullyVerified(): boolean {
    return this.complete && this.reads.size === 0 && this.refreshes.size === 0
      && this.ports.files().every((file) => this.valid(file.path, this.observations.get(file.path)));
  }

  private removeObservation(path: string): void {
    const id = this.observations.get(path)?.entry?.resourceId;
    if (id) {
      const paths = this.byId.get(id);
      paths?.delete(path);
      if (!paths?.size) this.byId.delete(id);
    }
    this.observations.delete(path);
  }

  private reindex(): void {
    const ids = new Map<string, Set<string>>();
    for (const [path, observation] of this.observations) {
      if (!observation.entry || !this.valid(path, observation)) continue;
      const paths = ids.get(observation.entry.resourceId) ?? new Set<string>();
      paths.add(path);
      ids.set(observation.entry.resourceId, paths);
    }
    this.byId = ids;
  }

  private emit(): void {
    if (this.disposed) return;
    const entries = this.entries().sort((a, b) => a.path.localeCompare(b.path));
    const fingerprint = JSON.stringify(entries);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.ports.changed(entries);
  }

  destroy(): void { this.disposed = true; this.progressListeners.clear(); }
}
