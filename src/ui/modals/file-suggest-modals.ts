import { App, FuzzySuggestModal, TFile } from "obsidian";
import { t } from "../../i18n";

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => void) {
    super(app); this.setPlaceholder(t("modal.searchFiles"));
  }
  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}

export class TemplateSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => void) {
    super(app); this.setPlaceholder(t("modal.template.search"));
  }
  onOpen(): void { super.onOpen(); this.titleEl.setText(t("modal.template.title")); }
  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}
