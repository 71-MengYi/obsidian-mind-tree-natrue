import type { App } from "obsidian";
import { UPDATE_PLUGIN_ID, UpdateError } from "./release-client";

interface ReloadablePlugin {
  manifest: { version: string };
  updateReady?: boolean;
  waitForUpdateUnload?: () => Promise<void>;
}
interface PluginManager {
  plugins: Record<string, ReloadablePlugin | undefined>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  loadManifests(): Promise<void>;
}

/**
 * Obsidian has no public hot-reload API. Keep its optional private surface in
 * ONE adapter, feature-detect before staging, and never alter enabled-plugins
 * configuration (the AndSave variants would sync an accidental disable).
 */
export class PluginReloadBridge {
  constructor(private readonly app: App) {}
  private manager(): PluginManager {
    const manager = (this.app as unknown as { plugins?: Partial<PluginManager> }).plugins;
    if (!manager?.plugins || typeof manager.disablePlugin !== "function" || typeof manager.enablePlugin !== "function"
      || typeof manager.loadManifests !== "function") throw new UpdateError("reload");
    return manager as PluginManager;
  }
  assertSupported(): void { this.manager(); }
  async unload(): Promise<void> {
    const manager = this.manager();
    const previous = manager.plugins[UPDATE_PLUGIN_ID];
    await manager.disablePlugin(UPDATE_PLUGIN_ID);
    await previous?.waitForUpdateUnload?.();
    if (manager.plugins[UPDATE_PLUGIN_ID]) throw new UpdateError("reload");
  }
  async load(version: string): Promise<void> {
    const manager = this.manager();
    if (manager.plugins[UPDATE_PLUGIN_ID]) await this.unload();
    await manager.loadManifests();
    await manager.enablePlugin(UPDATE_PLUGIN_ID);
    const loaded = manager.plugins[UPDATE_PLUGIN_ID];
    if (!loaded || loaded.manifest.version !== version || loaded.updateReady !== true) throw new UpdateError("reload");
  }
}
