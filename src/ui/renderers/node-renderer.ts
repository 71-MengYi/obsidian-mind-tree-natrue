import { setIcon } from "obsidian";
import {
  getVisibleNodeMarkers,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker
} from "../../domain/markers";
import { t } from "../../i18n";
import type { MindTreeDocument, MindTreeNode, NodeId, PositionedNode } from "../../types";
import type { FoldDirection } from "../fold-direction";
import { SHARE_SQUARE_ICON } from "../icons";
import { getNodeSizeClass, type TreeLayout } from "../layout";
import { branchColorCss } from "../presentation";
import { createNodeVisualState } from "./node-render-model";

export interface NodeRenderState {
  readonly document: Readonly<MindTreeDocument>;
  readonly positions: ReadonlyArray<PositionedNode>;
  readonly width: number;
  readonly height: number;
  readonly selectedIds: ReadonlySet<NodeId>;
  readonly editingNodeId?: NodeId;
  readonly editingSelectionMode: "all" | "end";
  readonly branchColorSlots: ReadonlyMap<NodeId, number>;
  readonly foldDirections: ReadonlyMap<NodeId, FoldDirection>;
}

export interface NodeRenderActions {
  readonly scheduleEditingRelayout: (nodeId: NodeId, title: string) => void;
  readonly finishEdit: (nodeId: NodeId, title: string) => void;
  readonly cancelEdit: () => void;
  readonly saveImmediately: () => void;
  readonly focusCanvas: () => void;
  readonly toggleCollapsed: (nodeId: NodeId) => void;
  readonly nodePointerDown: (event: PointerEvent, nodeId: NodeId) => void;
  readonly beginEdit: (nodeId: NodeId) => void;
  readonly showContextMenu: (event: MouseEvent, nodeId: NodeId) => void;
  readonly openResource: (nodeId: NodeId) => void;
}

/** Creates title, editor, badges, resource controls and fold controls for nodes. */
export class NodeRenderer {
  private focusTimer?: number;

  constructor(readonly element: HTMLElement) {}

  render(state: NodeRenderState, actions: NodeRenderActions): void {
    this.clearFocusTimer();
    this.element.empty();
    this.element.style.width = `${state.width}px`;
    this.element.style.height = `${state.height}px`;
    for (const position of state.positions) this.renderNode(position, state, actions);
  }

  applyGeometry(layout: TreeLayout): void {
    this.element.style.width = `${layout.width}px`;
    this.element.style.height = `${layout.height}px`;
    for (const position of layout.nodes) {
      const node = this.element.querySelector<HTMLElement>(`.mtn-node[data-node-id="${CSS.escape(position.id)}"]`);
      if (!node) continue;
      node.style.left = `${position.x}px`;
      node.style.top = `${position.y}px`;
      node.style.width = `${position.width}px`;
      node.style.height = `${position.height}px`;
    }
  }

