import { addIcon, normalizePath, Notice, Platform, Plugin, removeIcon, requestUrl, requireApiVersion, TFile, WorkspaceLeaf, type ViewState, type ViewStateResult } from "obsidian";
import { around } from "monkey-around";
import { createMindTreeFile, parseMindTreeFile, serializeMindTreeFile } from "./format/document";
import { t } from "./i18n";
import { ResourceIndexService, type ResourceIndexProgress, type ResourceIndexReport } from "./services/resource-index";
import { LocalResourceCache } from "./services/local-resource-cache";
import { SettingsPersistence, removeLegacyResourceIndex } from "./services/settings-persistence";
import { decideDocumentIdentityWrite } from "./services/resource-identity";
import { MindTreeSessionRegistry, type SharedMindTreeSession } from "./services/mind-tree-session-registry";
import { PendingConflictStore } from "./services/pending-conflict-store";
import { VersionConflictCoordinator } from "./services/version-conflict-coordinator";
import { MindTreeOpenCoordinator } from "./services/mind-tree-open-coordinator";
import { canonicalTreePath } from "./services/pending-conflict-store";
import { normalizePluginData, type PluginData } from "./plugin-data";
import { DEFAULT_SETTINGS, MindTreeSettingTab, type MindTreeSettings } from "./settings";
import {
  CHAIN_BROKEN_ICON,
  CHAIN_BROKEN_ICON_SVG,
  SHARE_SQUARE_ICON,
  SHARE_SQUARE_ICON_SVG,
} from "./ui/icons";
import { MindTreeView } from "./ui/mind-tree-view";
import { CreateMindTreeModal, PluginUpdateModal, TextPromptModal } from "./ui/modals";
import { LAYOUT_OPTIONS } from "./ui/presentation";
import { isMindTreePath, MIND_TREE_VIEW_TYPE, routeMindTreeViewState } from "./view-routing";
import { ReleaseClient, UpdateError } from "./services/updates/release-client";
import { UpdateStore } from "./services/updates/update-store";
import { UpdateCoordinator, updateRuntime } from "./services/updates/update-coordinator";
import { PluginReloadBridge } from "./services/updates/plugin-reload-bridge";
import { WorkspaceUpdateHost, type UpdateViewParticipant } from "./services/updates/workspace-update-host";
import { UpdateActivity } from "./services/updates/update-activity";
import { updateMessage } from "./services/updates/update-messages";
import { AdaptiveTooltipController } from "./ui/adaptive-tooltip";

export default class MindTreeNaturePlugin extends Plugin {
  settings: MindTreeSettings = structuredClone(DEFAULT_SETTINGS);
  resources!: ResourceIndexService;
  /** Every open leaf of the same file shares one document/history/write queue. */
  readonly mindTreeSessions = new MindTreeSessionRegistry();
  pendingConflicts!: PendingConflictStore;
  private openCoordinator!: MindTreeOpenCoordinator<WorkspaceLeaf>;
  private pendingActivationTimer?: number;
  private resourceCache!: LocalResourceCache;
  private cacheSaveTimer?: number;
  private settingsPersistence!: SettingsPersistence<MindTreeSettings>;
  private settingTab?: MindTreeSettingTab;
  private updateModal?: PluginUpdateModal;
  private unloading = false;
  readonly updateRuntime = updateRuntime(this.app);
  updates!: UpdateCoordinator;
  /** Internal readiness handshake, checked by the reload compatibility adapter. */
  updateReady = false;
  private readonly updateActivity = new UpdateActivity();
  private updateUnloadTask: Promise<void> = Promise.resolve();
  private coreInitialized = false;


