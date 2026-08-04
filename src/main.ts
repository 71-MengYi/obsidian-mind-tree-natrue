import { addIcon, normalizePath, Notice, Plugin, removeIcon, TFile, WorkspaceLeaf, type ViewState, type ViewStateResult } from "obsidian";
import { around } from "monkey-around";
import { createMindTreeFile, parseMindTreeFile, serializeMindTreeFile } from "./format/document";
import { t } from "./i18n";
import { ResourceIndexService, type IndexedResource } from "./services/resource-index";
import { decideDocumentIdentityWrite } from "./services/resource-identity";
import { normalizePluginData, type PluginData } from "./plugin-data";
import { DEFAULT_SETTINGS, MindTreeSettingTab, type MindTreeSettings } from "./settings";
import {
  CHAIN_BROKEN_ICON,
  CHAIN_BROKEN_ICON_SVG,
  SHARE_SQUARE_ICON,
  SHARE_SQUARE_ICON_SVG,
} from "./ui/icons";
import { MindTreeView } from "./ui/mind-tree-view";
import { CreateMindTreeModal, TextPromptModal } from "./ui/modals";
import { LAYOUT_OPTIONS } from "./ui/presentation";
import { isMindTreePath, MIND_TREE_VIEW_TYPE, routeMindTreeViewState } from "./view-routing";

export default class MindTreeNaturePlugin extends Plugin {
  settings: MindTreeSettings = { ...DEFAULT_SETTINGS };
  resources!: ResourceIndexService;
  private switchingFilePath?: string;
  private pendingActivationTimer?: number;
  private resourceIndexData: Record<string, IndexedResource> = {};
  private dataSaveTimer?: number;
  /** Settings and resource-index writes share one chain so stale saves finish first. */
  private dataSaveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.resources = new ResourceIndexService(this.app, this.resourceIndexData, (entries) => {
      this.resourceIndexData = entries;
      this.schedulePluginDataSave();
    }, () => this.settings.nonMarkdownIdSeparator, (file, documentId, expectedDocumentId) =>
      this.writeMindTreeDocumentId(file, documentId, expectedDocumentId));
    addIcon(SHARE_SQUARE_ICON, SHARE_SQUARE_ICON_SVG);
    this.register(() => removeIcon(SHARE_SQUARE_ICON));
    addIcon(CHAIN_BROKEN_ICON, CHAIN_BROKEN_ICON_SVG);
    this.register(() => removeIcon(CHAIN_BROKEN_ICON));
    this.registerView(MIND_TREE_VIEW_TYPE, (leaf) => new MindTreeView(leaf, this));
    this.registerDirectOpenRouting();
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      void this.activateMindTreeLeaf(leaf);
    }));
    this.addSettingTab(new MindTreeSettingTab(this.app, this));

    this.addRibbonIcon("git-fork", t("tree.create"), () => this.promptCreateMindTreeInFolder());
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
      this.resources.rebuild();
      this.registerEvent(this.app.workspace.on("file-open", (file) => {
        if (file && isMindTreePath(file.path)) this.scheduleMindTreeActivation(file);
      }));
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.resources.indexFile(file);
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.resources.indexFile(file);
      }));
      // Vault modify can fire before MetadataCache has parsed new Frontmatter.
      // Re-index and refresh linked views on the cache event, where the
      // excalidraw-plugin property is authoritative and already available.
      this.registerEvent(this.app.metadataCache.on("changed", (file) => {
        const indexed = this.resources.indexFile(file);
        if (!indexed) return;
        for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
          if (leaf.view instanceof MindTreeView) leaf.view.handleResourceMetadataChange(indexed.resourceId);
        }
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => this.resources.removePath(file.path)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.resources.handleRename(file, oldPath);
        for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
          if (leaf.view instanceof MindTreeView) leaf.view.handleResourceRename(file, oldPath);
        }
      }));
      void this.activateMindTreeLeaf(this.app.workspace.getMostRecentLeaf());
    });
  }

  onunload(): void {
    if (this.pendingActivationTimer !== undefined) window.clearTimeout(this.pendingActivationTimer);
    if (this.dataSaveTimer !== undefined) window.clearTimeout(this.dataSaveTimer);
    void this.savePluginData();
    for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) leaf.detach();
  }

  async loadSettings(): Promise<void> {
    const normalized = normalizePluginData(await this.loadData());
    this.settings = normalized.settings;
    this.resourceIndexData = normalized.resourceIndex;
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
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

    let persistedDocumentId = proposedDocumentId;
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
      return serializeMindTreeFile(parsed.document, source);
    });

    for (const view of openViews) view.adoptDocumentIdentity(path, persistedDocumentId);
    return {
      file: this.app.vault.getFileByPath(path) ?? file,
      documentId: persistedDocumentId
    };
  }

  /** Re-render all views when a global appearance preference changes. */
  refreshOpenMindTreeLayouts(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)) {
      if (leaf.view instanceof MindTreeView) leaf.view.refreshLayoutFromSettings();
    }
  }

  private registerDirectOpenRouting(): void {
    this.register(around(WorkspaceLeaf.prototype, {
      setViewState(next: WorkspaceLeaf["setViewState"]) {
        return function (
          this: WorkspaceLeaf,
          viewState: ViewState,
          ...rest: [ViewStateResult?]
        ): ReturnType<WorkspaceLeaf["setViewState"]> {
          return next.apply(this, [routeMindTreeViewState(viewState), ...rest]);
        };
      }
    }));
  }

  async activateMindTree(file: TFile, preferredLeaf?: WorkspaceLeaf): Promise<void> {
    if (this.switchingFilePath === file.path) return;
    const existing = this.app.workspace.getLeavesOfType(MIND_TREE_VIEW_TYPE)
      .find((leaf) => this.getLeafFilePath(leaf) === file.path);
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = preferredLeaf ?? this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf("tab");
    if (leaf.getViewState().type === MIND_TREE_VIEW_TYPE && this.getLeafFilePath(leaf) === file.path) return;
    this.switchingFilePath = file.path;
    try {
      await leaf.setViewState({ type: MIND_TREE_VIEW_TYPE, state: { file: file.path }, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } finally {
      this.switchingFilePath = undefined;
    }
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
    new TextPromptModal(this.app, t("tree.create"), t("tree.newName"), t("tree.namePlaceholder"), t("action.create"), (title) => void this.createMindTree(title)).open();
  }

  /** Ribbon creation explicitly asks for a destination instead of inferring it. */
  private promptCreateMindTreeInFolder(): void {
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
    const leaf = this.app.workspace.getMostRecentLeaf();
    return leaf?.view instanceof MindTreeView ? leaf.view : undefined;
  }

  private schedulePluginDataSave(): void {
    if (this.dataSaveTimer !== undefined) window.clearTimeout(this.dataSaveTimer);
    this.dataSaveTimer = window.setTimeout(() => {
      this.dataSaveTimer = undefined;
      void this.savePluginData();
    }, 500);
  }

  private async savePluginData(): Promise<void> {
    const snapshot = structuredClone({
      settings: this.settings,
      resourceIndex: this.resourceIndexData
    } satisfies PluginData);
    const operation = this.dataSaveQueue.then(() => this.saveData(snapshot));
    // Keep the queue usable after an individual write failure while returning
    // that failure to the explicit settings caller that initiated it.
    this.dataSaveQueue = operation.catch(() => undefined);
    await operation;
  }
}
