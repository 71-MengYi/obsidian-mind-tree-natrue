import { nodeTitleMode, type TitleCommitResult } from "../../format/node-title";
import { renderRichTitleSvg } from "../rich-title";
import { setIcon } from "obsidian";
import {
  getVisibleNodeMarkers,
  isCustomMarkerCategory
} from "../../domain/markers";
import { t } from "../../i18n";
import type { MindTreeDocument, MindTreeNode, NodeId, PositionedNode } from "../../types";
import type { FoldDirection } from "../fold-direction";
import { SHARE_SQUARE_ICON } from "../icons";
import {
  getNodeMarkerGeometry,
  type ResourceBadgePresentation
} from "../resource-badges";
import {
  getNodeSizeClass,
  getNodeTitleEditorSize,
  NODE_HORIZONTAL_INSETS
} from "../layout";
import { branchColorCss } from "../presentation";
import type { NodeTextMeasurer } from "../text-measurer";
import type { ImageNodePresentation, ImageNodeVisual } from "../image-nodes";
import { createNodeVisualState, type NodeVisualState } from "./node-render-model";

export interface NodeRenderState {
  readonly readOnly?: boolean;
  readonly document: Readonly<MindTreeDocument>;
  readonly positions: ReadonlyArray<PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly selectedIds: ReadonlySet<NodeId>;
  readonly editingNodeId?: NodeId;
  readonly editingDraftValue?: string;
  /** A resumed draft in a background leaf must not steal keyboard focus. */
  readonly focusEditor?: boolean;
  readonly editingSelectionMode: "all" | "end";
  readonly branchColorSlots: ReadonlyMap<NodeId, number>;
  readonly foldDirections: ReadonlyMap<NodeId, FoldDirection>;
  readonly nodeWrapWidth: number;
  readonly textMeasurer: NodeTextMeasurer;
  readonly resourceBadgePresentation: ResourceBadgePresentation;
  readonly imageNodePresentation: ImageNodePresentation;
}

export interface NodeRenderActions {
  readonly finishEdit: (nodeId: NodeId, title: string) => TitleCommitResult;
  readonly updateEditDraft: (nodeId: NodeId, title: string) => void;
  readonly cancelEdit: () => void;
  readonly saveImmediately: () => void;
  readonly focusCanvas: () => void;
  readonly toggleCollapsed: (nodeId: NodeId) => void;
  readonly nodePointerDown: (event: PointerEvent, nodeId: NodeId) => void;
  readonly beginEdit: (nodeId: NodeId) => void;
  readonly showContextMenu: (event: MouseEvent, nodeId: NodeId) => void;
  readonly openResource: (nodeId: NodeId) => void;
  readonly beginImageResize: (event: PointerEvent, nodeId: NodeId, image: ImageNodeVisual) => void;
  readonly editorReady?: (editor: HTMLTextAreaElement) => void;
}

/** Creates title, editor, badges, resource controls and fold controls for nodes. */
export class NodeRenderer {
  private focusEditor?: () => void;

  constructor(readonly element: HTMLElement) {}

  render(state: NodeRenderState, actions: NodeRenderActions): void {
    this.focusEditor = undefined;
    this.element.empty();
    this.element.style.width = `${state.width}px`;
    this.element.style.height = `${state.height}px`;
    for (const position of state.positions) this.renderNode(position, state, actions);
    this.focusRenderedEditor();
  }

  private focusRenderedEditor(): void {
    const focus = this.focusEditor;
    this.focusEditor = undefined;
    // Stay inside the user activation so iOS can open the software keyboard.
    focus?.();
  }

  destroy(): void {
    this.focusEditor = undefined;
    this.element.empty();
  }