  async onload(): Promise<void> {
    if (!await this.initializeUpdater()) return;
    this.coreInitialized = true;
    this.register(this.updateActivity.observe(this, ["createMindTree", "writeMindTreeDocumentId"]));
    this.settingsPersistence = new SettingsPersistence({
      read: async () => {
        const raw: unknown = await this.loadData();
        if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
          throw new Error("Invalid plugin settings JSON");
        }
        return normalizePluginData(raw).settings;
      },
      write: (settings) => this.saveData({ settings } satisfies PluginData),
      apply: (settings) => {
        const changed = JSON.stringify(this.settings) !== JSON.stringify(settings);
        Object.assign(this.settings, settings);
        if (changed) {
          this.settingTab?.refreshFromExternal();
          this.refreshOpenMindTreeLayouts();
        }
      },
      failed: (error, operation) => {
        console.error("Mind Tree Nature: settings I/O failed", error);
        new Notice(t(operation === "read" ? "settings.sync.readFailed" : "settings.sync.writeFailed"));
      }
    });
    await this.removeLegacyIndexOnce();
    await this.loadSettings();
    this.resourceCache = new LocalResourceCache(this.manifest.id, {
      load: (key) => this.app.loadLocalStorage(key),
      save: (key, value) => this.app.saveLocalStorage(key, value)
    }, (error) => {
      console.error("Mind Tree Nature: device-local cache unavailable", error);
      new Notice(t("resourceIndex.cacheUnavailable"));
    });
    // Obsidian local storage is vault-scoped and is not synced as plugin data.
    // Every device writes only its own journal directory.
    const clientKey = `${this.manifest.id}:pending-conflict-client`;
    let clientId: unknown = this.app.loadLocalStorage(clientKey);
    if (typeof clientId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(clientId)) {
      clientId = crypto.randomUUID();
      this.app.saveLocalStorage(clientKey, clientId);
    }
    this.pendingConflicts = new PendingConflictStore(this.app.vault.adapter,
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`, clientId as string,
      () => this.documentParseOptions());
    this.resources = new ResourceIndexService(this.app, this.resourceCache.load(), () => {
      this.scheduleResourceCacheSave();
    }, () => this.settings.nonMarkdownIdSeparator, (file, documentId, expectedDocumentId) =>
      this.writeMindTreeDocumentId(file, documentId, expectedDocumentId));
    this.register(this.updateActivity.observe(this.resources, [
      "ensureStableReference", "ensureStableReferences", "createNote", "createFileFromTemplate",
      "discardTemplateFile", "importExternalFile", "importClipboardImage", "renameLinkedFile",
      "moveLinkedFile", "trashLinkedFile"
    ]));
    addIcon(SHARE_SQUARE_ICON, SHARE_SQUARE_ICON_SVG);
    this.register(() => removeIcon(SHARE_SQUARE_ICON));
    addIcon(CHAIN_BROKEN_ICON, CHAIN_BROKEN_ICON_SVG);
    this.register(() => removeIcon(CHAIN_BROKEN_ICON));
    this.registerView(MIND_TREE_VIEW_TYPE, (leaf) => new MindTreeView(leaf, this));
    this.registerDirectOpenRouting();
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      void this.activateMindTreeLeaf(leaf);
    }));
    this.settingTab = new MindTreeSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    const ribbon = this.addRibbonIcon("git-fork", t("tree.create"), () => this.promptCreateMindTreeInFolder());
    const ribbonTooltips = new AdaptiveTooltipController(ribbon, true);
    this.register(() => ribbonTooltips.destroy());
    this.addCommand({
      id: "create-mind-tree",
      name: t("command.createTree"),
      callback: () => this.promptCreateMindTree()
    });
    this.addCommand({
      id: "open-current-as-mind-tree",
      name: t("command.openTree"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isMindTreePath(file.path)) return false;
        if (!checking) void this.activateMindTree(file);
        return true;
      }
    });
    this.addCommand({
      id: "add-child-node",
      name: t("command.addChild"),
      checkCallback: (checking) => {
        const view = this.activeMindTreeView();
        if (!view) return false;
        if (!checking) view.addChildNode();
        return true;
      }
    });
    this.addCommand({
      id: "undo-mind-tree-change",
      name: t("command.undo"),
      checkCallback: (checking) => {
        const view = this.activeMindTreeView();
        if (!view) return false;
        if (!checking) view.undo();
        return true;
      }
    });
    this.addCommand({
      id: "redo-mind-tree-change",
      name: t("command.redo"),
      checkCallback: (checking) => {
        const view = this.activeMindTreeView();
        if (!view) return false;
        if (!checking) view.redo();
        return true;
      }
    });
    this.addCommand({
      id: "fit-mind-tree-canvas",
      name: t("command.fitCanvas"),
      checkCallback: (checking) => {
        const view = this.activeMindTreeView();
        if (!view) return false;
        if (!checking) view.fitCanvas();
        return true;
      }
    });
    for (const option of LAYOUT_OPTIONS) {
      this.addCommand({
        id: `set-mind-tree-layout-${option.value}`,
        name: t(option.command),
        checkCallback: (checking) => {
          const view = this.activeMindTreeView();
          if (!view) return false;
          if (!checking) view.setLayoutMode(option.value);
          return true;
        }
      });
    }

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
      if (file instanceof TFile && isMindTreePath(file.path)) {
        menu.addItem((item) => item
          .setTitle(t("menu.openAsTree"))
          .setIcon("git-fork")
          .onClick(() => void this.activateMindTree(file, leaf)));
      }
    }));

    this.app.workspace.onLayoutReady(() => {
      this.updates.startup(this.settings.autoCheckUpdates);
      void this.rebuildResourceIndex().catch((error: unknown) => this.reportIndexFailure(error));
      void this.reportUnlocatedPendingVersions();
      void this.deduplicateRestoredMindTrees();
      this.registerEvent(this.app.workspace.on("file-open", (file) => {
        if (file && isMindTreePath(file.path)) this.scheduleMindTreeActivation(file);
      }));
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile) void this.refreshResource(file);
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (isMindTreePath(file.path)) {
          for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
            if (leaf.view instanceof MindTreeView && leaf.view.file?.path === file.path) leaf.view.checkExternalVersion();
          }
        }
        void this.refreshResource(file);
      }));
      this.registerEvent(this.app.metadataCache.on("changed", (file) => {
        void this.refreshResource(file, "metadata");
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        this.resources.removePath(file.path);
        for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
          if (leaf.view instanceof MindTreeView && leaf.view.file?.path === file.path) leaf.view.checkExternalVersion();
        }
      }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        // Folder moves may emit only a folder event, not an event per child.
        const files = file instanceof TFile ? [file]
          : this.app.vault.getFiles().filter((child) => child.path.startsWith(`${file.path}/`));
        for (const child of files) {
          const previousPath = oldPath + child.path.slice(file.path.length);
          this.mindTreeSessions.rename(previousPath, child.path);
          const session = this.mindTreeSessions.get(child.path);
          if (isMindTreePath(child.path)) void (session?.conflict?.active
            ? session.conflict.rename(child.path)
            : this.pendingConflicts.load(previousPath).then(async (record) => {
              if (record) await this.pendingConflicts.put({ ...record, path: child.path });
            })).catch((error: unknown) => new Notice(t("conflict.storageError", { message: String(error) })));
          void this.resources.handleRename(child, previousPath).then(() => {
            if (this.unloading) return;
            for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
              if (leaf.view instanceof MindTreeView) leaf.view.handleResourceRename(child, previousPath);
            }
          }).catch((error: unknown) => this.reportIndexFailure(error));
        }
      }));
      void this.activateMindTreeLeaf(this.app.workspace.getMostRecentLeaf());
    });
    this.updateReady = true;
    this.updates.markReady();
  }

  onunload(): void {
    this.unloading = true;
    this.updateReady = false;
    this.updateModal?.close();
    this.updates?.dispose();
    if (!this.coreInitialized) return;
    if (this.pendingActivationTimer !== undefined) window.clearTimeout(this.pendingActivationTimer);
    if (this.cacheSaveTimer !== undefined) window.clearTimeout(this.cacheSaveTimer);
    // Only a disposable local cache is flushed at unload, never old user settings.
    this.resourceCache?.save(this.resources?.entries() ?? []);
    this.settingsPersistence?.destroy();
    this.settingTab?.hide();
    const leaves = this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE);
    // The index must outlive a title draft's final filename synchronization.
    // The public unload hook is synchronous, so retain services until the views'
    // existing idempotent flush completes, then release the scanner.
    this.updateUnloadTask = Promise.allSettled(leaves.map(async (leaf) => {
      try {
        if (leaf.view instanceof MindTreeView) await leaf.view.prepareForPluginUnload();
        leaf.detach();
      } catch (error) {
        console.error("Mind Tree Nature: could not finish closing a view", error);
      }
    })).then(() => {
      this.resourceCache?.save(this.resources?.entries() ?? []);
      this.resources?.destroy();
    });
  }

  waitForUpdateUnload(): Promise<void> { return this.updateUnloadTask; }

  /** Both check notifications and settings reopen this same release window. */
  showAvailableUpdate(): void {
    const release = this.updates.state.availableRelease;
    if (this.unloading || this.updates.state.phase !== "available" || !release) return;
    if (this.updateModal?.release === release) return;
    this.updateModal?.close();
    const modal = new PluginUpdateModal(this.app, this.manifest.name, release, this.updates, () => {
      if (this.updateModal === modal) this.updateModal = undefined;
    });
    this.updateModal = modal;
    modal.open();
  }

  /** Initialize update recovery before any document sessions or async writers. */
  private async initializeUpdater(): Promise<boolean> {
    const directory = normalizePath(this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const clientKey = `${this.manifest.id}:update-client`;
    const pointerKey = `${this.manifest.id}:update-transaction`;
    let clientId: unknown;
    let storageError: UpdateError | undefined;
    try { clientId = this.app.loadLocalStorage(clientKey); }
    catch (error) { storageError = new UpdateError("storage", directory, { stage: "backup", cause: error }); }
    if (typeof clientId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(clientId)) {
      clientId = crypto.randomUUID();
      try {
        this.app.saveLocalStorage(clientKey, clientId);
        if (this.app.loadLocalStorage(clientKey) !== clientId) throw new Error();
      } catch (error) { storageError = new UpdateError("storage", directory, { stage: "backup", cause: error }); }
    }
    const store = new UpdateStore(this.app.vault.adapter, {
      load: () => this.app.loadLocalStorage(pointerKey),
      save: (value) => this.app.saveLocalStorage(pointerKey, value)
    }, directory, clientId as string);
    const bridge = new PluginReloadBridge(this.app);
    const host = new WorkspaceUpdateHost(this.app, bridge, this.updateRuntime, {
      // Duck typing is deliberate: a newly loaded bundle has a different class
      // identity. Never use the old bundle's instanceof to restore new views.
      views: () => this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)
        .map((leaf) => leaf.view as unknown as UpdateViewParticipant)
        .filter((view) => typeof view.captureUpdatePresentation === "function"),
      settle: () => this.updateActivity.settle(),
      flushSettings: async () => {
        try { await this.settingsPersistence.flush(); }
        catch (error) { throw new UpdateError("save", "", { stage: "preparing", cause: error }); }
      },
      isUnloading: () => this.unloading,
      hasBlockingDialog: () => {
        const documents = new Set<Document>([this.app.workspace.containerEl.ownerDocument]);
        this.app.workspace.iterateAllLeaves((leaf) => documents.add(leaf.view.containerEl.ownerDocument));
        return [...documents].some((document) => [...document.querySelectorAll<HTMLElement>(".modal-container,.menu")]
          .some((element) => element.getClientRects().length > 0
            && !element.contains(this.settingTab?.containerEl ?? null)
            && !element.querySelector(".mod-settings,.vertical-tabs-container")));
      }
    });
    this.updates = new UpdateCoordinator(new ReleaseClient((url) => requestUrl({ url,
      headers: { Accept: "application/vnd.github+json" }, throw: false }), requireApiVersion, Platform.isMobile),
      store, host, this.updateRuntime, this.manifest.version, (state) => {
        if (state.phase === "available") this.showAvailableUpdate();
        else new Notice(updateMessage(state), state.phase === "restart-required" ? 0 : 10_000);
      });
    if (storageError) { this.updates.block(storageError); return true; }
    if (!this.updateRuntime.installing) {
      try {
        const recovered = await store.recover();
        if (recovered?.rolledBack) {
          new Notice(t("update.recovered", { version: recovered.version }));
          if (!bridge.canReload()) {
            this.updates.requireRestart(recovered.version);
            return false;
          }
          // Reload even if manifest versions match: a crash might have replaced
          // main.js but not manifest.json, so the running code can still be new.
          this.updateRuntime.installing = true;
          this.updateRuntime.startupChecked = true;
          setTimeout(() => {
            void bridge.load(recovered.version).catch((error) => {
              console.warn("Mind Tree Nature update: reload after recovery", error);
              this.updates.requireRestart(recovered.version);
            })
              .finally(() => { this.updateRuntime.installing = false; });
          }, 0);
          return false;
        }
      } catch (error) {
        this.updates.block(error instanceof UpdateError ? error
          : new UpdateError("recovery", store.directory, { stage: "recovery", cause: error }));
        new Notice(updateMessage(this.updates.state), 0);
      }
    }
    return true;
  }

  async loadSettings(): Promise<void> { await this.settingsPersistence.reload(); }
  async saveSettings(): Promise<void> { await this.settingsPersistence.save(this.settings); }

  /** Obsidian owns the merge; adopt the result without echoing it back to Sync. */
  async onExternalSettingsChange(): Promise<void> {
    if (!this.unloading) await this.settingsPersistence?.reload();
  }

  private async removeLegacyIndexOnce(): Promise<void> {
    const key = `${this.manifest.id}:local-index-migration:v1`;
    try {
      if (this.app.loadLocalStorage(key) === true) return;
      const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      const path = `${directory}/data.json`;
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(path)) {
        const source = await adapter.read(path);
        // Avoid an unnecessary write when no upgrade cleanup is needed.
        if (removeLegacyResourceIndex(source) !== source) {
          await adapter.process(path, removeLegacyResourceIndex);
        }
      }
      this.app.saveLocalStorage(key, true);
    } catch (error) {
      console.error("Mind Tree Nature: legacy index cleanup deferred", error);
      new Notice(t("settings.sync.cleanupFailed"));
    }
  }

  async rebuildResourceIndex(progress?: (value: ResourceIndexProgress) => void): Promise<ResourceIndexReport> {
    const report = await this.resources.rebuild(progress);
    if (this.unloading) return report;
    if (this.cacheSaveTimer !== undefined) window.clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = undefined;
    report.persisted = this.resourceCache.save(this.resources.entries());
    // Rendering only: rebuilding must not mutate documents or their histories.
    this.refreshOpenMindTreeLayouts();
    return report;
  }

  private async refreshResource(file: TFile, event: "file" | "metadata" = "file"): Promise<void> {
    try {
      const indexed = await this.resources.indexFile(file, event);
      if (this.unloading) return;
      // Unlinked files (including most .mtn.md files) must not redraw every
      // editor on each autosave or unrelated Markdown modification.
      if (!indexed) return;
      for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
        if (leaf.view instanceof MindTreeView) leaf.view.handleResourceMetadataChange(indexed.resourceId);
      }
    } catch (error) {
      // The shared read already retried transient races at most three times.
      // A persistent background failure waits for the next event/rebuild, not
      // an unbounded retry loop or fallback to the previous identity.
      console.warn("Mind Tree Nature: resource verification deferred", file.path, error);
    }
  }

  private reportIndexFailure(error: unknown): void {
    if (this.unloading) return;
    console.error("Mind Tree Nature: index rebuild failed", error);
    new Notice(t("resourceIndex.failed"));
  }

  private documentParseOptions() {
    return {
      defaultLayoutMode: this.settings.defaultLayoutMode, defaultTheme: this.settings.theme,
      defaultNodeShape: this.settings.nodeShape, defaultCollectionMode: this.settings.defaultCollectionMode,
      defaultConnectionStyle: this.settings.connectionStyle
    };
  }

  /** Session-owned I/O ports remain valid after the last view closes. */
  ensureConflictCoordinator(session: SharedMindTreeSession): VersionConflictCoordinator {
    if (session.conflict) return session.conflict;
    const requireFile = (): TFile => {
      const file = this.app.vault.getFileByPath(session.path);
      if (!file) throw new Error(t("conflict.fileMissing", { path: session.path }));
      return file;
    };
    session.conflict = new VersionConflictCoordinator({
      store: this.pendingConflicts, options: () => this.documentParseOptions(), path: () => session.path,
      read: () => this.app.vault.read(requireFile()),
      process: (transform) => this.app.vault.process(requireFile(), transform),
      beginWrite: (source) => session.beginWrite(source), endWrite: (source) => session.endWrite(source),
      changed: () => session.notifyConflict(), resolved: (result) => session.acceptVersion(result),
      restored: (document, baseline) => session.restoreFrozenVersion(document, baseline),
      createId: () => crypto.randomUUID(),
      checkIdentityAvailable: async (id) => {
        const file = requireFile();
        const guard = await this.resources.prepareIdentityRestore(id, file.path);
        return () => {
          if (requireFile() !== file) throw new Error(t("resourceIndex.identityChanged"));
          guard();
        };
      },
      scheduleResume: () => {
        void session.history.runExclusiveWrite(() => session.conflict!.resumeUnchanged())
          .then((result) => {
            if (!result) return;
            for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
              if (leaf.view instanceof MindTreeView && leaf.view.file?.path === session.path) leaf.view.checkExternalVersion();
            }
          })
          .catch((error: unknown) => { console.error("Mind Tree metadata resume failed", error); });
      }
    });
    return session.conflict;
  }

  /**
   * Assign the lazy link identity against the latest saved tree. Open views are
   * flushed first and then adopt the same ID in every undo snapshot so a later
   * undo can never remove the persisted identity again.
   */
  private async writeMindTreeDocumentId(
    file: TFile,
    proposedDocumentId: string,
    expectedDocumentId?: string
  ): Promise<{ file: TFile; documentId: string }> {
    const path = normalizePath(file.path);
    const openViews = this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is MindTreeView => view instanceof MindTreeView && normalizePath(view.file?.path ?? "") === path);
    for (const view of openViews) await view.flushForDocumentIdentityWrite(path);
    const persistedPath = normalizePath(file.path);
    const sharedSession = this.mindTreeSessions.get(persistedPath);

    let persistedDocumentId = proposedDocumentId;
    let identityWriteSource: string | undefined;
    const writeIdentity = async (): Promise<void> => {
      await this.app.vault.process(file, (source) => {
        const parsed = parseMindTreeFile(source, {
          defaultLayoutMode: this.settings.defaultLayoutMode,
          defaultTheme: this.settings.theme,
          defaultNodeShape: this.settings.nodeShape,
          defaultCollectionMode: this.settings.defaultCollectionMode,
          defaultConnectionStyle: this.settings.connectionStyle
        });
        const currentDocumentId = parsed.document.documentId;
        // Vault.process applies this compare-and-set to the latest file contents.
        // A concurrent first-link operation therefore adopts the winning ID
        // instead of overwriting it with a second UUID.
        const decision = decideDocumentIdentityWrite(currentDocumentId, proposedDocumentId, expectedDocumentId);
        persistedDocumentId = decision.documentId;
        if (!decision.write) return source;
        parsed.document.documentId = decision.documentId;
        identityWriteSource = serializeMindTreeFile(parsed.document, source);
        sharedSession?.beginWrite(identityWriteSource);
        return identityWriteSource;
      });
    };
    try {
      if (sharedSession) await sharedSession.runFileOperation(() => sharedSession.history.runExclusiveWrite(async () => {
        if (sharedSession.mutationLocked) throw new Error(t("status.saveConflict"));
        await writeIdentity();
      }));
      else await writeIdentity();

      const verifiedSource = await this.app.vault.read(this.app.vault.getFileByPath(file.path) ?? file);
      const verified = parseMindTreeFile(verifiedSource, {
        defaultLayoutMode: this.settings.defaultLayoutMode,
        defaultTheme: this.settings.theme,
        defaultNodeShape: this.settings.nodeShape,
        defaultCollectionMode: this.settings.defaultCollectionMode,
        defaultConnectionStyle: this.settings.connectionStyle
      });
      if (verified.document.documentId !== persistedDocumentId) {
        throw new Error("The mind-tree identity changed before it could be verified.");
      }

      for (const view of openViews) view.adoptDocumentIdentity(persistedPath, persistedDocumentId);
      if (sharedSession && identityWriteSource !== undefined) {
        // This verified plugin-owned write becomes the new comparison baseline;
        // a delayed TextFileView modify event must not be mistaken for Sync.
        sharedSession.history.replaceBaseline(verifiedSource);
        sharedSession.replaceSource(verifiedSource, "identity-writer");
      }
      return {
        file: this.app.vault.getFileByPath(persistedPath) ?? file,
        documentId: persistedDocumentId
      };
    } finally {
      if (identityWriteSource !== undefined) sharedSession?.endWrite(identityWriteSource);
    }
  }

  /** Re-render all views when a global appearance preference changes. */
  refreshOpenMindTreeLayouts(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
      if (leaf.view instanceof MindTreeView) leaf.view.refreshLayoutFromSettings();
    }
  }

  private registerDirectOpenRouting(): void {
    const plugin = this;
    this.openCoordinator = new MindTreeOpenCoordinator({
      findExisting: (path, requested) => {
        let match: WorkspaceLeaf | undefined;
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (!match && leaf !== requested && leaf.getViewState().type === MIND_TREE_VIEW_TYPE
            && canonicalTreePath(this.getLeafFilePath(leaf) ?? "") === path) match = leaf;
        });
        return match;
      },
      reveal: (leaf) => this.app.workspace.revealLeaf(leaf),
      discardRedirected: (requested, winner, path) => {
        if (requested === winner) return;
        const state = requested.getViewState();
        // Never close a reused leaf containing some other document. Empty
        // request leaves and restored duplicates contain no distinct user work.
        if (state.type === "empty" || (["markdown", MIND_TREE_VIEW_TYPE].includes(state.type)
          && canonicalTreePath(this.getLeafFilePath(requested) ?? "") === path)) requested.detach();
      }
    });
    this.register(around(WorkspaceLeaf.prototype, {
      openFile(next: WorkspaceLeaf["openFile"]) {
        return function (this: WorkspaceLeaf, file: TFile, ...rest: Parameters<WorkspaceLeaf["openFile"]> extends [TFile, ...infer R] ? R : never) {
          if (!isMindTreePath(file.path)) return next.apply(this, [file, ...rest]);
          return plugin.openCoordinator.open(file.path, this, () => next.apply(this, [file, ...rest]), rest[0]?.active !== false, true)
            .then(() => undefined);
        };
      },
      setViewState(next: WorkspaceLeaf["setViewState"]) {
        return function (
          this: WorkspaceLeaf,
          viewState: ViewState,
          ...rest: [ViewStateResult?]
        ): ReturnType<WorkspaceLeaf["setViewState"]> {
          const routed = routeMindTreeViewState(viewState);
          const path = routed.state?.["file"];
          if (routed.type !== MIND_TREE_VIEW_TYPE || typeof path !== "string"
            || plugin.openCoordinator.consumeNestedRoute(path, this)) return next.apply(this, [routed, ...rest]);
          return plugin.openCoordinator.open(path, this, () => next.apply(this, [routed, ...rest]), routed.active === true)
            .then(() => undefined);
        };
      }
    }));
  }

  private async reportUnlocatedPendingVersions(): Promise<void> {
    try {
      const missing = (await this.pendingConflicts.pendingPaths()).filter((path) => !this.app.vault.getFileByPath(path));
      if (missing.length) new Notice(t("conflict.unlocated", { paths: missing.join("\n") }), 0);
    } catch (error) { new Notice(t("conflict.storageError", { message: String(error) }), 0); }
  }

  /** Restored leaves may predate routing hooks; keep one owner without focus changes. */
  private async deduplicateRestoredMindTrees(): Promise<void> {
    const groups = new Map<string, WorkspaceLeaf[]>();
    const active = this.app.workspace.getMostRecentLeaf();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const path = this.getLeafFilePath(leaf);
      if (!path || !isMindTreePath(path) || !["markdown", MIND_TREE_VIEW_TYPE].includes(leaf.getViewState().type)) return;
      const canonical = canonicalTreePath(path);
      groups.set(canonical, [...groups.get(canonical) ?? [], leaf]);
    });
    for (const [path, leaves] of groups) {
      // Retain a live tree (and its pending session) before a deferred Markdown
      // leaf. Remove duplicates before conversion so routing cannot redirect
      // the chosen owner to a duplicate that is about to be detached.
      leaves.sort((a, b) => Number(b.getViewState().type === MIND_TREE_VIEW_TYPE) - Number(a.getViewState().type === MIND_TREE_VIEW_TYPE)
        || Number(b === active) - Number(a === active));
      const leaf = leaves[0]!;
      for (const duplicate of leaves.slice(1)) duplicate.detach();
      if (leaf.getViewState().type !== MIND_TREE_VIEW_TYPE) {
        try { await leaf.setViewState({ type: MIND_TREE_VIEW_TYPE, state: { file: path }, active: false }); }
        catch (error) { new Notice(t("notice.operationFailed", { message: String(error) })); }
      }
      if (active && active !== leaf && leaves.includes(active)) await this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Allocate a destination only if a tree does not already have an owner. */
  async openLinkedFile(file: TFile, destination: () => WorkspaceLeaf): Promise<void> {
    if (isMindTreePath(file.path)) {
      const existing = this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)
        .find((leaf) => canonicalTreePath(this.getLeafFilePath(leaf) ?? "") === canonicalTreePath(file.path));
      if (existing) { await this.app.workspace.revealLeaf(existing); return; }
      await this.activateMindTree(file, destination());
      return;
    }
    const leaf = destination();
    await leaf.openFile(file, { active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateMindTree(file: TFile, preferredLeaf?: WorkspaceLeaf): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)
      .find((leaf) => this.getLeafFilePath(leaf) === file.path);
    if (existing) {
      if (preferredLeaf && preferredLeaf !== existing && preferredLeaf.getViewState().type === "empty") preferredLeaf.detach();
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = preferredLeaf ?? this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    if (leaf.getViewState().type === MIND_TREE_VIEW_TYPE && this.getLeafFilePath(leaf) === file.path) return;
    await leaf.setViewState({ type: MIND_TREE_VIEW_TYPE, state: { file: file.path }, active: true });
  }

  private async activateMindTreeLeaf(leaf: WorkspaceLeaf | null): Promise<void> {
    if (!leaf || leaf.getViewState().type === MIND_TREE_VIEW_TYPE) return;
    const filePath = this.getLeafFilePath(leaf);
    if (!filePath || !isMindTreePath(filePath)) return;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) await this.activateMindTree(file, leaf);
  }

  private scheduleMindTreeActivation(file: TFile): void {
    if (this.pendingActivationTimer !== undefined) window.clearTimeout(this.pendingActivationTimer);
    this.pendingActivationTimer = window.setTimeout(() => {
      this.pendingActivationTimer = undefined;
      const leaf = this.findLeafForFile(file.path);
      if (leaf) void this.activateMindTreeLeaf(leaf);
    });
  }

  private findLeafForFile(filePath: string): WorkspaceLeaf | undefined {
    const recent = this.app.workspace.getMostRecentLeaf();
    if (recent && this.getLeafFilePath(recent) === filePath) return recent;
    let match: WorkspaceLeaf | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!match && this.getLeafFilePath(leaf) === filePath) match = leaf;
    });
    return match;
  }

  private getLeafFilePath(leaf: WorkspaceLeaf): string | undefined {
    const state = leaf.getViewState().state as { file?: unknown } | undefined;
    return typeof state?.file === "string" ? state.file : undefined;
  }

  private promptCreateMindTree(): void {
    if (this.updateRuntime.paused) return;
    new TextPromptModal(this.app, t("tree.create"), t("tree.newName"), t("tree.namePlaceholder"), t("action.create"), (title) => void this.createMindTree(title)).open();
  }

  /** Ribbon creation explicitly asks for a destination instead of inferring it. */
  private promptCreateMindTreeInFolder(): void {
    if (this.updateRuntime.paused) return;
    const active = this.app.workspace.getActiveFile();
    const currentFolderPath = active?.parent?.isRoot() ? "" : active?.parent?.path ?? "";
    const folderPaths = [...new Set([
      "",
      ...this.app.vault.getAllFolders(true).map((folder) => folder.isRoot() ? "" : folder.path)
    ])].sort((left, right) => left.localeCompare(right));
    new CreateMindTreeModal(
      this.app,
      folderPaths,
      currentFolderPath,
      ({ title, folderPath }) => void this.createMindTree(title, folderPath)
    ).open();
  }

  private async createMindTree(title: string, targetFolderPath?: string): Promise<void> {
    if (this.updateRuntime.paused) return;
    try {
      const active = this.app.workspace.getActiveFile();
      // Commands retain their existing active-file default; the Ribbon passes
      // the folder chosen explicitly in CreateMindTreeModal.
      const activeDirectory = active?.parent?.isRoot() ? "" : active?.parent?.path ?? "";
      const directory = targetFolderPath === undefined ? activeDirectory : normalizePath(targetFolderPath);
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
      if (!safeTitle) throw new Error(t("tree.invalidName"));
      let path = normalizePath(`${directory ? `${directory}/` : ""}${safeTitle}.mtn.md`);
      let counter = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        path = normalizePath(`${directory ? `${directory}/` : ""}${safeTitle} ${counter}.mtn.md`);
        counter += 1;
      }
      // Global appearance and collection choices are copied once into the new
      // file's YAML. Later preference changes must not rewrite existing trees.
      const file = await this.app.vault.create(
        path,
        createMindTreeFile(
          safeTitle,
          this.settings.theme,
          this.settings.defaultLayoutMode,
          this.settings.nodeShape,
          this.settings.defaultCollectionMode,
          this.settings.connectionStyle
        )
      );
      await this.activateMindTree(file, this.app.workspace.getLeaf("tab"));
    } catch (error) {
      new Notice(t("notice.createTreeFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  private activeMindTreeView(): MindTreeView | undefined {
    if (this.updateRuntime.paused) return undefined;
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof MindTreeView ? leaf.view : undefined;
  }

  private scheduleResourceCacheSave(): void {
    if (this.unloading) return;
    if (this.cacheSaveTimer !== undefined) window.clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = window.setTimeout(() => {
      this.cacheSaveTimer = undefined;
      this.resourceCache.save(this.resources.entries());
    }, 500);
  }
}
