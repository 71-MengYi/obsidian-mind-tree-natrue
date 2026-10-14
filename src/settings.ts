import { App, Platform, PluginSettingTab } from "obsidian";
import { t, type TranslationKey } from "./i18n";
import type MindTreeNaturePlugin from "./main";
import type { ResourceIndexProgress } from "./services/resource-catalog";
import { isMcpSupported } from "./services/mcp/availability";
import { AiSettingsPage, BasicSettingsPage, CustomMarkersSettingsPage, MindMapSettingsPage, TopicNoteSettingsPage } from "./ui/settings-pages";
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
/** `all` = every platform; `desktop` = only where the plugin can serve it. */
export type SettingsPageAvailability = "all" | "desktop";

export interface SettingsPageEntry {
  id: string;
  label: TranslationKey;
  availability: SettingsPageAvailability;
  create: (panel: HTMLElement, port: SettingsPagePort) => SettingsPageObject;
}

export const SETTINGS_PAGES = [
  { id: "basic", label: "settings.tabs.basic", availability: "all", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new BasicSettingsPage(panel, port) },
  { id: "mind-map", label: "settings.tabs.mindMap", availability: "all", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new MindMapSettingsPage(panel, port) },
  { id: "topic-notes", label: "settings.tabs.topicNotes", availability: "all", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new TopicNoteSettingsPage(panel, port) },
  { id: "custom-markers", label: "settings.tabs.customMarkers", availability: "all", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new CustomMarkersSettingsPage(panel, port) },
  { id: "ai", label: "settings.tabs.ai", availability: "desktop", create: (panel: HTMLElement, port: SettingsPagePort): SettingsPageObject => new AiSettingsPage(panel, port) }
] as const satisfies ReadonlyArray<SettingsPageEntry>;

type SettingsPage = (typeof SETTINGS_PAGES)[number]["id"];
/** Kept as the literal union so `id` never widens to `string` after filtering. */
type SettingsPageEntryUnion = (typeof SETTINGS_PAGES)[number];

/**
 * Whether this platform may host one declared page.
 *
 * Desktop availability reuses the MCP platform predicate on purpose: the tab,
 * the transport and the controller must never disagree about what can run here,
 * and one shared predicate is what keeps them from drifting apart.
 *
 * An unavailable page is deliberately *absent* rather than visible-but-inert:
 * a tab the device cannot act on would be dishonest about what it can do.
 */
export function isSettingsPageAvailable(
  entry: { readonly availability: SettingsPageAvailability },
  facts: { readonly isDesktop: boolean }
): boolean {
  return entry.availability === "all" || isMcpSupported(facts);
}

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

    const pages = this.availablePages();
    this.renderPageTabs(containerEl, pages);
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
      },
      mcp: this.plugin.mcpSettings()
    };
    // An unavailable page can never become the active one: a stale preference
    // (or a settings pane synced from another device) falls back to the first
    // page this platform can actually host instead of rendering a dead tab.
    const active = pages.find((entry) => entry.id === this.activePage) ?? pages[0] ?? SETTINGS_PAGES[0];
    this.activePage = active.id;
    this.page = active.create(panel, port);
    this.tooltips = new AdaptiveTooltipController(containerEl);
  }

  private availablePages(): ReadonlyArray<SettingsPageEntryUnion> {
    const facts = { isDesktop: !Platform.isMobile };
    return SETTINGS_PAGES.filter((entry) => isSettingsPageAvailable(entry, facts));
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

  private renderPageTabs(container: HTMLElement, pages: ReadonlyArray<SettingsPageEntryUnion>): void {
    const tabList = container.createDiv({ cls: "mtn-settings-tabs", attr: { role: "tablist" } });
    for (const page of pages) {
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
