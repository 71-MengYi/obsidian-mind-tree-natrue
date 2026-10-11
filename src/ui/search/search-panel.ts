import { setIcon } from "obsidian";
import type { NodeId } from "../../types";
import { DisposableUiObject } from "../components/ui-object";
import type { SearchCard, SearchHit, SearchRange, SearchResult } from "./search-core";

/** Debounce applied before a keystroke reaches the host's search port. */
const DEFAULT_DEBOUNCE_MS = 120;
/** Placeholder inside `SearchPanelLabels.count`, replaced by the card count. */
const COUNT_PLACEHOLDER = "{count}";
/** Separator glyph between two nodes of a card's ancestor path. */
const PATH_ARROW = "\u2192";

export interface SearchPanelLabels {
  readonly title: string;
  readonly placeholder: string;
  readonly close: string;
  readonly clear: string;
  readonly count: string;
  readonly empty: string;
  readonly loading: string;
  /** Closing note on a card whose hit rows were capped; `{count}` = shown rows. */
  readonly truncated: string;
}

export interface SearchPanelActions {
  /** The host performs the actual search; `undefined` means "input is stale". */
  readonly search: (query: string) => Promise<SearchResult | undefined>;
  readonly jumpToNode: (nodeId: NodeId) => void;
  readonly openFileAtLine: (path: string, line: number) => void;
  /**
   * Optional display title for a path node. Cards only carry node ids, so without
   * this resolver the path row has to fall back to showing the raw id.
   */
  readonly nodeTitle?: (nodeId: NodeId) => string | undefined;
  readonly visibilityChanged?: (open: boolean) => void;
}

export interface SearchPanelClock {
  setTimeout(handler: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export interface SearchPanelOptions {
  readonly debounceMs?: number;
  readonly clock?: SearchPanelClock;
}

const globalClock: SearchPanelClock = {
  setTimeout: (handler, delay) => Number(globalThis.setTimeout(handler, delay)),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle); }
};

/** Prefer the element's own window so popout views keep their own timers. */
function defaultClock(element: HTMLElement): SearchPanelClock {
  const view = element.ownerDocument.defaultView;
  if (!view) return globalClock;
  return {
    setTimeout: (handler, delay) => Number(view.setTimeout(handler, delay)),
    clearTimeout: (handle) => { view.clearTimeout(handle); }
  };
}

/** Wrap every matched range in a `<mark>` and keep the untouched text intact. */
function fillHighlighted(target: HTMLElement, text: string, ranges: readonly SearchRange[]): void {
  let cursor = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(cursor, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    if (from > cursor) target.appendText(text.slice(cursor, from));
    if (to > from) {
      const mark = target.createEl("mark", { cls: "mtn-search-mark" });
      mark.setText(text.slice(from, to));
    }
    cursor = to;
  }
  if (cursor < text.length) target.appendText(text.slice(cursor));
}

/**
 * The right-hand search window: a debounced query field above a scrollable list
 * of result cards. It renders only what `SearchPanelActions.search` returns and
 * never reads the document model, so every host decision stays in the view.
 *
 * Only `×` and Escape close the window. A blurred input deliberately keeps it
 * open, because the user must be able to click a result without losing it.
 */
export class MindTreeSearchPanel extends DisposableUiObject {
  readonly element: HTMLElement;

  private readonly labels: SearchPanelLabels;
  private readonly actions: SearchPanelActions;
  private readonly clock: SearchPanelClock;
  private readonly debounceMs: number;
  private readonly input: HTMLInputElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly results: HTMLElement;
  private opened = false;
  private destroyed = false;
  /** Monotonic request id: any answer that is not the newest one is dropped. */
  private requestId = 0;
  private timer: number | undefined;

