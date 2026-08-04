import { App, FuzzySuggestModal, Modal, Setting, setIcon, TFile } from "obsidian";
import { t } from "../i18n";
import type { TextImportRule } from "../services/text-import";

export class TextPromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly titleText: string,
    initialValue: string,
    private readonly placeholder: string,
    private readonly submitLabel: string,
    private readonly onSubmit: (value: string) => void
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { cls: "mtn-modal-input", type: "text", value: this.value });
    input.placeholder = this.placeholder;
    input.addEventListener("input", () => { this.value = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submit();
    });
    new Setting(this.contentEl).addButton((button) => button
      .setCta()
      .setButtonText(this.submitLabel)
      .onClick(() => this.submit()));
    window.setTimeout(() => { input.focus(); input.select(); });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const value = this.value.trim();
    if (!value) return;
    this.close();
    this.onSubmit(value);
  }
}

export interface TextImportOptions {
  text: string;
  rule: TextImportRule;
}

/** One-shot confirmation used before allocating large external File buffers. */
export class LargeExternalFilesModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly files: readonly File[],
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.largeFiles.title"));
    const total = this.files.reduce((sum, file) => sum + file.size, 0);
    this.contentEl.createEl("p", {
      text: t("modal.largeFiles.summary", { count: this.files.length, size: formatByteSize(total) })
    });
    const list = this.contentEl.createEl("ul", { cls: "mtn-large-files-list" });
    for (const file of this.files) list.createEl("li", { text: `${file.name} — ${formatByteSize(file.size)}` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("modal.cancel")).onClick(() => this.finish(false)))
      .addButton((button) => button.setWarning().setButtonText(t("modal.largeFiles.continue")).onClick(() => this.finish(true)));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish(false, false);
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    if (close) this.close();
    this.resolve(confirmed);
  }
}

export function confirmLargeExternalFiles(app: App, files: readonly File[]): Promise<boolean> {
  return new Promise((resolve) => new LargeExternalFilesModal(app, files, resolve).open());
}

export type SaveConflictAction = "external" | "overwrite" | "open-recovery" | "later";

