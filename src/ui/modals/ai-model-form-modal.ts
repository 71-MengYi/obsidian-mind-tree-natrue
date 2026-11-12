/**
 * Add/edit one chat or embedding model under a provider.
 *
 * One window serves both tables; the provider is fixed by the row that opened
 * it. Like the provider form, the draft is local and the port validates on
 * save, so `AiValidationIssue.code`s appear inline and the user keeps the
 * values they typed. Numeric fields stay text inputs on purpose: a number input
 * would drop a rejected character before the validation message could name it.
 */
import { getLanguage, Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { t } from "../../i18n";
import type {
  AiBuiltinToolProvider,
  AiChatModelConfig,
  AiChatModality,
  AiCustomParameter,
  AiCustomParameterType,
  AiEmbeddingModelConfig,
  AiReasoningType,
  AiSettingsPagePort,
  AiValidationIssue
} from "../../services/ai/contracts";
import {
  builtinToolOptions,
  customParameterTypeOptions,
  modalityOptions,
  reasoningOptions,
  validationErrorText
} from "../settings-pages/ai-providers-view";

export type AiModelFormKind = "chat" | "embedding";

export interface AiModelFormOptions {
  kind: AiModelFormKind;
  providerId: string;
  model?: AiChatModelConfig | AiEmbeddingModelConfig;
}

export class AiModelFormModal extends Modal {
  private readonly kind: AiModelFormKind;
  private readonly providerId: string;
  private readonly editing: boolean;
  private id = "";
  private model = "";
  private name = "";
  private enable = true;
  private reasoningType: AiReasoningType = "none";
  private temperature = "";
  private topP = "";
  private maxContextTokens = "";
  private maxOutputTokens = "";
  private modalities = new Set<AiChatModality>(["text"]);
  private builtinToolProvider: AiBuiltinToolProvider = "none";
  private customParameters: AiCustomParameter[] = [];
  private dimension = "";
  private fieldsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private saveButton?: { setDisabled(value: boolean): unknown };
  private saving = false;

  constructor(
    app: App,
    private readonly port: AiSettingsPagePort,
    private readonly options: AiModelFormOptions,
    private readonly onSaved: () => void
  ) {
    super(app);
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.editing = options.model !== undefined;
    if (options.model === undefined) {
      this.dimension = this.kind === "embedding" ? "1536" : "";
      return;
    }
    this.id = options.model.id;
    this.model = options.model.model;
    this.name = options.model.name ?? "";
    if (options.kind === "embedding") {
      this.dimension = String((options.model as AiEmbeddingModelConfig).dimension);
      return;
    }
    const chat = options.model as AiChatModelConfig;
    this.enable = chat.enable;
    this.reasoningType = chat.reasoningType ?? "none";
    this.temperature = chat.temperature === undefined ? "" : String(chat.temperature);
    this.topP = chat.topP === undefined ? "" : String(chat.topP);
    this.maxContextTokens = chat.maxContextTokens === undefined ? "" : String(chat.maxContextTokens);
    this.maxOutputTokens = chat.maxOutputTokens === undefined ? "" : String(chat.maxOutputTokens);
    this.modalities = new Set(chat.modalities ?? ["text"]);
    this.builtinToolProvider = chat.builtinToolProvider ?? "none";
    this.customParameters = (chat.customParameters ?? []).map((parameter) => ({ ...parameter }));
  }

  onOpen(): void {
    this.modalEl.addClass("mtn-ai-model-form-modal");
    this.titleEl.setText(t(this.titleKey()));
    this.errorEl = this.contentEl.createDiv({
      cls: "mtn-setting-inline-error mtn-ai-model-form-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.errorEl.hidden = true;
    this.fieldsEl = this.contentEl.createDiv({ cls: "mtn-ai-model-form" });
    this.renderFields();
    this.renderActions();
  }

  private titleKey(): Parameters<typeof t>[0] {
    if (this.kind === "embedding") {
      return this.editing ? "settings.ai.models.form.editEmbeddingTitle" : "settings.ai.models.form.addEmbeddingTitle";
    }
    return this.editing ? "settings.ai.models.form.editChatTitle" : "settings.ai.models.form.addChatTitle";
  }

  private renderActions(): void {
    const actions = new Setting(this.contentEl).setClass("mtn-ai-model-form-actions");
    actions.addButton((button) => button
      .setButtonText(t("settings.ai.models.form.cancel"))
      .onClick(() => this.close()));
    actions.addButton((button) => {
      this.saveButton = button;
      button
        .setButtonText(t("settings.ai.models.form.save"))
        .setCta()
        .onClick(() => { void this.save(); });
    });
  }

  private renderFields(): void {
    const language = getLanguage();
    this.fieldsEl.empty();

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.provider"))
      .setDesc(this.providerId);

    this.renderIdSetting();
    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.model"))
      .setDesc(t("settings.ai.models.form.model.desc"))
      .addText((text) => text
        .setValue(this.model)
        .onChange((value) => { this.model = value; }));
    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.name"))
      .setDesc(t("settings.ai.models.form.name.desc"))
      .addText((text) => text
        .setValue(this.name)
        .onChange((value) => { this.name = value; }));

    if (this.kind === "embedding") {
      new Setting(this.fieldsEl)
        .setName(t("settings.ai.models.form.dimension"))
        .setDesc(t("settings.ai.models.form.dimension.desc"))
        .addText((text) => {
          text.inputEl.setAttribute("inputmode", "numeric");
          text
            .setValue(this.dimension)
            .onChange((value) => { this.dimension = value; });
        });
      return;
    }

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.enable"))
      .addToggle((toggle) => toggle
        .setValue(this.enable)
        .onChange((value) => { this.enable = value; }));

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.reasoning"))
      .addDropdown((dropdown) => {
        for (const option of reasoningOptions(language)) dropdown.addOption(option.value, option.label);
        dropdown.setValue(this.reasoningType).onChange((value) => {
          this.reasoningType = value as AiReasoningType;
        });
      });

    this.renderNumberSetting("settings.ai.models.form.temperature", this.temperature, (value) => {
      this.temperature = value;
    });
    this.renderNumberSetting("settings.ai.models.form.topP", this.topP, (value) => {
      this.topP = value;
    });
    this.renderNumberSetting("settings.ai.models.form.maxContext", this.maxContextTokens, (value) => {
      this.maxContextTokens = value;
    });
    this.renderNumberSetting("settings.ai.models.form.maxOutput", this.maxOutputTokens, (value) => {
      this.maxOutputTokens = value;
    });

    const modalities = new Setting(this.fieldsEl).setName(t("settings.ai.models.form.modalities"));
    for (const option of modalityOptions(language)) {
      const label = modalities.controlEl.createEl("label", { cls: "mtn-ai-model-modality" });
      const checkbox = label.createEl("input", {
        attr: { type: "checkbox", "aria-label": option.label }
      });
      checkbox.checked = this.modalities.has(option.value);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.modalities.add(option.value);
        else this.modalities.delete(option.value);
      });
      label.createSpan({ text: option.label });
    }

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.builtinTools"))
      .addDropdown((dropdown) => {
        for (const option of builtinToolOptions(language)) dropdown.addOption(option.value, option.label);
        dropdown.setValue(this.builtinToolProvider).onChange((value) => {
          this.builtinToolProvider = value as AiBuiltinToolProvider;
        });
      });

    this.renderCustomParameters(language);
  }

  private renderIdSetting(): void {
    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.id"))
      .setDesc(t("settings.ai.models.form.id.desc"))
      .addText((text) => text
        .setValue(this.id)
        .onChange((value) => { this.id = value; }));
  }

  private renderNumberSetting(
    label: Parameters<typeof t>[0],
    value: string,
    onChange: (value: string) => void
  ): void {
    new Setting(this.fieldsEl)
      .setName(t(label))
      .addText((text) => {
        text.inputEl.setAttribute("inputmode", "decimal");
        text.setValue(value).onChange(onChange);
      });
  }

  private renderCustomParameters(language: string): void {
    this.fieldsEl.createEl("h5", { text: t("settings.ai.models.form.customParameters") });
    const rows = this.fieldsEl.createDiv({ cls: "mtn-ai-model-form-parameters" });
    const typeOptions = customParameterTypeOptions(language);
    const renderRows = (): void => {
      rows.empty();
      this.customParameters.forEach((parameter, index) => {
        const row = rows.createDiv({ cls: "mtn-ai-model-form-parameter-row" });
        row.createEl("input", {
          cls: "mtn-ai-model-form-parameter-key",
          attr: {
            type: "text",
            value: parameter.key,
            placeholder: t("settings.ai.models.form.customParameters.key"),
            "aria-label": t("settings.ai.models.form.customParameters.key")
          }
        }).addEventListener("input", (event) => {
          parameter.key = (event.target as HTMLInputElement).value;
        });
        const select = row.createEl("select", {
          cls: "dropdown mtn-ai-model-form-parameter-type",
          attr: { "aria-label": t("settings.ai.models.form.customParameters.type") }
        });
        for (const option of typeOptions) {
          const element = select.createEl("option", { text: option.label, attr: { value: option.value } });
          if (option.value === parameter.type) element.selected = true;
        }
        select.addEventListener("change", () => {
          parameter.type = select.value as AiCustomParameterType;
        });
        row.createEl("input", {
          cls: "mtn-ai-model-form-parameter-value",
          attr: {
            type: "text",
            value: parameter.value,
            placeholder: t("settings.ai.models.form.customParameters.value"),
            "aria-label": t("settings.ai.models.form.customParameters.value")
          }
        }).addEventListener("input", (event) => {
          parameter.value = (event.target as HTMLInputElement).value;
        });
        const remove = row.createEl("button", {
          cls: "mtn-ai-model-form-row-remove",
          text: t("settings.ai.models.form.customParameters.remove"),
          attr: { type: "button" }
        });
        remove.addEventListener("click", () => {
          this.customParameters.splice(index, 1);
          renderRows();
        });
      });
    };
    renderRows();
    const add = this.fieldsEl.createEl("button", {
      cls: "mtn-ai-model-form-add-row",
      text: t("settings.ai.models.form.customParameters.add"),
      attr: { type: "button" }
    });
    add.addEventListener("click", () => {
      this.customParameters.push({ key: "", type: "text", value: "" });
      renderRows();
    });
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.saveButton?.setDisabled(true);
    try {
      const result = this.kind === "embedding"
        ? await this.saveEmbedding()
        : await this.saveChat();
      if (!result.ok) {
        this.showIssues(result.issues);
        return;
      }
      this.errorEl.hidden = true;
      this.close();
      this.onSaved();
    } catch (error) {
      this.showMessage(t("settings.ai.models.error.saveFailed", { message: describeError(error) }));
    } finally {
      this.saving = false;
      this.saveButton?.setDisabled(false);
    }
  }

  private async saveChat() {
    const input = this.buildChatInput();
    return this.options.model === undefined
      ? this.port.addChatModel(input)
      : this.port.updateChatModel(this.options.model.id, input);
  }

  private async saveEmbedding() {
    const input = this.buildEmbeddingInput();
    return this.options.model === undefined
      ? this.port.addEmbeddingModel(input)
      : this.port.updateEmbeddingModel(this.options.model.id, input);
  }

  private buildChatInput(): AiChatModelConfig {
    const parameters = this.customParameters
      .filter((parameter) => parameter.key.trim() !== "")
      .map((parameter) => ({ key: parameter.key.trim(), type: parameter.type, value: parameter.value }));
    return {
      id: this.id.trim(),
      providerId: this.providerId,
      model: this.model.trim(),
      enable: this.enable,
      ...(this.name.trim() === "" ? {} : { name: this.name.trim() }),
      reasoningType: this.reasoningType,
      ...optionalNumber("temperature", this.temperature),
      ...optionalNumber("topP", this.topP),
      ...optionalNumber("maxContextTokens", this.maxContextTokens),
      ...optionalNumber("maxOutputTokens", this.maxOutputTokens),
      modalities: [...this.modalities],
      builtinToolProvider: this.builtinToolProvider,
      ...(parameters.length === 0 ? {} : { customParameters: parameters })
    };
  }

  private buildEmbeddingInput(): AiEmbeddingModelConfig {
    const raw = this.dimension.trim();
    return {
      id: this.id.trim(),
      providerId: this.providerId,
      model: this.model.trim(),
      dimension: raw === "" ? Number.NaN : Number(raw),
      ...(this.name.trim() === "" ? {} : { name: this.name.trim() })
    };
  }

  private showIssues(issues: AiValidationIssue[]): void {
    const language = getLanguage();
    const messages = [...new Set(issues.map((issue) => validationErrorText(issue.code, language)))];
    this.showMessage(messages.join(" "));
  }

  private showMessage(message: string): void {
    this.errorEl.setText(message);
    this.errorEl.hidden = false;
    this.errorEl.addClass("is-visible");
  }
}

/** Empty means "provider default"; unparsable text becomes NaN for validation. */
function optionalNumber(
  field: "temperature" | "topP" | "maxContextTokens" | "maxOutputTokens",
  raw: string
): Partial<Record<typeof field, number>> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  const value = Number(trimmed);
  return { [field]: Number.isFinite(value) ? value : Number.NaN };
}

function describeError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
