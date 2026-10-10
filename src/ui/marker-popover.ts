import { setIcon } from "obsidian";
import {
  customMarkerDefinitionsByKind,
  type CustomMarkerDefinition,
  type CustomMarkerKind
} from "../domain/custom-markers";
import {
  getNodeMarker,
  isCustomMarkerCategory,
  NODE_HIGHLIGHT_COLORS,
  removeNodeMarker,
  setNodeMarker,
  type NodeMarkerCategory
} from "../domain/markers";
import { t, type TranslationKey } from "../i18n";
import type { MindTreeSettings } from "../settings-model";
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
  /** Live custom marker registry; read on every render so settings apply at once. */
  settings: () => MindTreeSettings;
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
      const valueLabel = choice.labelKey
        ? t(choice.labelKey)
        : t("marker.highlight.color", { color: choice.marker.value });
      renderOption(choicesRow, choice.marker, current?.value, valueLabel, choice.icon, choice.color);
    }
  };

  /**
   * One selectable value. A category holds at most one value, so choosing a
   * value only ever replaces the current one; unselecting goes through the
   * category's own delete button (and, for custom groups, the selected chip).
   */
  const renderOption = (
    parent: HTMLElement,
    marker: NodeMarker,
    currentValue: string | undefined,
    valueLabel: string,
    icon: string | undefined,
    color: string | undefined
  ): void => {
    const selected = currentValue === marker.value;
    const button = parent.createEl("button", {
      cls: `clickable-icon mtn-marker-choice is-${marker.type}${selected ? " is-active" : ""}`,
      attr: {
        type: "button",
        "aria-label": valueLabel,
        "aria-pressed": String(selected)
      }
    });
    if (color) button.style.setProperty("--mtn-marker-choice-color", color);
    // Custom values are user text, so they are rendered as text instead of an
    // icon lookup that would silently render nothing for an unknown name.
    if (icon) setIcon(button, icon);
    else button.textContent = marker.value;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.updateNode((draftNode) => {
        // Clicking the selected custom chip clears its category, which is the
        // only way to unset the value from this row without hunting for the
        // small delete button. Built-in categories keep the single-click
        // "select again replaces" behavior users already know.
        if (selected && isCustomMarkerCategory(marker.type)) removeNodeMarker(draftNode, marker.type);
        else setNodeMarker(draftNode, marker);
      });
      render();
    });
  };

  /**
   * Append one user-managed group. `settings.customMarkers` is read on every
   * render, so a marker added in the settings tab appears the next time this
   * palette is drawn without reopening it. An empty group renders nothing at
   * all: a heading with no choices would only look like a broken control.
   */
  const renderCustomCategory = (parent: HTMLElement, kind: CustomMarkerKind): void => {
    const definitions: CustomMarkerDefinition[] =
      customMarkerDefinitionsByKind(options.settings().customMarkers, kind);
    if (definitions.length === 0) return;
    const node = options.readNode();
    if (!node) { close(); return; }
    const current = getNodeMarker(node, kind);
    const categoryLabel = t(kind === "emoji" ? "marker.category.emoji" : "marker.category.tag");
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
      options.updateNode((draftNode) => removeNodeMarker(draftNode, kind));
      render();
    });

    const choicesRow = category.createDiv("mtn-marker-choices");
    for (const definition of definitions) {
      const valueLabel = t(kind === "emoji" ? "marker.custom.emojiValue" : "marker.custom.tagValue", {
        value: definition.value
      });
      renderOption(
        choicesRow,
        { type: kind, value: definition.value },
        current?.value,
        valueLabel,
        undefined,
        undefined
      );
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
    // Custom groups follow the three built-ins; each stays invisible until the
    // user defines at least one entry for that kind.
    renderCustomCategory(panel, "emoji");
    renderCustomCategory(panel, "tag");
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
