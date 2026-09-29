import { readUpdateManifest, sha256, UPDATE_FILES, UPDATE_LIMITS, UpdateError, type UpdateFile, type UpdatePayload } from "./release-client";

/** Minimal public DataAdapter surface, shared by mobile, desktop and fault tests. */
export interface UpdateStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  process(path: string, update: (value: string) => string): Promise<string>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}
export interface UpdateLocalStorage { load(): unknown; save(value: string | null): void }
type Phase = "prepared" | "writing" | "installed" | "committed" | "rolled-back";
interface UpdateJournal {
  schema: 1; task: string; from: string; to: string; phase: Phase;
  hashes: Record<UpdateFile, { before: string; after: string }>;
}
const SAFE_SEGMENT = /^[a-zA-Z0-9-]{1,80}$/;

/**
 * This is a PROGRAM-file journal, not a mind-tree Recovery or settings store.
 * Paths are derived locally from a fixed allowlist; no downloaded filename or
 * journal field can redirect writes outside this plugin's directory.
 */
export class UpdateStore {
  private journal?: UpdateJournal;
  private before?: UpdatePayload;
  private after?: UpdatePayload;
  readonly directory: string;

  constructor(private readonly io: UpdateStorage, private readonly local: UpdateLocalStorage,
    readonly pluginDirectory: string, clientId: string) {
    if (!SAFE_SEGMENT.test(clientId) || !pluginDirectory || /[\\:]|^\//.test(pluginDirectory)
      || pluginDirectory.split("/").some((part) => !part || part === "." || part === "..")) throw new UpdateError("storage");
    this.directory = `${pluginDirectory}/.updates/${clientId}`;
  }

  get backupPath(): string { return this.journal ? `${this.directory}/${this.journal.task}` : this.directory; }
  private file(name: UpdateFile): string { return `${this.pluginDirectory}/${name}`; }
  private saved(name: UpdateFile, side: "before" | "after"): string { return `${this.backupPath}/${side}-${name}`; }

