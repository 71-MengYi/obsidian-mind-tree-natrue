import type { TFile } from "obsidian";
import type { MindTreeDocument, MindTreeNode, MindTreeNodeAlignment } from "../../types";
import { t } from "../../i18n";
import { BrowserImageNodePresentation } from "../image-nodes";
import { layoutTree } from "../layout";
import { BrowserNodeTextMeasurer } from "../text-measurer";
import { BrowserResourceBadgeMeasurer, createResourceBadgePresentation, type FileBadgeRules } from "../resource-badges";
import { getBranchColorSlots } from "../presentation";
import { resolveFoldDirections } from "../fold-direction";
import { NodeRenderer, ConnectionRenderer } from "../renderers";
import { centerViewportOnRect, pinchViewport, viewportToCssPresentation, wheelDeltaToPixels, zoomViewportAt,
  type ViewportState, type ViewportPoint } from "../viewport";
import { DisposableUiObject } from "./ui-object";
import { createCanvasLabelId } from "./canvas-shell";
import { previewDocument } from "./version-preview-model";

export interface TreePreviewOptions extends FileBadgeRules {
  readonly nodeWrapWidth: number;
  readonly nodeAlignment: MindTreeNodeAlignment;
  readonly resolveImageFile: (node: Readonly<MindTreeNode>) => TFile | undefined;
  readonly resourcePath: (file: TFile) => string;
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
  private readonly pointers = new Map<number, ViewportPoint>();
  private readonly folds = new Map<string, boolean>();
  private document?: MindTreeDocument;
  private viewport: ViewportState = { x: 0, y: 0, zoom: 1 };
  private fitted = false;

  constructor(parent: HTMLElement, label: string, private readonly options: TreePreviewOptions) {
    super();
    this.element = parent.createDiv("mtn-view mtn-version-tree");
    this.canvas = this.element.createDiv("mtn-canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "application");
    const name = this.canvas.createSpan({ cls: "mtn-visually-hidden", text: label });
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
      event.preventDefault(); event.stopPropagation();
      const rect = this.canvas.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) this.viewport = zoomViewportAt(this.viewport, event.deltaY < 0 ? 0.1 : -0.1,
        event.clientX - rect.left, event.clientY - rect.top);
      else {
        const delta = wheelDeltaToPixels(event.deltaY, event.deltaMode, rect.height);
        if (event.shiftKey) this.viewport.x -= delta; else this.viewport.y -= delta;
      }
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
      event.preventDefault(); event.stopPropagation(); this.applyViewport();
    }) as EventListener);
  }

  update(document: MindTreeDocument): void {
    if (this.document === document) return;
    this.document = document;
    this.render();
  }

  private point(event: PointerEvent): ViewportPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private render(): void {
    if (!this.document || this.cleanup.isDisposed) return;
    const document = previewDocument(this.document, this.folds);
    const settings = document.settings;
    this.element.dataset.mtnTheme = settings.theme;
    this.element.dataset.mtnNodeShape = settings.nodeShape;
    this.element.dataset.mtnLayout = settings.layoutMode;
    this.element.dataset.mtnConnectionStyle = settings.connectionStyle;
    this.text.refreshStyles(); this.badges.refreshStyles();
    const badges = createResourceBadgePresentation(this.options,
      { mindTree: t("node.mindTreeMarker"), drawing: t("node.drawingMarker") }, this.badges);
    const layout = layoutTree(document, document.rootId, true, this.options.nodeWrapWidth,
      settings.layoutMode, this.options.nodeAlignment, this.text, badges, this.images);
    const colors = getBranchColorSlots(document);
    this.connections.render({ layout, settings, positions: new Map(layout.nodes.map((node) => [node.id, node])), branchColorSlots: colors });
    const noop = (): void => undefined;
    this.nodes.render({ document, positions: layout.nodes, width: layout.width, height: layout.height,
      selectedIds: new Set(), editingSelectionMode: "end", branchColorSlots: colors,
      foldDirections: resolveFoldDirections(document, layout.nodes, settings.layoutMode),
      nodeWrapWidth: this.options.nodeWrapWidth, textMeasurer: this.text, resourceBadgePresentation: badges,
      imageNodePresentation: this.images, readOnly: true }, {
      finishEdit: noop, updateEditDraft: noop, cancelEdit: noop, saveImmediately: noop, focusCanvas: noop,
      nodePointerDown: noop, beginEdit: noop, showContextMenu: noop, openResource: noop, beginImageResize: noop,
      toggleCollapsed: (id) => { this.folds.set(id, !document.nodes[id]?.collapsed); this.render(); }
    });
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!this.fitted && width > 0 && height > 0) {
      const zoom = Math.max(0.2, Math.min(1, (width - 48) / Math.max(1, layout.width), (height - 48) / Math.max(1, layout.height)));
      this.viewport = centerViewportOnRect(width, height, { x: 0, y: 0, width: layout.width, height: layout.height }, zoom);
      this.fitted = true;
    }
    this.applyViewport();
  }

  private applyViewport(): void {
    const css = viewportToCssPresentation(this.viewport, this.element.ownerDocument.defaultView!.devicePixelRatio);
    this.pan.style.left = css.panLeft; this.pan.style.top = css.panTop;
    if (this.element.ownerDocument.defaultView!.CSS.supports("zoom", "1")) this.world.style.zoom = css.contentZoom;
    else this.world.style.transform = `scale(${css.contentZoom})`;
  }
}
