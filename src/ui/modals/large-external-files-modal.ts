import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";

export class LargeExternalFilesModal extends Modal {
  private settled = false;
  constructor(app: App, private readonly files: readonly File[], private readonly resolve: (confirmed: boolean) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("modal.largeFiles.title"));
    const total = this.files.reduce((sum, file) => sum + file.size, 0);
    this.contentEl.createEl("p", { text: t("modal.largeFiles.summary", { count: this.files.length, size: formatByteSize(total) }) });
    const list = this.contentEl.createEl("ul", { cls: "mtn-large-files-list" });
    for (const file of this.files) list.createEl("li", { text: `${file.name} — ${formatByteSize(file.size)}` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("modal.cancel")).onClick(() => this.finish(false)))
      .addButton((button) => button.setWarning().setButtonText(t("modal.largeFiles.continue")).onClick(() => this.finish(true)));
  }
  onClose(): void { this.contentEl.empty(); if (!this.settled) this.finish(false, false); }
  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true; if (close) this.close(); this.resolve(confirmed);
  }
}

export function confirmLargeExternalFiles(app: App, files: readonly File[]): Promise<boolean> {
  return new Promise((resolve) => new LargeExternalFilesModal(app, files, resolve).open());
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}
