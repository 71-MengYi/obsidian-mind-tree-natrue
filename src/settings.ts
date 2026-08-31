import { App, PluginSettingTab } from "obsidian";
import { t, type TranslationKey } from "./i18n";
import type MindTreeNaturePlugin from "./main";
import { BasicSettingsPage, MindMapSettingsPage, TopicNoteSettingsPage } from "./ui/settings-pages";
export { DEFAULT_SETTINGS } from "./settings-model";
export type { MindTreeSettings } from "./settings-model";

/**
 * Cross-tree preferences remain in plugin data. Layout, theme, connection and
 * shape preferences are creation defaults; active values live per document.
 */
type SettingsPage = "basic" | "mind-map" | "topic-notes";

const SETTINGS_PAGES: ReadonlyArray<{ id: SettingsPage; label: TranslationKey }> = [
  { id: "basic", label: "settings.tabs.basic" },
  { id: "mind-map", label: "settings.tabs.mindMap" },
  { id: "topic-notes", label: "settings.tabs.topicNotes" }
];

export class MindTreeSettingTab extends PluginSettingTab {
  private activePage: SettingsPage = "basic";

  constructor(app: App, private readonly plugin: MindTreeNaturePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mtn-settings");
    containerEl.createEl("h2", { text: t("app.name") });

    this.renderPageTabs(containerEl);
    const panel = containerEl.createDiv({ cls: "mtn-settings-panel", attr: { role: "tabpanel" } });
    const port = {
      settings: this.plugin.settings,
      save: () => this.plugin.saveSettings(),
      refreshOpenLayouts: () => this.plugin.refreshOpenMindTreeLayouts()
    };
    if (this.activePage === "basic") new BasicSettingsPage(panel, port);
    else if (this.activePage === "mind-map") new MindMapSettingsPage(panel, port);
    else new TopicNoteSettingsPage(panel, port);
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
