import { Setting } from "obsidian";
import { t } from "../../i18n";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme
} from "../../types";
import { MAX_NODE_WRAP_WIDTH, MIN_NODE_WRAP_WIDTH, normalizeNodeWrapWidth } from "../layout";
import {
  COLLECTION_MODE_OPTIONS, CONNECTION_OPTIONS, LAYOUT_OPTIONS, NODE_SHAPE_OPTIONS, THEME_OPTIONS
} from "../presentation";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

/** Global appearance/export preferences and runtime defaults for trees without their own value. */
export class MindMapSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.mindMap") });

    new Setting(parent).setName(t("settings.defaultLayout.name")).setDesc(t("settings.defaultLayout.desc"))
      .addDropdown((dropdown) => {
        for (const option of LAYOUT_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown.setValue(port.settings.defaultLayoutMode).onChange(async (value) => {
          port.settings.defaultLayoutMode = value as MindTreeLayoutMode;
          await port.save();
        });
      });
    new Setting(parent).setName(t("settings.defaultCollectionMode.name")).setDesc(t("settings.defaultCollectionMode.desc"))
      .addDropdown((dropdown) => {
        for (const option of COLLECTION_MODE_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown.setValue(port.settings.defaultCollectionMode).onChange(async (value) => {
          port.settings.defaultCollectionMode = value as MindTreeCollectionMode;
          await port.save();
        });
      });
    new Setting(parent).setName(t("settings.nodeAlignment.name"))
      .addDropdown((dropdown) => dropdown
        .addOption("level", t("settings.nodeAlignment.level"))
        .addOption("compact", t("settings.nodeAlignment.compact"))
        .setValue(port.settings.nodeAlignment).onChange(async (value) => {
          port.settings.nodeAlignment = value as MindTreeNodeAlignment;
          port.refreshOpenLayouts();
          await port.save();
        }));
    new Setting(parent).setName(t("settings.newNoteOpenMode.name"))
      .addDropdown((dropdown) => dropdown
        .addOption("split-right", t("settings.newNoteOpenMode.splitRight"))
        .addOption("tab", t("settings.newNoteOpenMode.tab"))
        .addOption("current", t("settings.newNoteOpenMode.current"))
        .addOption("window", t("settings.newNoteOpenMode.window"))
        .setValue(port.settings.newNoteOpenMode).onChange(async (value) => {
          port.settings.newNoteOpenMode = value as typeof port.settings.newNoteOpenMode;
          await port.save();
        }));
    new Setting(parent).setName(t("settings.theme.name")).setDesc(t("settings.theme.desc"))
      .addDropdown((dropdown) => {
        for (const option of THEME_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown.setValue(port.settings.theme).onChange(async (value) => {
          port.settings.theme = value as MindTreeTheme;
          await port.save();
        });
      });
    new Setting(parent).setName(t("settings.connection.name")).setDesc(t("settings.connection.desc"))
      .addDropdown((dropdown) => {
        for (const option of CONNECTION_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown.setValue(port.settings.connectionStyle).onChange(async (value) => {
          port.settings.connectionStyle = value as MindTreeConnectionStyle;
          await port.save();
        });
      });
    new Setting(parent).setName(t("settings.nodeShape.name")).setDesc(t("settings.nodeShape.desc"))
      .addDropdown((dropdown) => {
        for (const option of NODE_SHAPE_OPTIONS) dropdown.addOption(option.value, t(option.label));
        return dropdown.setValue(port.settings.nodeShape).onChange(async (value) => {
          port.settings.nodeShape = value as MindTreeNodeShape;
          await port.save();
        });
      });
    new Setting(parent).setName(t("settings.nodeWrapWidth.name")).setDesc(t("settings.nodeWrapWidth.desc"))
      .addSlider((slider) => slider
        .setLimits(MIN_NODE_WRAP_WIDTH, MAX_NODE_WRAP_WIDTH, 20).setDynamicTooltip()
        .setValue(normalizeNodeWrapWidth(port.settings.nodeWrapWidth)).onChange(async (value) => {
          port.settings.nodeWrapWidth = normalizeNodeWrapWidth(value);
          port.refreshOpenLayouts();
          await port.save();
        }));
    new Setting(parent).setName(t("settings.pngScale.name")).setDesc(t("settings.pngScale.desc"))
      .addDropdown((dropdown) => dropdown.addOption("1", "1x").addOption("2", "2x").addOption("3", "3x")
        .setValue(String(port.settings.pngScale)).onChange(async (value) => {
          port.settings.pngScale = Number(value) as 1 | 2 | 3;
          await port.save();
        }));
  }
}
