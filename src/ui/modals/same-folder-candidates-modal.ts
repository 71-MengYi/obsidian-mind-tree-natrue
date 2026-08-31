import { App, Modal, Setting, TFile } from "obsidian";
import { t } from "../../i18n";

export type CandidateAction = "root" | "collect";

export class SameFolderCandidatesModal extends Modal {
  private readonly selected = new Set<string>();
  constructor(app: App, private readonly files: TFile[],
    private readonly onSubmit: (files: TFile[], action: CandidateAction) => void) {
    super(app); for (const file of files) this.selected.add(file.path);
  }
  onOpen(): void {
    this.titleEl.setText(t("modal.collect.title"));
    this.contentEl.createEl("p", { text: t("modal.collect.desc") });
    const list = this.contentEl.createDiv("mtn-candidate-list");
    for (const file of this.files) new Setting(list).setName(file.name).setDesc(file.path).addToggle((toggle) => toggle
      .setValue(true).onChange((value) => value ? this.selected.add(file.path) : this.selected.delete(file.path)));
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("modal.collect.ignore")).onClick(() => this.close()))
      .addButton((button) => button.setButtonText(t("modal.collect.root")).onClick(() => this.submit("root")))
      .addButton((button) => button.setCta().setButtonText(t("modal.collect.collection")).onClick(() => this.submit("collect")));
  }
  private submit(action: CandidateAction): void {
    const selected = this.files.filter((file) => this.selected.has(file.path));
    this.close(); if (selected.length > 0) this.onSubmit(selected, action);
  }
}
