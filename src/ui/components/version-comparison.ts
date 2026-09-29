import type { MindTreeDocumentSettings } from "../../types";
import type { VersionPreviewState } from "../../services/version-conflict-coordinator";
import { t } from "../../i18n";
import { COLLECTION_MODE_OPTIONS, CONNECTION_OPTIONS, LAYOUT_OPTIONS, NODE_SHAPE_OPTIONS, THEME_OPTIONS } from "../presentation";
import { ReadOnlyTreePreview, type TreePreviewOptions } from "./read-only-tree-preview";
import { DisposableUiObject } from "./ui-object";
import { changedVersionSettings } from "./version-preview-model";
import { DocumentSafetyPanel } from "./document-safety-panel";

function settingDescription(key: keyof MindTreeDocumentSettings, settings: MindTreeDocumentSettings): string {
  const catalogs = { layoutMode: LAYOUT_OPTIONS, theme: THEME_OPTIONS, nodeShape: NODE_SHAPE_OPTIONS,
    connectionStyle: CONNECTION_OPTIONS, collectionMode: COLLECTION_MODE_OPTIONS };
  if (key === "recursiveScan") return `${t("conflict.recursiveScan")}: ${settings[key] ? t("conflict.yes") : t("conflict.no")}`;
  const item = catalogs[key].find((item) => item.value === settings[key]);
  const names = { layoutMode: "settings.layout.name", theme: "viewSettings.theme", nodeShape: "viewSettings.nodeShape",
    connectionStyle: "viewSettings.connectionStyle", collectionMode: "settings.scan.name" } as const;
  return `${t(names[key])}: ${item ? t(item.label) : settings[key]}`;
}

export class VersionComparison extends DisposableUiObject {
  readonly element: HTMLElement;
  private readonly left: ReadOnlyTreePreview;
  private readonly right: ReadOnlyTreePreview;
  private readonly leftSettings: HTMLElement;
  private readonly rightSettings: HTMLElement;
  private readonly status: HTMLElement;
  private readonly currentButton: HTMLButtonElement;
  private readonly externalButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly safety: DocumentSafetyPanel;
  private readonly panes: HTMLElement;
  private readonly rightPane: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly help: HTMLElement;

  constructor(parent: HTMLElement, options: TreePreviewOptions,
    actions: { choose: (side: "current" | "external") => void; retry: () => void; restoreIdentity: () => void }) {
    super();
    this.element = parent.createDiv("mtn-version-comparison");
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", t("conflict.title"));
    const header = this.element.createDiv("mtn-version-heading");
    this.heading = header.createEl("strong", { text: t("conflict.title") });
    this.help = header.createDiv({ text: t("conflict.help") });
    this.status = header.createDiv({ cls: "mtn-version-status", attr: { role: "status", "aria-live": "polite" } });
    this.retryButton = header.createEl("button", { text: t("conflict.retry"), attr: { type: "button" } });
    this.listen(this.retryButton, "click", actions.retry);
    this.safety = new DocumentSafetyPanel(header, actions.restoreIdentity);
    this.own(() => this.safety.destroy());
    const panes = this.panes = this.element.createDiv("mtn-version-panes");
    const left = panes.createDiv("mtn-version-pane is-current");
    const right = this.rightPane = panes.createDiv("mtn-version-pane is-external");
    left.createEl("h3", { text: t("conflict.current") });
    right.createEl("h3", { text: t("conflict.external") });
    this.leftSettings = left.createDiv("mtn-version-settings");
    this.rightSettings = right.createDiv("mtn-version-settings");
    this.left = new ReadOnlyTreePreview(left, t("conflict.current"), options);
    this.right = new ReadOnlyTreePreview(right, t("conflict.external"), options);
    this.own(() => this.left.destroy()); this.own(() => this.right.destroy());
    this.currentButton = left.createEl("button", { cls: "mtn-version-keep", text: t("conflict.keep"),
      attr: { type: "button", "aria-label": t("conflict.keepCurrent") } });
    this.externalButton = right.createEl("button", { cls: "mtn-version-keep", text: t("conflict.keep"),
      attr: { type: "button", "aria-label": t("conflict.keepExternal") } });
    this.listen(this.currentButton, "click", () => actions.choose("current"));
    this.listen(this.externalButton, "click", () => actions.choose("external"));
    // No default action and no forced focus: a background tab stays background.
  }

  update(state: VersionPreviewState): void {
    const comparison = state.mode === "comparison";
    this.heading.setText(t(comparison ? "conflict.title" : "conflict.safetyTitle"));
    this.help.setText(t(comparison ? "conflict.help" : "conflict.safetyHelp"));
    this.element.setAttribute("aria-label", this.heading.textContent ?? "");
    this.panes.classList.toggle("is-safety", !comparison);
    this.rightPane.hidden = !comparison;
    this.currentButton.hidden = this.externalButton.hidden = !comparison;
    this.safety.update(state);
    this.left.update(state.current);
    if (state.external) this.right.update(state.external);
    this.currentButton.disabled = this.externalButton.disabled = !state.ready;
    this.status.setText(state.error ? t("conflict.error", { message: state.error === "identity" ? t("conflict.identity")
      : state.error === "invalid-source" ? `${t("conflict.invalid")}${state.errorDetails ? ` ${state.errorDetails}` : ""}` : state.error })
      : state.changedAgain ? t("conflict.changedAgain") : state.busy ? t("conflict.saving")
        : state.ready ? t(state.mode === "metadata" ? "conflict.resuming" : "conflict.pending") : t("conflict.staging"));
    this.retryButton.hidden = !state.error && state.mode !== "identity";
    this.retryButton.disabled = state.busy;
    this.retryButton.setText(t(state.mode === "identity" ? "conflict.recheck" : "conflict.retry"));
    const keys = state.external ? changedVersionSettings(state.current.settings, state.external.settings) : [];
    this.leftSettings.setText(keys.map((key) => settingDescription(key, state.current.settings)).join(" · "));
    this.rightSettings.setText(state.external ? keys.map((key) => settingDescription(key, state.external!.settings)).join(" · ") : "");
  }
}
