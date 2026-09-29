import { t } from "../../i18n";
import type { VersionPreviewState } from "../../services/version-conflict-coordinator";
import { DisposableUiObject } from "./ui-object";

/** Safety failures are actionable diagnostics, not two disabled version choices. */
export class DocumentSafetyPanel extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly identity: HTMLElement;
  private readonly restore: HTMLButtonElement;

  constructor(parent: HTMLElement, restoreIdentity: () => void) {
    super();
    this.element = parent.createDiv("mtn-document-safety");
    this.identity = this.element.createDiv({ attr: { role: "status" } });
    this.restore = this.element.createEl("button", {
      text: t("conflict.restoreIdentity"), attr: { type: "button" }
    });
    this.listen(this.restore, "click", restoreIdentity);
  }

  update(state: VersionPreviewState): void {
    this.element.hidden = state.mode !== "identity";
    this.identity.setText(t("conflict.identityValues", {
      original: state.originalId ?? t("conflict.identityMissing"),
      current: state.currentId ?? t("conflict.identityMissing")
    }));
    this.restore.disabled = !state.canRestoreIdentity;
  }
}
