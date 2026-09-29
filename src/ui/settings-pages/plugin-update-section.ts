import { Setting } from "obsidian";
import { t } from "../../i18n";
import { updateBusy } from "../../services/updates/update-coordinator";
import { updateMessage } from "../../services/updates/update-messages";
import type { SettingsPagePort } from "./ports";

/** Own subscription only; leaving settings never cancels an installation. */
export class PluginUpdateSection {
  private readonly unsubscribe: () => void;
  constructor(parent: HTMLElement, port: SettingsPagePort) {
    new Setting(parent).setName(t("update.heading")).setHeading();
    const current = parent.createDiv({ cls: "setting-item-description" });
    new Setting(parent).setName(t("update.auto.name")).setDesc(t("update.auto.desc"))
      .addToggle((toggle) => toggle.setValue(port.settings.autoCheckUpdates).onChange(async (value) => {
        port.settings.autoCheckUpdates = value;
        await port.save();
      }));
    const actions = new Setting(parent).setName(t("update.check")).setDesc(t("update.desc"));
    const status = parent.createDiv({ cls: "setting-item-description", attr: { role: "status", "aria-live": "polite" } });
    let check!: HTMLButtonElement, install!: HTMLButtonElement;
    actions.addButton((button) => {
      check = button.buttonEl;
      button.setButtonText(t("update.check")).onClick(() => void port.updates.check());
    }).addButton((button) => {
      install = button.buttonEl;
      button.setButtonText(t("update.install")).onClick(() => void port.updates.install());
    });
    this.unsubscribe = port.updates.subscribe((state) => {
      current.setText(t("update.currentVersion", { version: state.currentVersion }));
      status.setText(updateMessage(state));
      check.disabled = updateBusy(state);
      install.hidden = state.phase !== "available";
      install.disabled = updateBusy(state);
    });
  }
  destroy(): void { this.unsubscribe(); }
}
