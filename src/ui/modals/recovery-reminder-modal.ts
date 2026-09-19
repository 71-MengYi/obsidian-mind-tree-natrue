import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";

/** Read-only reminder. Closing it never marks a recovery copy as handled. */
export class RecoveryReminderModal extends Modal {
  constructor(
    app: App,
    private readonly recoveryPaths: readonly string[],
    private readonly onDismiss: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.recoveryReminder.title"));
    this.modalEl.addClass("mtn-recovery-reminder-modal");
    this.contentEl.createDiv({
      cls: "callout is-warning",
      text: t("modal.recoveryReminder.warning", { count: this.recoveryPaths.length })
    });
    this.contentEl.createEl("p", { text: t("modal.recoveryReminder.description") });
    const paths = this.contentEl.createEl("ul", { cls: "mtn-recovery-reminder-paths" });
    for (const path of this.recoveryPaths) paths.createEl("li", { text: path });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setCta()
        .setButtonText(t("modal.recoveryReminder.acknowledge"))
        .onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDismiss();
  }
}
