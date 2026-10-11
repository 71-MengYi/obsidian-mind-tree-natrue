import { t } from "../i18n";

/** Match cap: a large vault stays responsive while the query is typed. */
const FOLDER_RESULT_LIMIT = 12;

/** Canonical vault-relative folder path: forward slashes, no wrapping slash. */
export function normalizeFolderPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Display form of a folder path; the vault root is shown as "/". */
export function displayFolderPath(value: string): string {
  return normalizeFolderPath(value) || "/";
}

/** Case-insensitive exact match inside the known folder list. */
export function findExactFolder(folderPaths: readonly string[], value: string): string | undefined {
  const normalized = normalizeFolderPath(value);
  return folderPaths.find((path) =>
    normalizeFolderPath(path).toLocaleLowerCase() === normalized.toLocaleLowerCase());
}

/** Result-list class names the owning dialog keeps for its own styling prefix. */
export interface FolderPickerClassNames {
  readonly option: string;
  readonly empty: string;
}

export interface FolderPickerOptions {
  readonly inputEl: HTMLInputElement;
  readonly resultsEl: HTMLElement;
  readonly folderPaths: readonly string[];
  readonly classNames: FolderPickerClassNames;
  /** The dialog re-evaluates its action buttons whenever the selection changes. */
  readonly onChange: () => void;
}

/**
 * Searchable vault-folder list shared by the create-tree and move-files dialogs.
 * Those dialogs differ only in CSS prefix, action buttons and the label above the
 * input, so filtering, root display, exact-match selection and the empty note
 * live here once. The picker never mutates document state: it only reports the
 * selected folder through `selection`, and the owner decides what to do with it.
 */
export class FolderPicker {
  private selectedFolderPath?: string;

  constructor(private readonly options: FolderPickerOptions) {
    options.resultsEl.setAttribute("role", "listbox");
    options.resultsEl.setAttribute("aria-label", t("folderPicker.results"));
  }

  /** The normalized selected folder, or undefined while the text matches nothing. */
  get selection(): string | undefined { return this.selectedFolderPath; }

  /** Adopt the dialog's initial selection and render the first result list. */
  start(initialFolderPath: string | undefined): void {
    this.selectedFolderPath = initialFolderPath;
    this.render();
    this.options.onChange();
  }

  /** Re-resolve the selection from the input text after the user typed. */
  handleInput(): void {
    this.selectedFolderPath = findExactFolder(this.options.folderPaths, this.options.inputEl.value);
    this.render();
    this.options.onChange();
  }

  /** Apply a picked folder to the input and re-render the list. */
  selectFolder(path: string): void {
    this.selectedFolderPath = normalizeFolderPath(path);
    this.options.inputEl.value = displayFolderPath(this.selectedFolderPath);
    this.render();
    this.options.onChange();
  }

  private render(): void {
    const { resultsEl, inputEl, folderPaths, classNames } = this.options;
    resultsEl.empty();
    const query = normalizeFolderPath(inputEl.value).toLocaleLowerCase();
    const matches = folderPaths
      .filter((path) => !query || displayFolderPath(path).toLocaleLowerCase().includes(query))
      .slice(0, FOLDER_RESULT_LIMIT);
    for (const path of matches) {
      const option = resultsEl.createEl("button", {
        cls: classNames.option,
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
    resultsEl.toggleClass("is-empty", matches.length === 0);
    if (matches.length === 0) {
      resultsEl.createDiv({ cls: classNames.empty, text: t("folderPicker.noFolders") });
    }
  }
}
