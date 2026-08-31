import { setIcon } from "obsidian";
import type { BottomStatusBarState } from "./models";
import { DisposableUiObject } from "./ui-object";

export interface BottomStatusBarLabels {
  readonly resetCanvas: string;
  readonly save: string;
  readonly scanFolder: string;
  readonly undo: string;
  readonly redo: string;
}

export interface BottomStatusBarActions {
  readonly resetCanvas: () => void;
  readonly save: () => void;
  readonly scanFolder: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
}

/** Counts, persistence state and history controls anchored at the lower-left. */
export class BottomStatusBar extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly topicCount: HTMLElement;
  private readonly noteCount: HTMLElement;
  private readonly depth: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly scanButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;

  constructor(parent: HTMLElement, labels: BottomStatusBarLabels, actions: BottomStatusBarActions) {
    super();
    this.element = parent.createDiv("mtn-bottom-bar");
    const panel = this.element.createDiv("mtn-status-panel");
    this.topicCount = panel.createSpan("mtn-status-metric");
    this.noteCount = panel.createSpan("mtn-status-metric");
    this.depth = panel.createSpan("mtn-status-metric");
    this.createButton(panel, "mtn-status-icon-button", "focus", labels.resetCanvas, actions.resetCanvas);
    this.saveButton = this.createButton(panel, "mtn-status-icon-button mtn-save-button is-saved", "save", labels.save, actions.save);
    this.scanButton = this.createButton(panel, "mtn-status-icon-button mtn-scan-folder-button", "folder-search-2", labels.scanFolder, actions.scanFolder);
    this.undoButton = this.createButton(this.element, "mtn-history-button", "undo-2", labels.undo, actions.undo);
    this.redoButton = this.createButton(this.element, "mtn-history-button", "redo-2", labels.redo, actions.redo);
  }

  update(state: BottomStatusBarState): void {
    this.topicCount.setText(state.topicLabel);
    this.noteCount.setText(state.noteLabel);
    this.depth.setText(state.depthLabel);
    this.undoButton.disabled = !state.canUndo;
    this.redoButton.disabled = !state.canRedo;
    this.saveButton.disabled = state.saveBusy;
    this.saveButton.toggleClass("is-saved", state.saveState === "saved");
    this.saveButton.toggleClass("is-dirty", state.saveState !== "saved");
    this.saveButton.setAttribute("aria-label", state.saveLabel);
    this.scanButton.disabled = !state.scanEnabled || state.scanBusy;
  }

  private createButton(
    parent: HTMLElement,
    className: string,
    icon: string,
    label: string,
    action: () => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `clickable-icon ${className}`,
      attr: { type: "button", "aria-label": label }
    });
    setIcon(button, icon);
    this.listen(button, "click", action as EventListener);
    return button;
  }
}
