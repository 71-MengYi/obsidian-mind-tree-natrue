/**
 * "Fetch model catalog": discover a provider's models and batch-add chat models.
 *
 * One window per provider. The host supplies the catalog (`listRemoteModels`);
 * this dialog only decides what is shown, what is selected, and in what order
 * the configs are added. Adding is one `addChatModel` call per model so a single
 * rejected row cannot roll back the ones that succeeded; failures stay inline
 * instead of closing the window.
 *
 * Models already configured for the provider are shown but not selectable: the
 * catalog is a convenience, not a second way to duplicate rows. Config ids are
 * `<provider>/<model>` and grow a numeric suffix when that id is taken.
 */
import { getLanguage, Modal } from "obsidian";
import type { App } from "obsidian";
import { t } from "../../i18n";
import type { AiChatModelConfig, AiRemoteModelList, AiSettingsPagePort } from "../../services/ai/contracts";
import { inferReasoningType, modelConfigId, validationErrorText } from "../settings-pages/ai-providers-view";

interface BatchFailure {
  model: string;
  message: string;
}

interface BatchResult {
  added: number;
  skipped: number;
  failures: BatchFailure[];
}

export class AiModelCatalogModal extends Modal {
  private catalog?: AiRemoteModelList;
  private loading = false;
  private loadError?: string;
  private query = "";
  private readonly selected = new Set<string>();
  private adding = false;
  private result?: BatchResult;
  private closed = false;

  private statusEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private selectAllRow!: HTMLElement;
  private selectAllEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private countEl!: HTMLElement;
  private addButton!: HTMLButtonElement;
  private manualButton!: HTMLButtonElement;
  /** Model names already configured for this provider, refreshed per redraw. */
  private existing = new Set<string>();

  constructor(
    app: App,
    private readonly port: AiSettingsPagePort,
    private readonly providerId: string,
    private readonly onAdded: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mtn-ai-model-catalog-modal");
    this.titleEl.setText(t("settings.ai.models.catalog.title"));
    this.contentEl.createEl("p", {
      cls: "setting-item-description mtn-ai-model-catalog-desc",
      text: t("settings.ai.models.catalog.desc", { provider: this.providerId })
    });

    this.statusEl = this.contentEl.createDiv({
      cls: "mtn-ai-model-catalog-status",
      attr: { role: "status", "aria-live": "polite" }
    });

    const search = this.contentEl.createDiv({ cls: "mtn-ai-model-catalog-search" });
    this.searchEl = search.createEl("input", {
      attr: {
        type: "search",
        placeholder: t("settings.ai.models.catalog.searchPlaceholder"),
        "aria-label": t("settings.ai.models.catalog.search")
      }
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value;
      this.renderList();
    });

    this.selectAllRow = this.contentEl.createDiv({ cls: "mtn-ai-model-catalog-selectall" });
    const selectAllLabel = this.selectAllRow.createEl("label", { cls: "mtn-ai-model-catalog-selectall-label" });
    this.selectAllEl = selectAllLabel.createEl("input", { attr: { type: "checkbox" } });
    selectAllLabel.createSpan({ text: t("settings.ai.models.catalog.selectAll") });
    this.selectAllEl.addEventListener("change", () => this.toggleSelectAll());

    this.listEl = this.contentEl.createDiv({ cls: "mtn-ai-model-catalog-list" });
    this.resultsEl = this.contentEl.createDiv({
      cls: "mtn-ai-model-catalog-results",
      attr: { role: "status", "aria-live": "polite" }
    });

    const footer = this.contentEl.createDiv({ cls: "mtn-ai-model-catalog-footer" });
    this.countEl = footer.createSpan({ cls: "mtn-ai-model-catalog-count" });
    this.manualButton = footer.createEl("button", {
      cls: "mtn-ai-model-catalog-manual",
      text: t("settings.ai.models.catalog.manual"),
      attr: { type: "button" }
    });
    this.manualButton.addEventListener("click", () => { void this.openManualForm(); });
    this.addButton = footer.createEl("button", {
      cls: "mod-cta mtn-ai-model-catalog-add",
      attr: { type: "button" }
    });
    this.addButton.addEventListener("click", () => { void this.addSelected(); });
    const close = footer.createEl("button", {
      cls: "mtn-ai-model-catalog-close",
      text: t("settings.ai.models.catalog.close"),
      attr: { type: "button" }
    });
    close.addEventListener("click", () => this.close());

    this.loading = true;
    this.renderAll();
    void this.loadCatalog();
    this.searchEl.focus();
  }

