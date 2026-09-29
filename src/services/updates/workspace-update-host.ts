import type { App, TFile, ViewState, WorkspaceLeaf } from "obsidian";
import { MIND_TREE_VIEW_TYPE } from "../../view-routing";
import type { ViewportState } from "../../ui/viewport";
import { UpdateError, updateTimeout } from "./release-client";
import type { UpdateHost, UpdateRuntime, PreparedPluginUpdate } from "./update-coordinator";
import type { PluginReloadBridge } from "./plugin-reload-bridge";

/** Transient presentation, never serialized to a mind tree or settings. */
export interface UpdateViewPresentation {
  readonly viewport: ViewportState;
  readonly selectedIds: readonly string[];
  readonly primarySelectedId?: string;
}
export interface UpdateViewParticipant {
  readonly leaf: WorkspaceLeaf;
  readonly file: TFile | null;
  pauseForUpdate(): void;
  flushForUpdate(): Promise<void>;
  assertUpdateSafe(): void;
  updateSourceBaseline(): string;
  resumeAfterUpdate(): void;
  captureUpdatePresentation(): UpdateViewPresentation;
  restoreUpdatePresentation(state: UpdateViewPresentation): void;
}

export class WorkspaceUpdateHost implements UpdateHost {
  constructor(private readonly app: App, private readonly bridge: PluginReloadBridge,
    private readonly runtime: UpdateRuntime, private readonly ports: {
      views(): UpdateViewParticipant[];
      settle(): Promise<void>;
      flushSettings(): Promise<void>;
      isUnloading(): boolean;
      hasBlockingDialog(): boolean;
    }) {}

  assertSupported(): void { this.bridge.assertSupported(); }

  async prepare(): Promise<PreparedPluginUpdate> {
    if (this.ports.hasBlockingDialog()) throw new UpdateError("busy");
    const participants = new Set<UpdateViewParticipant>();
    const resume = (): void => {
      this.runtime.paused = false; this.runtime.frozen = false;
      for (const view of participants) view.resumeAfterUpdate();
      for (const view of this.ports.views()) view.resumeAfterUpdate();
    };
    this.runtime.paused = true;
    let cancelled = false;
    try {
      // The timeout only aborts preparation, never continues into installation.
      // Delayed continuations check cancelled before taking any further action.
      await updateTimeout((async () => {
        for (;;) {
          if (cancelled) return;
          for (const view of this.ports.views()) if (!participants.has(view)) {
            participants.add(view); view.pauseForUpdate();
          }
          await this.ports.settle();
          if (cancelled) return;
          for (const view of this.ports.views()) await view.flushForUpdate();
          if (cancelled) return;
          await this.ports.flushSettings();
          if (this.ports.views().every((view) => participants.has(view))) break;
        }
      })(), 30_000);
      if (this.ports.isUnloading()) throw new UpdateError("cancelled");
      this.runtime.frozen = true;
      const views = this.ports.views();
      for (const view of views) view.assertUpdateSafe();
      const activeLeaf = this.app.workspace.getMostRecentLeaf();
      const entries = await Promise.all(views.map(async (view) => {
        if (!view.file) throw new UpdateError("save");
        const file = view.file;
        const source = await this.app.vault.read(file);
        if (source !== view.updateSourceBaseline()) throw new UpdateError("changed", file.path);
        return { leaf: view.leaf, state: structuredClone(view.leaf.getViewState()) as ViewState,
          presentation: view.captureUpdatePresentation(), file, path: file.path,
          source };
      }));
      this.runtime.baselines = new Map(entries.map((entry) => [entry.path, entry.source]));
      let unloaded = false;
      const emptyLeaves = async (): Promise<void> => {
        for (const entry of entries) {
          if (entry.leaf.view.getViewType() === MIND_TREE_VIEW_TYPE) {
            await entry.leaf.setViewState({ type: "empty", active: false });
          }
        }
      };
      return {
        assertSafe: async () => {
          if (!unloaded) {
            if (this.ports.isUnloading()) throw new UpdateError("cancelled");
            await this.ports.settle();
            await this.ports.flushSettings();
            for (const view of views) view.assertUpdateSafe();
          }
          for (const entry of entries) {
            if (entry.file.path !== entry.path || this.app.vault.getFileByPath(entry.path) !== entry.file
              || await this.app.vault.read(entry.file) !== entry.source) throw new UpdateError("changed", entry.path);
          }
        },
        unload: async () => {
          await emptyLeaves(); // keep leaf positions, splits and popout windows
          unloaded = true;
          await this.bridge.unload();
        },
        load: async (version) => {
          // Also used after a failed new instance/restore, before rolling back.
          await emptyLeaves();
          await this.bridge.load(version);
        },
        restore: async () => {
          for (const entry of entries) {
            let exists = false;
            this.app.workspace.iterateAllLeaves((leaf) => { if (leaf === entry.leaf) exists = true; });
            if (!exists || entry.leaf.view.getViewType() !== "empty") continue;
            await entry.leaf.setViewState({ ...entry.state, active: false });
            const view = entry.leaf.view as unknown as Partial<UpdateViewParticipant>;
            if (typeof view.restoreUpdatePresentation !== "function") throw new UpdateError("reload");
            view.restoreUpdatePresentation(entry.presentation);
          }
          let stillExists = false;
          this.app.workspace.iterateAllLeaves((leaf) => { if (leaf === activeLeaf) stillExists = true; });
          if (activeLeaf && stillExists) this.app.workspace.setActiveLeaf(activeLeaf, { focus: false });
        },
        resume
      };
    } catch (error) { cancelled = true; resume(); throw error; }
  }
}
