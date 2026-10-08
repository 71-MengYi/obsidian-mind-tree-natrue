import { compareVersions, updateFailure, UpdateError, type PluginRelease, type ReleaseClient, type UpdateStage } from "./release-client";
import type { UpdateStore } from "./update-store";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "preparing"
  | "installing" | "reloading" | "updated" | "restart-required" | "error";
export interface UpdateState {
  readonly phase: UpdatePhase; readonly currentVersion: string; readonly latestVersion?: string;
  readonly availableRelease?: PluginRelease;
  readonly installedVersion?: string;
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
  canReload(): boolean;
  prepare(): Promise<PreparedPluginUpdate>;
}

/** App-scoped memory survives hot reload, but never survives an app restart or sync. */
export interface UpdateRuntime {
  startupChecked: boolean; installing: boolean; paused: boolean; frozen: boolean;
  /** Saved baselines bridge the brief interval without a live file view. */
  baselines?: Map<string, string>;
  pendingRestartVersion?: string;
  restartListeners?: Set<() => void>;
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
    private readonly notify: (state: UpdateState) => void,
    private readonly diagnose: (error: UpdateError) => void = (error) => console.warn("Mind Tree Nature update:", error)) {
    this.state = { phase: "idle", currentVersion: version };
    (this.runtime.restartListeners ??= new Set()).add(this.syncRestartState);
    this.syncRestartState();
  }

  private syncRestartState = (): void => {
    const installedVersion = this.runtime.pendingRestartVersion;
    if (installedVersion) {
      if (this.state.phase === "restart-required" && this.state.installedVersion === installedVersion) return;
      this.publish({ phase: "restart-required", currentVersion: this.state.currentVersion,
        installedVersion, latestVersion: installedVersion });
    } else if (this.state.phase === "restart-required") {
      this.publish({ phase: "idle", currentVersion: this.state.currentVersion });
    }
  };
  /** A manual reload of the installed version also completes a pending restart. */
  markReady(): void {
    if (!this.runtime.installing && this.runtime.pendingRestartVersion === this.state.currentVersion) {
      this.runtime.pendingRestartVersion = undefined;
      for (const listener of this.runtime.restartListeners ?? []) listener();
    }
  }
  requireRestart(version: string): void {
    this.runtime.pendingRestartVersion = version;
    this.syncRestartState();
    for (const listener of this.runtime.restartListeners ?? []) listener();
    this.notify(this.state);
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
    this.diagnose(error);
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
    if (this.runtime.pendingRestartVersion) { this.syncRestartState(); return Promise.resolve(); }
    const currentVersion = this.state.currentVersion;
    const operation = Promise.resolve().then(async () => {
      let state: UpdateState;
      try {
        const release = await this.client.latest();
        const newer = compareVersions(release.version, currentVersion) > 0;
        state = { phase: newer ? "available" : "current", currentVersion,
          latestVersion: release.version, availableRelease: newer ? release : undefined };
      } catch (error) {
        const failure = updateFailure(error, "checking");
        this.diagnose(failure);
        state = { phase: "error", currentVersion, error: failure };
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
      || this.runtime.pendingRestartVersion
      || (expectedRelease && expectedRelease !== release)) return Promise.resolve();
    this.runtime.installing = true;
    const originalVersion = this.state.currentVersion;
    const phase = (phase: UpdatePhase): void => this.publish({ phase, currentVersion: originalVersion, latestVersion: release.version });
    phase("downloading");
    this.operation = (async () => {
      let prepared: PreparedPluginUpdate | undefined;
      let staged = false, writeStarted = false, committed = false;
      let runningVersion = originalVersion;
      let stage: UpdateStage = "downloading";
      try {
        const payload = await this.client.download(release);
        if (this.disposed) throw new UpdateError("cancelled");
        stage = "preparing";
        phase("preparing");
        prepared = await this.host.prepare();
        if (this.disposed) throw new UpdateError("cancelled");
        stage = "backup";
        await this.store.stage(payload, originalVersion, release.version);
        staged = true;
        if (this.disposed) throw new UpdateError("cancelled");
        stage = "preparing";
        await prepared.assertSafe();
        stage = "installing";
        phase("installing");
        writeStarted = true;
        await this.store.install();
        await this.store.commit();
        committed = true;
        stage = "reloading";
        phase("reloading");
        if (this.disposed || !this.host.canReload()) throw new UpdateError("reload");
        await prepared.assertSafe();
        await prepared.unload();
        await prepared.load(release.version);
        runningVersion = release.version;
        await prepared.restore();
        this.runtime.pendingRestartVersion = undefined;
        this.publish({ phase: "updated", currentVersion: runningVersion, installedVersion: release.version, latestVersion: release.version });
        this.notify(this.state);
      } catch (error) {
        let failure = updateFailure(error, stage);
        this.diagnose(failure);
        if (committed) {
          this.runtime.pendingRestartVersion = release.version;
          this.publish({ phase: "restart-required", currentVersion: runningVersion,
            installedVersion: release.version, latestVersion: release.version });
        } else {
          try {
            if (writeStarted) await this.store.rollback();
          } catch (rollbackError) {
            failure = new UpdateError("recovery", this.store.backupPath, { stage: "rollback", cause: rollbackError });
            this.diagnose(failure);
          }
          this.publish({ phase: "error", currentVersion: originalVersion, error: failure, backupPath: this.store.backupPath });
        }
        this.notify(this.state);
      } finally {
        if (staged) await this.store.cleanupAfterUpdate();
        try { prepared?.resume(); } catch (error) { this.diagnose(updateFailure(error, "reloading")); }
        this.runtime.installing = false;
        this.runtime.paused = false;
        this.runtime.frozen = false;
        this.runtime.baselines = undefined;
        for (const listener of this.runtime.restartListeners ?? []) listener();
      }
    })().finally(() => { this.operation = undefined; });
    return this.operation;
  }

  /** Own hot reload must not cancel its independent installation continuation. */
  dispose(): void {
    this.disposed = true; this.listeners.clear();
    this.runtime.restartListeners?.delete(this.syncRestartState);
  }
}