  onClose(): void {
    this.closed = true;
  }

  private async loadCatalog(): Promise<void> {
    try {
      const catalog = await this.port.listRemoteModels(this.providerId);
      if (this.closed) return;
      this.catalog = catalog;
      this.loadError = undefined;
      this.selected.clear();
    } catch (error) {
      if (this.closed) return;
      this.loadError = describeError(error);
    }
    if (this.closed) return;
    this.loading = false;
    this.renderAll();
  }

  private existingModels(): Set<string> {
    this.existing = new Set(
      this.port.state().chatModels
        .filter((model) => model.providerId === this.providerId)
        .map((model) => model.model)
    );
    return this.existing;
  }

  private isExisting(model: string): boolean {
    return this.existing.has(model);
  }

  /** Unique catalog entries matching the search box, in catalog order. */
  private visibleModels(): string[] {
    if (this.catalog === undefined) return [];
    const needle = this.query.trim().toLowerCase();
    const seen = new Set<string>();
    const result: string[] = [];
    for (const model of this.catalog.models) {
      if (model.trim() === "" || seen.has(model)) continue;
      seen.add(model);
      if (needle !== "" && !model.toLowerCase().includes(needle)) continue;
      result.push(model);
    }
    return result;
  }

  private selectableModels(): string[] {
    return this.visibleModels().filter((model) => !this.isExisting(model));
  }

  private renderAll(): void {
    this.existingModels();
    this.renderStatus();
    this.renderList();
    this.renderResults();
  }

  private renderStatus(): void {
    this.statusEl.empty();
    this.statusEl.hidden = true;
    this.statusEl.classList.remove("is-error");
    if (this.loading) {
      this.statusEl.hidden = false;
      this.statusEl.setText(t("settings.ai.models.catalog.loading"));
      return;
    }
    if (this.loadError !== undefined) {
      this.statusEl.hidden = false;
      this.statusEl.addClass("is-error");
      this.statusEl.setText(t("settings.ai.models.catalog.error", { message: this.loadError }));
      return;
    }
    const catalog = this.catalog;
    if (catalog === undefined) return;
    const parts: string[] = [];
    if (catalog.source === "fallback") {
      if (catalog.message === "unsupported") {
        parts.push(t("settings.ai.models.catalog.unsupported"));
      } else {
        const message = catalog.message === undefined ? "" : ` ${catalog.message}`;
        parts.push(t("settings.ai.models.catalog.fallback") + message);
      }
    }
    if (catalog.models.length === 0) parts.push(t("settings.ai.models.catalog.empty"));
    if (parts.length === 0) return;
    this.statusEl.hidden = false;
    this.statusEl.setText(parts.join(" "));
  }

