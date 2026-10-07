import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { t } from "../../i18n";
import type { PluginRelease } from "../../services/updates/release-client";
import type { UpdateCoordinator } from "../../services/updates/update-coordinator";

/** Async Markdown processors may register resources after the window closes. */
class ReleaseNotesComponent extends Component {
  private closed = false;
  override register(cleanup: () => unknown): void {
    if (this.closed) cleanup();
    else super.register(cleanup);
  }
  override addChild<T extends Component>(child: T): T {
    if (!this.closed) return super.addChild(child);
    child.unload();
    return child;
  }
  override unload(): void { this.closed = true; super.unload(); }
}

export class PluginUpdateModal extends Modal {
  private opened = false;
  private submitting = false;
  private unsubscribe?: () => void;
  private renderComponent?: ReleaseNotesComponent;
  private focusTimer?: number;

  constructor(app: App, private readonly pluginName: string, readonly release: PluginRelease,
    private readonly updates: UpdateCoordinator, private readonly onClosed: () => void) {
    super(app);
  }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("mtn-plugin-update-modal");
    this.titleEl.setText(t("update.title", { name: this.pluginName }));
    const versions = this.contentEl.createDiv("mtn-plugin-update-versions");
    versions.createEl("strong", { text: t("update.newVersion", { version: this.release.version }) });
    versions.createEl("span", { text: t("update.currentVersion", { version: this.updates.state.currentVersion }) });
    const notes = this.contentEl.createDiv({ cls: "mtn-plugin-update-notes",
      attr: { role: "region", "aria-label": t("update.notes"), tabindex: "0" } });
    const actions = this.contentEl.createDiv("mtn-plugin-update-actions");
    const later = actions.createEl("button", { text: t("update.later"), attr: { type: "button" } });
    later.addEventListener("click", () => this.close());
    const install = actions.createEl("button", { cls: "mod-cta", text: t("update.install"), attr: { type: "button" } });
    install.addEventListener("click", () => {
      if (!this.opened || this.submitting) return;
      const current = this.isCurrent();
      this.submitting = true;
      install.disabled = true;
      // The workspace's existing safety check must see the confirmation as closed.
      this.close();
      if (current) void this.updates.install(this.release);
    });
    const unsubscribe = this.updates.subscribe(() => {
      if (!this.isCurrent()) this.close();
    });
    // subscribe immediately delivers its state, which may already have closed us.
    if (!this.opened) { unsubscribe(); return; }
    this.unsubscribe = unsubscribe;
    this.focusTimer = this.modalEl.ownerDocument.defaultView?.setTimeout(() => {
      if (this.opened) later.focus();
    }, 0);
    if (this.release.notes) void this.renderNotes(notes);
    else notes.createEl("p", { text: t("update.notes.empty") });
  }

  private isCurrent(): boolean {
    return this.updates.state.phase === "available" && this.updates.state.availableRelease === this.release;
  }

  private async renderNotes(notes: HTMLElement): Promise<void> {
    const component = new ReleaseNotesComponent();
    this.renderComponent = component;
    component.load();
    // Stage separately so a late renderer can never repopulate a closed window.
    const rendered = notes.ownerDocument.createElement("div");
    rendered.addClass("markdown-rendered");
    try {
      await MarkdownRenderer.render(this.app, this.release.notes, rendered, "", component);
      if (this.opened && this.renderComponent === component) notes.append(rendered);
    } catch {
      component.unload();
      if (this.opened && this.renderComponent === component) {
        notes.createDiv({ cls: "mtn-plugin-update-notes-raw", text: this.release.notes });
      }
    } finally {
      if (!this.opened || this.renderComponent !== component) component.unload();
    }
  }

  onClose(): void {
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.focusTimer !== undefined) this.modalEl.ownerDocument.defaultView?.clearTimeout(this.focusTimer);
    this.focusTimer = undefined;
    this.renderComponent?.unload();
    this.renderComponent = undefined;
    this.contentEl.empty();
    this.onClosed();
  }
}
