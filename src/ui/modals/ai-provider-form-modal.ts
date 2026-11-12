/**
 * Add/edit a model provider.
 *
 * The form edits a local draft only; the port validates and persists on save.
 * A rejected save renders `AiValidationIssue.code`s as inline i18n sentences and
 * keeps the window open, so the user can fix the field without losing input.
 *
 * The API key is never rendered or read back: editing shows an empty password
 * field and keeps the stored key unless a new one is typed.
 */
import { getLanguage, Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import { t } from "../../i18n";
import type {
  AiAdditionalSettingKey,
  AiApiType,
  AiProviderAdditionalSettings,
  AiProviderConfig,
  AiProviderHeader,
  AiProviderPreset,
  AiSettingsPagePort,
  AiValidationIssue
} from "../../services/ai/contracts";
import { aiPresetInfo, allAiPresets, defaultApiType, defaultBaseUrl } from "../../services/ai/presets";
import { createProviderDraft, resolvePrimaryRequestUrl } from "../../services/ai/normalize";
import {
  additionalSettingLabel,
  additionalSettingOptions,
  apiTypeOptions,
  presetLabel,
  validationErrorText
} from "../settings-pages/ai-providers-view";

export interface AiProviderFormOptions {
  preset?: AiProviderPreset;
  provider?: AiProviderConfig;
}

const TEXT_SETTING_KEYS = [
  "projectId",
  "deployment",
  "apiVersion",
  "awsRegion",
  "oauthClientId",
  "oauthClientSecret"
] as const;

type TextSettingKey = (typeof TEXT_SETTING_KEYS)[number];

function isTextSettingKey(key: AiAdditionalSettingKey): key is TextSettingKey {
  return (TEXT_SETTING_KEYS as readonly string[]).includes(key);
}

function cloneAdditional(source: AiProviderAdditionalSettings | undefined): AiProviderAdditionalSettings {
  if (source === undefined) return {};
  const transport = source.requestTransportMode;
  return {
    ...source,
    ...(transport === undefined ? {} : { requestTransportMode: { ...transport } })
  };
}

export class AiProviderFormModal extends Modal {
  private preset: AiProviderPreset;
  private apiType: AiApiType;
  private providerId: string;
  private baseUrl: string;
  private apiKey = "";
  private readonly existingKey?: string;
  private readonly editing: boolean;
  private additional: AiProviderAdditionalSettings;
  private headers: AiProviderHeader[];
  private fieldsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private saveButton?: { setDisabled(value: boolean): unknown };
  private saving = false;

  constructor(
    app: App,
    private readonly port: AiSettingsPagePort,
    private readonly options: AiProviderFormOptions,
    private readonly onSaved: () => void
  ) {
    super(app);
    this.editing = options.provider !== undefined;
    const draft = options.provider ?? createProviderDraft(options.preset ?? "openai-compatible", port.state().providers);
    this.preset = draft.preset;
    this.apiType = draft.apiType;
    this.providerId = draft.id;
    this.baseUrl = draft.baseUrl ?? "";
    this.existingKey = draft.apiKey;
    this.additional = cloneAdditional(draft.additionalSettings);
    this.headers = (draft.customHeaders ?? []).map((header) => ({ ...header }));
  }

  onOpen(): void {
    this.modalEl.addClass("mtn-ai-provider-form-modal");
    this.titleEl.setText(t(this.editing
      ? "settings.ai.models.form.editProviderTitle"
      : "settings.ai.models.form.addProviderTitle"));
    this.errorEl = this.contentEl.createDiv({
      cls: "mtn-setting-inline-error mtn-ai-provider-form-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.errorEl.hidden = true;
    this.fieldsEl = this.contentEl.createDiv({ cls: "mtn-ai-provider-form" });
    this.renderFields();
    this.renderActions();
  }

  private renderActions(): void {
    const actions = new Setting(this.contentEl).setClass("mtn-ai-provider-form-actions");
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
      .setName(t("settings.ai.models.form.preset"))
      .addDropdown((dropdown) => {
        for (const preset of allAiPresets()) dropdown.addOption(preset, presetLabel(preset));
        dropdown.setValue(this.preset).onChange((value) => this.changePreset(value as AiProviderPreset));
      });

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.providerId"))
      .setDesc(t("settings.ai.models.form.providerId.desc"))
      .addText((text) => text
        .setValue(this.providerId)
        .onChange((value) => { this.providerId = value; }));

    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.apiType"))
      .addDropdown((dropdown) => {
        for (const option of apiTypeOptions(this.preset, language)) {
          dropdown.addOption(option.value, option.label);
        }
        if (!this.apiTypeIsSupported()) {
          // A hand-edited file can hold an API type the preset no longer lists;
          // keeping it selectable would silently change it on save.
          dropdown.addOption(this.apiType, this.apiType);
        }
        dropdown.setValue(this.apiType).onChange((value) => {
          this.apiType = value as AiApiType;
          this.updatePreview();
        });
      });

    this.renderApiKeySetting();
    this.renderBaseUrlSetting();
    this.previewEl = this.fieldsEl.createDiv({ cls: "mtn-ai-provider-preview", attr: { role: "status" } });
    this.updatePreview();

    for (const definition of aiPresetInfo(this.preset).additionalSettings) {
      this.renderAdditionalSetting(definition.key, definition.required === true, definition.placeholder, language);
    }

    this.renderHeaders();
  }

  private apiTypeIsSupported(): boolean {
    return apiTypeOptions(this.preset, "en").some((option) => option.value === this.apiType);
  }

  private renderApiKeySetting(): void {
    const info = aiPresetInfo(this.preset);
    const setting = new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.apiKey"))
      .addText((text) => {
        const input = text.inputEl;
        input.setAttribute("type", "password");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("placeholder", t("settings.ai.models.form.apiKey.placeholder"));
        text.setValue(this.apiKey).onChange((value) => { this.apiKey = value; });
      });
    if (this.editing && this.existingKey !== undefined) {
      setting.setDesc(t("settings.ai.models.form.apiKey.keep"));
    }
    if (info.apiKeyUrl !== undefined) {
      setting.descEl.appendText(" ");
      setting.descEl.createEl("a", {
        cls: "external-link",
        text: t("settings.ai.models.form.apiKey.getKey"),
        href: info.apiKeyUrl,
        attr: { target: "_blank", rel: "noopener noreferrer" }
      });
    }
  }

  private renderBaseUrlSetting(): void {
    new Setting(this.fieldsEl)
      .setName(t("settings.ai.models.form.baseUrl"))
      .setDesc(t("settings.ai.models.form.baseUrl.optional"))
      .addText((text) => text
        .setPlaceholder(defaultBaseUrl(this.preset) ?? "")
        .setValue(this.baseUrl)
        .onChange((value) => {
          this.baseUrl = value;
          this.updatePreview();
        }));
  }

  private renderAdditionalSetting(
    key: AiAdditionalSettingKey,
    required: boolean,
    placeholder: string | undefined,
    language: string
  ): void {
    const name = additionalSettingLabel(key, language) + (required ? " *" : "");
    const choices = additionalSettingOptions(key, language);
    if (key === "promptCaching" || key === "noStainless") {
      new Setting(this.fieldsEl)
        .setName(name)
        .addToggle((toggle) => toggle
          .setValue(this.additional[key] === true)
          .onChange((value) => { this.additional[key] = value; }));
      return;
    }
    if (key === "requestTransportMode") {
      const current = this.additional.requestTransportMode?.desktop ?? "node";
      new Setting(this.fieldsEl)
        .setName(name)
        .addDropdown((dropdown) => {
          for (const option of choices ?? []) dropdown.addOption(option.value, option.label);
          dropdown.setValue(current).onChange((value) => {
            this.additional.requestTransportMode = {
              desktop: value as NonNullable<AiProviderAdditionalSettings["requestTransportMode"]>["desktop"],
              // Mobile has no node transport; an explicit desktop direct request
              // falls back to Obsidian's HTTP bridge there.
              mobile: value === "node" ? "obsidian" : value as "browser" | "obsidian"
            };
          });
        });
      return;
    }
    if (key === "responseStreamingMode") {
      const current = this.additional.responseStreamingMode ?? "auto";
      new Setting(this.fieldsEl)
        .setName(name)
        .addDropdown((dropdown) => {
          for (const option of choices ?? []) dropdown.addOption(option.value, option.label);
          dropdown.setValue(current).onChange((value) => {
            this.additional.responseStreamingMode = value as NonNullable<AiProviderAdditionalSettings["responseStreamingMode"]>;
          });
        });
      return;
    }
    if (isTextSettingKey(key)) {
      // The catalog's placeholders are examples, not UI copy; two of them have
      // localized equivalents so the user sees the same invitation in both
      // languages as the label above the field.
      const placeholderKey = key === "projectId"
        ? "settings.ai.models.form.projectId.placeholder"
        : key === "awsRegion"
          ? "settings.ai.models.form.awsRegion.placeholder"
          : undefined;
      new Setting(this.fieldsEl)
        .setName(name)
        .addText((text) => {
          if (key === "oauthClientSecret") {
            text.inputEl.setAttribute("type", "password");
            text.inputEl.setAttribute("autocomplete", "off");
          }
          text
            .setPlaceholder(placeholderKey === undefined ? placeholder ?? "" : t(placeholderKey))
            .setValue(this.additional[key] ?? "")
            .onChange((value) => { this.additional[key] = value; });
        });
    }
  }

  private renderHeaders(): void {
    this.fieldsEl.createEl("h5", { text: t("settings.ai.models.form.headers") });
    const rows = this.fieldsEl.createDiv({ cls: "mtn-ai-provider-form-headers" });
    const renderRows = (): void => {
      rows.empty();
      this.headers.forEach((header, index) => {
        const row = rows.createDiv({ cls: "mtn-ai-provider-form-header-row" });
        row.createEl("input", {
          cls: "mtn-ai-provider-form-header-key",
          attr: {
            type: "text",
            value: header.key,
            placeholder: t("settings.ai.models.form.headers.key"),
            "aria-label": t("settings.ai.models.form.headers.key")
          }
        }).addEventListener("input", (event) => {
          header.key = (event.target as HTMLInputElement).value;
        });
        row.createEl("input", {
          cls: "mtn-ai-provider-form-header-value",
          attr: {
            type: "text",
            value: header.value,
            placeholder: t("settings.ai.models.form.headers.value"),
            "aria-label": t("settings.ai.models.form.headers.value")
          }
        }).addEventListener("input", (event) => {
          header.value = (event.target as HTMLInputElement).value;
        });
        const remove = row.createEl("button", {
          cls: "mtn-ai-provider-form-row-remove",
          text: t("settings.ai.models.form.headers.remove"),
          attr: { type: "button" }
        });
        remove.addEventListener("click", () => {
          this.headers.splice(index, 1);
          renderRows();
        });
      });
    };
    renderRows();
    const add = this.fieldsEl.createEl("button", {
      cls: "mtn-ai-provider-form-add-row",
      text: t("settings.ai.models.form.headers.add"),
      attr: { type: "button" }
    });
    add.addEventListener("click", () => {
      this.headers.push({ key: "", value: "" });
      renderRows();
    });
  }

  private updatePreview(): void {
    if (this.previewEl === undefined) return;
    const url = resolvePrimaryRequestUrl({
      preset: this.preset,
      apiType: this.apiType,
      ...(this.baseUrl.trim() === "" ? {} : { baseUrl: this.baseUrl }),
      additionalSettings: this.additional
    });
    this.previewEl.setText(url === undefined
      ? t("settings.ai.models.form.previewUnavailable")
      : t("settings.ai.models.form.preview", { url }));
  }

  private changePreset(preset: AiProviderPreset): void {
    const previousDefault = defaultBaseUrl(this.preset);
    this.preset = preset;
    this.apiType = defaultApiType(preset);
    // A user-typed URL is theirs to keep; only a value that was the old preset's
    // default follows the new preset.
    if (this.baseUrl.trim() === "" || this.baseUrl.trim() === previousDefault) {
      this.baseUrl = defaultBaseUrl(preset) ?? "";
    }
    this.additional = {};
    this.renderFields();
  }

  private buildInput(): AiProviderConfig {
    const apiKey = this.apiKey.trim() === "" ? this.existingKey : this.apiKey.trim();
    const baseUrl = this.baseUrl.trim();
    const additional = this.normalizedAdditional();
    const headers = this.headers
      .map((header) => ({ key: header.key.trim(), value: header.value }))
      .filter((header) => header.key !== "");
    return {
      id: this.providerId.trim(),
      preset: this.preset,
      apiType: this.apiType,
      ...(baseUrl === "" ? {} : { baseUrl }),
      ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      ...(Object.keys(additional).length === 0 ? {} : { additionalSettings: additional }),
      ...(headers.length === 0 ? {} : { customHeaders: headers })
    };
  }

  private normalizedAdditional(): AiProviderAdditionalSettings {
    const result: AiProviderAdditionalSettings = {};
    const transport = this.additional.requestTransportMode;
    if (transport !== undefined) {
      result.requestTransportMode = { ...transport };
    }
    if (this.additional.responseStreamingMode !== undefined) {
      result.responseStreamingMode = this.additional.responseStreamingMode;
    }
    if (this.additional.promptCaching !== undefined) result.promptCaching = this.additional.promptCaching;
    if (this.additional.noStainless !== undefined) result.noStainless = this.additional.noStainless;
    for (const key of TEXT_SETTING_KEYS) {
      const value = this.additional[key]?.trim();
      if (value !== undefined && value !== "") result[key] = value;
    }
    return result;
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.saveButton?.setDisabled(true);
    try {
      const input = this.buildInput();
      const result = this.options.provider === undefined
        ? await this.port.addProvider(input)
        : await this.port.updateProvider(this.options.provider.id, input);
      if (!result.ok) {
        this.showIssues(result.issues);
        return;
      }
      this.errorEl.hidden = true;
      this.close();
      this.onSaved();
    } catch (error) {
      this.showMessage(t("settings.ai.providers.error.saveFailed", { message: describeError(error) }));
    } finally {
      this.saving = false;
      this.saveButton?.setDisabled(false);
    }
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

function describeError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
