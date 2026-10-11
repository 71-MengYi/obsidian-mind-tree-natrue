import { App, PluginSettingTab } from "obsidian";
import { t, type TranslationKey } from "./i18n";
import type MindTreeNaturePlugin from "./main";
import type { ResourceIndexProgress } from "./services/resource-catalog";
import { BasicSettingsPage, CustomMarkersSettingsPage, MindMapSettingsPage, TopicNoteSettingsPage } from "./ui/settings-pages";
import type { SettingsPageObject, SettingsPagePort } from "./ui/settings-pages/ports";
import { AdaptiveTooltipController } from "./ui/adaptive-tooltip";
export { DEFAULT_SETTINGS } from "./settings-model";
export type { MindTreeSettings } from "./settings-model";

/**
 * Cross-tree preferences remain in plugin data. Layout, theme, connection and
 * shape preferences are runtime defaults for trees without their own value;
 * active values live per document.
 *
 * One row per tab: the same entry drives the tab strip, the active-page type and
 * the panel factory, so a new page cannot be added to only part of the UI.
 * `create` stays lazy so only the active page's class is instantiated.
 */
const SETTINGS_PAGES = [
  { id: "basic", label: "settings.tabs.basic", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new BasicSettingsPage(panel, port) },
  { id: "mind-map", label: "settings.tabs.mindMap", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new MindMapSettingsPage(panel, port) },
  { id: "topic-notes", label: "settings.tabs.topicNotes", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new TopicNoteSettingsPage(panel, port) },
  { id: "custom-markers", label: "settings.tabs.customMarkers", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new CustomMarkersSettingsPage(panel, port) }
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey; create: (panel: HTMLElement, port: SettingsPagePort) => SettingsPageObject }>;

type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];

export class MindTreeSettingTab extends PluginSettingTab {
  private activePage: SettingsPage = "basic";
  private externalRefreshPending = false;
  private deferredRefreshCleanup?: () => void;
  private page?: SettingsPageObject;
  private tooltips?: AdaptiveTooltipController;

  constructor(app: App, private readonly plugin: MindTreeNaturePlugin) {
    super(app, plugin);
  }

  display(): void {
    this.tooltips?.destroy();
    this.page?.destroy?.();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mtn-settings");
    containerEl.createEl("h2", { text: t("app.name") });

    this.renderPageTabs(containerEl);
    const panel = containerEl.createDiv({ cls: "mtn-settings-panel", attr: { role: "tabpanel" } });
    const port: SettingsPagePort = {
      settings: this.plugin.settings,
      save: () => this.plugin.saveSettings(),
      refreshOpenLayouts: () => this.plugin.refreshOpenMindTreeLayouts(),
      rebuildResourceIndex: (progress?: (value: ResourceIndexProgress) => void) => this.plugin.rebuildResourceIndex(progress),
      updates: {
        check: () => this.plugin.updates.check(),
        showAvailable: () => this.plugin.showAvailableUpdate(),
        subscribe: (listener) => this.plugin.updates.subscribe(listener)
      }
    };
    const active = SETTINGS_PAGES.find((entry) => entry.id === this.activePage) ?? SETTINGS_PAGES[0];
    this.page = active.create(panel, port);
    this.tooltips = new AdaptiveTooltipController(containerEl);
  }

  /** Do not replace an input (or its IME composition) while a user is typing. */
  refreshFromExternal(): void {
    if (!this.containerEl.isShown()) return;
    const active = this.containerEl.ownerDocument.activeElement;
    if (active && this.containerEl.contains(active) && active.matches("input, textarea, [contenteditable]")) {
      this.externalRefreshPending = true;
      if (this.deferredRefreshCleanup) return;
      const refresh = (): void => {
        this.deferredRefreshCleanup?.();
        if (this.externalRefreshPending && this.containerEl.isShown()) this.display();
        this.externalRefreshPending = false;
      };
      active.addEventListener("blur", refresh, { once: true });
      this.deferredRefreshCleanup = () => {
        active.removeEventListener("blur", refresh);
        this.deferredRefreshCleanup = undefined;
      };
      return;
    }
    this.display();
  }

  hide(): void {
    this.tooltips?.destroy();
    this.tooltips = undefined;
    this.page?.destroy?.();
    this.page = undefined;
    this.deferredRefreshCleanup?.();
    this.externalRefreshPending = false;
  }

  private renderPageTabs(container: HTMLElement): void {
    const tabList = container.createDiv({ cls: "mtn-settings-tabs", attr: { role: "tablist" } });
    for (const page of SETTINGS_PAGES) {
      const selected = page.id === this.activePage;
      const button = tabList.createEl("button", {
        cls: "mtn-settings-tab",
        text: t(page.label),
        attr: { type: "button", role: "tab", "aria-selected": String(selected) }
      });
      button.toggleClass("is-active", selected);
      button.addEventListener("click", () => {
        if (this.activePage === page.id) return;
        this.activePage = page.id;
        this.display();
      });
    }
  }

}
