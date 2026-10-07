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
    new Setting(parent).setName(t("update.auto.name"))
      .addToggle((toggle) => toggle.setValue(port.settings.autoCheckUpdates).onChange(async (value) => {
        port.settings.autoCheckUpdates = value;
        await port.save();
      }));
    const actions = new Setting(parent);
    const status = parent.createDiv({ cls: "setting-item-description", attr: { role: "status", "aria-live": "polite" } });
    let check!: HTMLButtonElement, view!: HTMLButtonElement;
    actions.addButton((button) => {
      check = button.buttonEl;
      button.setButtonText(t("update.check")).onClick(() => void port.updates.check());
    }).addButton((button) => {
      view = button.buttonEl;
      button.setButtonText(t("update.view")).onClick(() => port.updates.showAvailable());
    });
    this.unsubscribe = port.updates.subscribe((state) => {
      actions.setName(t("update.currentVersion", { version: state.currentVersion }));
      const message = updateMessage(state);
      status.hidden = !message;
      status.setText(message);
      check.disabled = updateBusy(state);
      view.hidden = state.phase !== "available" || !state.availableRelease;
      view.disabled = updateBusy(state);
    });
  }
  destroy(): void { this.unsubscribe(); }
}