  private renderNode(position: PositionedNode, state: NodeRenderState, actions: NodeRenderActions): void {
    const node = state.document.nodes[position.id];
    if (!node) return;
    const element = this.element.createDiv(`mtn-node ${getNodeSizeClass(position.depth)}`);
    element.dataset.nodeId = node.id;
    element.style.left = `${position.x}px`;
    element.style.top = `${position.y}px`;
    element.style.width = `${position.width}px`;
    element.style.height = `${position.height}px`;
    element.style.setProperty("--mtn-branch-color", branchColorCss(state.branchColorSlots.get(node.id)));
    const image = state.imageNodePresentation.resolve(node);
    const visual = createNodeVisualState(
      node,
      state.selectedIds.has(node.id),
      state.editingNodeId === node.id,
      state.resourceBadgePresentation
    );
    element.toggleClass("is-selected", visual.selected);
    element.toggleClass("is-editing", visual.editing);
    element.toggleClass("is-leaf", visual.leaf);
    element.toggleClass("has-resource", visual.hasResourceControls);
    element.toggleClass("is-title-sync-off", visual.titleSyncDisabled);
    element.toggleClass("has-markers", visual.markerDisplayWidth > 0);
    element.toggleClass("has-image", Boolean(image));
    // The first grid track is the title-only box. It stays fixed while marker
    // and file-control tracks extend the complete node toward screen-right.
    element.style.setProperty(
      "--mtn-node-title-width",
      `${Math.max(1, position.contentWidth - NODE_HORIZONTAL_INSETS)}px`
    );
    element.style.setProperty("--mtn-node-marker-width", `${visual.markerDisplayWidth}px`);
    if (image) {
      element.style.setProperty("--mtn-node-image-width", `${image.width}px`);
      element.style.setProperty("--mtn-node-image-height", `${image.height}px`);
    }
    element.toggleClass("has-highlight", Boolean(visual.highlight));
    if (visual.highlight) {
      element.style.setProperty("--mtn-node-bg", visual.highlight);
      element.style.setProperty("--mtn-node-text", readableTextColor(visual.highlight));
    } else if (node.style?.background && element.ownerDocument.defaultView?.CSS.supports("color", node.style.background)) {
      element.style.setProperty("--mtn-node-bg", node.style.background);
    }

    if (image) this.renderImage(element, node, image, actions, state.readOnly);
    if (state.editingNodeId === node.id) this.renderEditor(element, node, position, state, actions, image);
    else this.renderTitle(element, node, position, state);
    this.renderMarkers(element, node, state.resourceBadgePresentation);
    this.renderResourceControls(element, node, visual, actions);
    this.renderFoldControl(element, node, state.foldDirections.get(node.id) ?? "right", actions);

    if (state.readOnly) {
      // Keep the original geometry/appearance, but previews cannot open a
      // resource or begin an edit/drag. Only temporary fold controls are live.
      const open = element.querySelector<HTMLButtonElement>(".mtn-resource-open");
      if (open) { open.disabled = true; open.tabIndex = -1; }
      return;
    }

    element.addEventListener("pointerdown", (event) => actions.nodePointerDown(event, node.id));
    element.addEventListener("dblclick", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.beginEdit(node.id);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.showContextMenu(event, node.id);
    });
  }

  /**
   * Render the exact line partition produced by the shared text measurer.
   * Allowing CSS to wrap the complete title again created a second, subtly
   * different layout calculation: a subpixel typography difference could make
   * the DOM display two lines inside a box that the tree measured as one.
   */
  private renderTitle(
    element: HTMLElement,
    node: MindTreeNode,
    position: PositionedNode,
    state: NodeRenderState
  ): void {
    const title = node.title || t("node.untitled");
    const measurement = state.textMeasurer.measure(title, position.depth, state.nodeWrapWidth, nodeTitleMode(node, position.depth));
    const titleElement = element.createDiv("mtn-node-title");
    if (measurement.richLines) {
      const owner = element.ownerDocument;
      const Parser = owner.defaultView?.DOMParser ?? DOMParser;
      const svg = new Parser().parseFromString(renderRichTitleSvg(measurement), "image/svg+xml").documentElement;
      titleElement.classList.add("mtn-rich-title");
      titleElement.setAttribute("aria-label", measurement.normalizedTitle);
      titleElement.appendChild(owner.importNode(svg, true));
      return;
    }
    for (const line of measurement.lines) {
      titleElement.createSpan({ cls: "mtn-node-title-line", text: line });
    }
  }

  private renderEditor(
    element: HTMLElement,
    node: MindTreeNode,
    position: PositionedNode,
    state: NodeRenderState,
    actions: NodeRenderActions,
    image?: ImageNodeVisual
  ): void {
    const input = element.createEl("textarea", {
      cls: "mtn-title-input", attr: { rows: "1", spellcheck: "false" }
    });
    input.value = state.editingDraftValue ?? node.title;
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    // Keep the committed node rectangle and every connection frozen while the
    // neutral editor alone grows toward screen-right and down.
    const initialSize = getNodeTitleEditorSize(position.depth, node.title, state.nodeWrapWidth, state.textMeasurer);
    // Like an ordinary editor, the textarea includes the node's outer padding.
    // Start it at the image/gap boundary so its inner text aligns with the
    // second grid row instead of double-counting the node's top inset.
    const captionTop = image ? image.height + 2 : 0;
    const captionHeight = image ? Math.max(0, position.height - captionTop) : position.height;
    const editorTop = captionTop + Math.max(0, (captionHeight - initialSize.height) / 2);
    const resizeEditor = (): void => {
      const size = getNodeTitleEditorSize(position.depth, input.value, state.nodeWrapWidth, state.textMeasurer);
      input.style.width = `${size.width}px`;
      input.style.height = `${size.height}px`;
      input.style.top = `${editorTop}px`;
    };
    resizeEditor();
    input.addEventListener("input", () => {
      resizeEditor();
      actions.updateEditDraft(node.id, input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation();
        if (actions.finishEdit(node.id, input.value) === "rejected") return;
        actions.focusCanvas();
        actions.saveImmediately();
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); actions.cancelEdit(); }
    });
    input.addEventListener("blur", () => actions.finishEdit(node.id, input.value));
    this.focusEditor = () => {
      if (state.focusEditor === false) return;
      actions.editorReady?.(input);
      input.focus({ preventScroll: true });
      if (state.editingSelectionMode === "end") {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } else input.select();
    };
  }

  /** Render a vault-backed image without exposing its runtime URL to node data. */
  private renderImage(
    element: HTMLElement,
    node: MindTreeNode,
    image: ImageNodeVisual,
    actions: NodeRenderActions,
    readOnly = false
  ): void {
    const frame = element.createDiv("mtn-node-image-frame");
    const preview = frame.createEl("img", {
      cls: "mtn-node-image",
      attr: { src: image.source, alt: "", draggable: "false" }
    });
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.addEventListener("dragstart", (event) => event.preventDefault());
    if (readOnly) return;

    const handle = frame.createEl("button", {
      cls: "mtn-image-resize-handle",
      attr: { type: "button", "aria-label": t("node.resizeImage") }
    });
    setIcon(handle, "move-diagonal-2");
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      actions.beginImageResize(event, node.id, image);
    });
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  private renderFoldControl(
    element: HTMLElement,
    node: MindTreeNode,
    direction: FoldDirection,
    actions: NodeRenderActions
  ): void {
    if (node.childIds.length === 0) return;
    const fold = element.createEl("button", {
      cls: `mtn-fold-button is-fold-${direction} ${node.collapsed ? "is-expand" : "is-collapse"}`,
      attr: { type: "button", "aria-label": node.collapsed ? t("node.expandBranch") : t("node.collapseBranch") }
    });
    if (node.collapsed) fold.createSpan({ cls: "mtn-child-count", text: String(node.childIds.length) });
    else setIcon(fold, "minus");
    fold.addEventListener("pointerdown", (event) => event.stopPropagation());
    fold.addEventListener("click", (event) => {
      event.stopPropagation(); actions.toggleCollapsed(node.id);
    });
  }

  private renderResourceControls(
    element: HTMLElement,
    node: MindTreeNode,
    visual: NodeVisualState,
    actions: NodeRenderActions
  ): void {
    if (!visual.hasResourceControls) return;
    const controls = element.createDiv("mtn-node-controls");
    if (visual.titleSyncDisabled) {
      const syncStatus = controls.createSpan({
        cls: "mtn-title-sync-off", attr: { role: "img", "aria-label": t("node.syncDisabled") }
      });
      setIcon(syncStatus, "unlink");
    }
    const openButton = controls.createEl("button", {
      cls: "mtn-resource-open fa-share-square-o",
      attr: { type: "button", "aria-label": t("node.openLinkedResource") }
    });
    setIcon(openButton, SHARE_SQUARE_ICON);
    openButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    openButton.addEventListener("dblclick", (event) => event.stopPropagation());
    openButton.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.openResource(node.id);
    });
  }

  /**
   * Custom emoji and text tags are global definitions, so they are resolved
   * through the presentation profile that also measured this node. Built-in
   * icon markers keep their SVG identity and fixed square box.
   */
  private renderMarkers(
    element: HTMLElement,
    node: MindTreeNode,
    presentation: ResourceBadgePresentation
  ): void {
    const markers = getVisibleNodeMarkers(node);
    const customMarkers = presentation.resolveCustomMarkerDisplays(node);
    const resourceBadges = presentation.resolve(node)
      .filter((badge) => badge.kind === "mind-tree" || badge.kind === "excalidraw" || badge.kind === "extension");
    if (markers.length === 0 && customMarkers.length === 0 && resourceBadges.length === 0) return;
    const markerWidth = getNodeMarkerGeometry(node, presentation).width;
    const container = element.createDiv("mtn-node-markers");
    container.style.width = `${markerWidth}px`;
    for (const marker of markers) {
      if (isCustomMarkerCategory(marker.type)) continue;
      const markerElement = container.createSpan({
        cls: `mtn-node-marker is-${marker.type} is-${marker.value}`,
        attr: { role: "img", "aria-label": markerLabel(marker.type, marker.value) }
      });
      setIcon(markerElement, marker.type === "priority" ? "flag" : marker.value === "todo"
        ? "circle" : marker.value === "inprogress" ? "loader-circle"
          : marker.value === "done" ? "circle-check" : "circle-x");
    }
    for (const custom of customMarkers) {
      if (custom.kind === "emoji") {
        container.createSpan({
          cls: "mtn-node-marker is-emoji",
          text: custom.value,
          attr: { role: "img", "aria-label": t("marker.custom.emojiValue", { value: custom.value }) }
        });
        continue;
      }
      // Text tags reuse the measured file-badge treatment: a rounded label that
      // grows with its content instead of a fixed square icon box.
      container.createSpan({
        cls: "mtn-node-marker is-resource-badge is-tag",
        text: custom.value,
        attr: { role: "img", "aria-label": t("marker.custom.tagValue", { value: custom.value }) }
      });
    }
    for (const badge of resourceBadges) container.createSpan({
      cls: `mtn-node-marker is-resource-badge is-${badge.kind}`,
      text: badge.label,
      attr: { role: "img", "aria-label": badge.label }
    });
  }
}

function markerLabel(type: "progress" | "priority", value: string): string {
  if (type === "progress") {
    if (value === "todo") return t("marker.progress.todo");
    if (value === "inprogress") return t("marker.progress.inprogress");
    if (value === "done") return t("marker.progress.done");
    return t("marker.progress.cancelled");
  }
  if (value === "red") return t("marker.priority.red");
  if (value === "yellow") return t("marker.priority.yellow");
  return t("marker.priority.blue");
}

function readableTextColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#1f2937" : "#ffffff";
}
