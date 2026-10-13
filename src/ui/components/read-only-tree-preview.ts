import type { TFile } from "obsidian";
import type { MindTreeDocument, MindTreeNode, MindTreeNodeAlignment, NodeId } from "../../types";
import { t } from "../../i18n";
import { BrowserImageNodePresentation } from "../image-nodes";
import { layoutTree } from "../../render/layout";
import { BrowserNodeTextMeasurer } from "../text-measurer";
import { BrowserResourceBadgeMeasurer } from "../resource-badges";
import { createResourceBadgePresentation, type FileBadgeRules } from "../../render/resource-badges";
import { getBranchColorSlots } from "../../render/presentation";
import { resolveFoldDirections } from "../fold-direction";
import { NodeRenderer, ConnectionRenderer } from "../renderers";
import { centerViewportOnRect, pinchViewport, viewportToCssPresentation, wheelDeltaToPixels, zoomViewportAt,
  type ViewportState, type ViewportPoint } from "../../render/viewport";
import { DisposableUiObject } from "./ui-object";
import { createCanvasLabelId } from "./canvas-shell";
import { previewDocument } from "./version-preview-model";
import { applyMindTreeThemeDataset } from "../theme-dataset";

export interface TreePreviewOptions extends FileBadgeRules {
  readonly nodeWrapWidth: number;
  readonly nodeAlignment: MindTreeNodeAlignment;
  readonly resolveImageFile: (node: Readonly<MindTreeNode>) => TFile | undefined;
  readonly resourcePath: (file: TFile) => string;
  /** Branch to lay out; defaults to the document root (version/theme previews). */
  readonly startId?: NodeId;
  /** Root classes, so `mtn-view` stays intact for the theme dataset. */
  readonly className?: string;
  /** `contain` fits both axes; `width` only scales the layout into the width. */
  readonly fit?: "contain" | "width";
  /** Opt in to a live open control; node links and edits stay dead in a preview. */
  readonly allowResourceOpen?: boolean;
  /** Host handler for an enabled open control, called with the rendered node. */
  readonly openResource?: (node: Readonly<MindTreeNode>) => void;
  /** Let an ordinary wheel gesture scroll the host note instead of panning. */
  readonly wheelPassThrough?: boolean;
  /** Reports the laid-out size and zoom; used by height-fitting hosts. */
  readonly onLayout?: (size: { readonly width: number; readonly height: number; readonly zoom: number }) => void;
  /**
   * Re-fit and re-center whenever the container size changes, until the reader
   * pans or zooms. A host whose box height is derived from the layout needs
   * this: the very first fit still measures the placeholder height, so the
   * branch would otherwise sit off-center (and be clipped) in its final box.
   * Only meaningful together with `fit: "width"`: a `contain` fit derives its
   * zoom from the height and would therefore feed the box back into itself.
   */
  readonly refitOnResize?: boolean;
}

