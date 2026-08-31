import { Setting } from "obsidian";
import { t } from "../../i18n";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

export class BasicSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.basic") });
    new Setting(parent)
      .setName(t("settings.autosave.name"))
      .setDesc(t("settings.autosave.desc"))
      .addSlider((slider) => slider
        .setLimits(250, 2_000, 250)
        .setDynamicTooltip()
        .setValue(port.settings.autosaveDelayMs)
        .onChange(async (value) => {
          port.settings.autosaveDelayMs = value;
          await port.save();
        }));
  }
}
