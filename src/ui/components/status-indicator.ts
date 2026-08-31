import type { StatusMessageState } from "./models";
import { DisposableUiObject } from "./ui-object";

/** Non-modal warning/error text layered above the canvas. */
export class StatusIndicator extends DisposableUiObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement) {
    super();
    this.element = parent.createDiv("mtn-status");
  }

  update(state: StatusMessageState): void {
    this.element.setText(state.message);
    this.element.className = state.kind === "normal" ? "mtn-status" : `mtn-status is-${state.kind}`;
  }
}