/** No document/session mutation ports exist on a preview. */
export class ReadOnlyTreePreview extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly pan: HTMLElement;
  private readonly world: HTMLElement;
  private readonly nodes: NodeRenderer;
  private readonly connections: ConnectionRenderer;
  private readonly text: BrowserNodeTextMeasurer;
  private readonly badges: BrowserResourceBadgeMeasurer;
  private readonly images: BrowserImageNodePresentation;
  private readonly label: HTMLElement;
  private readonly pointers = new Map<number, ViewportPoint>();
  private readonly folds = new Map<string, boolean>();
  private document?: MindTreeDocument;
  private viewport: ViewportState = { x: 0, y: 0, zoom: 1 };
  private fitted = false;
  private fittedWidth = 0;
  private fittedHeight = 0;
  /** Once the reader moves the viewport, only they own its position. */
  private userAdjusted = false;
  private lastReportedLayout?: { readonly width: number; readonly height: number; readonly zoom: number };

  constructor(parent: HTMLElement, label: string, private readonly options: TreePreviewOptions) {
    super();
    this.element = parent.createDiv(options.className ?? "mtn-view mtn-version-tree");
    this.canvas = this.element.createDiv("mtn-canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    const name = this.canvas.createSpan({ cls: "mtn-visually-hidden", text: label });
    this.label = name;
    name.id = createCanvasLabelId();
    this.canvas.setAttribute("aria-labelledby", name.id);
    this.pan = this.canvas.createDiv("mtn-pan-layer");
    this.world = this.pan.createDiv("mtn-world");
    const svg = this.element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("mtn-connections");
    this.world.append(svg);
    this.connections = new ConnectionRenderer(svg);
    this.nodes = new NodeRenderer(this.world.createDiv("mtn-node-layer"));
    const owner = this.element.ownerDocument.defaultView!;
    this.text = new BrowserNodeTextMeasurer(this.element, () => this.render());
    this.badges = new BrowserResourceBadgeMeasurer(this.element);
    this.images = new BrowserImageNodePresentation(owner, options.resolveImageFile, options.resourcePath, () => this.render());
    this.own(() => { this.text.destroy(); this.badges.destroy(); this.images.destroy(); this.nodes.destroy(); this.connections.destroy(); });
    const resize = new owner.ResizeObserver(() => this.render());
    resize.observe(this.canvas);
    this.own(() => resize.disconnect());

    this.listen(this.canvas, "wheel", ((event: WheelEvent) => {
      // An embedded preview must not trap the host note's scroll: an ordinary
      // wheel passes through, while the zoom gesture (Ctrl/Cmd) stays ours.
      const zoomGesture = event.ctrlKey || event.metaKey;
      if (!zoomGesture && this.options.wheelPassThrough === true) return;
      event.preventDefault(); event.stopPropagation();
      const rect = this.canvas.getBoundingClientRect();
      if (zoomGesture) this.viewport = zoomViewportAt(this.viewport, event.deltaY < 0 ? 0.1 : -0.1,
        event.clientX - rect.left, event.clientY - rect.top);
      else {
        const delta = wheelDeltaToPixels(event.deltaY, event.deltaMode, rect.height);
        if (event.shiftKey) this.viewport.x -= delta; else this.viewport.y -= delta;
      }
      this.userAdjusted = true;
      this.applyViewport();
    }) as EventListener, { passive: false });
    this.listen(this.canvas, "pointerdown", ((event: PointerEvent) => {
      if ((event.target as Element).closest(".mtn-fold-button")) return;
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
      event.preventDefault(); event.stopPropagation();
      this.canvas.focus({ preventScroll: true });
      this.pointers.set(event.pointerId, this.point(event));
      this.canvas.setPointerCapture(event.pointerId);
    }) as EventListener);
    this.listen(this.canvas, "pointermove", ((event: PointerEvent) => {
      if (!this.pointers.has(event.pointerId)) return;
      event.preventDefault(); event.stopPropagation();
      const ids = [...this.pointers.keys()].slice(0, 2);
      const before = ids.map((id) => this.pointers.get(id)!);
      this.pointers.set(event.pointerId, this.point(event));
      if (ids.length === 2) this.viewport = pinchViewport(this.viewport, [before[0]!, before[1]!],
        [this.pointers.get(ids[0]!)!, this.pointers.get(ids[1]!)!]);
      else {
        const after = this.pointers.get(event.pointerId)!;
        this.viewport.x += after.x - before[0]!.x;
        this.viewport.y += after.y - before[0]!.y;
      }
      this.userAdjusted = true;
      this.applyViewport();
    }) as EventListener);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) this.listen(this.canvas, name, ((event: PointerEvent) => {
      if (!this.pointers.delete(event.pointerId)) return;
      event.stopPropagation();
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    }) as EventListener);
    const releasePointers = (): void => {
      for (const id of [...this.pointers.keys()]) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
      this.pointers.clear();
    };
    this.listen(owner, "blur", releasePointers);
    this.listen(this.element.ownerDocument, "visibilitychange", () => {
      if (this.element.ownerDocument.hidden) releasePointers();
    });
    this.own(releasePointers);
    // Touch isolation is local to this pane. Native button clicks remain live;
    // canvas gestures never reach Obsidian's sidebar/down-swipe handlers.
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) this.listen(this.canvas, name, (event) => {
      event.stopPropagation();
      if (!(event.target as Element).closest("button") && event.cancelable) event.preventDefault();
    }, { capture: true, passive: false });
    for (const name of ["contextmenu", "dragover", "drop", "dblclick"]) this.listen(this.canvas, name,
      (event) => { event.preventDefault(); event.stopPropagation(); });
    this.listen(this.canvas, "keydown", ((event: KeyboardEvent) => {
      if (event.target !== this.canvas) return;
      const delta = 40;
      if (event.key === "ArrowLeft") this.viewport.x += delta;
      else if (event.key === "ArrowRight") this.viewport.x -= delta;
      else if (event.key === "ArrowUp") this.viewport.y += delta;
      else if (event.key === "ArrowDown") this.viewport.y -= delta;
      else if (event.key === "+" || event.key === "=" || event.key === "-") this.viewport = zoomViewportAt(this.viewport,
        event.key === "-" ? -0.1 : 0.1, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
      else return;
      event.preventDefault(); event.stopPropagation();
      this.userAdjusted = true;
      this.applyViewport();
    }) as EventListener);
  }

  update(document: MindTreeDocument): void {
    if (this.document === document) return;
    this.document = document;
    this.render();
  }

  /**
   * Refresh the accessible name without rebuilding the canvas. An in-place
   * `update()` keeps the viewport and folds, so a retitled branch would
   * otherwise keep announcing its previous title.
   */
  setLabel(label: string): void {
    this.label.textContent = label;
  }

  private point(event: PointerEvent): ViewportPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private render(): void {
    if (!this.document || this.cleanup.isDisposed) return;
    const document = previewDocument(this.document, this.folds);
    const settings = document.settings;
    applyMindTreeThemeDataset(this.element, settings);
    this.text.refreshStyles(); this.badges.refreshStyles();    const badges = createResourceBadgePresentation(this.options,
      { mindTree: t("node.mindTreeMarker"), drawing: t("node.drawingMarker") }, this.badges);
    const layout = layoutTree(document, this.options.startId ?? document.rootId, true, this.options.nodeWrapWidth,
      settings.layoutMode, this.options.nodeAlignment, this.text, badges, this.images);
    const colors = getBranchColorSlots(document);
    this.connections.render({ layout, settings, positions: new Map(layout.nodes.map((node) => [node.id, node])), branchColorSlots: colors });
    const noop = (): void => undefined;
    this.nodes.render({ document, positions: layout.nodes, width: layout.width, height: layout.height,
      selectedIds: new Set(), editingSelectionMode: "end", branchColorSlots: colors,
      foldDirections: resolveFoldDirections(document, layout.nodes, settings.layoutMode),
      nodeWrapWidth: this.options.nodeWrapWidth, textMeasurer: this.text, resourceBadgePresentation: badges,
      imageNodePresentation: this.images, readOnly: true,
      resourceOpenEnabled: this.options.allowResourceOpen === true }, {
      finishEdit: () => "rejected", updateEditDraft: noop, cancelEdit: noop, saveImmediately: noop, focusCanvas: noop,
      nodePointerDown: noop, beginEdit: noop, showContextMenu: noop,
      openResource: (id) => {
        // Resolve from the document rendered by this pass: a host may swap in a
        // new document (the note embed refreshes in place) without rebuilding
        // the options, so a captured document would open a stale resource.
        const node = document.nodes[id];
        if (node) this.options.openResource?.(node);
      },
      goToLinkedNode: noop, beginImageResize: noop,
      toggleCollapsed: (id) => { this.folds.set(id, !document.nodes[id]?.collapsed); this.render(); }
    });
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!this.fitted && width > 0 && height > 0) {
      this.fitToContainer(width, height, layout.width, layout.height);
      this.fitted = true;
    } else if (this.options.refitOnResize === true && !this.userAdjusted
      && width > 0 && height > 0
      // Ignore sub-pixel churn: a box change can reflow the host note (scrollbar)
      // and a hair-thin feedback would otherwise be able to oscillate.
      && (width !== this.fittedWidth || Math.abs(height - this.fittedHeight) >= 2)) {
      // The host just applied the height it derived from this layout: re-fit so
      // the branch is centered in the box that will actually be shown.
      this.fitToContainer(width, height, layout.width, layout.height);
    }
    this.applyViewport();
    this.reportLayout(layout.width, layout.height);
  }

  /** Center the whole laid-out branch inside the canvas at the fitting zoom. */
  private fitToContainer(width: number, height: number, layoutWidth: number, layoutHeight: number): void {
    const zoom = this.options.fit === "width"
      ? Math.min(1, (width - 48) / Math.max(1, layoutWidth))
      : Math.max(0.2, Math.min(1, (width - 48) / Math.max(1, layoutWidth), (height - 48) / Math.max(1, layoutHeight)));
    this.viewport = centerViewportOnRect(width, height, { x: 0, y: 0, width: layoutWidth, height: layoutHeight }, zoom);
    this.fittedWidth = width;
    this.fittedHeight = height;
  }

  /**
   * Report only real changes: a host that resizes itself from this callback
   * would otherwise feed the ResizeObserver that triggered the render.
   */
  private reportLayout(width: number, height: number): void {
    const onLayout = this.options.onLayout;
    if (!onLayout) return;
    const zoom = this.viewport.zoom;
    const last = this.lastReportedLayout;
    if (last && last.width === width && last.height === height && last.zoom === zoom) return;
    this.lastReportedLayout = { width, height, zoom };
    onLayout({ width, height, zoom });
  }

  private applyViewport(): void {
    const css = viewportToCssPresentation(this.viewport, this.element.ownerDocument.defaultView!.devicePixelRatio);
    this.pan.style.left = css.panLeft; this.pan.style.top = css.panTop;
    if (this.element.ownerDocument.defaultView!.CSS.supports("zoom", "1")) this.world.style.zoom = css.contentZoom;
    else this.world.style.transform = `scale(${css.contentZoom})`;
  }
}
