import { setIcon } from "obsidian";
import {
  getNodeMarker,
  NODE_HIGHLIGHT_COLORS,
  removeNodeMarker,
  setNodeMarker,
  type NodeMarkerCategory
} from "../domain/markers";
import { t, type TranslationKey } from "../i18n";
import type { MindTreeNode, NodeMarker } from "../types";
import { AdaptiveTooltipController } from "./adaptive-tooltip";

interface MarkerChoice {
  marker: NodeMarker;
  icon: string;
  labelKey?: TranslationKey;
  color?: string;
}

export interface MarkerPopoverHandle {
  close(): void;
}

export interface MarkerPopoverOptions {
  ownerDocument: Document;
  position: { x: number; y: number };
  readNode: () => MindTreeNode | undefined;
  updateNode: (mutator: (node: MindTreeNode) => void) => void;
  onClose?: () => void;
}

const PROGRESS_CHOICES: readonly MarkerChoice[] = [
  { marker: { type: "progress", value: "todo" }, icon: "circle", labelKey: "marker.progress.todo" },
  { marker: { type: "progress", value: "inprogress" }, icon: "loader-circle", labelKey: "marker.progress.inprogress" },
  { marker: { type: "progress", value: "done" }, icon: "circle-check", labelKey: "marker.progress.done" },
  { marker: { type: "progress", value: "cancelled" }, icon: "circle-x", labelKey: "marker.progress.cancelled" }
];

const PRIORITY_CHOICES: readonly MarkerChoice[] = [
  { marker: { type: "priority", value: "red" }, icon: "flag", color: "#dc2626", labelKey: "marker.priority.red" },
  { marker: { type: "priority", value: "yellow" }, icon: "flag", color: "#d6a700", labelKey: "marker.priority.yellow" },
  { marker: { type: "priority", value: "blue" }, icon: "flag", color: "#2563eb", labelKey: "marker.priority.blue" }
];

const HIGHLIGHT_CHOICES: readonly MarkerChoice[] = NODE_HIGHLIGHT_COLORS.map((color) => ({
  marker: { type: "highlight", value: color },
  icon: "circle",
  color
}));

/**
 * Build the icon-only marker palette shared by the toolbar and node menu.
 * The popover stays open after a choice so users can set several independent
 * categories without repeatedly reopening it.
 */
export function openMarkerPopover(options: MarkerPopoverOptions): MarkerPopoverHandle {
  const panel = options.ownerDocument.body.createDiv("mtn-marker-popover");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("menu.markers"));
  let closed = false;
  let tooltips: AdaptiveTooltipController | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    tooltips?.destroy();
    options.ownerDocument.removeEventListener("pointerdown", onOutsidePointer, true);
    options.ownerDocument.removeEventListener("keydown", onKeyDown, true);
    panel.remove();
    options.onClose?.();
  };

  const onOutsidePointer = (event: PointerEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  const renderCategory = (
    parent: HTMLElement,
    type: NodeMarkerCategory,
    categoryLabel: string,
    choices: readonly MarkerChoice[]
  ): void => {
    const node = options.readNode();
    if (!node) { close(); return; }
    const current = getNodeMarker(node, type);
    const category = parent.createDiv("mtn-marker-category");
    const header = category.createDiv("mtn-marker-category-header");
    header.createSpan({ cls: "mtn-marker-category-name", text: categoryLabel });
    const removeButton = header.createEl("button", {
      cls: "clickable-icon mtn-marker-category-remove",
      attr: {
        type: "button",
        "aria-label": t("marker.removeCategory", { category: categoryLabel })
      }
    });
    setIcon(removeButton, "trash-2");
    removeButton.disabled = !current;
    removeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.updateNode((draftNode) => removeNodeMarker(draftNode, type));
      render();
    });

    const choicesRow = category.createDiv("mtn-marker-choices");
    for (const choice of choices) {
      const selected = current?.value === choice.marker.value;
      const valueLabel = choice.labelKey
        ? t(choice.labelKey)
        : t("marker.highlight.color", { color: choice.marker.value });
      const button = choicesRow.createEl("button", {
        cls: `clickable-icon mtn-marker-choice is-${choice.marker.type}${selected ? " is-active" : ""}`,
        attr: {
          type: "button",
          "aria-label": valueLabel,
          "aria-pressed": String(selected)
        }
      });
      if (choice.color) button.style.setProperty("--mtn-marker-choice-color", choice.color);
      setIcon(button, choice.icon);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.updateNode((draftNode) => setNodeMarker(draftNode, choice.marker));
        render();
      });
    }
  };

  const render = (): void => {
    if (closed) return;
    const node = options.readNode();
    if (!node) { close(); return; }
    panel.empty();
    renderCategory(panel, "progress", t("marker.category.progress"), PROGRESS_CHOICES);
    renderCategory(panel, "priority", t("marker.category.priority"), PRIORITY_CHOICES);
    renderCategory(panel, "highlight", t("marker.category.highlight"), HIGHLIGHT_CHOICES);
  };

  render();
  if (!closed) tooltips = new AdaptiveTooltipController(panel);
  panel.style.left = `${options.position.x}px`;
  panel.style.top = `${options.position.y}px`;
  const view = options.ownerDocument.defaultView;
  const rect = panel.getBoundingClientRect();
  const viewportWidth = view?.innerWidth ?? options.ownerDocument.documentElement.clientWidth;
  const viewportHeight = view?.innerHeight ?? options.ownerDocument.documentElement.clientHeight;
  panel.style.left = `${Math.max(8, Math.min(options.position.x, viewportWidth - rect.width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(options.position.y, viewportHeight - rect.height - 8))}px`;

  options.ownerDocument.addEventListener("pointerdown", onOutsidePointer, true);
  options.ownerDocument.addEventListener("keydown", onKeyDown, true);
  return { close };
}
