import { setIcon } from "obsidian";
import type { TopToolbarState } from "./models";
import { DisposableUiObject } from "./ui-object";
export { TOP_TOOLBAR_ORDER } from "../ui-contracts";

export interface TopToolbarLabels {
  readonly expandAll: string;
  readonly collapseAll: string;
  readonly collapseLevel: string;
  readonly markers: string;
  readonly fit: string;
  readonly zoomOut: string;
  readonly zoomIn: string;
  readonly search: string;
  readonly copy: string;
  readonly importText: string;
  readonly exportTree: string;
}

export interface TopToolbarActions {
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly showCollapseLevel: (event: MouseEvent) => void;
  readonly showMarkers: (anchor: HTMLElement) => void;
  readonly fit: () => void;
  readonly zoomOut: () => void;
  readonly zoomIn: () => void;
  readonly search: () => void;
  readonly showCopyMenu: (event: MouseEvent) => void;
  readonly importText: () => void;
  readonly showExportMenu: (event: MouseEvent) => void;
}

/** Toolbar availability and zoom reflect the current view state. */
export class TopToolbar extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly zoomElement: HTMLElement;
  private readonly selectionButtons: HTMLButtonElement[] = [];

  constructor(parent: HTMLElement, labels: TopToolbarLabels, actions: TopToolbarActions) {
    super();
    this.element = parent.createDiv("mtn-toolbar");
    this.addButton("unfold-vertical", labels.expandAll, () => actions.expandAll());
    this.addButton("fold-vertical", labels.collapseAll, () => actions.collapseAll());
    this.addButton("list-tree", labels.collapseLevel, actions.showCollapseLevel);
    this.addButton("tags", labels.markers, (event) => {
      const anchor = event.currentTarget as HTMLElement | null;
      if (anchor) actions.showMarkers(anchor);
    }, true);
    this.addSeparator();
    this.addButton("maximize", labels.fit, () => actions.fit());
    this.addButton("minus", labels.zoomOut, () => actions.zoomOut());
    this.zoomElement = this.element.createEl("span", { cls: "mtn-zoom-label", text: "100%" });
    this.zoomElement.dataset.role = "zoom";
    this.addButton("plus", labels.zoomIn, () => actions.zoomIn());
    this.addButton("search", labels.search, () => actions.search());
    this.addSeparator();
    this.addButton("copy", labels.copy, actions.showCopyMenu, true);
    this.addButton("upload", labels.importText, () => actions.importText());
    this.addButton("download", labels.exportTree, actions.showExportMenu, true);
  }

  update(state: TopToolbarState): void {
    this.zoomElement.setText(`${Math.round(state.zoom * 100)}%`);
    for (const button of this.selectionButtons) button.disabled = !state.hasSelection;
  }

  private addButton(icon: string, label: string, action: (event: MouseEvent) => void, requiresSelection = false): void {
    const button = this.element.createEl("button", {
      cls: "clickable-icon mtn-toolbar-button",
      attr: { type: "button", "aria-label": label }
    });
    if (requiresSelection) {
      button.disabled = true;
      this.selectionButtons.push(button);
    }
    setIcon(button, icon);
    this.listen(button, "click", action as EventListener);
  }

  private addSeparator(): void {
    this.element.createDiv("mtn-toolbar-separator");
  }
}
