import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";

export class TextPromptModal extends Modal {
  private value: string;
  constructor(app: App, private readonly titleText: string, initialValue: string,
    private readonly placeholder: string, private readonly submitLabel: string,
    private readonly onSubmit: (value: string) => void) {
    super(app); this.value = initialValue;
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { cls: "mtn-modal-input", type: "text", value: this.value });
    input.placeholder = this.placeholder;
    input.addEventListener("input", () => { this.value = input.value; });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") this.submit(); });
    new Setting(this.contentEl).addButton((button) => button.setCta().setButtonText(this.submitLabel).onClick(() => this.submit()));
    this.modalEl.ownerDocument.defaultView?.setTimeout(() => { input.focus(); input.select(); });
  }
  onClose(): void { this.contentEl.empty(); }
  private submit(): void {
    const value = this.value.trim();
    if (!value) return;
    this.close(); this.onSubmit(value);
  }
}

export class UrlPromptModal extends Modal {
  private url = "https://";
  private title = "";
  constructor(app: App, private readonly onSubmit: (url: string, title: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("modal.linkWeb.title"));
    new Setting(this.contentEl).setName(t("modal.linkWeb.url")).addText((input) => input
      .setValue(this.url).onChange((value) => { this.url = value.trim(); }));
    new Setting(this.contentEl).setName(t("modal.linkWeb.nodeTitle")).setDesc(t("modal.linkWeb.titleDesc"))
      .addText((input) => input.onChange((value) => { this.title = value.trim(); }));
    new Setting(this.contentEl).addButton((button) => button.setCta().setButtonText(t("action.link")).onClick(() => {
      let parsed: URL;
      try { parsed = new URL(this.url); } catch { return; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      this.close(); this.onSubmit(parsed.toString(), this.title || parsed.hostname);
    }));
  }
}
