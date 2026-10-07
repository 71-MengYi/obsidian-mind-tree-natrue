import { compareVersions, UpdateError, type PluginRelease, type ReleaseClient } from "./release-client";
import type { UpdateStore } from "./update-store";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "preparing"
  | "installing" | "reloading" | "updated" | "error";
export interface UpdateState {
  readonly phase: UpdatePhase; readonly currentVersion: string; readonly latestVersion?: string;
  readonly availableRelease?: PluginRelease;
  readonly error?: UpdateError; readonly backupPath?: string;
}
export interface PreparedPluginUpdate {
  assertSafe(): Promise<void>;
  unload(): Promise<void>;
  load(version: string): Promise<void>;
  restore(): Promise<void>;
  resume(): void;
}
export interface UpdateHost {
  assertSupported(): void;
  prepare(): Promise<PreparedPluginUpdate>;
}

/** App-scoped memory survives hot reload, but never survives an app restart or sync. */
export interface UpdateRuntime {
  startupChecked: boolean; installing: boolean; paused: boolean; frozen: boolean;
  /** Saved baselines bridge the brief interval without a live file view. */
  baselines?: Map<string, string>;
}
const RUNTIME = Symbol.for("mind-tree-nature:update-runtime:v1");
export function updateRuntime(app: object): UpdateRuntime {
  const holder = app as { [RUNTIME]?: UpdateRuntime };
  return holder[RUNTIME] ??= { startupChecked: false, installing: false, paused: false, frozen: false };
}

export function updateBusy(state: UpdateState): boolean {
  return ["checking", "downloading", "preparing", "installing", "reloading"].includes(state.phase);
}

/** Owns one check/install at a time, independently of settings-page lifetimes. */
export class UpdateCoordinator {
  private listeners = new Set<(state: UpdateState) => void>();
  private operation?: Promise<void>;
  private disposed = false;
  private blocked?: UpdateError;
  state: UpdateState;

  constructor(private readonly client: ReleaseClient, private readonly store: UpdateStore,
    private readonly host: UpdateHost, private readonly runtime: UpdateRuntime, version: string,
    private readonly notify: (state: UpdateState) => void) {
    this.state = { phase: "idle", currentVersion: version };
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => this.listeners.delete(listener);
  }
  private publish(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  block(error: UpdateError): void {
    this.blocked = error;
    this.publish({ ...this.state, phase: "error", error, backupPath: this.store.backupPath });
  }
  startup(enabled: boolean): void {
    if (this.runtime.startupChecked) return;
    this.runtime.startupChecked = true;
    if (enabled && !this.runtime.installing) void this.check();
  }
  check(): Promise<void> {
    if (this.disposed || this.blocked || this.runtime.installing) return Promise.resolve();
    if (this.operation) return this.operation;
    const currentVersion = this.state.currentVersion;
    const operation = Promise.resolve().then(async () => {
      let state: UpdateState;
      try {
        const release = await this.client.latest();
        const newer = compareVersions(release.version, currentVersion) > 0;
        state = { phase: newer ? "available" : "current", currentVersion,
          latestVersion: release.version, availableRelease: newer ? release : undefined };
      } catch (error) {
        state = { phase: "error", currentVersion, error: this.asError(error) };
      }
      // Release the check before exposing its result: confirmation may install immediately.
      this.operation = undefined;
      if (this.disposed || this.blocked) return;
      this.publish(state);
      if (this.state === state && state.availableRelease) this.notify(state);
    });
    this.operation = operation;
    this.publish({ phase: "checking", currentVersion });
    return operation;
  }

  install(expectedRelease?: PluginRelease): Promise<void> {
    if (this.operation) return this.operation;
    const release = this.state.availableRelease;
    if (this.disposed || this.blocked || !release || this.state.phase !== "available" || this.runtime.installing
      || (expectedRelease && expectedRelease !== release)) return Promise.resolve();
    this.runtime.installing = true;
    const originalVersion = this.state.currentVersion;
    const phase = (phase: UpdatePhase): void => this.publish({ phase, currentVersion: originalVersion, latestVersion: release.version });
    phase("downloading");
    this.operation = (async () => {
      let prepared: PreparedPluginUpdate | undefined;
      let staged = false, unloadStarted = false, writeStarted = false, committed = false;
      try {
        this.host.assertSupported();
        const payload = await this.client.download(release);
        if (this.disposed) throw new UpdateError("cancelled");
        await this.store.stage(payload, originalVersion);
        staged = true;
        if (this.disposed) throw new UpdateError("cancelled");
        phase("preparing");
        prepared = await this.host.prepare();
        if (this.disposed) throw new UpdateError("cancelled");
        await prepared.assertSafe();
        await this.store.verify("before");
        unloadStarted = true;
        await prepared.unload();
        phase("installing");
        writeStarted = true;
        await this.store.install(() => prepared!.assertSafe());
        phase("reloading");
        await prepared.assertSafe();
        await prepared.load(release.version);
        await prepared.restore();
        await this.store.commit();
        committed = true;
        await this.store.cleanup();
        this.publish({ phase: "updated", currentVersion: release.version, latestVersion: release.version });
        this.notify(this.state);
      } catch (error) {
        let failure = this.asError(error);
        try {
          if (!committed) {
            if (writeStarted) await this.store.rollback();
            if (unloadStarted) { await prepared!.load(originalVersion); await prepared!.restore(); }
            if (staged) await this.store.cleanup();
          }
        } catch { failure = new UpdateError("recovery", this.store.backupPath); }
        this.publish({ phase: "error", currentVersion: committed ? release.version : originalVersion,
          error: failure, backupPath: this.store.backupPath });
        this.notify(this.state);
      } finally {
        prepared?.resume();
        this.runtime.installing = false;
        this.runtime.paused = false;
        this.runtime.frozen = false;
        this.runtime.baselines = undefined;
      }
    })().finally(() => { this.operation = undefined; });
    return this.operation;
  }

  private asError(error: unknown): UpdateError { return error instanceof UpdateError ? error : new UpdateError("storage"); }
  /** Own hot reload must not cancel its independent installation continuation. */
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}
