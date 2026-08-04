import { App, PluginSettingTab, Setting } from "obsidian";
import { t, type TranslationKey } from "./i18n";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme
} from "./types";
import {
  MAX_NODE_WRAP_WIDTH,
  MIN_NODE_WRAP_WIDTH,
  normalizeNodeWrapWidth
} from "./ui/layout";
import {
  COLLECTION_MODE_OPTIONS,
  CONNECTION_OPTIONS,
  LAYOUT_OPTIONS,
  NODE_SHAPE_OPTIONS,
  THEME_OPTIONS
} from "./ui/presentation";
import { normalizeNewNoteDefaultContent } from "./services/note-content";
import type MindTreeNaturePlugin from "./main";
import type { MindTreeSettings } from "./settings-model";
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
    if (this.activePage === "basic") this.renderBasicSettings(panel);
    else if (this.activePage === "mind-map") this.renderMindMapSettings(panel);
    else this.renderTopicNoteSettings(panel);
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

  private renderBasicSettings(container: HTMLElement): void {
    container.createEl("h3", { text: t("settings.tabs.basic") });

    new Setting(container)
      .setName(t("settings.autosave.name"))
      .setDesc(t("settings.autosave.desc"))
      .addSlider((slider) => slider
        .setLimits(250, 2_000, 250)
        .setDynamicTooltip()
        .setValue(this.plugin.settings.autosaveDelayMs)
        .onChange(async (value) => {
          this.plugin.settings.autosaveDelayMs = value;
          await this.plugin.saveSettings();
        }));
  }

  /** Global appearance/export preferences plus defaults for newly created trees. */
  private renderMindMapSettings(container: HTMLElement): void {
    container.createEl("h3", { text: t("settings.tabs.mindMap") });

    new Setting(container)
      .setName(t("settings.defaultLayout.name"))
      .setDesc(t("settings.defaultLayout.desc"))
      .addDropdown((dropdown) => {
        for (const option of LAYOUT_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown
          .setValue(this.plugin.settings.defaultLayoutMode)
          .onChange(async (value) => {
            // This preference initializes new files only. Existing trees keep
            // the layoutMode stored in their own YAML and are not refreshed.
            this.plugin.settings.defaultLayoutMode = value as MindTreeLayoutMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t("settings.defaultCollectionMode.name"))
      .setDesc(t("settings.defaultCollectionMode.desc"))
      .addDropdown((dropdown) => {
        for (const option of COLLECTION_MODE_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown
          .setValue(this.plugin.settings.defaultCollectionMode)
          .onChange(async (value) => {
            // Like layout/theme/shape, this value is copied only when a tree is
            // created or when an older file has no collectionMode property.
            this.plugin.settings.defaultCollectionMode = value as MindTreeCollectionMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t("settings.nodeAlignment.name"))
      .setDesc(t("settings.nodeAlignment.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("level", t("settings.nodeAlignment.level"))
        .addOption("compact", t("settings.nodeAlignment.compact"))
        .setValue(this.plugin.settings.nodeAlignment)
        .onChange(async (value) => {
          this.plugin.settings.nodeAlignment = value as MindTreeNodeAlignment;
          this.plugin.refreshOpenMindTreeLayouts();
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.newNoteOpenMode.name"))
      .setDesc(t("settings.newNoteOpenMode.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("split-right", t("settings.newNoteOpenMode.splitRight"))
        .addOption("tab", t("settings.newNoteOpenMode.tab"))
        .addOption("current", t("settings.newNoteOpenMode.current"))
        .addOption("window", t("settings.newNoteOpenMode.window"))
        .setValue(this.plugin.settings.newNoteOpenMode)
        .onChange(async (value) => {
          this.plugin.settings.newNoteOpenMode = value as MindTreeSettings["newNoteOpenMode"];
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.theme.name"))
      .setDesc(t("settings.theme.desc"))
      .addDropdown((dropdown) => {
        for (const option of THEME_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value as MindTreeTheme;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t("settings.connection.name"))
      .setDesc(t("settings.connection.desc"))
      .addDropdown((dropdown) => {
        for (const option of CONNECTION_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown
          .setValue(this.plugin.settings.connectionStyle)
          .onChange(async (value) => {
            // Existing trees keep their YAML connectionStyle; this value only
            // initializes new trees and repairs files where the key is absent.
            this.plugin.settings.connectionStyle = value as MindTreeConnectionStyle;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t("settings.nodeShape.name"))
      .setDesc(t("settings.nodeShape.desc"))
      .addDropdown((dropdown) => {
        for (const option of NODE_SHAPE_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown
          .setValue(this.plugin.settings.nodeShape)
          .onChange(async (value) => {
            // Existing trees keep their YAML nodeShape; this value initializes
            // only new files and v1 files migrated for the first time.
            this.plugin.settings.nodeShape = value as MindTreeNodeShape;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t("settings.nodeWrapWidth.name"))
      .setDesc(t("settings.nodeWrapWidth.desc"))
      .addSlider((slider) => slider
        .setLimits(MIN_NODE_WRAP_WIDTH, MAX_NODE_WRAP_WIDTH, 20)
        .setDynamicTooltip()
        .setValue(normalizeNodeWrapWidth(this.plugin.settings.nodeWrapWidth))
        .onChange(async (value) => {
          this.plugin.settings.nodeWrapWidth = normalizeNodeWrapWidth(value);
          this.plugin.refreshOpenMindTreeLayouts();
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.pngScale.name"))
      .setDesc(t("settings.pngScale.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("1", "1x")
        .addOption("2", "2x")
        .addOption("3", "3x")
        .setValue(String(this.plugin.settings.pngScale))
        .onChange(async (value) => {
          this.plugin.settings.pngScale = Number(value) as 1 | 2 | 3;
          await this.plugin.saveSettings();
        }));
  }

  /** Note behavior and shared scan exclusions apply consistently across trees. */
  private renderTopicNoteSettings(container: HTMLElement): void {
    container.createEl("h3", { text: t("settings.tabs.topicNotes") });

    new Setting(container)
      .setName(t("settings.newNoteFolder.name"))
      .setDesc(t("settings.newNoteFolder.desc"))
      .addText((text) => text
        .setPlaceholder("notes")
        .setValue(this.plugin.settings.newNoteFolder)
        .onChange(async (value) => {
          this.plugin.settings.newNoteFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.newNoteDefaultContent.name"))
      .setDesc(t("settings.newNoteDefaultContent.desc"))
      .addTextArea((text) => {
        text
          .setPlaceholder(t("settings.newNoteDefaultContent.placeholder"))
          .setValue(this.plugin.settings.newNoteDefaultContent)
          .onChange(async (value) => {
            // Preserve the user's Markdown byte-for-byte at the setting layer;
            // leading indentation and trailing blank lines may be meaningful.
            this.plugin.settings.newNoteDefaultContent = normalizeNewNoteDefaultContent(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 8;
        text.inputEl.addClass("mtn-new-note-default-content");
      });

    new Setting(container)
      .setName(t("settings.templateFolder.name"))
      .setDesc(t("settings.templateFolder.desc"))
      .addText((text) => text
        .setPlaceholder("templates")
        .setValue(this.plugin.settings.templateFolder)
        .onChange(async (value) => {
          this.plugin.settings.templateFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.ignore.name"))
      .setDesc(t("settings.ignore.desc"))
      .addTextArea((text) => text
        .setPlaceholder(".obsidian/\n.trash/")
        .setValue(this.plugin.settings.ignoredPathPrefixes.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.ignoredPathPrefixes = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    container.createEl("h4", { text: t("settings.linkedResources.heading") });

    new Setting(container)
      .setName(t("settings.titleSync.name"))
      .setDesc(t("settings.titleSync.desc"))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.titleSync)
        .onChange(async (value) => {
          this.plugin.settings.titleSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.nonMarkdownIdSeparator.name"))
      .setDesc(t("settings.nonMarkdownIdSeparator.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("@", "@")
        .addOption("%", "%")
        .setValue(this.plugin.settings.nonMarkdownIdSeparator)
        .onChange(async (value) => {
          this.plugin.settings.nonMarkdownIdSeparator = value === "%" ? "%" : "@";
          await this.plugin.saveSettings();
        }));

    new Setting(container)
      .setName(t("settings.openMode.name"))
      .setDesc(t("settings.openMode.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("tab", t("settings.openMode.tab"))
        .addOption("split-right", t("settings.openMode.splitRight"))
        .setValue(this.plugin.settings.resourceOpenMode)
        .onChange(async (value) => {
          this.plugin.settings.resourceOpenMode = value as MindTreeSettings["resourceOpenMode"];
          await this.plugin.saveSettings();
        }));
  }
}
