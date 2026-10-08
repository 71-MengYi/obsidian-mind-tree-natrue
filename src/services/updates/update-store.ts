import { sha256, versionParts, UPDATE_FILES, UPDATE_LIMITS, UPDATE_RETRY_DELAYS, updateDelay, updateFailure, UpdateError,
  type UpdateDelay, type UpdateFile, type UpdatePayload, type UpdateStage } from "./release-client";

/** Public DataAdapter operations, shared by desktop, mobile and fault tests. */
export interface UpdateStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
  process(path: string, update: (value: string) => string): Promise<string>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
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
const terminal = (journal: UpdateJournal) => journal.phase === "committed" || journal.phase === "rolled-back";
const transient = (error: unknown) => !!error && typeof error === "object" && "code" in error
  && ["EBUSY", "EAGAIN", "ETXTBSY"].includes(String(error.code));

/** Owns only the three program files and this device's update receipts. */
export class UpdateStore {
  private journal?: UpdateJournal;
  private before?: UpdatePayload;
  private after?: UpdatePayload;
  readonly directory: string;
  private readonly delay: UpdateDelay;
  private readonly diagnose: (error: UpdateError) => void;

  constructor(private readonly io: UpdateStorage, private readonly local: UpdateLocalStorage,
    readonly pluginDirectory: string, clientId: string,
    options: { delay?: UpdateDelay; diagnose?: (error: UpdateError) => void } = {}) {
    if (!SAFE_SEGMENT.test(clientId) || !pluginDirectory || /[\\:]|^\//.test(pluginDirectory)
      || pluginDirectory.split("/").some((part) => !part || part === "." || part === "..")) throw new UpdateError("storage");
    this.directory = pluginDirectory + "/.updates/" + clientId;
    this.delay = options.delay ?? updateDelay;
    this.diagnose = options.diagnose ?? ((error) => console.warn("Mind Tree Nature update:", error));
  }
  get backupPath(): string { return this.journal ? this.directory + "/" + this.journal.task : this.directory; }
  private file(name: UpdateFile): string { return this.pluginDirectory + "/" + name; }
  private saved(name: UpdateFile, side: "before" | "after"): string { return this.backupPath + "/" + side + "-" + name; }
  private reset(): void { this.journal = undefined; this.before = undefined; this.after = undefined; }
  private async read(path: string, stage: UpdateStage): Promise<string> {
    try { return await this.io.read(path); } catch (error) { throw updateFailure(error, stage, path); }
  }
  private async mkdir(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join("/");
      try { if (!await this.io.exists(current)) await this.io.mkdir(current); }
      catch (error) { if (!await this.io.exists(current)) throw updateFailure(error, "backup", current); }
    }
  }
  private async verifiedWrite(path: string, text: string, stage: UpdateStage): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.io.write(path, text);
        if (await this.io.read(path) !== text) throw new UpdateError("storage", path);
        return;
      } catch (error) {
        // Some adapters finish the write before reporting a transient failure.
        if (await this.io.read(path).catch(() => undefined) === text) return;
        if (!transient(error) || attempt >= UPDATE_RETRY_DELAYS.length) throw updateFailure(error, stage, path);
        await this.delay(UPDATE_RETRY_DELAYS[attempt]!);
      }
    }
  }
  private async phase(phase: Phase, stage: UpdateStage): Promise<void> {
    const next = { ...this.journal!, phase };
    await this.verifiedWrite(this.backupPath + "/transaction.json", JSON.stringify(next), stage);
    this.journal = next;
  }

  async stage(payload: UpdatePayload, runningVersion: string, targetVersion: string): Promise<void> {
    // A terminal receipt may still have garbage to collect; it is not an active update.
    await this.recover();
    this.reset();
    try {
      const before = {} as UpdatePayload;
      const hashes = {} as UpdateJournal["hashes"];
      for (const name of UPDATE_FILES) {
        before[name] = await this.read(this.file(name), "backup");
        if (new TextEncoder().encode(before[name]).length > UPDATE_LIMITS[name]) throw new UpdateError("asset", name);
        hashes[name] = { before: await sha256(before[name]), after: await sha256(payload[name]) };
      }
      if (JSON.parse(before["manifest.json"]).version !== runningVersion) throw new UpdateError("changed", this.file("manifest.json"));
      this.journal = { schema: 1, task: crypto.randomUUID(), from: runningVersion, to: targetVersion, hashes, phase: "prepared" };
      this.before = before; this.after = payload;
      await this.mkdir(this.backupPath);
      for (const name of UPDATE_FILES) {
        await this.verifiedWrite(this.saved(name, "before"), before[name], "backup");
        await this.verifiedWrite(this.saved(name, "after"), payload[name], "backup");
      }
      await this.phase("prepared", "backup");
      this.local.save(this.journal.task);
      if (this.local.load() !== this.journal.task) throw new UpdateError("storage", this.backupPath);
    } catch (error) {
      // No program file has changed, even when preparation only partly completed.
      await this.cleanupAfterUpdate();
      throw updateFailure(error, "backup", this.backupPath);
    }
  }

  private async verify(side: "before" | "after", stage: UpdateStage): Promise<void> {
    if (!this.journal) throw new UpdateError("storage");
    for (const name of UPDATE_FILES) {
      if (await sha256(await this.read(this.file(name), stage)) !== this.journal.hashes[name][side]) {
        throw new UpdateError("changed", this.file(name), { stage });
      }
    }
  }
  private async replace(name: UpdateFile, value: string, allowed: string[], stage: "installing" | "rollback"): Promise<void> {
    const path = this.file(name);
    const conflict = () => new UpdateError(stage === "rollback" ? "recovery" : "changed", path, { stage });
    for (let attempt = 0; ; attempt++) {
      const before = await this.read(path, stage);
      if (before === value) return;
      if (!allowed.includes(before)) throw conflict();
      try {
        await this.io.process(path, (current) => {
          if (current !== value && !allowed.includes(current)) throw conflict();
          return value;
        });
        return; // One complete readback below verifies all three program files.
      } catch (error) {
        const actual = await this.read(path, stage);
        if (actual === value) return;
        if (!allowed.includes(actual)) throw conflict();
        if (!transient(error) || attempt >= UPDATE_RETRY_DELAYS.length) throw updateFailure(error, stage, path);
        await this.delay(UPDATE_RETRY_DELAYS[attempt]!);
      }
    }
  }
  async install(): Promise<void> {
    await this.phase("writing", "installing");
    for (const name of UPDATE_FILES) await this.replace(name, this.after![name], [this.before![name]], "installing");
    await this.verify("after", "installing");
    await this.phase("installed", "installing");
  }
  async rollback(): Promise<void> {
    if (!this.journal || !this.before || !this.after) throw new UpdateError("storage");
    for (const name of UPDATE_FILES) {
      const current = await this.read(this.file(name), "rollback");
      if (current !== this.before[name] && current !== this.after[name]) throw new UpdateError("recovery", this.file(name), { stage: "rollback" });
    }
    for (const name of [...UPDATE_FILES].reverse()) {
      await this.replace(name, this.before[name], [this.after[name]], "rollback");
    }
    await this.verify("before", "rollback");
    await this.phase("rolled-back", "rollback");
  }
  async commit(): Promise<void> {
    if (this.journal?.phase !== "installed") throw new UpdateError("storage");
    await this.phase("committed", "installing");
  }

  /** Record an unambiguous outcome BEFORE deleting any recovery material. */
  async cleanup(): Promise<void> {
    if (!this.journal) return;
    if (this.journal.phase === "prepared") {
      await this.verify("before", "cleanup");
      await this.phase("rolled-back", "cleanup");
    }
    if (!terminal(this.journal)) throw new UpdateError("recovery", this.backupPath);
    const path = this.backupPath;
    for (const name of UPDATE_FILES) for (const side of ["before", "after"] as const) {
      const saved = this.saved(name, side);
      try { if (await this.io.exists(saved)) await this.io.remove(saved); }
      catch (error) { throw updateFailure(error, "cleanup", saved); }
    }
    // Never clear the pointer belonging to a newer transaction.
    if (this.local.load() === this.journal.task) {
      this.local.save(null);
      if (this.local.load() === this.journal.task) throw new UpdateError("storage", path, { stage: "cleanup" });
    }
    const receipt = path + "/transaction.json";
    if (await this.io.exists(receipt)) await this.io.remove(receipt);
    if (await this.io.exists(path)) await this.io.rmdir(path, false);
    this.reset();
  }
  async cleanupAfterUpdate(): Promise<void> {
    try { await this.cleanup(); }
    catch (error) { this.diagnose(updateFailure(error, "cleanup", this.backupPath)); }
  }

  private async journalAt(task: string): Promise<UpdateJournal> {
    if (!SAFE_SEGMENT.test(task)) throw new UpdateError("recovery", this.directory);
    const path = this.directory + "/" + task + "/transaction.json";
    const text = await this.read(path, "recovery");
    if (text.length > 16_384) throw new UpdateError("recovery", path);
    const raw = JSON.parse(text) as UpdateJournal;
    if (raw?.schema !== 1 || raw.task !== task || !["prepared", "writing", "installed", "committed", "rolled-back"].includes(raw.phase)) {
      throw new UpdateError("recovery", path);
    }
    versionParts(raw.from); versionParts(raw.to);
    for (const name of UPDATE_FILES) for (const side of ["before", "after"] as const) {
      if (!/^[a-f0-9]{64}$/.test(raw.hashes?.[name]?.[side] ?? "")) throw new UpdateError("recovery", path);
    }
    return raw;
  }

  /** Only completed receipts in this device's directory are eligible for garbage collection. */
  private async sweep(): Promise<void> {
    try {
      if (!await this.io.exists(this.directory)) return;
      for (const folder of (await this.io.list(this.directory)).folders) {
        const task = folder.slice(this.directory.length + 1);
        if (folder !== this.directory + "/" + task || !SAFE_SEGMENT.test(task) || task === this.local.load()) continue;
        try {
          if (!await this.io.exists(folder + "/transaction.json")) {
            const contents = await this.io.list(folder);
            if (!contents.files.length && !contents.folders.length) await this.io.rmdir(folder, false);
            continue;
          }
          const journal = await this.journalAt(task);
          if (!terminal(journal)) continue;
          this.journal = journal;
          await this.cleanupAfterUpdate();
        } catch (error) { this.diagnose(updateFailure(error, "cleanup", folder)); }
        finally { this.reset(); }
      }
    } catch (error) { this.diagnose(updateFailure(error, "cleanup", this.directory)); }
  }

  async recover(): Promise<{ version: string; rolledBack: boolean } | undefined> {
    const task = this.local.load();
    let result: { version: string; rolledBack: boolean } | undefined;
    if (task != null) {
      try {
        if (typeof task !== "string") throw new UpdateError("recovery", this.directory);
        const raw = await this.journalAt(task);
        this.journal = raw;
        if (terminal(raw)) {
          // Cleanup never depends on files that may already belong to a later update.
          result = { version: raw.phase === "committed" ? raw.to : raw.from, rolledBack: false };
        } else {
          const current = {} as UpdatePayload;
          let allBefore = true, allAfter = true;
          for (const name of UPDATE_FILES) {
            current[name] = await this.read(this.file(name), "recovery");
            const hash = await sha256(current[name]);
            const before = hash === raw.hashes[name].before, after = hash === raw.hashes[name].after;
            if (!before && !after) throw new UpdateError("recovery", this.file(name));
            allBefore &&= before; allAfter &&= after;
          }
          if (allBefore || allAfter) {
            await this.phase(allAfter ? "committed" : "rolled-back", "recovery");
            result = { version: allAfter ? raw.to : raw.from, rolledBack: false };
          } else {
            this.before = {} as UpdatePayload;
            this.after = current;
            for (const name of UPDATE_FILES) {
              const before = await this.read(this.saved(name, "before"), "recovery");
              if (new TextEncoder().encode(before).length > UPDATE_LIMITS[name] || await sha256(before) !== raw.hashes[name].before) {
                throw new UpdateError("recovery", this.saved(name, "before"));
              }
              this.before[name] = before;
            }
            await this.rollback();
            result = { version: raw.from, rolledBack: true };
          }
        }
        await this.cleanupAfterUpdate();
        this.reset();
      } catch (error) {
        throw new UpdateError("recovery", this.backupPath, { stage: "recovery", cause: error });
      }
    }
    await this.sweep();
    return result;
  }
}
