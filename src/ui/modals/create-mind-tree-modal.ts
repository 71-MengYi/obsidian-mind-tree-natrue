import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { displayFolderPath, findExactFolder, FolderPicker } from "../folder-picker";

export interface CreateMindTreeOptions { title: string; folderPath: string; }

export class CreateMindTreeModal extends Modal {
  private title = "";
  private initialFolderPath?: string;
  private picker!: FolderPicker;
  private titleInputEl!: HTMLInputElement;
  private folderInputEl!: HTMLInputElement;
  private createButtonEl!: HTMLButtonElement;

  constructor(app: App, private readonly folderPaths: string[], initialFolderPath: string,
    private readonly onSubmit: (options: CreateMindTreeOptions) => void) {
    super(app);
    this.title = t("tree.newName");
    this.initialFolderPath = findExactFolder(this.folderPaths, initialFolderPath) ?? findExactFolder(this.folderPaths, "");
  }
  onOpen(): void {
    this.titleEl.setText(t("tree.create"));
    this.modalEl.addClass("mtn-create-tree-modal");
    const nameField = this.contentEl.createDiv("mtn-create-tree-field");
    nameField.createEl("label", { text: t("tree.nameLabel") });
    this.titleInputEl = nameField.createEl("input", { cls: "mtn-create-tree-name", type: "text", value: this.title,
      attr: { placeholder: t("tree.namePlaceholder"), "aria-label": t("tree.nameLabel") } });
    const folderField = this.contentEl.createDiv("mtn-create-tree-field");
    folderField.createEl("label", { text: t("tree.targetFolder") });
    this.folderInputEl = folderField.createEl("input", { cls: "mtn-create-tree-folder-search", type: "search",
      value: this.initialFolderPath === undefined ? "" : displayFolderPath(this.initialFolderPath),
      attr: { placeholder: t("folderPicker.placeholder"), "aria-label": t("tree.targetFolder") } });
    this.picker = new FolderPicker({
      inputEl: this.folderInputEl,
      resultsEl: folderField.createDiv("mtn-create-tree-folder-results"),
      folderPaths: this.folderPaths,
      classNames: { option: "mtn-create-tree-folder-option", empty: "mtn-create-tree-folder-empty" },
      onChange: () => this.updateCreateButton()
    });
    const actions = this.contentEl.createDiv("mtn-create-tree-actions");
    actions.createEl("button", { text: t("modal.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
    this.createButtonEl = actions.createEl("button", { cls: "mod-cta", text: t("action.create"), attr: { type: "button" } });
    this.createButtonEl.addEventListener("click", () => this.submit());
    this.titleInputEl.addEventListener("input", () => { this.title = this.titleInputEl.value; this.updateCreateButton(); });
    this.titleInputEl.addEventListener("keydown", (event) => { if (event.key === "Enter") this.submit(); });
    this.folderInputEl.addEventListener("input", () => this.picker.handleInput());
    this.folderInputEl.addEventListener("keydown", (event) => { if (event.key === "Enter") this.submit(); });
    this.picker.start(this.initialFolderPath);
    (this.modalEl.ownerDocument.defaultView ?? window).setTimeout(() => { this.titleInputEl.focus(); this.titleInputEl.select(); });
  }
  onClose(): void { this.contentEl.empty(); }
  private updateCreateButton(): void { this.createButtonEl.disabled = !this.title.trim() || this.picker.selection === undefined; }
  private submit(): void {
    const title = this.title.trim();
    const folderPath = this.picker.selection;
    if (!title || folderPath === undefined) return;
    this.close(); this.onSubmit({ title, folderPath });
  }
}
