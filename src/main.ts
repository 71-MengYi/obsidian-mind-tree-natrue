import { addIcon, normalizePath, Notice, Platform, Plugin, removeIcon, requestUrl, requireApiVersion, TFile, WorkspaceLeaf, type ViewState, type ViewStateResult } from "obsidian";
import { around } from "monkey-around";
import { parseMindTreeFile, serializeMindTreeFile, type ParseMindTreeOptions } from "./format/document";
import { addNode } from "./domain/tree";
import { createBranchReference, BRANCH_REFERENCE_LANGUAGE, parseBranchReference, type BranchReference } from "./domain/branch-reference";
import { t } from "./i18n";
import { ResourceIndexService, type ResourceIndexProgress, type ResourceIndexReport } from "./services/resource-index";
import { LocalResourceCache } from "./services/local-resource-cache";
import { SettingsPersistence, removeLegacyResourceIndex } from "./services/settings-persistence";
import { decideDocumentIdentityWrite } from "./services/resource-identity";
import { MindTreeSessionRegistry, type SharedMindTreeSession } from "./services/mind-tree-session-registry";
import { MindTreeReferenceService } from "./services/mind-tree-reference";
import { MindTreeCreationService } from "./services/tree-creation";
import { PendingConflictStore } from "./services/pending-conflict-store";
import { PendingConflictMaintenance } from "./services/pending-conflict-maintenance";
import { VersionConflictCoordinator } from "./services/version-conflict-coordinator";
import { readStableSource } from "./services/stable-source-read";
import { MindTreeOpenCoordinator } from "./services/mind-tree-open-coordinator";
import { canonicalTreePath } from "./services/pending-conflict-store";
import { isMcpSupported } from "./services/mcp/availability";
import { handleMcpMessage } from "./services/mcp/mcp-core";
import { McpServerController } from "./services/mcp/mcp-server";
import { ObsidianToolHost } from "./services/mcp/obsidian-tool-host";
import { MindTreeSessionWriter } from "./services/mcp/session-writer";
import { parseMcpPortInput, type McpSettingsStatus } from "./services/mcp/settings-page-model";
import { McpToolError } from "./services/mcp/tool-error";
import { MindTreePathLocator } from "./services/mcp/tree-locator";
import { MindTreeReader } from "./services/mcp/tree-reader";
import { normalizePluginData, type PluginData } from "./plugin-data";
import { DEFAULT_SETTINGS, MindTreeSettingTab, type MindTreeSettings } from "./settings";
import { createParseOptions, normalizeMcpPort } from "./settings-model";
import { unsupportedMcpSettingsPort, type McpSettingsPagePort } from "./ui/settings-pages/ports";
import {
  CHAIN_BROKEN_ICON,
  CHAIN_BROKEN_ICON_SVG,
  SHARE_SQUARE_ICON,
  SHARE_SQUARE_ICON_SVG,
} from "./ui/icons";
import { MindTreeView } from "./ui/mind-tree-view";
import { MindTreeReferenceRenderChild, type MindTreeReferenceEmbedPorts } from "./ui/components/mind-tree-reference-embed";
import { CreateMindTreeModal, PluginUpdateModal, TextPromptModal } from "./ui/modals/index";
import { LAYOUT_OPTIONS } from "./render/presentation";
import { isMindTreePath, MIND_TREE_VIEW_TYPE, routeMindTreeViewState } from "./view-routing";
import type { MindTreeDocument, MindTreeNode, NodeId, FileResourceRef } from "./types";
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
  private conflictMaintenance!: PendingConflictMaintenance<TFile>;
  /** Resolves note-embedded branch references without requiring an open view. */
  private references!: MindTreeReferenceService;
  /** The one path that creates a `.mtn.md`, shared by the UI and the MCP tools. */
  private treeCreation!: MindTreeCreationService<TFile>;
  /**
   * The MCP subsystem. Absent on a platform that cannot serve it, which is what
   * makes "unsupported" a fact about the object graph rather than a flag.
   */
  private mcpServer?: McpServerController;
  private mcpReader?: MindTreeReader;


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
          // Global defaults fill absent YAML properties, so every cached parse
          // could now describe settings the user just changed.
          this.mcpReader?.invalidateAll();
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
    // A note can embed a tree that is open nowhere, so reference resolution is
    // owned by the plugin and refreshed by vault events rather than by a view.
    this.references = new MindTreeReferenceService({
      fileExists: (path) => Boolean(this.app.vault.getFileByPath(path)),
      read: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error(t("notice.fileNotFound", { path }));
        return this.app.vault.read(file);
      },
      parseOptions: () => this.documentParseOptions(),
      indexedTreePaths: (documentId) => this.resources.entries()
        .filter((entry) => entry.resourceId === documentId && isMindTreePath(entry.path))
        .map((entry) => entry.path)
    });
    this.register(() => this.references.destroy());
    const notifyReferenceChange = (file: { path: string }): void => {
      if (isMindTreePath(file.path)) this.references.notifyChanged(file.path);
    };
    // A parsed tree the MCP reader cached is only valid until the vault changes.
    // Folder events report the folder alone, so every child path is dropped.
    const forgetParsedTree = (file: { path: string }, previousPath?: string): void => {
      if (!this.mcpReader) return;
      if (previousPath !== undefined) this.mcpReader.invalidate(previousPath);
      if (isMindTreePath(file.path)) this.mcpReader.invalidate(file.path);
    };
    this.registerEvent(this.app.vault.on("create", notifyReferenceChange));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      notifyReferenceChange(file);
      forgetParsedTree(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        this.references.notifyRemoved(file.path);
        forgetParsedTree(file);
      } else {
        this.references.notifyChanged();
        this.mcpReader?.invalidateAll();
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      // A folder rename reports the folder alone; every child path changed.
      if (file instanceof TFile) {
        this.references.notifyRenamed(oldPath, file.path);
        forgetParsedTree(file, oldPath);
      } else {
        this.references.notifyChanged();
        this.mcpReader?.invalidateAll();
      }
    }));
    this.registerEvent(this.app.metadataCache.on("changed", notifyReferenceChange));
    // Journal maintenance owns its debounce timers and decisions; vault reads,
    // view refreshes and notices stay here as thin ports.
    this.conflictMaintenance = new PendingConflictMaintenance<TFile>({
      pendingConflicts: this.pendingConflicts,
      resources: this.resources,
      sessions: this.mindTreeSessions,
      vaultFiles: () => this.app.vault.getFiles(),
      documentIdAt: (file) => {
        const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["documentId"];
        return typeof value === "string" && value ? value : undefined;
      },
      parseOptions: () => this.documentParseOptions(),
      refreshOpenViews: (path) => {
        for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
          if (leaf.view instanceof MindTreeView && leaf.view.file?.path === path) leaf.view.checkExternalVersion();
        }
      },
      clock: {
        setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
        clearTimeout: (handle) => window.clearTimeout(handle)
      },
      noticeStorageError: (error) => new Notice(t("conflict.storageError", { message: String(error) }), 0),
      noticeDiscarded: (paths) => new Notice(t("conflict.discarded", { paths: [...paths].sort().join("\n") }), 0),
      isUnloading: () => this.unloading
    });
    // The Ribbon, the command and the MCP `create_tree` tool share this one
    // creation path, so a tree made by a tool is the same tree a user would get.
    this.treeCreation = new MindTreeCreationService<TFile>({
      fileExists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
      createFile: async (path, source) => {
        const file = await this.app.vault.create(path, source);
        // The parsed document is the identity the caller reports back, so a new
        // tree needs no second disk read to learn its root id.
        return { file, document: parseMindTreeFile(source, this.documentParseOptions()).document };
      },
      appendChildren: async (file, titles) => {
        const created: NodeId[] = [];
        // Compare-and-set on the file this plugin just created: at this point the
        // only writer is this call, so the initial children land in one write.
        await this.app.vault.process(file, (source) => {
          const document = parseMindTreeFile(source, this.documentParseOptions()).document;
          for (const title of titles) created.push(addNode(document, document.rootId, title).id);
          return serializeMindTreeFile(document, source);
        });
        return created;
      },
      // Focus is the caller's decision: an MCP tool must never steal it.
      activate: async (file, focus) => {
        if (!focus) return;
        await this.activateMindTree(file, this.app.workspace.getLeaf("tab"));
      }
    });
    if (isMcpSupported({ isDesktop: !Platform.isMobile })) this.initializeMcpServer();
    addIcon(SHARE_SQUARE_ICON, SHARE_SQUARE_ICON_SVG);
    this.register(() => removeIcon(SHARE_SQUARE_ICON));
    addIcon(CHAIN_BROKEN_ICON, CHAIN_BROKEN_ICON_SVG);
    this.register(() => removeIcon(CHAIN_BROKEN_ICON));
    // A reference block is user-editable note text: parse defensively and let the
    // render child show a placeholder for anything malformed.
    this.registerMarkdownCodeBlockProcessor(BRANCH_REFERENCE_LANGUAGE, (source, el, ctx) => {
      ctx.addChild(new MindTreeReferenceRenderChild(el, parseBranchReference(source), this.referenceEmbedPorts()));
    });
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
    this.addViewCommand("add-child-node", t("command.addChild"), (view) => view.addChildNode());
    this.addViewCommand("undo-mind-tree-change", t("command.undo"), (view) => view.undo());
    this.addViewCommand("redo-mind-tree-change", t("command.redo"), (view) => view.redo());
    this.addViewCommand("fit-mind-tree-canvas", t("command.fitCanvas"), (view) => view.fitCanvas());
    for (const option of LAYOUT_OPTIONS) {
      this.addViewCommand(`set-mind-tree-layout-${option.value}`, t(option.command), (view) => view.setLayoutMode(option.value));
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
      void this.rebuildResourceIndex()
        .catch((error: unknown) => this.reportIndexFailure(error))
        // Journal cleanup reads vault paths and indexed identities, so it waits
        // for the background index instead of racing it.
        .then(() => { if (!this.unloading) return this.reportUnlocatedPendingVersions(); })
        .catch(() => undefined);
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
        this.scheduleConflictCleanup();
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
        // A move that missed the synchronous rekey above is repaired here.
        if (files.some((child) => isMindTreePath(child.path))) this.scheduleConflictCleanup();
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
    if (this.conflictMaintenance !== undefined) this.conflictMaintenance.cancel();
    // Stop accepting new tool calls before the services they depend on go away.
    void this.mcpServer?.stop();
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

  private documentParseOptions(): Readonly<ParseMindTreeOptions> {
    return createParseOptions(this.settings);
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
      // Every decision compares settled bytes: a read that overlapped another
      // writer must never be presented as a version, let alone as damage.
      read: async () => {
        const outcome = await readStableSource({
          stamp: async () => {
            const current = this.app.vault.getFileByPath(session.path);
            return current ? `${current.stat.ctime}:${current.stat.mtime}:${current.stat.size}` : undefined;
          },
          read: () => this.app.vault.read(requireFile()),
          delay: (milliseconds) => new Promise<void>((resolve) => { window.setTimeout(resolve, milliseconds); })
        });
        if (outcome.ok) return outcome.source;
        throw new Error(outcome.reason === "unstable"
          ? t("conflict.unstableRead")
          : t("conflict.fileMissing", { path: session.path }));
      },
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
        const parsed = parseMindTreeFile(source, this.documentParseOptions());
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
      const verified = parseMindTreeFile(verifiedSource, this.documentParseOptions());
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

  /**
   * Build the pointer a Markdown note can embed. The tree identity is
   * allocated here, at the moment the user asks for a reference, so a later
   * rename or move of the `.mtn.md` file cannot invalidate it. `ensureStableReference`
   * reuses the existing lazy-identity pipeline and keeps every open view aligned.
   */
  async buildBranchReference(
    file: TFile,
    nodeId: NodeId,
    document: MindTreeDocument
  ): Promise<BranchReference> {
    const current = this.app.vault.getFileByPath(file.path);
    if (!current || !document.nodes[nodeId]) throw new Error(t("notice.resourceTargetChanged"));
    const identity = document.documentId ?? (await this.resources.ensureStableReference(current)).resourceId;
    return createBranchReference(identity, nodeId, current.path);
  }

  /** Narrow ports for the note-embedded read-only branch view. */
  private referenceEmbedPorts(): MindTreeReferenceEmbedPorts {
    return {
      resolve: (reference) => this.references.resolve(reference),
      subscribe: (listener) => this.references.subscribe(listener),
      openTree: (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (file) void this.activateMindTree(file);
        else new Notice(t("notice.fileNotFound", { path }));
      },
      openResource: (node) => void this.openReferenceResource(node),
      // Images go through the same verified index as the canvas; the embed never
      // touches the vault on its own.
      resolveImageFile: (node) => node.resource?.type === "file"
        ? this.resources.resolve(node.resource)
        : undefined,
      resourcePath: (file) => this.app.vault.getResourcePath(file)
    };
  }

  /**
   * Open one node's linked resource from a note embed. The rules match the
   * canvas: safe http/https URLs go to the browser, files open at the configured
   * location, and nothing is written back to any document.
   */
  private async openReferenceResource(node: Readonly<MindTreeNode>): Promise<void> {
    const resource = node.resource;
    if (!resource) return;
    if (resource.type === "url") {
      let parsed: URL;
      try { parsed = new URL(resource.url); } catch { new Notice(t("notice.invalidLink")); return; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        new Notice(t("notice.unsafeLink"));
        return;
      }
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
      return;
    }
    try {
      const file = await this.resources.resolveVerified(resource);
      if (!file) {
        new Notice(t("notice.fileNotFound", { path: resource.pathHint }));
        return;
      }
      await this.openLinkedFile(file, () => this.settings.resourceOpenMode === "split-right"
        ? this.app.workspace.getLeaf("split", "vertical")
        : this.app.workspace.getLeaf("tab"));
    } catch (error) {
      console.warn("Mind Tree Nature: embedded reference could not open its linked file", error);
      new Notice(t("resourceIndex.unverified"));
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

  /**
   * Pending-version journal maintenance (rebind a uniquely identified move,
   * drop records whose document is gone, report one notice per burst) lives in
   * `services/pending-conflict-maintenance.ts`; these thin wrappers keep the
   * existing call sites and unload wiring local.
   */
  private reportUnlocatedPendingVersions(): Promise<void> {
    return this.conflictMaintenance.reportUnlocated();
  }

  /** Delete/rename bursts settle first; the vault index is read afterwards. */
  private scheduleConflictCleanup(): void {
    this.conflictMaintenance.schedule();
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
      const folderPath = targetFolderPath === undefined ? activeDirectory : normalizePath(targetFolderPath);
      // The same service MCP uses; only the focus request differs, and an
      // interactive creation is the one that is allowed to take focus.
      await this.treeCreation.create({ title, folderPath, focus: true });
    } catch (error) {
      new Notice(t("notice.createTreeFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Commands that act on the active tree share one guard: unavailable without
   * an active Mind Tree view, and a `checking` pass must never run the action.
   */
  private addViewCommand(id: string, name: string, run: (view: MindTreeView) => void): void {
    this.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const view = this.activeMindTreeView();
        if (!view) return false;
        if (!checking) run(view);
        return true;
      }
    });
  }

  private activeMindTreeView(): MindTreeView | undefined {
    if (this.updateRuntime.paused) return undefined;
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof MindTreeView ? leaf.view : undefined;
  }

  /**
   * Builds the local MCP endpoint, or nothing at all on a platform that cannot
   * serve it. The transport needs a TCP listener and node's HTTP module, so a
   * half-registered service would be worse than a clearly absent one.
   */
  private initializeMcpServer(): void {
    this.mcpReader = new MindTreeReader({
      filePaths: () => this.app.vault.getFiles().map((file) => file.path),
      read: (path) => this.readVaultText(path),
      parseOptions: () => this.documentParseOptions()
    });
    const locator = new MindTreePathLocator({
      // The index knows which tree a document id belongs to; the vault sweep in
      // the locator is the fallback for a tree the index never saw.
      indexedTreePaths: (documentId) => this.resources.entries()
        .filter((entry) => entry.resourceId === documentId && isMindTreePath(entry.path))
        .map((entry) => entry.path),
      filePaths: () => this.app.vault.getFiles().map((file) => file.path),
      fileExists: (path) => Boolean(this.app.vault.getFileByPath(path)),
      read: (path) => this.readVaultText(path),
      // "The active mind tree" has one definition in this plugin: the view the
      // user most recently focused.
      activeTreePath: () => this.activeMindTreeView()?.file?.path
    });
    const writer = new MindTreeSessionWriter({
      sessions: this.mindTreeSessions,
      fileExists: (path) => Boolean(this.app.vault.getFileByPath(path)),
      read: (path) => this.readVaultText(path),
      process: (path, transform) => this.processVaultText(path, transform),
      parseOptions: () => this.documentParseOptions(),
      allowsWrites: () => this.settings.mcpAllowWrites,
      fileReference: (filePath) => this.resolveFileReference(filePath),
      creation: this.treeCreation,
      notifyExternalChange: (path) => this.refreshOpenMindTreeViews(path)
    });
    const host = new ObsidianToolHost({
      reader: this.mcpReader,
      writer,
      locator,
      environment: {
        isSupported: () => isMcpSupported({ isDesktop: !Platform.isMobile }),
        allowsWrites: () => this.settings.mcpAllowWrites,
        allowsTreeCreation: () => this.settings.mcpAllowTreeCreation,
        connection: () => ({
          port: this.mcpServer?.port ?? this.settings.mcpPort,
          token: this.mcpServer?.token() ?? ""
        }),
        version: () => this.manifest.version,
        logger: (message) => console.debug(`Mind Tree Nature: ${message}`)
      }
    });
    this.mcpServer = new McpServerController({
      pluginId: this.manifest.id,
      isDesktop: () => !Platform.isMobile,
      // The port and the access token are per device and never synced: one
      // device's token must not unlock another device's endpoint.
      storage: {
        load: (key) => this.app.loadLocalStorage(key),
        save: (key, value) => this.app.saveLocalStorage(key, value)
      },
      handleMessage: (raw) => handleMcpMessage(raw, host),
      logger: (message) => console.debug(`Mind Tree Nature: ${message}`)
    });
    if (this.settings.mcpEnabled) {
      void this.startMcpServer().catch((error: unknown) => {
        // A busy port range is a normal outcome; the operator has the AI tab.
        console.error("Mind Tree Nature: MCP server could not start", error);
      });
    }
  }

  private async startMcpServer(): Promise<McpSettingsStatus> {
    if (!this.mcpServer) return { kind: "unsupported" };
    return this.mcpServer.start(this.settings.mcpPort);
  }

  private async stopMcpServer(): Promise<void> {
    await this.mcpServer?.stop();
  }

  /**
   * The AI settings page's port.
   *
   * Never returns `undefined`: on a platform that cannot serve MCP the page gets
   * the shared unsupported port and renders its desktop-only notice, which is
   * also what keeps the settings pane from having to know about platforms.
   */
  mcpSettings(): McpSettingsPagePort {
    const controller = this.mcpServer;
    if (!controller) return unsupportedMcpSettingsPort();
    const setPort = async (port: number): Promise<void> => {
      const normalized = normalizeMcpPort(port);
      if (normalized === undefined || normalized === this.settings.mcpPort) return;
      this.settings.mcpPort = normalized;
      await this.saveSettings();
      // A bound port cannot be changed in place; restart to apply the choice.
      if (controller.status().kind === "running") {
        await this.stopMcpServer();
        await this.startMcpServer();
      }
    };
    return {
      state: () => ({
        supported: true,
        enabled: this.settings.mcpEnabled,
        allowWrites: this.settings.mcpAllowWrites,
        allowTreeCreation: this.settings.mcpAllowTreeCreation,
        port: this.settings.mcpPort,
        status: controller.status(),
        configuredPort: controller.port,
        token: controller.token()
      }),
      setEnabled: async (enabled) => {
        if (this.settings.mcpEnabled === enabled) return;
        this.settings.mcpEnabled = enabled;
        await this.saveSettings();
        if (enabled) await this.startMcpServer();
        else await this.stopMcpServer();
      },
      setAllowWrites: async (allowWrites) => {
        if (this.settings.mcpAllowWrites === allowWrites) return;
        this.settings.mcpAllowWrites = allowWrites;
        // Read at call time by the writer and the protocol gate, so the next
        // tool call already honours it without restarting the server.
        await this.saveSettings();
      },
      setAllowTreeCreation: async (allowTreeCreation) => {
        if (this.settings.mcpAllowTreeCreation === allowTreeCreation) return;
        this.settings.mcpAllowTreeCreation = allowTreeCreation;
        await this.saveSettings();
      },
      setPort,
      applyPortInput: async (raw) => {
        const port = parseMcpPortInput(raw);
        if (port === undefined) return false;
        await setPort(port);
        return true;
      },
      start: () => this.startMcpServer(),
      stop: () => this.stopMcpServer(),
      copyText: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          // The page then reveals the read-only textarea instead of failing.
          return false;
        }
      }
    };
  }

  private async readVaultText(path: string): Promise<string> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new McpToolError("file-not-found", t("mcp.error.fileNotFound", { path }));
    return this.app.vault.read(file);
  }

  /** Vault.process owns the per-file lock, exactly as a view save does. */
  private async processVaultText(path: string, transform: (source: string) => string): Promise<unknown> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new McpToolError("file-not-found", t("mcp.error.fileNotFound", { path }));
    return this.app.vault.process(file, transform);
  }

  private async resolveFileReference(filePath: string): Promise<FileResourceRef> {
    const file = this.app.vault.getFileByPath(filePath);
    if (!file) throw new McpToolError("file-not-found", t("mcp.error.fileNotFound", { path: filePath }));
    return this.resources.ensureStableReference(file);
  }

  /** A refused MCP write may mean the disk changed; let open views re-read it. */
  private refreshOpenMindTreeViews(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
      if (leaf.view instanceof MindTreeView && leaf.view.file?.path === path) leaf.view.checkExternalVersion();
    }
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
