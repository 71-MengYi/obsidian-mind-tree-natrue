import type { MindTreeNodeAlignment, MindTreeTheme } from "../../types";
import { t } from "../../i18n";
import { THEME_OPTIONS } from "../presentation";
import { ReadOnlyTreePreview, type TreePreviewOptions } from "./read-only-tree-preview";
import { DisposableUiObject } from "./ui-object";
import {
  placeThemePreview,
  themePreviewDocument,
  type ThemePreviewRect,
  type ThemePreviewTitles
} from "./theme-preview-model";

export interface ThemePreviewOptions {
  readonly ownerDocument: Document;
  readonly nodeWrapWidth: number;
  readonly nodeAlignment: MindTreeNodeAlignment;
}

/**
 * Hover preview for one theme choice. It renders a static sample tree through
 * the shared read-only preview, so it needs no document, session or history
 * port and can never write anything back.
 */
export class ThemePreviewPanel extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly options: ThemePreviewOptions;
  private preview?: ReadOnlyTreePreview;
  private anchor?: ThemePreviewRect;
  private shown = false;

  constructor(options: ThemePreviewOptions) {
    super();
    this.options = options;
    this.element = options.ownerDocument.createElement("div");
    this.element.className = "mtn-theme-preview";
    this.element.setAttribute("aria-hidden", "true");
    // The read-only preview keeps a focusable canvas; the whole subtree is
    // inert so a hidden, aria-hidden panel never joins the tab order.
    this.element.inert = true;
    this.element.hidden = true;
    options.ownerDocument.body.append(this.element);
    const owner = options.ownerDocument.defaultView;
    if (owner) {
      // Font-size or zoom changes resize the panel; re-place with the last anchor.
      const resize = new owner.ResizeObserver(() => {
        if (this.shown && this.anchor) this.place(this.anchor);
      });
      resize.observe(this.element);
      this.own(() => resize.disconnect());
    }
    this.own(() => this.preview?.destroy());
  }

  get visible(): boolean {
    return this.shown && !this.cleanup.isDisposed;
  }

  /** Create the sample tree on first use; later calls only swap theme and position. */
  show(theme: MindTreeTheme, anchor: ThemePreviewRect): void {
    if (this.cleanup.isDisposed) return;
    this.anchor = anchor;
    this.shown = true;
    // The panel must have a box before its first placement can measure it.
    this.element.hidden = false;
    const sample = themePreviewDocument(theme, this.titles());
    if (!this.preview) this.preview = new ReadOnlyTreePreview(this.element, this.label(theme), this.previewOptions());
    this.preview.update(sample);
    this.place(anchor);
  }

  /** Immediate hide: no delay and no fade, so a fast pointer path cannot linger. */
  hide(): void {
    this.shown = false;
    this.element.hidden = true;
  }

  private place(anchor: ThemePreviewRect): void {
    const view = this.element.ownerDocument.defaultView;
    const visual = view?.visualViewport;
    const viewport = visual
      ? { left: visual.offsetLeft, top: visual.offsetTop,
        right: visual.offsetLeft + visual.width, bottom: visual.offsetTop + visual.height }
      : { left: 0, top: 0, right: view?.innerWidth ?? 0, bottom: view?.innerHeight ?? 0 };
    const size = this.element.getBoundingClientRect();
    const layout = placeThemePreview(anchor, { width: size.width, height: size.height }, viewport);
    this.element.style.left = `${layout.left}px`;
    this.element.style.top = `${layout.top}px`;
    this.element.dataset.side = layout.side;
  }

  private titles(): ThemePreviewTitles {
    return {
      root: t("theme.preview.root"),
      branchA: t("theme.preview.branchA"),
      branchB: t("theme.preview.branchB"),
      leaf: t("theme.preview.leaf")
    };
  }

  private label(theme: MindTreeTheme): string {
    const option = THEME_OPTIONS.find((item) => item.value === theme);
    return t(option ? option.label : "theme.preview.root");
  }

  private previewOptions(): TreePreviewOptions {
    return {
      ignoredFileBadgeExtensions: [],
      fileExtensionBadgeAliases: {},
      nodeWrapWidth: this.options.nodeWrapWidth,
      nodeAlignment: this.options.nodeAlignment,
      // The sample tree links no files, so both resource lookups stay inert.
      resolveImageFile: () => undefined,
      resourcePath: () => ""
    };
  }
}