  private renderList(): void {
    this.listEl.empty();
    const models = this.visibleModels();
    for (const model of models) {
      const existing = this.isExisting(model);
      const row = this.listEl.createEl("label", {
        cls: "mtn-ai-model-catalog-row" + (existing ? " is-existing" : ""),
        attr: { "data-model": model }
      });
      const checkbox = row.createEl("input", {
        attr: { type: "checkbox", "aria-label": model }
      });
      checkbox.checked = !existing && this.selected.has(model);
      checkbox.disabled = existing || this.adding || this.loading;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(model);
        else this.selected.delete(model);
        this.updateSelection();
      });
      row.createEl("code", { text: model });
      if (existing) {
        row.createSpan({
          cls: "mtn-ai-model-catalog-badge",
          text: t("settings.ai.models.catalog.alreadyAdded")
        });
      }
    }
    this.updateSelection();
  }

  private renderResults(): void {
    this.resultsEl.empty();
    const result = this.result;
    if (result === undefined) {
      this.resultsEl.hidden = true;
      return;
    }
    this.resultsEl.hidden = false;
    this.resultsEl.createDiv({
      text: t("settings.ai.models.catalog.result", {
        added: result.added,
        skipped: result.skipped
      })
    });
    if (result.failures.length === 0) return;
    this.resultsEl.createDiv({ text: t("settings.ai.models.catalog.failures") });
    const list = this.resultsEl.createEl("ul", { cls: "mtn-ai-model-catalog-failures" });
    for (const failure of result.failures) {
      list.createEl("li", {
        text: t("settings.ai.models.catalog.failure", { model: failure.model, message: failure.message })
      });
    }
  }

  private updateSelection(): void {
    const selected = [...this.selected].filter((model) => !this.isExisting(model));
    // Count only catalog entries that are already configured; unrelated manual
    // rows under the same provider are not "skipped by this catalog".
    const configuredInCatalog = new Set((this.catalog?.models ?? []).filter((model) => this.existing.has(model))).size;
    this.countEl.setText(configuredInCatalog === 0
      ? t("settings.ai.models.catalog.selected", { count: selected.length })
      : `${t("settings.ai.models.catalog.selected", { count: selected.length })} · ${
        t("settings.ai.models.catalog.alreadyCount", { count: configuredInCatalog })
      }`);
    this.addButton.setText(this.adding
      ? t("settings.ai.models.catalog.adding")
      : t("settings.ai.models.catalog.add", { count: selected.length }));
    this.addButton.disabled = selected.length === 0 || this.adding || this.loading || this.loadError !== undefined;
    this.manualButton.disabled = this.adding;
    const selectable = this.selectableModels();
    const chosen = selectable.filter((model) => this.selected.has(model)).length;
    this.selectAllRow.hidden = selectable.length === 0;
    this.selectAllEl.checked = selectable.length > 0 && chosen === selectable.length;
    this.selectAllEl.indeterminate = chosen > 0 && chosen < selectable.length;
    this.selectAllEl.disabled = this.adding || this.loading;
  }

  /** Select-all applies to the rows the current search shows, not the whole list. */
  private toggleSelectAll(): void {
    const selectable = this.selectableModels();
    const allChosen = selectable.length > 0 && selectable.every((model) => this.selected.has(model));
    for (const model of selectable) {
      if (allChosen) this.selected.delete(model);
      else this.selected.add(model);
    }
    this.renderList();
  }

  private async addSelected(): Promise<void> {
    if (this.adding) return;
    const selected = [...this.selected];
    if (selected.length === 0) return;
    this.adding = true;
    this.result = undefined;
    this.renderList();
    this.renderResults();
    const state = this.port.state();
    const existingPairs = new Set(
      state.chatModels.filter((model) => model.providerId === this.providerId).map((model) => model.model)
    );
    // Model ids share one namespace across chat and embedding configs, so the
    // uniqueness check must see both lists.
    const existingIds = new Set([
      ...state.chatModels.map((model) => model.id),
      ...state.embeddingModels.map((model) => model.id)
    ]);
    let added = 0;
    let skipped = 0;
    const failures: BatchFailure[] = [];
    for (const model of selected) {
      if (this.closed) break;
      if (existingPairs.has(model)) {
        skipped += 1;
        continue;
      }
      const input: AiChatModelConfig = {
        id: modelConfigId(this.providerId, model, existingIds),
        providerId: this.providerId,
        model,
        name: model,
        enable: true,
        modalities: ["text"],
        reasoningType: inferReasoningType(model)
      };
      try {
        const outcome = await this.port.addChatModel(input);
        if (outcome.ok) {
          added += 1;
          existingPairs.add(model);
          existingIds.add(outcome.value.id);
          this.selected.delete(model);
        } else {
          failures.push({
            model,
            message: [...new Set(outcome.issues.map((issue) => validationErrorText(issue.code, getLanguage())))].join(" ")
          });
        }
      } catch (error) {
        failures.push({ model, message: describeError(error) });
      }
    }
    if (this.closed) {
      // The user closed the window mid-batch; the successful rows still belong
      // in the parent card, so refresh it without touching this detached UI.
      if (added > 0) this.onAdded();
      return;
    }
    this.adding = false;
    this.result = { added, skipped, failures };
    // Existing rows must be marked even when part of the batch failed.
    if (added > 0) this.onAdded();
    if (failures.length === 0 && skipped === 0) {
      this.close();
      return;
    }
    this.renderAll();
  }

  /** Hand off to the ordinary model form; the catalog is only a shortcut. */
  private async openManualForm(): Promise<void> {
    try {
      const { AiModelFormModal } = await import("./ai-model-form-modal");
      this.close();
      new AiModelFormModal(
        this.app,
        this.port,
        { kind: "chat", providerId: this.providerId },
        () => this.onAdded()
      ).open();
    } catch (error) {
      this.result = {
        added: 0,
        skipped: 0,
        failures: [{ model: t("settings.ai.models.catalog.manual"), message: describeError(error) }]
      };
      this.renderResults();
    }
  }
}

function describeError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