  private async mkdir(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join("/");
      if (!await this.io.exists(current)) await this.io.mkdir(current);
    }
  }

  private async verifiedWrite(path: string, text: string): Promise<void> {
    await this.io.write(path, text);
    if (await this.io.read(path) !== text) throw new UpdateError("storage", path);
  }
  private async phase(phase: Phase): Promise<void> {
    const next = { ...this.journal!, phase };
    await this.verifiedWrite(`${this.backupPath}/transaction.json`, JSON.stringify(next));
    this.journal = next;
  }

  async stage(payload: UpdatePayload, runningVersion: string): Promise<void> {
    if (this.local.load() != null) throw new UpdateError("recovery", this.directory);
    const before = {} as UpdatePayload;
    const hashes = {} as UpdateJournal["hashes"];
    for (const name of UPDATE_FILES) {
      if (!await this.io.exists(this.file(name))) throw new UpdateError("changed", name);
      before[name] = await this.io.read(this.file(name));
      if (new TextEncoder().encode(before[name]).length > UPDATE_LIMITS[name]) throw new UpdateError("asset", name);
      hashes[name] = { before: await sha256(before[name]), after: await sha256(payload[name]) };
    }
    if (readUpdateManifest(before["manifest.json"]).version !== runningVersion) throw new UpdateError("changed", "manifest.json");
    this.journal = { schema: 1, task: crypto.randomUUID(), from: runningVersion,
      to: readUpdateManifest(payload["manifest.json"]).version, hashes, phase: "prepared" };
    this.before = before; this.after = payload;
    await this.mkdir(this.backupPath);
    for (const name of UPDATE_FILES) {
      await this.verifiedWrite(this.saved(name, "before"), before[name]);
      await this.verifiedWrite(this.saved(name, "after"), payload[name]);
    }
    await this.phase("prepared");
    this.local.save(this.journal.task);
    if (this.local.load() !== this.journal.task) throw new UpdateError("storage", this.backupPath);
  }

  async verify(side: "before" | "after"): Promise<void> {
    if (!this.journal) throw new UpdateError("storage");
    for (const name of UPDATE_FILES) {
      if (!await this.io.exists(this.file(name))
        || await sha256(await this.io.read(this.file(name))) !== this.journal.hashes[name][side]) {
        throw new UpdateError("changed", name);
      }
    }
  }

  async install(assertSafe: () => Promise<void>): Promise<void> {
    await this.verify("before");
    await this.phase("writing");
    for (const name of UPDATE_FILES) {
      await assertSafe();
      // Compare against the callback's latest bytes, not an earlier stat/cache.
      await this.io.process(this.file(name), (current) => {
        if (current !== this.before![name]) throw new UpdateError("changed", name);
        return this.after![name];
      });
      if (await this.io.read(this.file(name)) !== this.after![name]) throw new UpdateError("changed", name);
    }
    await this.verify("after");
    await this.phase("installed");
  }

  async rollback(): Promise<void> {
    if (!this.journal || !this.before || !this.after) throw new UpdateError("storage");
    // Preflight every file before reverting any; foreign changes are never
    // overwritten just to make this transaction look internally consistent.
    for (const name of UPDATE_FILES) {
      const current = await this.io.read(this.file(name));
      if (current !== this.before[name] && current !== this.after[name]) throw new UpdateError("recovery", this.backupPath);
    }
    for (const name of [...UPDATE_FILES].reverse()) {
      await this.io.process(this.file(name), (current) => {
        if (current !== this.before![name] && current !== this.after![name]) throw new UpdateError("recovery", this.backupPath);
        return this.before![name];
      });
    }
    await this.verify("before");
    await this.phase("rolled-back");
  }

  async commit(): Promise<void> { await this.verify("after"); await this.phase("committed"); }

  /** Delete only this transaction's known files; never recursively remove a plugin folder. */
  async cleanup(): Promise<void> {
    if (!this.journal) return;
    // Clearing the device pointer last makes interruption safe and retryable.
    for (const name of UPDATE_FILES) for (const side of ["before", "after"] as const) {
      if (await this.io.exists(this.saved(name, side))) await this.io.remove(this.saved(name, side));
    }
    const path = `${this.backupPath}/transaction.json`;
    // Keep the completion receipt until the pointer has been cleared durably.
    this.local.save(null);
    if (this.local.load() != null) throw new UpdateError("storage", this.backupPath);
    if (await this.io.exists(path)) await this.io.remove(path);
    await this.io.rmdir(this.backupPath, false);
    this.journal = undefined; this.before = undefined; this.after = undefined;
  }

  /**
   * A new process repairs an unfinished transaction before initializing views.
   * Committed receipts need only cleanup; they must not undo a successful update.
   */
  async recover(): Promise<{ version: string; rolledBack: boolean } | undefined> {
    const task = this.local.load();
    if (task == null) return undefined;
    if (typeof task !== "string" || !SAFE_SEGMENT.test(task)) throw new UpdateError("recovery", this.directory);
    const path = `${this.directory}/${task}/transaction.json`;
    try {
      const text = await this.io.read(path);
      if (text.length > 16_384) throw new Error();
      const raw = JSON.parse(text) as UpdateJournal;
      if (raw.schema !== 1 || raw.task !== task || !["prepared", "writing", "installed", "committed", "rolled-back"].includes(raw.phase)) throw new Error();
      for (const name of UPDATE_FILES) for (const side of ["before", "after"] as const) {
        if (!/^[a-f0-9]{64}$/.test(raw.hashes?.[name]?.[side] ?? "")) throw new Error();
      }
      this.journal = raw;
      if (raw.phase === "committed" || raw.phase === "rolled-back") {
        await this.verify(raw.phase === "committed" ? "after" : "before");
        await this.cleanup();
        return { version: raw.phase === "committed" ? raw.to : raw.from, rolledBack: raw.phase === "rolled-back" };
      }
      this.before = {} as UpdatePayload; this.after = {} as UpdatePayload;
      for (const name of UPDATE_FILES) for (const side of ["before", "after"] as const) {
        const content = await this.io.read(this.saved(name, side));
        if (new TextEncoder().encode(content).length > UPDATE_LIMITS[name]
          || await sha256(content) !== raw.hashes[name][side]) throw new Error();
        this[side]![name] = content;
      }
      if (readUpdateManifest(this.before["manifest.json"]).version !== raw.from
        || readUpdateManifest(this.after["manifest.json"]).version !== raw.to) throw new Error();
      await this.rollback();
      await this.cleanup();
      return { version: raw.from, rolledBack: true };
    } catch { throw new UpdateError("recovery", path); }
  }
}
