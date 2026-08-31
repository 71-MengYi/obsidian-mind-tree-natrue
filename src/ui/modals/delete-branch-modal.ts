import { App, Modal, setIcon } from "obsidian";
import { t } from "../../i18n";

export type DeleteBranchAction = "topics-and-files" | "files-only" | "topics-only";
export interface DeleteBranchSummary { topicTitles: string[]; filePaths: string[]; }
let detailSequence = 0;

export class DeleteBranchModal extends Modal {
  private submitted = false;
  private readonly floatingDetails: HTMLElement[] = [];
  constructor(app: App, private readonly summary: DeleteBranchSummary,
    private readonly onSubmit: (action: DeleteBranchAction) => void) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("modal.delete.title"));
    this.modalEl.addClass("mtn-delete-modal");
    const warning = this.contentEl.createDiv({ cls: "callout mtn-delete-warning", attr: { "data-callout": "warning" } });
    const warningTitle = warning.createDiv("callout-title");
    const warningIcon = warningTitle.createSpan("callout-icon");
    setIcon(warningIcon, "triangle-alert");
    warningTitle.createSpan({ cls: "callout-title-inner", text: t("modal.delete.warning") });
    const summaries = this.contentEl.createDiv("mtn-delete-summaries");
    this.renderSummaryCard(summaries, this.summary.topicTitles.length,
      t("modal.delete.topics", { count: this.summary.topicTitles.length }),
      t("modal.delete.topicList"), this.summary.topicTitles);
    this.renderSummaryCard(summaries, this.summary.filePaths.length,
      t("modal.delete.files", { count: this.summary.filePaths.length }),
      t("modal.delete.fileList"), this.summary.filePaths.length > 0 ? this.summary.filePaths : [t("modal.delete.noFiles")]);
    const actions = this.contentEl.createDiv("mtn-delete-actions");
    actions.createEl("button", { cls: "mtn-delete-action", text: t("modal.cancel"), attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    const both = actions.createEl("button", { cls: "mtn-delete-action mod-warning", text: t("modal.delete.topicsAndFiles"), attr: { type: "button" } });
    both.addEventListener("click", () => this.submit("topics-and-files"));
    const files = actions.createEl("button", { cls: "mtn-delete-action is-soft-warning", text: t("modal.delete.filesOnly"), attr: { type: "button" } });
    files.addEventListener("click", () => this.submit("files-only"));
    const topics = actions.createEl("button", { cls: "mtn-delete-action is-soft-warning is-default", text: t("modal.delete.topicsOnly"), attr: { type: "button" } });
    topics.addEventListener("click", () => this.submit("topics-only"));
    this.modalEl.ownerDocument.defaultView?.setTimeout(() => topics.focus());
  }
  onClose(): void {
    for (const detail of this.floatingDetails) detail.remove();
    this.floatingDetails.length = 0; this.contentEl.empty();
  }
  private renderSummaryCard(container: HTMLElement, count: number, label: string,
    detailTitle: string, entries: string[]): void {
    const card = container.createDiv({ cls: "mtn-delete-summary", attr: { tabindex: "0" } });
    card.createEl("strong", { text: String(count) }); card.createSpan({ text: label });
    const detailId = `mtn-delete-summary-detail-${++detailSequence}`;
    card.setAttribute("aria-describedby", detailId);
    const ownerDocument = card.ownerDocument;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const detail = ownerDocument.body.createDiv({ cls: "mtn-delete-summary-detail", attr: { id: detailId, role: "tooltip" } });
    this.floatingDetails.push(detail);
    detail.createEl("div", { cls: "mtn-delete-summary-detail-title", text: detailTitle });
    const list = detail.createEl("ul");
    for (const entry of entries) list.createEl("li", { text: entry });
    let hideTimer: number | undefined;
    const cancelHide = (): void => { if (hideTimer !== undefined) { ownerWindow.clearTimeout(hideTimer); hideTimer = undefined; } };
    const show = (): void => { cancelHide(); detail.addClass("is-visible"); this.positionDetail(card, detail); };
    const hide = (): void => {
      hideTimer = undefined;
      if (card.matches(":hover") || detail.matches(":hover") || ownerDocument.activeElement === card) return;
      detail.removeClass("is-visible");
    };
    const scheduleHide = (): void => { cancelHide(); hideTimer = ownerWindow.setTimeout(hide, 120); };
    card.addEventListener("mouseenter", show); card.addEventListener("mouseleave", scheduleHide);
    card.addEventListener("focus", show); card.addEventListener("blur", scheduleHide);
    detail.addEventListener("mouseenter", cancelHide); detail.addEventListener("mouseleave", scheduleHide);
  }
  private positionDetail(card: HTMLElement, detail: HTMLElement): void {
    const gutter = 12; const gap = 7;
    const ownerWindow = card.ownerDocument.defaultView ?? window;
    const cardRect = card.getBoundingClientRect();
    detail.style.width = `${Math.max(260, cardRect.width)}px`; detail.style.visibility = "hidden";
    const detailRect = detail.getBoundingClientRect();
    const maximumLeft = Math.max(gutter, ownerWindow.innerWidth - detailRect.width - gutter);
    const centeredLeft = cardRect.left + (cardRect.width - detailRect.width) / 2;
    const left = Math.min(maximumLeft, Math.max(gutter, centeredLeft));
    let top = cardRect.bottom + gap;
    if (top + detailRect.height > ownerWindow.innerHeight - gutter) top = Math.max(gutter, cardRect.top - detailRect.height - gap);
    detail.style.left = `${left}px`; detail.style.top = `${top}px`; detail.style.visibility = "";
  }
  private submit(action: DeleteBranchAction): void {
    if (this.submitted) return;
    this.submitted = true; this.close(); this.onSubmit(action);
  }
}
