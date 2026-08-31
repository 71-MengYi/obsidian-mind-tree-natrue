import { App, Modal } from "obsidian";
import { t } from "../../i18n";

export interface CreateMindTreeOptions { title: string; folderPath: string; }

export class CreateMindTreeModal extends Modal {
  private title = "";
  private selectedFolderPath?: string;
  private titleInputEl!: HTMLInputElement;
  private folderInputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private createButtonEl!: HTMLButtonElement;

  constructor(app: App, private readonly folderPaths: string[], initialFolderPath: string,
    private readonly onSubmit: (options: CreateMindTreeOptions) => void) {
    super(app);
    this.title = t("tree.newName");
    this.selectedFolderPath = this.findExactFolder(initialFolderPath) ?? this.findExactFolder("");
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
      value: this.selectedFolderPath === undefined ? "" : displayFolderPath(this.selectedFolderPath),
      attr: { placeholder: t("tree.folderPlaceholder"), "aria-label": t("tree.targetFolder") } });
    this.resultsEl = folderField.createDiv({ cls: "mtn-create-tree-folder-results",
      attr: { role: "listbox", "aria-label": t("tree.folderResults") } });
    const actions = this.contentEl.createDiv("mtn-create-tree-actions");
    actions.createEl("button", { text: t("modal.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
    this.createButtonEl = actions.createEl("button", { cls: "mod-cta", text: t("action.create"), attr: { type: "button" } });
    this.createButtonEl.addEventListener("click", () => this.submit());
    this.titleInputEl.addEventListener("input", () => { this.title = this.titleInputEl.value; this.updateCreateButton(); });
    this.titleInputEl.addEventListener("keydown", (event) => { if (event.key === "Enter") this.submit(); });
    this.folderInputEl.addEventListener("input", () => {
      this.selectedFolderPath = this.findExactFolder(this.folderInputEl.value);
      this.renderFolderResults(); this.updateCreateButton();
    });
    this.folderInputEl.addEventListener("keydown", (event) => { if (event.key === "Enter") this.submit(); });
    this.renderFolderResults(); this.updateCreateButton();
    (this.modalEl.ownerDocument.defaultView ?? window).setTimeout(() => { this.titleInputEl.focus(); this.titleInputEl.select(); });
  }
  onClose(): void { this.contentEl.empty(); }
  private renderFolderResults(): void {
    this.resultsEl.empty();
    const query = normalizeFolderPath(this.folderInputEl.value).toLocaleLowerCase();
    const matches = this.folderPaths.filter((path) => !query || displayFolderPath(path).toLocaleLowerCase().includes(query)).slice(0, 12);
    for (const path of matches) {
      const option = this.resultsEl.createEl("button", { cls: "mtn-create-tree-folder-option", text: displayFolderPath(path),
        attr: { type: "button", role: "option", "aria-selected": String(path === this.selectedFolderPath) } });
      option.toggleClass("is-selected", path === this.selectedFolderPath);
      option.addEventListener("click", () => this.selectFolder(path));
    }
    if (matches.length === 0) this.resultsEl.createDiv({ cls: "mtn-create-tree-folder-empty", text: t("tree.noFolders") });
  }
  private selectFolder(path: string): void {
    this.selectedFolderPath = normalizeFolderPath(path);
    this.folderInputEl.value = displayFolderPath(this.selectedFolderPath);
    this.renderFolderResults(); this.updateCreateButton();
  }
  private findExactFolder(value: string): string | undefined {
    const normalized = normalizeFolderPath(value);
    return this.folderPaths.find((path) => normalizeFolderPath(path).toLocaleLowerCase() === normalized.toLocaleLowerCase());
  }
  private updateCreateButton(): void { this.createButtonEl.disabled = !this.title.trim() || this.selectedFolderPath === undefined; }
  private submit(): void {
    const title = this.title.trim();
    if (!title || this.selectedFolderPath === undefined) return;
    const folderPath = this.selectedFolderPath;
    this.close(); this.onSubmit({ title, folderPath });
  }
}

function normalizeFolderPath(value: string): string { return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); }
function displayFolderPath(value: string): string { return normalizeFolderPath(value) || "/"; }
