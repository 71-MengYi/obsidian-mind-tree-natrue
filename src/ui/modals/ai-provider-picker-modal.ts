/**
 * The "add a model provider" picker.
 *
 * Search plus category chips over the preset catalog. Brand labels are product
 * names and stay untranslated; the search box, chips, empty state and the
 * custom tile are UI copy from the i18n catalog. Picking a tile only hands the
 * preset back to the caller, which opens the provider form.
 */
import { getLanguage, Modal } from "obsidian";
import type { App } from "obsidian";
import { t } from "../../i18n";
import type { AiProviderPreset } from "../../services/ai/contracts";
import { aiPickerCategories, filterAiPickerItems, type AiPickerFilter } from "../settings-pages/ai-providers-view";

export class AiProviderPickerModal extends Modal {
  private query = "";
  private category: AiPickerFilter = "all";
  private searchEl!: HTMLInputElement;
  private chipsEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private emptyEl!: HTMLElement;

  constructor(app: App, private readonly onChoose: (preset: AiProviderPreset) => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mtn-ai-provider-picker-modal");
    this.titleEl.setText(t("settings.ai.models.picker.title"));

    const search = this.contentEl.createDiv({ cls: "mtn-ai-provider-picker-search" });
    this.searchEl = search.createEl("input", {
      attr: {
        type: "search",
        placeholder: t("settings.ai.models.picker.searchPlaceholder"),
        "aria-label": t("settings.ai.models.picker.search")
      }
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value;
      this.renderGrid();
    });
    this.searchEl.addEventListener("keydown", (event) => {
      // Escape belongs to the modal, but a focus inside the search field would
      // otherwise swallow it before the window handles it.
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.close();
    });

    this.chipsEl = this.contentEl.createDiv({
      cls: "mtn-ai-provider-picker-categories",
      attr: { role: "group", "aria-label": t("settings.ai.models.picker.categories") }
    });
    this.gridEl = this.contentEl.createDiv({ cls: "mtn-ai-provider-picker-grid" });
    this.emptyEl = this.contentEl.createDiv({ cls: "setting-item-description mtn-ai-provider-picker-empty" });

    this.renderChips();
    this.renderGrid();
    this.searchEl.focus();
  }

  private renderChips(): void {
    const language = getLanguage();
    this.chipsEl.empty();
    for (const category of aiPickerCategories(language)) {
      const active = category.id === this.category;
      const chip = this.chipsEl.createEl("button", {
        cls: "mtn-ai-provider-picker-chip" + (active ? " is-active" : ""),
        text: category.label,
        attr: { type: "button", "aria-pressed": String(active) }
      });
      chip.addEventListener("click", () => {
        this.category = category.id;
        this.renderChips();
        this.renderGrid();
      });
    }
  }

  private renderGrid(): void {
    const language = getLanguage();
    const items = filterAiPickerItems(this.query, this.category, language);
    this.gridEl.empty();
    for (const item of items) {
      const tile = this.gridEl.createEl("button", {
        cls: "mtn-ai-provider-picker-tile" + (item.custom ? " is-custom" : ""),
        attr: { type: "button" }
      });
      tile.createSpan({ cls: "mtn-ai-provider-picker-tile-label", text: item.label });
      if (item.custom) {
        tile.createSpan({
          cls: "mtn-ai-provider-picker-tile-desc",
          text: t("settings.ai.models.picker.customDesc")
        });
      }
      tile.addEventListener("click", () => {
        this.close();
        this.onChoose(item.preset);
      });
    }
    this.emptyEl.hidden = items.length > 0;
    this.emptyEl.setText(items.length > 0 ? "" : t("settings.ai.models.picker.empty"));
  }
}