  constructor(
    parent: HTMLElement,
    labels: SearchPanelLabels,
    actions: SearchPanelActions,
    options: SearchPanelOptions = {}
  ) {
    super();
    this.labels = labels;
    this.actions = actions;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.element = parent.createDiv("mtn-search-panel");
    this.clock = options.clock ?? defaultClock(this.element);

    const header = this.element.createDiv("mtn-search-panel-header");
    const icon = header.createSpan({ cls: "mtn-search-panel-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "search");
    header.createSpan({ cls: "mtn-search-panel-title", text: labels.title });
    const closeButton = header.createEl("button", {
      cls: "mtn-search-panel-close",
      attr: { type: "button", "aria-label": labels.close }
    });
    setIcon(closeButton, "x");
    this.listen(closeButton, "click", () => this.close());

    const row = this.element.createDiv("mtn-search-panel-search");
    // The clear button is absolutely positioned inside the field wrapper so it
    // reads as part of the input rather than as a third item in the row.
    const field = row.createDiv("mtn-search-panel-input-wrap");
    this.input = field.createEl("input", {
      cls: "mtn-search-panel-input",
      type: "search",
      placeholder: labels.placeholder,
      attr: { "aria-label": labels.placeholder }
    });
    this.clearButton = field.createEl("button", {
      cls: "mtn-search-panel-clear",
      attr: { type: "button", "aria-label": labels.clear, tabindex: "-1" }
    });
    setIcon(this.clearButton, "x");
    this.listen(this.clearButton, "click", () => this.clearQuery());
    this.count = row.createDiv("mtn-search-panel-count");
    this.results = this.element.createDiv("mtn-search-panel-results");
    this.clearResults();
    this.updateClearButton();

    this.listen(this.input, "input", () => this.onInput());
    // The panel owns Escape: stopping propagation keeps the canvas keyboard
    // controller from reacting to the same key press.
    this.listen(this.element, "keydown", ((event: KeyboardEvent) => this.onKeyDown(event)) as EventListener);

    this.element.hidden = true;
  }

  get isOpen(): boolean { return this.opened; }

  open(): void {
    if (this.destroyed) return;
    this.updateClearButton();
    if (this.opened) {
      this.focusInput();
      return;
    }
    this.opened = true;
    this.element.hidden = false;
    this.focusInput();
    this.actions.visibilityChanged?.(true);
  }

  close(): void {
    if (this.destroyed || !this.opened) return;
    this.opened = false;
    this.invalidate();
    this.element.hidden = true;
    this.input.value = "";
    this.clearResults();
    this.updateClearButton();
    this.actions.visibilityChanged?.(false);
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /**
   * The host's document changed: older cached answers are meaningless, so they
   * are dropped and the current query is searched again without waiting for the
   * debounce (the user did not type anything new).
   */
  setContext(): void {
    if (this.destroyed) return;
    const requestId = this.invalidate();
    if (!this.opened) {
      this.clearResults();
      return;
    }
    const query = this.input.value;
    if (this.isBlank(query)) {
      this.clearResults();
      return;
    }
    this.showLoading();
    void this.runSearch(query, requestId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.opened = false;
    this.cancelTimer();
    this.requestId += 1;
    // Drop the rendered results with the element so a detached panel keeps no
    // references to cards, ranges or marks.
    this.element.empty();
    super.destroy();
  }

  private onInput(): void {
    const query = this.input.value;
    const requestId = this.invalidate();
    this.updateClearButton();
    if (this.isBlank(query)) {
      this.clearResults();
      return;
    }
    this.showLoading();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.runSearch(query, requestId);
    }, this.debounceMs);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  private async runSearch(query: string, requestId: number): Promise<void> {
    let result: SearchResult | undefined;
    try {
      result = await this.actions.search(query);
    } catch {
      if (requestId !== this.requestId) return;
      this.clearResults();
      return;
    }
    // A late answer for a superseded query must never reach the DOM.
    if (this.destroyed || requestId !== this.requestId) return;
    // The host marked its own answer stale. Waiting for the next keystroke would
    // leave the scroll area open on a spinner forever, so collapse it instead.
    if (!result) {
      this.clearResults();
      return;
    }
    this.renderResult(result);
  }

  private renderResult(result: SearchResult): void {
    this.results.empty();
    // A finished, non-blank query is the only thing that opens the scroll area.
    this.results.hidden = false;
    const cards = result.cards;
    for (const card of cards) this.renderCard(card);
    if (cards.length === 0) this.showEmptyState();
    this.showCount(true);
    this.count.setText(this.substituteCount(this.labels.count, cards.length));
  }

  private renderCard(card: SearchCard): void {
    const element = this.results.createDiv("mtn-search-card");
    const titleRow = element.createDiv({
      cls: "mtn-search-card-title",
      attr: { role: "button", tabindex: "0", title: card.title }
    });
    if (card.titleHit) fillHighlighted(titleRow, card.title, card.titleHit.ranges);
    else titleRow.setText(card.title);
    this.bindActivation(titleRow, () => this.actions.jumpToNode(card.nodeId));

    // The ancestor chain sits right under the title, without a rule of its own.
    const nodePath = card.nodePath;
    const hasPath = nodePath !== undefined && nodePath.length > 0;
    if (hasPath) this.renderPath(element, nodePath);

    // A node without a file has nothing to open: the title (and its path) is the card.
    const path = card.path;
    if (path === undefined) return;
    card.hits.forEach((hit, index) => {
      // The first hit needs a rule only when the path row sits above it.
      if (index > 0 || hasPath) element.createEl("hr", { cls: "mtn-search-card-separator" });
      this.renderHit(element, path, hit);
    });
    // The core capped this card's rows: say so with a plain note, never a target.
    if (card.hitsLimited === true) {
      const note = element.createDiv({ cls: "mtn-search-card-truncated" });
      note.setText(this.substituteCount(this.labels.truncated, card.hits.length));
    }
  }

  /**
   * Root → … → the node itself. Every arrow is its own element, and it travels in
   * the same non-shrinking flex item as the node it introduces, so wrapping can
   * never leave an arrow dangling at the end of a line.
   */
  private renderPath(element: HTMLElement, nodePath: readonly NodeId[]): void {
    const row = element.createEl("nav", { cls: "mtn-search-card-path" });
    let isFirst = true;
    for (const nodeId of nodePath) {
      this.createPathLink(isFirst ? row : this.createPathSegment(row), nodeId);
      isFirst = false;
    }
  }

  private createPathSegment(row: HTMLElement): HTMLElement {
    const segment = row.createSpan("mtn-search-path-segment");
    segment.createSpan({ cls: "mtn-search-path-arrow", text: PATH_ARROW, attr: { "aria-hidden": "true" } });
    return segment;
  }

  private createPathLink(host: HTMLElement, nodeId: NodeId): void {
    // Cards carry ids only: the host resolves the display name, and a missing or
    // blank answer degrades to the id instead of an empty clickable row.
    const label = this.nodeLabel(nodeId);
    const link = host.createSpan({
      cls: "mtn-search-path-link",
      attr: { role: "button", tabindex: "0", title: label }
    });
    link.setText(label);
    this.bindActivation(link, () => this.actions.jumpToNode(nodeId));
  }

  private nodeLabel(nodeId: NodeId): string {
    const title = this.actions.nodeTitle?.(nodeId);
    return title !== undefined && title.trim().length > 0 ? title : nodeId;
  }

  private renderHit(element: HTMLElement, path: string, hit: SearchHit): void {
    const row = element.createDiv({
      cls: "mtn-search-card-hit",
      attr: { role: "button", tabindex: "0", title: hit.text }
    });
    fillHighlighted(row, hit.text, hit.ranges);
    this.bindActivation(row, () => this.actions.openFileAtLine(path, hit.line));
  }

  /** Title and hit rows are separate targets, each reachable by pointer and keyboard. */
  private bindActivation(row: HTMLElement, activate: () => void): void {
    this.listen(row, "click", () => activate());
    this.listen(row, "keydown", ((event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      activate();
    }) as EventListener);
  }

  private focusInput(): void {
    this.input.focus();
    this.input.select();
  }

  private isBlank(query: string): boolean { return query.trim().length === 0; }

  /** Every count-bearing label uses the same `{count}` placeholder. */
  private substituteCount(template: string, count: number): string {
    return template.split(COUNT_PLACEHOLDER).join(String(count));
  }

  private showLoading(): void {
    this.results.empty();
    this.results.hidden = false;
    this.showCount(true);
    this.count.setText(this.labels.loading);
  }

  private showCount(visible: boolean): void {
    this.count.hidden = !visible;
    if (!visible) this.count.setText("");
  }

  /** Only a non-blank query with zero hits explains itself; an empty query stays compact. */
  private showEmptyState(): void {
    this.results.createDiv({ cls: "mtn-search-empty", text: this.labels.empty });
  }

  /** Empty the field without closing the window, so the user can keep typing. */
  private clearQuery(): void {
    this.invalidate();
    this.input.value = "";
    this.clearResults();
    this.updateClearButton();
    this.input.focus();
  }

  /** The clear affordance is pointless while the query is blank, so it hides. */
  private updateClearButton(): void {
    this.clearButton.hidden = this.isBlank(this.input.value);
  }

  /** No query means no result area at all: the card shrinks to title + field. */
  private clearResults(): void {
    this.results.empty();
    this.results.hidden = true;
    this.showCount(false);
  }

  /** Supersede every in-flight answer and drop the pending debounce. */
  private invalidate(): number {
    this.cancelTimer();
    this.requestId += 1;
    return this.requestId;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