/** Preserve both versions first, then let the user make an explicit choice. */
export class SaveConflictModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly recoveryPath: string,
    private readonly onAction: (action: SaveConflictAction) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.saveConflict.title"));
    this.modalEl.addClass("mtn-save-conflict-modal");
    this.contentEl.createDiv({ cls: "callout is-warning", text: t("modal.saveConflict.warning") });
    this.contentEl.createEl("p", { text: t("modal.saveConflict.recovery", { path: this.recoveryPath }) });
    const actions = this.contentEl.createDiv("mtn-save-conflict-actions");
    actions.createEl("button", { text: t("modal.saveConflict.external") })
      .addEventListener("click", () => this.finish("external"));
    actions.createEl("button", { text: t("modal.saveConflict.overwrite"), cls: "mod-warning" })
      .addEventListener("click", () => this.finish("overwrite"));
    actions.createEl("button", { text: t("modal.saveConflict.openRecovery") })
      .addEventListener("click", () => this.finish("open-recovery"));
    const later = actions.createEl("button", { text: t("modal.saveConflict.later"), cls: "mod-cta" });
    later.addEventListener("click", () => this.finish("later"));
    this.modalEl.ownerDocument.defaultView?.setTimeout(() => later.focus());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.finish("later", false);
  }

  private finish(action: SaveConflictAction, close = true): void {
    if (this.settled) return;
    this.settled = true;
    if (close) this.close();
    this.onAction(action);
  }
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.ceil(bytes / 1024)} KiB`;
}

/**
 * Explicit text import keeps a large editable source field and rule selection
 * in one dialog. No rule is preselected: the importer never guesses whether a
 * user's indentation or Markdown headings are authoritative.
 */
export class TextImportModal extends Modal {
  private text: string;
  private rule: TextImportRule | "" = "";
  private textAreaEl!: HTMLTextAreaElement;
  private errorEl!: HTMLElement;
  private importButtonEl!: HTMLButtonElement;
  private submitting = false;

  constructor(
    app: App,
    initialText: string,
    private readonly onSubmit: (options: TextImportOptions) => Promise<string | undefined>
  ) {
    super(app);
    this.text = initialText;
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.import.title"));
    this.modalEl.addClass("mtn-text-import-modal");

    const sourceField = this.contentEl.createDiv("mtn-text-import-field");
    sourceField.createEl("label", { text: t("modal.import.data") });
    this.textAreaEl = sourceField.createEl("textarea", {
      cls: "mtn-text-import-source",
      attr: {
        rows: "14",
        spellcheck: "false",
        placeholder: t("modal.import.placeholder"),
        "aria-label": t("modal.import.data")
      }
    });
    this.textAreaEl.value = this.text;
    this.textAreaEl.addEventListener("input", () => {
      this.text = this.textAreaEl.value;
      this.clearError();
      this.updateImportButton();
    });

    new Setting(this.contentEl)
      .setName(t("modal.import.rule"))
      .setDesc(t("modal.import.ruleDesc"))
      .addDropdown((dropdown) => dropdown
        .addOption("", t("modal.import.chooseRule"))
        .addOption("list", t("modal.import.rule.list"))
        .addOption("headings", t("modal.import.rule.headings"))
        .setValue("")
        .onChange((value) => {
          this.rule = value === "list" || value === "headings" ? value : "";
          this.clearError();
          this.updateImportButton();
        }));

    this.errorEl = this.contentEl.createDiv({
      cls: "mtn-text-import-error",
      attr: { role: "alert", "aria-live": "polite" }
    });

    const actions = this.contentEl.createDiv("mtn-text-import-actions");
    actions.createEl("button", {
      text: t("modal.cancel"),
      attr: { type: "button" }
    }).addEventListener("click", () => this.close());
    this.importButtonEl = actions.createEl("button", {
      cls: "mod-cta",
      text: t("action.import"),
      attr: { type: "button" }
    });
    this.importButtonEl.addEventListener("click", () => void this.submit());
    this.updateImportButton();

    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => this.textAreaEl.focus());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.text.trim() || !this.rule) return;
    this.submitting = true;
    this.updateImportButton();
    this.clearError();
    try {
      const error = await this.onSubmit({ text: this.text, rule: this.rule });
      if (error) {
        this.errorEl.setText(error);
        return;
      }
      this.close();
    } catch (error) {
      this.errorEl.setText(t("modal.import.failed", {
        message: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      this.submitting = false;
      this.updateImportButton();
    }
  }

  private clearError(): void {
    this.errorEl?.setText("");
  }

  private updateImportButton(): void {
    if (!this.importButtonEl) return;
    this.importButtonEl.disabled = this.submitting || !this.text.trim() || !this.rule;
  }
}

/** Values returned by the Ribbon's combined name-and-folder creation dialog. */
export interface CreateMindTreeOptions {
  title: string;
  folderPath: string;
}

/**
 * Let the user choose the destination before creating a mind tree. Keeping the
 * name and folder in one modal avoids a fragile two-dialog sequence and makes
 * the final vault path clear before any file is written.
 */
export class CreateMindTreeModal extends Modal {
  private title = "";
  private selectedFolderPath?: string;
  private titleInputEl!: HTMLInputElement;
  private folderInputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private createButtonEl!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly folderPaths: string[],
    initialFolderPath: string,
    private readonly onSubmit: (options: CreateMindTreeOptions) => void
  ) {
    super(app);
    this.title = t("tree.newName");
    this.selectedFolderPath = this.findExactFolder(initialFolderPath) ?? this.findExactFolder("");
  }

  onOpen(): void {
    this.titleEl.setText(t("tree.create"));
    this.modalEl.addClass("mtn-create-tree-modal");

    const nameField = this.contentEl.createDiv("mtn-create-tree-field");
    nameField.createEl("label", { text: t("tree.nameLabel") });
    this.titleInputEl = nameField.createEl("input", {
      cls: "mtn-create-tree-name",
      type: "text",
      value: this.title,
      attr: { placeholder: t("tree.namePlaceholder"), "aria-label": t("tree.nameLabel") }
    });

    const folderField = this.contentEl.createDiv("mtn-create-tree-field");
    folderField.createEl("label", { text: t("tree.targetFolder") });
    this.folderInputEl = folderField.createEl("input", {
      cls: "mtn-create-tree-folder-search",
      type: "search",
      value: this.selectedFolderPath === undefined ? "" : displayFolderPath(this.selectedFolderPath),
      attr: { placeholder: t("tree.folderPlaceholder"), "aria-label": t("tree.targetFolder") }
    });
    this.resultsEl = folderField.createDiv({
      cls: "mtn-create-tree-folder-results",
      attr: { role: "listbox", "aria-label": t("tree.folderResults") }
    });

    const actions = this.contentEl.createDiv("mtn-create-tree-actions");
    actions.createEl("button", {
      text: t("modal.cancel"),
      attr: { type: "button" }
    }).addEventListener("click", () => this.close());
    this.createButtonEl = actions.createEl("button", {
      cls: "mod-cta",
      text: t("action.create"),
      attr: { type: "button" }
    });
    this.createButtonEl.addEventListener("click", () => this.submit());

    this.titleInputEl.addEventListener("input", () => {
      this.title = this.titleInputEl.value;
      this.updateCreateButton();
    });
    this.titleInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submit();
    });
    this.folderInputEl.addEventListener("input", () => {
      this.selectedFolderPath = this.findExactFolder(this.folderInputEl.value);
      this.renderFolderResults();
      this.updateCreateButton();
    });
    this.folderInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submit();
    });

    this.renderFolderResults();
    this.updateCreateButton();
    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => {
      this.titleInputEl.focus();
      this.titleInputEl.select();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderFolderResults(): void {
    this.resultsEl.empty();
    const query = normalizeFolderPath(this.folderInputEl.value).toLocaleLowerCase();
    const matches = this.folderPaths
      .filter((path) => !query || displayFolderPath(path).toLocaleLowerCase().includes(query))
      .slice(0, 12);
    for (const path of matches) {
      const option = this.resultsEl.createEl("button", {
        cls: "mtn-create-tree-folder-option",
        text: displayFolderPath(path),
        attr: { type: "button", role: "option", "aria-selected": String(path === this.selectedFolderPath) }
      });
      option.toggleClass("is-selected", path === this.selectedFolderPath);
      option.addEventListener("click", () => this.selectFolder(path));
    }
    if (matches.length === 0) {
      this.resultsEl.createDiv({ cls: "mtn-create-tree-folder-empty", text: t("tree.noFolders") });
    }
  }

  private selectFolder(path: string): void {
    this.selectedFolderPath = normalizeFolderPath(path);
    this.folderInputEl.value = displayFolderPath(this.selectedFolderPath);
    this.renderFolderResults();
    this.updateCreateButton();
  }

  private findExactFolder(value: string): string | undefined {
    const normalized = normalizeFolderPath(value);
    return this.folderPaths.find((path) => normalizeFolderPath(path).toLocaleLowerCase() === normalized.toLocaleLowerCase());
  }

  private updateCreateButton(): void {
    this.createButtonEl.disabled = this.title.trim().length === 0 || this.selectedFolderPath === undefined;
  }

  private submit(): void {
    const title = this.title.trim();
    if (!title || this.selectedFolderPath === undefined) return;
    const folderPath = this.selectedFolderPath;
    this.close();
    this.onSubmit({ title, folderPath });
  }
}

export type DeleteBranchAction = "topics-and-files" | "files-only" | "topics-only";

export interface DeleteBranchSummary {
  topicTitles: string[];
  filePaths: string[];
}

let deleteSummaryDetailSequence = 0;

/**
 * Dedicated destructive-action dialog for a branch. Keeping its four choices in
 * one component makes the default action and danger hierarchy explicit instead
 * of relying on a generic two-button confirmation dialog.
 */
export class DeleteBranchModal extends Modal {
  private submitted = false;
  private readonly floatingDetails: HTMLElement[] = [];

  constructor(
    app: App,
    private readonly summary: DeleteBranchSummary,
    private readonly onSubmit: (action: DeleteBranchAction) => void
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("modal.delete.title"));
    this.modalEl.addClass("mtn-delete-modal");

    // The warning is deliberately the first content row, before counts or
    // actions, because two choices can remove real files from the vault.
    const warning = this.contentEl.createDiv({
      cls: "callout mtn-delete-warning",
      attr: { "data-callout": "warning" }
    });
    const warningTitle = warning.createDiv("callout-title");
    const warningIcon = warningTitle.createSpan("callout-icon");
    setIcon(warningIcon, "triangle-alert");
    warningTitle.createSpan({ cls: "callout-title-inner", text: t("modal.delete.warning") });

    const summaries = this.contentEl.createDiv("mtn-delete-summaries");
    this.renderSummaryCard(
      summaries,
      this.summary.topicTitles.length,
      t("modal.delete.topics", { count: this.summary.topicTitles.length }),
      t("modal.delete.topicList"),
      this.summary.topicTitles
    );
    this.renderSummaryCard(
      summaries,
      this.summary.filePaths.length,
      t("modal.delete.files", { count: this.summary.filePaths.length }),
      t("modal.delete.fileList"),
      this.summary.filePaths.length > 0 ? this.summary.filePaths : [t("modal.delete.noFiles")]
    );

    const actions = this.contentEl.createDiv("mtn-delete-actions");
    actions.createEl("button", {
      cls: "mtn-delete-action",
      text: t("modal.cancel"),
      attr: { type: "button" }
    }).addEventListener("click", () => this.close());

    const bothButton = actions.createEl("button", {
      cls: "mtn-delete-action mod-warning",
      text: t("modal.delete.topicsAndFiles"),
      attr: { type: "button" }
    });
    bothButton.addEventListener("click", () => this.submit("topics-and-files"));

    const filesButton = actions.createEl("button", {
      cls: "mtn-delete-action is-soft-warning",
      text: t("modal.delete.filesOnly"),
      attr: { type: "button" }
    });
    filesButton.addEventListener("click", () => this.submit("files-only"));

    const topicsButton = actions.createEl("button", {
      cls: "mtn-delete-action is-soft-warning is-default",
      text: t("modal.delete.topicsOnly"),
      attr: { type: "button" }
    });
    topicsButton.addEventListener("click", () => this.submit("topics-only"));

    // Focusing the safe default gives Enter its normal button semantics while
    // still allowing keyboard users to Tab to and activate any other action.
    window.setTimeout(() => topicsButton.focus());
  }

  onClose(): void {
    // Detail lists live under document.body so no modal overflow boundary can
    // clip them. They therefore need explicit cleanup with the modal lifecycle.
    for (const detail of this.floatingDetails) detail.remove();
    this.floatingDetails.length = 0;
    this.contentEl.empty();
  }

  /** Build a keyboard-focusable count card whose detail list appears on hover. */
  private renderSummaryCard(
    container: HTMLElement,
    count: number,
    label: string,
    detailTitle: string,
    entries: string[]
  ): void {
    const card = container.createDiv({ cls: "mtn-delete-summary", attr: { tabindex: "0" } });
    card.createEl("strong", { text: String(count) });
    card.createSpan({ text: label });
    // Append to body instead of the card/modal. A fixed-position portal floats
    // beyond the dialog border and never reserves space in the dialog layout.
    const detailId = `mtn-delete-summary-detail-${++deleteSummaryDetailSequence}`;
    card.setAttribute("aria-describedby", detailId);
    const ownerDocument = card.ownerDocument;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const detail = ownerDocument.body.createDiv({
      cls: "mtn-delete-summary-detail",
      attr: { id: detailId, role: "tooltip" }
    });
    this.floatingDetails.push(detail);
    detail.createEl("div", { cls: "mtn-delete-summary-detail-title", text: detailTitle });
    const list = detail.createEl("ul");
    for (const entry of entries) list.createEl("li", { text: entry });

    let hideTimer: number | undefined;
    const cancelHide = (): void => {
      if (hideTimer === undefined) return;
      ownerWindow.clearTimeout(hideTimer);
      hideTimer = undefined;
    };
    const show = (): void => {
      cancelHide();
      detail.addClass("is-visible");
      this.positionSummaryDetail(card, detail);
    };
    const hide = (): void => {
      hideTimer = undefined;
      if (card.matches(":hover") || detail.matches(":hover") || ownerDocument.activeElement === card) return;
      detail.removeClass("is-visible");
    };
    const scheduleHide = (): void => {
      cancelHide();
      hideTimer = ownerWindow.setTimeout(hide, 120);
    };
    card.addEventListener("mouseenter", show);
    card.addEventListener("mouseleave", scheduleHide);
    card.addEventListener("focus", show);
    card.addEventListener("blur", scheduleHide);
    detail.addEventListener("mouseenter", cancelHide);
    detail.addEventListener("mouseleave", scheduleHide);
  }

  /** Keep the floating list inside the viewport, preferring below the card. */
  private positionSummaryDetail(card: HTMLElement, detail: HTMLElement): void {
    const gutter = 12;
    const gap = 7;
    const ownerWindow = card.ownerDocument.defaultView ?? window;
    const cardRect = card.getBoundingClientRect();
    detail.style.width = `${Math.max(260, cardRect.width)}px`;
    detail.style.visibility = "hidden";
    const detailRect = detail.getBoundingClientRect();
    const maximumLeft = Math.max(gutter, ownerWindow.innerWidth - detailRect.width - gutter);
    const centeredLeft = cardRect.left + (cardRect.width - detailRect.width) / 2;
    const left = Math.min(maximumLeft, Math.max(gutter, centeredLeft));
    let top = cardRect.bottom + gap;
    if (top + detailRect.height > ownerWindow.innerHeight - gutter) {
      top = Math.max(gutter, cardRect.top - detailRect.height - gap);
    }
    detail.style.left = `${left}px`;
    detail.style.top = `${top}px`;
    detail.style.visibility = "";
  }

  private submit(action: DeleteBranchAction): void {
    if (this.submitted) return;
    this.submitted = true;
    this.close();
    this.onSubmit(action);
  }
}

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(t("modal.searchFiles"));
  }

  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}

/** Searchable dialog that initially lists every file from the template folder. */
export class TemplateSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(t("modal.template.search"));
  }

  onOpen(): void {
    super.onOpen();
    this.titleEl.setText(t("modal.template.title"));
  }

  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}

export type MoveNotesMode = "current" | "branch";

/** Searchable folder picker with the two move scopes required by node actions. */
export class MoveNotesModal extends Modal {
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
    private readonly onSubmit: (folderPath: string, mode: MoveNotesMode) => void
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("modal.moveNotes.title"));
    this.modalEl.addClass("mtn-move-notes-modal");
    this.inputEl = this.contentEl.createEl("input", {
      cls: "mtn-move-folder-search",
      type: "search",
      attr: { placeholder: t("modal.moveNotes.placeholder"), "aria-label": t("modal.moveNotes.placeholder") }
    });
    const currentFolder = this.contentEl.createEl("button", {
      cls: "mtn-move-current-folder",
      text: t("modal.moveNotes.currentFolder"),
      attr: { type: "button" }
    });
    currentFolder.addEventListener("click", () => this.selectFolder(this.currentFolderPath));
    this.resultsEl = this.contentEl.createDiv({
      cls: "mtn-move-folder-results",
      attr: { role: "listbox", "aria-label": t("modal.moveNotes.results") }
    });

    const actions = this.contentEl.createDiv("mtn-move-notes-actions");
    this.currentButtonEl = actions.createEl("button", {
      text: t("modal.moveNotes.currentOnly"),
      attr: { type: "button" }
    });
    this.currentButtonEl.addEventListener("click", () => this.submit("current"));
    this.branchButtonEl = actions.createEl("button", {
      cls: "mod-cta",
      text: t("modal.moveNotes.branch"),
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
    const ownerWindow = this.modalEl.ownerDocument.defaultView ?? window;
    ownerWindow.setTimeout(() => this.inputEl.focus());
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
        attr: { type: "button", role: "option", "aria-selected": String(path === this.selectedFolderPath) }
      });
      option.toggleClass("is-selected", path === this.selectedFolderPath);
      option.addEventListener("click", () => this.selectFolder(path));
    }
    this.resultsEl.toggleClass("is-empty", matches.length === 0);
    if (matches.length === 0) this.resultsEl.createDiv({ cls: "mtn-move-folder-empty", text: t("modal.moveNotes.noFolders") });
  }

  private selectFolder(path: string): void {
    this.selectedFolderPath = normalizeFolderPath(path);
    this.inputEl.value = displayFolderPath(this.selectedFolderPath);
    this.renderFolderResults();
    this.updateButtons();
  }

  private findExactFolder(value: string): string | undefined {
    const normalized = normalizeFolderPath(value);
    return this.folderPaths.find((path) => normalizeFolderPath(path).toLocaleLowerCase() === normalized.toLocaleLowerCase());
  }

  private updateButtons(): void {
    const selected = this.selectedFolderPath !== undefined;
    this.currentButtonEl.disabled = !selected || !this.canMoveCurrent;
    this.branchButtonEl.disabled = !selected || !this.canMoveBranch;
  }

  private submit(mode: MoveNotesMode): void {
    if (this.selectedFolderPath === undefined) return;
    if (mode === "current" && !this.canMoveCurrent) return;
    if (mode === "branch" && !this.canMoveBranch) return;
    const destination = this.selectedFolderPath;
    this.close();
    this.onSubmit(destination, mode);
  }
}

export class UrlPromptModal extends Modal {
  private url = "https://";
  private title = "";

  constructor(app: App, private readonly onSubmit: (url: string, title: string) => void) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("modal.linkWeb.title"));
    new Setting(this.contentEl).setName(t("modal.linkWeb.url")).addText((input) => input
      .setValue(this.url)
      .onChange((value) => { this.url = value.trim(); }));
    new Setting(this.contentEl).setName(t("modal.linkWeb.nodeTitle")).setDesc(t("modal.linkWeb.titleDesc")).addText((input) => input
      .onChange((value) => { this.title = value.trim(); }));
    new Setting(this.contentEl).addButton((button) => button.setCta().setButtonText(t("action.link")).onClick(() => {
      let parsed: URL;
      try { parsed = new URL(this.url); } catch { return; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      this.close();
      this.onSubmit(parsed.toString(), this.title || parsed.hostname);
    }));
  }
}

function normalizeFolderPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function displayFolderPath(value: string): string {
  return normalizeFolderPath(value) || "/";
}

export type CandidateAction = "root" | "collect";

export class SameFolderCandidatesModal extends Modal {
  private readonly selected = new Set<string>();

  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly onSubmit: (files: TFile[], action: CandidateAction) => void
  ) {
    super(app);
    for (const file of files) this.selected.add(file.path);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.collect.title"));
    this.contentEl.createEl("p", { text: t("modal.collect.desc") });
    const list = this.contentEl.createDiv("mtn-candidate-list");
    for (const file of this.files) {
      new Setting(list).setName(file.name).setDesc(file.path).addToggle((toggle) => toggle
        .setValue(true)
        .onChange((value) => value ? this.selected.add(file.path) : this.selected.delete(file.path)));
    }
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("modal.collect.ignore")).onClick(() => this.close()))
      .addButton((button) => button.setButtonText(t("modal.collect.root")).onClick(() => this.submit("root")))
      .addButton((button) => button.setCta().setButtonText(t("modal.collect.collection")).onClick(() => this.submit("collect")));
  }

  private submit(action: CandidateAction): void {
    const selected = this.files.filter((file) => this.selected.has(file.path));
    this.close();
    if (selected.length > 0) this.onSubmit(selected, action);
  }
}
