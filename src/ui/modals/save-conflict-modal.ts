import { App, Modal } from "obsidian";
import { t } from "../../i18n";

export type SaveConflictAction = "external" | "overwrite" | "open-recovery" | "later";

export class SaveConflictModal extends Modal {
  private settled = false;
  constructor(app: App, private readonly recoveryPath: string,
    private readonly onAction: (action: SaveConflictAction) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("modal.saveConflict.title"));
    this.modalEl.addClass("mtn-save-conflict-modal");
    this.contentEl.createDiv({ cls: "callout is-warning", text: t("modal.saveConflict.warning") });
    this.contentEl.createEl("p", { text: t("modal.saveConflict.recovery", { path: this.recoveryPath }) });
    const actions = this.contentEl.createDiv("mtn-save-conflict-actions");
    actions.createEl("button", { text: t("modal.saveConflict.external") }).addEventListener("click", () => this.finish("external"));
    actions.createEl("button", { text: t("modal.saveConflict.overwrite"), cls: "mod-warning" }).addEventListener("click", () => this.finish("overwrite"));
    actions.createEl("button", { text: t("modal.saveConflict.openRecovery") }).addEventListener("click", () => this.finish("open-recovery"));
    const later = actions.createEl("button", { text: t("modal.saveConflict.later"), cls: "mod-cta" });
    later.addEventListener("click", () => this.finish("later"));
    this.modalEl.ownerDocument.defaultView?.setTimeout(() => later.focus());
  }
  /** Close because the underlying conflict was merged, without choosing Later. */
  dismiss(): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
  }
  onClose(): void { this.contentEl.empty(); if (!this.settled) this.finish("later", false); }
  private finish(action: SaveConflictAction, close = true): void {
    if (this.settled) return;
    this.settled = true; if (close) this.close(); this.onAction(action);
  }
}