  destroy(): void {
    this.clearFocusTimer();
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
    const visual = createNodeVisualState(node, state.selectedIds.has(node.id), state.editingNodeId === node.id);
    element.toggleClass("is-selected", visual.selected);
    element.toggleClass("is-editing", visual.editing);
    element.toggleClass("is-leaf", visual.leaf);
    element.toggleClass("has-resource", visual.hasFileControls);
    element.toggleClass("is-title-sync-off", visual.titleSyncDisabled);
    element.toggleClass("has-markers", visual.markerDisplayWidth > 0);
    // The first grid track is the title-only box. It stays fixed while marker
    // and file-control tracks extend the complete node toward screen-right.
    element.style.setProperty("--mtn-node-title-width", `${Math.max(1, position.contentWidth - 4)}px`);
    element.style.setProperty("--mtn-node-marker-width", `${visual.markerDisplayWidth}px`);
    element.toggleClass("has-highlight", Boolean(visual.highlight));
    if (visual.highlight) {
      element.style.setProperty("--mtn-node-bg", visual.highlight);
      element.style.setProperty("--mtn-node-text", readableTextColor(visual.highlight));
    } else if (node.style?.background && element.ownerDocument.defaultView?.CSS.supports("color", node.style.background)) {
      element.style.setProperty("--mtn-node-bg", node.style.background);
    }

    if (state.editingNodeId === node.id) this.renderEditor(element, node, state, actions);
    else element.createDiv("mtn-node-title").setText(node.title || t("node.untitled"));
    this.renderMarkers(element, node);
    this.renderFileControls(element, node, actions);
    this.renderFoldControl(element, node, state.foldDirections.get(node.id) ?? "right", actions);

    element.addEventListener("pointerdown", (event) => actions.nodePointerDown(event, node.id));
    element.addEventListener("dblclick", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.beginEdit(node.id);
    });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.showContextMenu(event, node.id);
    });
  }

  private renderEditor(
    element: HTMLElement,
    node: MindTreeNode,
    state: NodeRenderState,
    actions: NodeRenderActions
  ): void {
    const input = element.createEl("textarea", {
      cls: "mtn-title-input", attr: { rows: "1", spellcheck: "false" }
    });
    input.value = node.title;
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("input", () => actions.scheduleEditingRelayout(node.id, input.value));
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); event.stopPropagation();
        actions.finishEdit(node.id, input.value);
        actions.focusCanvas();
        actions.saveImmediately();
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); actions.cancelEdit(); }
    });
    input.addEventListener("blur", () => actions.finishEdit(node.id, input.value));
    const ownerWindow = element.ownerDocument.defaultView ?? window;
    this.focusTimer = ownerWindow.setTimeout(() => {
      this.focusTimer = undefined;
      input.focus();
      if (state.editingSelectionMode === "end") {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      } else input.select();
    });
  }

  private clearFocusTimer(): void {
    if (this.focusTimer === undefined) return;
    (this.element.ownerDocument.defaultView ?? window).clearTimeout(this.focusTimer);
    this.focusTimer = undefined;
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

  private renderFileControls(element: HTMLElement, node: MindTreeNode, actions: NodeRenderActions): void {
    if (node.resource?.type !== "file") return;
    const controls = element.createDiv("mtn-node-controls");
    if (node.titleSync !== "bidirectional") {
      const syncStatus = controls.createSpan({
        cls: "mtn-title-sync-off", attr: { role: "img", "aria-label": t("node.syncDisabled") }
      });
      setIcon(syncStatus, "unlink");
    }
    const openButton = controls.createEl("button", {
      cls: "mtn-resource-open fa-share-square-o",
      attr: { type: "button", "aria-label": t("node.openLinkedFile") }
    });
    setIcon(openButton, SHARE_SQUARE_ICON);
    openButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    openButton.addEventListener("dblclick", (event) => event.stopPropagation());
    openButton.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation(); actions.openResource(node.id);
    });
  }

  private renderMarkers(element: HTMLElement, node: MindTreeNode): void {
    const markers = getVisibleNodeMarkers(node);
    const hasMindTreeMarker = hasMindTreeResourceMarker(node);
    const hasExcalidrawMarker = hasExcalidrawResourceMarker(node);
    if (markers.length === 0 && !hasMindTreeMarker && !hasExcalidrawMarker) return;
    const container = element.createDiv("mtn-node-markers");
    for (const marker of markers) {
      const markerElement = container.createSpan({
        cls: `mtn-node-marker is-${marker.type} is-${marker.value}`,
        attr: { role: "img", "aria-label": markerLabel(marker.type, marker.value) }
      });
      setIcon(markerElement, marker.type === "priority" ? "flag" : marker.value === "todo"
        ? "circle" : marker.value === "inprogress" ? "loader-circle"
          : marker.value === "done" ? "circle-check" : "circle-x");
    }
    if (hasMindTreeMarker) container.createSpan({
      cls: "mtn-node-marker is-mind-tree", text: t("node.mindTreeMarker"),
      attr: { role: "img", "aria-label": t("node.mindTreeMarker") }
    });
    if (hasExcalidrawMarker) container.createSpan({
      cls: "mtn-node-marker is-excalidraw", text: t("node.drawingMarker"),
      attr: { role: "img", "aria-label": t("node.drawingMarker") }
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
