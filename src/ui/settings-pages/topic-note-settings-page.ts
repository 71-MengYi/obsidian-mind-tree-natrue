import { Setting } from "obsidian";
import { t } from "../../i18n";
import { normalizeNewNoteDefaultContent } from "../../services/note-content";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

/** Note creation, linking and shared scan exclusions. */
export class TopicNoteSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.topicNotes") });
    new Setting(parent).setName(t("settings.newNoteFolder.name")).setDesc(t("settings.newNoteFolder.desc"))
      .addText((text) => text.setPlaceholder("notes").setValue(port.settings.newNoteFolder).onChange(async (value) => {
        port.settings.newNoteFolder = value.trim(); await port.save();
      }));
    new Setting(parent).setName(t("settings.newNoteDefaultContent.name")).setDesc(t("settings.newNoteDefaultContent.desc"))
      .addTextArea((text) => {
        text.setPlaceholder(t("settings.newNoteDefaultContent.placeholder"))
          .setValue(port.settings.newNoteDefaultContent).onChange(async (value) => {
            port.settings.newNoteDefaultContent = normalizeNewNoteDefaultContent(value);
            await port.save();
          });
        text.inputEl.rows = 8;
        text.inputEl.addClass("mtn-new-note-default-content");
      });
    new Setting(parent).setName(t("settings.templateFolder.name")).setDesc(t("settings.templateFolder.desc"))
      .addText((text) => text.setPlaceholder("templates").setValue(port.settings.templateFolder).onChange(async (value) => {
        port.settings.templateFolder = value.trim(); await port.save();
      }));
    new Setting(parent).setName(t("settings.ignore.name")).setDesc(t("settings.ignore.desc"))
      .addTextArea((text) => text.setPlaceholder(".obsidian/\n.trash/")
        .setValue(port.settings.ignoredPathPrefixes.join("\n")).onChange(async (value) => {
          port.settings.ignoredPathPrefixes = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await port.save();
        }));
    parent.createEl("h4", { text: t("settings.linkedResources.heading") });
    new Setting(parent).setName(t("settings.titleSync.name")).setDesc(t("settings.titleSync.desc"))
      .addToggle((toggle) => toggle.setValue(port.settings.titleSync).onChange(async (value) => {
        port.settings.titleSync = value; await port.save();
      }));
    new Setting(parent).setName(t("settings.nonMarkdownIdSeparator.name")).setDesc(t("settings.nonMarkdownIdSeparator.desc"))
      .addDropdown((dropdown) => dropdown.addOption("@", "@").addOption("%", "%")
        .setValue(port.settings.nonMarkdownIdSeparator).onChange(async (value) => {
          port.settings.nonMarkdownIdSeparator = value === "%" ? "%" : "@";
          await port.save();
        }));
    new Setting(parent).setName(t("settings.openMode.name"))
      .addDropdown((dropdown) => dropdown.addOption("tab", t("settings.openMode.tab"))
        .addOption("split-right", t("settings.openMode.splitRight"))
        .setValue(port.settings.resourceOpenMode).onChange(async (value) => {
          port.settings.resourceOpenMode = value as typeof port.settings.resourceOpenMode;
          await port.save();
        }));
  }
}
