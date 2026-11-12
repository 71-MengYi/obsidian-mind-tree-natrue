/**
 * The AI tab's "Model providers" section.
 *
 * Command-style DOM: every element is created here and every user action asks
 * the injected `AiSettingsPagePort` for a named transition, then re-reads
 * `port.state()` and redraws. Nothing is cached as if it were the truth, and no
 * message is shown with `alert`/`confirm` — failures land in inline status lines.
 *
 * The three edit windows are Obsidian modals. They are loaded with a dynamic
 * `import()` so the page stays constructible without a Modal implementation;
 * the ambient Obsidian test stubs only need the helpers this section itself
 * uses. The modals receive the port and the `App` explicitly, never a global.
 */
import { getLanguage, Setting } from "obsidian";
import type { App } from "obsidian";
import { t } from "../../i18n";
import type {
  AiProviderConfig,
  AiProviderPreset,
  AiSettingsPagePort,
  AiTestResult
} from "../../services/ai/contracts";
import type { AiProviderCardView, AiProviderConnectionKind } from "./ai-providers-view";
import { buildAiProvidersView } from "./ai-providers-view";
import type { AiModelFormKind } from "../modals/ai-model-form-modal";

/** How long a delete button stays armed before its second click expires. */
const DELETE_CONFIRM_MS = 5_000;
/** How often a waiting OAuth flow re-reads the device-local status. */
const OAUTH_POLL_MS = 1_000;

interface DeleteState {
  readonly timer: ReturnType<typeof setTimeout>;
}

export class AiProvidersSection {
  private readonly root: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly descriptionEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly noticeEl: HTMLElement;

  /** Providers whose model list is open; survives every redraw. */
  private readonly expanded = new Set<string>();
  /** Two-click delete confirmations, keyed by `provider:<id>` / `model:<id>`. */
  private readonly armedDeletes = new Map<string, DeleteState>();
  /** Latest connectivity-test result per model id, including `"testing"`. */
  private readonly testResults = new Map<string, AiTestResult | "testing">();
  /** Manual token text while the user types; redraws must not wipe it. */
  private readonly tokenDrafts = new Map<string, string>();
  /** Host failures that have no place in the resolved state snapshot. */
  private readonly oauthFailures = new Map<string, string>();
  private readonly oauthBusy = new Set<string>();
  private readonly oauthPolls = new Map<string, ReturnType<typeof setInterval>>();
  private destroyed = false;

