import { setIcon } from "obsidian";
import { DisposableUiObject } from "./ui-object";

export interface ViewMenuBarActions {
  readonly showSettings: (event: MouseEvent) => void;
  readonly showKeyboardHelp: (event: MouseEvent) => void;
}

export interface ViewMenuBarLabels {
  readonly settings: string;
  readonly keyboardHelp: string;
}

/** The compact vertical menu at the upper-left of a mind-tree view. */
export class ViewMenuBar extends DisposableUiObject {
  readonly element: HTMLElement;
  readonly settingsButton: HTMLButtonElement;

  constructor(parent: HTMLElement, labels: ViewMenuBarLabels, actions: ViewMenuBarActions) {
    super();
    this.element = parent.createDiv("mtn-view-menu-bar");
    this.settingsButton = this.createButton("mtn-view-settings-button", "menu", labels.settings, actions.showSettings);
    this.createButton("mtn-shortcut-help-button", "circle-help", labels.keyboardHelp, actions.showKeyboardHelp);
  }

  private createButton(
    className: string,
    icon: string,
    label: string,
    action: (event: MouseEvent) => void
  ): HTMLButtonElement {
    const button = this.element.createEl("button", {
      cls: `clickable-icon mtn-view-menu-button ${className}`,
      attr: { type: "button", "aria-label": label }
    });
    setIcon(button, icon);
    this.listen(button, "click", ((event: MouseEvent) => {
      event.stopPropagation();
      action(event);
    }) as EventListener);
    return button;
  }
}
