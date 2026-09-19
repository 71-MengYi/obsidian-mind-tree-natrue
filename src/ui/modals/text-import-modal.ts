import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";
import {
  DEFAULT_TEXT_IMPORT_RULE,
  type TextImportRule
} from "../../services/text-import";

export interface TextImportOptions { text: string; rule: TextImportRule; }

export class TextImportModal extends Modal {
  private text: string;
  private rule: TextImportRule = DEFAULT_TEXT_IMPORT_RULE;
  private textAreaEl!: HTMLTextAreaElement;
  private errorEl!: HTMLElement;
  private importButtonEl!: HTMLButtonElement;
  private submitting = false;

  constructor(app: App, initialText: string,
    private readonly onSubmit: (options: TextImportOptions) => Promise<string | undefined>) {
    super(app); this.text = initialText;
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.import.title"));
    this.modalEl.addClass("mtn-text-import-modal");
    const sourceField = this.contentEl.createDiv("mtn-text-import-field");
    sourceField.createEl("label", { text: t("modal.import.data") });
    this.textAreaEl = sourceField.createEl("textarea", {
      cls: "mtn-text-import-source",
      attr: { rows: "14", spellcheck: "false", placeholder: t("modal.import.placeholder"), "aria-label": t("modal.import.data") }
    });
    this.textAreaEl.value = this.text;
    this.textAreaEl.addEventListener("input", () => {
      this.text = this.textAreaEl.value; this.clearError(); this.updateImportButton();
    });
    new Setting(this.contentEl).setName(t("modal.import.rule")).setDesc(t("modal.import.ruleDesc"))
      .addDropdown((dropdown) => dropdown
        .addOption("list", t("modal.import.rule.list")).addOption("headings", t("modal.import.rule.headings"))
        .setValue(DEFAULT_TEXT_IMPORT_RULE).onChange((value) => {
          if (value === "list" || value === "headings") this.rule = value;
          this.clearError(); this.updateImportButton();
        }));
    this.errorEl = this.contentEl.createDiv({ cls: "mtn-text-import-error", attr: { role: "alert", "aria-live": "polite" } });
    const actions = this.contentEl.createDiv("mtn-text-import-actions");
    actions.createEl("button", { text: t("modal.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
    this.importButtonEl = actions.createEl("button", { cls: "mod-cta", text: t("action.import"), attr: { type: "button" } });
    this.importButtonEl.addEventListener("click", () => void this.submit());
    this.updateImportButton();
    (this.modalEl.ownerDocument.defaultView ?? window).setTimeout(() => this.textAreaEl.focus());
  }

  onClose(): void { this.contentEl.empty(); }

  private async submit(): Promise<void> {
    if (this.submitting || !this.text.trim()) return;
    this.submitting = true; this.updateImportButton(); this.clearError();
    try {
      const error = await this.onSubmit({ text: this.text, rule: this.rule });
      if (error) { this.errorEl.setText(error); return; }
      this.close();
    } catch (error) {
      this.errorEl.setText(t("modal.import.failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally { this.submitting = false; this.updateImportButton(); }
  }
  private clearError(): void { this.errorEl?.setText(""); }
  private updateImportButton(): void {
    if (this.importButtonEl) this.importButtonEl.disabled = this.submitting || !this.text.trim();
  }
}
