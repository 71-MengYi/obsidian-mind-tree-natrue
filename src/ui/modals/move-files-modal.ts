import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { FolderPicker } from "../folder-picker";

export type MoveFilesMode = "current" | "branch";

/** Search a vault folder and move either the current file or all branch files. */
export class MoveFilesModal extends Modal {
  private picker!: FolderPicker;
  private inputEl!: HTMLInputElement;
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
        placeholder: t("folderPicker.placeholder"),
        "aria-label": t("folderPicker.placeholder")
      }
    });
    const currentFolder = this.contentEl.createEl("button", {
      cls: "mtn-move-current-folder",
      text: t("modal.moveFiles.currentFolder"),
      attr: { type: "button" }
    });
    this.picker = new FolderPicker({
      inputEl: this.inputEl,
      resultsEl: this.contentEl.createDiv("mtn-move-folder-results"),
      folderPaths: this.folderPaths,
      classNames: { option: "mtn-move-folder-option", empty: "mtn-move-folder-empty" },
      onChange: () => this.updateButtons()
    });
    currentFolder.addEventListener("click", () => this.picker.selectFolder(this.currentFolderPath));
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
    this.inputEl.addEventListener("input", () => this.picker.handleInput());
    this.picker.start(undefined);
    (this.modalEl.ownerDocument.defaultView ?? window).setTimeout(() => this.inputEl.focus());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private updateButtons(): void {
    const selected = this.picker.selection !== undefined;
    this.currentButtonEl.disabled = !selected || !this.canMoveCurrent;
    this.branchButtonEl.disabled = !selected || !this.canMoveBranch;
  }

  private submit(mode: MoveFilesMode): void {
    const destination = this.picker.selection;
    if (destination === undefined
      || (mode === "current" && !this.canMoveCurrent)
      || (mode === "branch" && !this.canMoveBranch)) return;
    this.close();
    this.onSubmit(destination, mode);
  }
}