  constructor(parent: HTMLElement, private readonly port: AiSettingsPagePort, private readonly app: App) {
    this.root = parent.createDiv({ cls: "mtn-ai-provider-section" });
    this.headingEl = this.root.createEl("h4", { cls: "mtn-ai-provider-section-heading" });
    this.descriptionEl = this.root.createEl("p", { cls: "setting-item-description mtn-ai-provider-section-desc" });
    const toolbar = this.root.createDiv({ cls: "mtn-ai-provider-section-toolbar" });
    this.countEl = toolbar.createSpan({ cls: "mtn-ai-provider-section-count" });
    this.addButton = toolbar.createEl("button", { cls: "mod-cta mtn-ai-provider-section-add", attr: { type: "button" } });
    this.addButton.addEventListener("click", () => { void this.openPicker(); });
    this.listEl = this.root.createDiv({ cls: "mtn-ai-provider-list" });
    this.emptyEl = this.root.createEl("p", { cls: "setting-item-description mtn-ai-provider-section-empty" });
    this.errorEl = this.root.createDiv({
      cls: "mtn-ai-provider-section-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.errorEl.hidden = true;
    this.noticeEl = this.root.createDiv({ cls: "mtn-ai-provider-section-notice" });
    this.noticeEl.hidden = true;
    this.render();
  }

  /** Every timer and poll belongs to this section; nothing may outlive it. */
  destroy(): void {
    this.destroyed = true;
    for (const state of this.armedDeletes.values()) clearTimeout(state.timer);
    this.armedDeletes.clear();
    for (const poll of this.oauthPolls.values()) clearInterval(poll);
    this.oauthPolls.clear();
  }

  /** Rebuild the list from one resolved snapshot of the port. */
  private render(): void {
    if (this.destroyed) return;
    // A waiting OAuth flow polls once a second. Replacing the list underneath a
    // half-typed token would steal focus, so a redraw waits until the field
    // loses it; the pending status is still visible in the card header.
    if (this.hasFocusedToken()) return;
    const language = getLanguage();
    const view = buildAiProvidersView(this.port.state(), language);
    this.headingEl.setText(view.heading);
    this.descriptionEl.setText(view.description);
    this.countEl.setText(view.countText);
    this.addButton.setText(view.addLabel);
    this.addButton.disabled = !view.supported;
    this.emptyEl.setText(view.emptyText);
    this.emptyEl.hidden = view.cards.length > 0;
    this.noticeEl.hidden = view.supported;
    this.noticeEl.setText(view.unsupportedText ?? "");
    this.listEl.empty();
    for (const card of view.cards) this.renderCard(card);
  }

  private hasFocusedToken(): boolean {
    const document = this.root.ownerDocument;
    const active = document.activeElement as { classList?: { contains(name: string): boolean } } | null | undefined;
    return active?.classList?.contains("mtn-ai-provider-oauth-token") === true;
  }

  private showError(message: string): void {
    this.errorEl.setText(message);
    this.errorEl.hidden = false;
  }

  private clearError(): void {
    this.errorEl.setText("");
    this.errorEl.hidden = true;
  }

  private renderCard(card: AiProviderCardView): void {
    const expanded = this.expanded.has(card.id);
    const root = this.listEl.createDiv({ cls: "mtn-ai-provider-card", attr: { "data-provider": card.id } });
    const head = root.createDiv({ cls: "mtn-ai-provider-card-head" });

    const expand = head.createEl("button", {
      cls: "mtn-ai-provider-expand",
      text: expanded ? "\u25BE" : "\u25B8",
      attr: {
        type: "button",
        "aria-expanded": String(expanded),
        "aria-label": t(expanded ? "settings.ai.providers.actions.collapse" : "settings.ai.providers.actions.expand")
      }
    });
    expand.addEventListener("click", () => {
      if (expanded) this.expanded.delete(card.id);
      else this.expanded.add(card.id);
      this.render();
    });

    const identity = head.createDiv({ cls: "mtn-ai-provider-identity" });
    identity.createSpan({ cls: "mtn-ai-provider-name", text: card.id });
    identity.createSpan({ cls: "mtn-ai-provider-preset", text: card.presetLabel });
    identity.createSpan({ cls: "mtn-ai-provider-api", text: card.apiTypeLabel });

    head.createSpan({
      cls: "mtn-ai-provider-status",
      text: card.connection.text,
      attr: { role: "status", "data-status": card.connection.kind }
    });

    const actions = head.createDiv({ cls: "mtn-ai-provider-actions" });
    const edit = actions.createEl("button", {
      cls: "mtn-ai-provider-edit",
      text: t("settings.ai.providers.actions.edit"),
      attr: { type: "button" }
    });
    edit.addEventListener("click", () => {
      const provider = this.port.state().providers.find((entry) => entry.id === card.id);
      if (provider !== undefined) void this.openProviderForm({ provider });
    });
    const remove = actions.createEl("button", {
      cls: "mtn-ai-provider-delete",
      text: this.deleteLabel(
        "provider:" + card.id,
        "settings.ai.providers.actions.delete",
        "settings.ai.providers.actions.deleteConfirm"
      ),
      attr: { type: "button" }
    });
    remove.addEventListener("click", () => this.confirmDelete("provider:" + card.id, () => this.deleteProvider(card.id)));

    if (!expanded) return;
    const body = root.createDiv({ cls: "mtn-ai-provider-body" });
    this.renderBaseUrl(body, card);
    this.renderChatModels(body, card);
    this.renderEmbeddingModels(body, card);
    if (card.oauth !== undefined) this.renderOAuth(body, card);
  }

  private renderBaseUrl(parent: HTMLElement, card: AiProviderCardView): void {
    const row = parent.createDiv({ cls: "mtn-ai-provider-field" });
    row.createSpan({ cls: "mtn-ai-provider-field-label", text: t("settings.ai.providers.card.baseUrl") });
    if (card.baseUrl === undefined) {
      row.createSpan({ cls: "mtn-ai-provider-field-value", text: t("settings.ai.providers.card.baseUrlDefault") });
    } else {
      row.createEl("code", { cls: "mtn-ai-provider-field-value", text: card.baseUrl });
      if (card.baseUrlIsDefault) {
        row.createSpan({
          cls: "setting-item-description mtn-ai-provider-field-hint",
          text: t("settings.ai.providers.card.baseUrlDefault")
        });
      }
    }
  }

  private renderChatModels(parent: HTMLElement, card: AiProviderCardView): void {
    const section = parent.createDiv({ cls: "mtn-ai-model-section", attr: { "data-model-kind": "chat" } });
    section.createEl("h5", { text: t("settings.ai.models.chatHeading") });
    if (card.chatModels.length === 0) {
      section.createEl("p", { cls: "setting-item-description", text: card.chatEmpty });
    } else {
      const table = section.createEl("table", { cls: "mtn-ai-model-table" });
      const header = table.createEl("thead").createEl("tr");
      header.createEl("th", { text: t("settings.ai.models.column.name") });
      header.createEl("th", { text: t("settings.ai.models.column.model") });
      header.createEl("th", { text: t("settings.ai.models.column.enable") });
      header.createEl("th", { text: t("settings.ai.models.column.actions") });
      const body = table.createEl("tbody");
      for (const model of card.chatModels) {
        const row = body.createEl("tr", { attr: { "data-model": model.id } });
        row.createEl("td", { cls: "mtn-ai-model-name", text: model.name });
        row.createEl("td").createEl("code", { text: model.model });
        const enableCell = row.createEl("td", { cls: "mtn-ai-model-enable" });
        const checkbox = enableCell.createEl("input", {
          attr: {
            type: "checkbox",
            "aria-label": `${t("settings.ai.models.column.enable")}: ${model.name}`,
            "data-model": model.id
          }
        });
        checkbox.checked = model.enabled;
        checkbox.addEventListener("change", () => { void this.setEnabled(model.id, checkbox); });
        this.renderModelActions(row.createEl("td", { cls: "mtn-ai-model-actions" }), model.id, "chat");
      }
    }
    const actions = section.createDiv({ cls: "mtn-ai-model-add-row" });
    const add = actions.createEl("button", {
      cls: "mtn-ai-model-add",
      text: t("settings.ai.models.addChat"),
      attr: { type: "button" }
    });
    add.addEventListener("click", () => { void this.openModelForm("chat", card.id); });
    const catalog = actions.createEl("button", {
      cls: "mtn-ai-model-catalog-open",
      text: t("settings.ai.models.catalog.open"),
      attr: { type: "button" }
    });
    catalog.addEventListener("click", () => { void this.openModelCatalog(card.id); });
  }

  private renderEmbeddingModels(parent: HTMLElement, card: AiProviderCardView): void {
    const section = parent.createDiv({ cls: "mtn-ai-model-section", attr: { "data-model-kind": "embedding" } });
    section.createEl("h5", { text: t("settings.ai.models.embeddingHeading") });
    if (card.embeddingModels.length === 0) {
      section.createEl("p", { cls: "setting-item-description", text: card.embeddingEmpty });
    } else {
      const table = section.createEl("table", { cls: "mtn-ai-model-table" });
      const header = table.createEl("thead").createEl("tr");
      header.createEl("th", { text: t("settings.ai.models.column.name") });
      header.createEl("th", { text: t("settings.ai.models.column.model") });
      header.createEl("th", { text: t("settings.ai.models.column.dimension") });
      header.createEl("th", { text: t("settings.ai.models.column.actions") });
      const body = table.createEl("tbody");
      for (const model of card.embeddingModels) {
        const row = body.createEl("tr", { attr: { "data-model": model.id } });
        row.createEl("td", { cls: "mtn-ai-model-name", text: model.name });
        row.createEl("td").createEl("code", { text: model.model });
        row.createEl("td", { cls: "mtn-ai-model-dimension", text: String(model.dimension) });
        this.renderModelActions(row.createEl("td", { cls: "mtn-ai-model-actions" }), model.id, "embedding");
      }
    }
    if (!card.supportsEmbedding) return;
    const add = section.createEl("button", {
      cls: "mtn-ai-model-add",
      text: t("settings.ai.models.addEmbedding"),
      attr: { type: "button" }
    });
    add.addEventListener("click", () => { void this.openModelForm("embedding", card.id); });
  }

  /** Test, edit and delete controls shared by both model tables. */
  private renderModelActions(
    cell: HTMLElement,
    modelId: string,
    kind: AiModelFormKind
  ): void {
    const actions = cell.createDiv({ cls: "mtn-ai-model-action-row" });
    const test = actions.createEl("button", {
      cls: "mtn-ai-model-test",
      text: t("settings.ai.models.test"),
      attr: { type: "button" }
    });
    test.addEventListener("click", () => { void this.runModelTest(modelId, kind); });
    const status = actions.createSpan({
      cls: "mtn-ai-model-test-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    // The result is keyed by model id, so a redraw rebuilds this cell with it.
    status.dataset["model"] = modelId;
    this.applyTestState(status, modelId);

    const edit = actions.createEl("button", {
      cls: "mtn-ai-model-edit",
      text: t("settings.ai.models.actions.edit"),
      attr: { type: "button" }
    });
    edit.addEventListener("click", () => { void this.openModelForm(kind, undefined, modelId); });
    const remove = actions.createEl("button", {
      cls: "mtn-ai-model-delete",
      text: this.deleteLabel(
        "model:" + modelId,
        "settings.ai.models.actions.delete",
        "settings.ai.models.actions.deleteConfirm"
      ),
      attr: { type: "button" }
    });
    remove.addEventListener("click", () => this.confirmDelete("model:" + modelId, () => this.deleteModel(modelId, kind)));
  }

  private applyTestState(status: HTMLElement, modelId: string): void {
    const result = this.testResults.get(modelId);
    if (result === undefined) return;
    if (result === "testing") {
      status.setText(t("settings.ai.models.testing"));
      status.dataset["result"] = "testing";
      return;
    }
    if (result.ok) {
      status.setText(result.latencyMs === undefined
        ? t("settings.ai.models.testOkNoLatency")
        : t("settings.ai.models.testOk", { latency: result.latencyMs }));
      status.dataset["result"] = "ok";
      return;
    }
    status.setText(t("settings.ai.models.testFailed", {
      message: result.message ?? t("settings.ai.models.testUnavailable")
    }));
    status.dataset["result"] = "failed";
  }

  private renderOAuth(parent: HTMLElement, card: AiProviderCardView): void {
    const oauth = card.oauth;
    if (oauth === undefined) return;
    const panel = parent.createDiv({ cls: "mtn-ai-provider-oauth", attr: { "data-provider": card.id } });
    panel.createEl("h5", { text: t("settings.ai.providers.oauth.heading") });
    panel.createEl("p", {
      cls: "setting-item-description mtn-ai-provider-oauth-desc",
      text: t("settings.ai.providers.oauth.desc", { label: card.presetLabel })
    });
    panel.createDiv({
      cls: "mtn-ai-provider-oauth-status",
      text: oauth.statusText,
      attr: { role: "status", "aria-live": "polite", "data-status": oauth.status }
    });
    if (oauth.userCode !== undefined) {
      panel.createEl("code", { cls: "mtn-ai-provider-oauth-code", text: oauth.userCode });
    }
    if (oauth.verificationUri !== undefined) {
      const row = panel.createDiv({ cls: "mtn-ai-provider-oauth-verify" });
      if (oauth.verificationUri.startsWith("https://")) {
        const link = row.createEl("a", {
          cls: "external-link",
          text: t("settings.ai.providers.oauth.openVerification"),
          href: oauth.verificationUri
        });
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      } else {
        row.createSpan({ text: oauth.verificationUri });
      }
    }
    if (this.oauthBusy.has(card.id)) {
      panel.createDiv({ cls: "mtn-ai-provider-oauth-waiting", text: t("settings.ai.providers.oauth.waiting") });
    }
    const failure = this.oauthFailures.get(card.id);
    if (failure !== undefined) {
      panel.createDiv({
        cls: "mtn-setting-inline-error is-visible",
        text: t("settings.ai.providers.oauth.failed", { message: failure }),
        attr: { role: "status", "aria-live": "polite" }
      });
    }
    if (oauth.disabledHint !== undefined) {
      panel.createDiv({ cls: "mtn-ai-provider-oauth-hint", text: oauth.disabledHint });
    }

    const buttons = panel.createDiv({ cls: "mtn-ai-provider-oauth-actions" });
    if (oauth.status === "connected") {
      const disconnect = buttons.createEl("button", {
        cls: "mtn-ai-provider-oauth-disconnect",
        text: t("settings.ai.providers.oauth.disconnect"),
        attr: { type: "button" }
      });
      disconnect.disabled = oauth.actionsDisabled;
      disconnect.addEventListener("click", () => { void this.disconnectOAuth(card.id); });
    } else if (oauth.status === "pending") {
      const cancel = buttons.createEl("button", {
        cls: "mtn-ai-provider-oauth-cancel",
        text: t("settings.ai.providers.oauth.cancel"),
        attr: { type: "button" }
      });
      cancel.disabled = oauth.actionsDisabled;
      cancel.addEventListener("click", () => this.cancelOAuth(card.id));
    } else {
      const connect = buttons.createEl("button", {
        cls: "mod-cta mtn-ai-provider-oauth-connect",
        text: t("settings.ai.providers.oauth.connect"),
        attr: { type: "button" }
      });
      connect.disabled = oauth.actionsDisabled || this.oauthBusy.has(card.id);
      connect.addEventListener("click", () => { void this.beginOAuth(card.id); });
    }

    if (!oauth.showManualToken) return;
    const error = panel.createDiv({
      cls: "mtn-setting-inline-error mtn-ai-provider-oauth-token-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    error.hidden = true;
    new Setting(panel)
      .setName(t("settings.ai.providers.oauth.manualHeading"))
      .setDesc(t("settings.ai.providers.oauth.manualDesc"))
      .addText((text) => {
        const input = text.inputEl;
        input.addClass("mtn-ai-provider-oauth-token");
        input.setAttribute("type", "password");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("placeholder", t("settings.ai.providers.oauth.manualPlaceholder"));
        input.setAttribute("aria-label", t("settings.ai.providers.oauth.manualPlaceholder"));
        input.value = this.tokenDrafts.get(card.id) ?? "";
        input.addEventListener("input", () => this.tokenDrafts.set(card.id, input.value));
        // A redraw is deferred while this field has focus; leaving it applies
        // whatever the host resolved in the meantime.
        input.addEventListener("blur", () => { if (!this.destroyed) this.render(); });
      })
      .addButton((button) => button
        .setButtonText(t("settings.ai.providers.oauth.saveToken"))
        .onClick(() => { void this.saveManualToken(card.id, panel, error); }));
  }

  private deleteLabel(
    key: string,
    normal: Parameters<typeof t>[0],
    confirm: Parameters<typeof t>[0]
  ): string {
    return this.armedDeletes.has(key) ? t(confirm) : t(normal);
  }

  /**
   * Two clicks delete; a second click inside the window runs the transition.
   *
   * The armed state lives in the section (not in the button) so a redraw in
   * between — a poll tick, a toggle — does not silently disarm it.
   */
  private confirmDelete(key: string, run: () => Promise<void>): void {
    const armed = this.armedDeletes.get(key);
    if (armed === undefined) {
      const timer = setTimeout(() => {
        this.armedDeletes.delete(key);
        this.render();
      }, DELETE_CONFIRM_MS);
      this.armedDeletes.set(key, { timer });
      this.render();
      return;
    }
    clearTimeout(armed.timer);
    this.armedDeletes.delete(key);
    void run();
  }

  private async deleteProvider(providerId: string): Promise<void> {
    try {
      await this.port.deleteProvider(providerId);
      this.expanded.delete(providerId);
      this.clearError();
    } catch (error) {
      this.showError(t("settings.ai.providers.error.deleteFailed", { message: describeError(error) }));
    }
    this.render();
  }

  private async deleteModel(modelId: string, kind: AiModelFormKind): Promise<void> {
    try {
      if (kind === "chat") await this.port.deleteChatModel(modelId);
      else await this.port.deleteEmbeddingModel(modelId);
      this.testResults.delete(modelId);
      this.clearError();
    } catch (error) {
      this.showError(t("settings.ai.models.error.deleteFailed", { message: describeError(error) }));
    }
    this.render();
  }

  private async setEnabled(modelId: string, checkbox: HTMLInputElement): Promise<void> {
    try {
      await this.port.setChatModelEnabled(modelId, checkbox.checked);
      this.clearError();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      this.showError(t("settings.ai.models.error.enableFailed", { message: describeError(error) }));
    }
    this.render();
  }

  private async runModelTest(modelId: string, kind: AiModelFormKind): Promise<void> {
    this.testResults.set(modelId, "testing");
    this.render();
    let result: AiTestResult;
    try {
      result = kind === "chat"
        ? await this.port.testChatModel(modelId)
        : await this.port.testEmbeddingModel(modelId);
    } catch (error) {
      result = { ok: false, message: describeError(error) };
    }
    this.testResults.set(modelId, result);
    this.render();
  }

  private async beginOAuth(providerId: string): Promise<void> {
    if (this.destroyed || this.oauthBusy.has(providerId)) return;
    this.oauthBusy.add(providerId);
    this.oauthFailures.delete(providerId);
    this.render();
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      const start = await this.port.oauthBegin(providerId);
      if (start.mode !== "manual") {
        // The host is waiting on a browser/device callback; refresh the panel so
        // the device code it exposes becomes visible while we wait.
        poll = setInterval(() => this.render(), OAUTH_POLL_MS);
        this.oauthPolls.set(providerId, poll);
        const status = await this.port.oauthComplete(providerId, {});
        if (status.state === "error") this.oauthFailures.set(providerId, status.message);
      }
    } catch (error) {
      this.oauthFailures.set(providerId, describeError(error));
    } finally {
      if (poll !== undefined) clearInterval(poll);
      this.oauthPolls.delete(providerId);
      this.oauthBusy.delete(providerId);
      this.render();
    }
  }

  private cancelOAuth(providerId: string): void {
    this.port.oauthCancel(providerId);
    const poll = this.oauthPolls.get(providerId);
    if (poll !== undefined) {
      clearInterval(poll);
      this.oauthPolls.delete(providerId);
    }
    this.oauthBusy.delete(providerId);
    this.oauthFailures.delete(providerId);
    this.render();
  }

  private async disconnectOAuth(providerId: string): Promise<void> {
    try {
      await this.port.oauthDisconnect(providerId);
      this.oauthFailures.delete(providerId);
      this.tokenDrafts.delete(providerId);
      this.clearError();
    } catch (error) {
      this.oauthFailures.set(providerId, describeError(error));
    }
    this.render();
  }

  private async saveManualToken(providerId: string, panel: HTMLElement, error: HTMLElement): Promise<void> {
    const input = panel.querySelector<HTMLInputElement>(".mtn-ai-provider-oauth-token");
    const token = input?.value.trim() ?? "";
    if (!token) {
      error.setText(t("settings.ai.providers.oauth.tokenRequired"));
      error.hidden = false;
      error.addClass("is-visible");
      return;
    }
    try {
      const status = await this.port.oauthSaveManualToken(providerId, token);
      if (status.state === "error") {
        error.setText(t("settings.ai.providers.oauth.failed", { message: status.message }));
        error.hidden = false;
        error.addClass("is-visible");
        return;
      }
      this.tokenDrafts.delete(providerId);
      this.oauthFailures.delete(providerId);
      error.hidden = true;
      error.removeClass("is-visible");
      this.render();
    } catch (failure) {
      error.setText(t("settings.ai.providers.oauth.failed", { message: describeError(failure) }));
      error.hidden = false;
      error.addClass("is-visible");
    }
  }

  private async openPicker(): Promise<void> {
    try {
      const { AiProviderPickerModal } = await import("../modals/ai-provider-picker-modal");
      new AiProviderPickerModal(this.app, (preset) => { void this.openProviderForm({ preset }); }).open();
    } catch (error) {
      this.showError(t("settings.ai.providers.error.saveFailed", { message: describeError(error) }));
    }
  }

  private async openProviderForm(options: { preset?: AiProviderPreset; provider?: AiProviderConfig }): Promise<void> {
    try {
      const { AiProviderFormModal } = await import("../modals/ai-provider-form-modal");
      new AiProviderFormModal(this.app, this.port, options, () => this.render()).open();
    } catch (error) {
      this.showError(t("settings.ai.providers.error.saveFailed", { message: describeError(error) }));
    }
  }

  private async openModelForm(
    kind: AiModelFormKind,
    providerId?: string,
    modelId?: string
  ): Promise<void> {
    const state = this.port.state();
    const resolvedProviderId = providerId ?? state.providers.find((provider) =>
      (kind === "chat" ? state.chatModels : state.embeddingModels).some((model) =>
        model.id === modelId && model.providerId === provider.id))?.id;
    if (resolvedProviderId === undefined) return;
    const model = modelId === undefined
      ? undefined
      : kind === "chat"
        ? state.chatModels.find((entry) => entry.id === modelId)
        : state.embeddingModels.find((entry) => entry.id === modelId);
    try {
      const { AiModelFormModal } = await import("../modals/ai-model-form-modal");
      new AiModelFormModal(
        this.app,
        this.port,
        { kind, providerId: resolvedProviderId, ...(model === undefined ? {} : { model }) },
        () => this.render()
      ).open();
    } catch (error) {
      this.showError(t("settings.ai.models.error.saveFailed", { message: describeError(error) }));
    }
  }

  /**
   * Open the provider's remote catalog. Loaded lazily for the same reason as the
   * other windows: the page itself must stay constructible without a Modal base,
   * and the catalog only exists once the user asks for it.
   */
  private async openModelCatalog(providerId: string): Promise<void> {
    try {
      const { AiModelCatalogModal } = await import("../modals/ai-model-catalog-modal");
      new AiModelCatalogModal(this.app, this.port, providerId, () => this.render()).open();
    } catch (error) {
      this.showError(t("settings.ai.models.error.saveFailed", { message: describeError(error) }));
    }
  }
}

/**
 * Error objects format differently across hosts; only the message is shown.
 *
 * Not `instanceof Error`: a failure can cross a realm boundary (test sandbox,
 * plugin host), where `instanceof` is false and `String(error)` would leak an
 * "Error:" prefix into the user's status line.
 */
function describeError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
