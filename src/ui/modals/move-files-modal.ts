import { App, Modal } from "obsidian";
import { t } from "../../i18n";

export type MoveFilesMode = "current" | "branch";

/** Search a vault folder and move either the current file or all branch files. */
export class MoveFilesModal extends Modal {
  private selectedFolderPath?: string;
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private currentButtonEl!: HTMLButtonElement;
  private branchButtonEl!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly folderPaths: string[],
    private readonly currentFolderPath: string,
    private readonly canMoveCurrent: boolean,
    private readonly canMoveBranch: boolean,
    private readonly onSubmit: (folderPath: string, mode: MoveFilesMode) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.moveFiles.title"));
    this.modalEl.addClass("mtn-move-files-modal");
    this.inputEl = this.contentEl.createEl("input", {
      cls: "mtn-move-folder-search",
      type: "search",
      attr: {
        placeholder: t("modal.moveFiles.placeholder"),
        "aria-label": t("modal.moveFiles.placeholder")
      }
    });
    const currentFolder = this.contentEl.createEl("button", {
      cls: "mtn-move-current-folder",
      text: t("modal.moveFiles.currentFolder"),
      attr: { type: "button" }
    });
    currentFolder.addEventListener("click", () => this.selectFolder(this.currentFolderPath));
    this.resultsEl = this.contentEl.createDiv({
      cls: "mtn-move-folder-results",
      attr: { role: "listbox", "aria-label": t("modal.moveFiles.results") }
    });
    const actions = this.contentEl.createDiv("mtn-move-files-actions");
    this.currentButtonEl = actions.createEl("button", {
      text: t("modal.moveFiles.currentOnly"),
      attr: { type: "button" }
    });
    this.currentButtonEl.addEventListener("click", () => this.submit("current"));
    this.branchButtonEl = actions.createEl("button", {
      cls: "mod-cta",
      text: t("modal.moveFiles.branch"),
      attr: { type: "button" }
    });
    this.branchButtonEl.addEventListener("click", () => this.submit("branch"));
    this.inputEl.addEventListener("input", () => {
      this.selectedFolderPath = this.findExactFolder(this.inputEl.value);
      this.renderFolderResults();
      this.updateButtons();
    });
    this.renderFolderResults();
    this.updateButtons();
    (this.modalEl.ownerDocument.defaultView ?? window).setTimeout(() => this.inputEl.focus());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderFolderResults(): void {
    this.resultsEl.empty();
    const query = normalizeFolderPath(this.inputEl.value).toLocaleLowerCase();
    const matches = this.folderPaths
      .filter((path) => !query || displayFolderPath(path).toLocaleLowerCase().includes(query))
      .slice(0, 12);
    for (const path of matches) {
      const option = this.resultsEl.createEl("button", {
        cls: "mtn-move-folder-option",
        text: displayFolderPath(path),
        attr: {
          type: "button",
          role: "option",
          "aria-selected": String(path === this.selectedFolderPath)
        }
      });
      option.toggleClass("is-selected", path === this.selectedFolderPath);
      option.addEventListener("click", () => this.selectFolder(path));
    }
    this.resultsEl.toggleClass("is-empty", matches.length === 0);
    if (matches.length === 0) {
      this.resultsEl.createDiv({ cls: "mtn-move-folder-empty", text: t("modal.moveFiles.noFolders") });
    }
  }

  private selectFolder(path: string): void {
    this.selectedFolderPath = normalizeFolderPath(path);
    this.inputEl.value = displayFolderPath(this.selectedFolderPath);
    this.renderFolderResults();
    this.updateButtons();
  }

  private findExactFolder(value: string): string | undefined {
    const normalized = normalizeFolderPath(value);
    return this.folderPaths.find((path) =>
      normalizeFolderPath(path).toLocaleLowerCase() === normalized.toLocaleLowerCase());
  }

  private updateButtons(): void {
    const selected = this.selectedFolderPath !== undefined;
    this.currentButtonEl.disabled = !selected || !this.canMoveCurrent;
    this.branchButtonEl.disabled = !selected || !this.canMoveBranch;
  }

  private submit(mode: MoveFilesMode): void {
    if (this.selectedFolderPath === undefined
      || (mode === "current" && !this.canMoveCurrent)
      || (mode === "branch" && !this.canMoveBranch)) return;
    const destination = this.selectedFolderPath;
    this.close();
    this.onSubmit(destination, mode);
  }
}

function normalizeFolderPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function displayFolderPath(value: string): string {
  return normalizeFolderPath(value) || "/";
}
