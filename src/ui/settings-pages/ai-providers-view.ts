/**
 * Pure view model for the AI tab's provider section and its modals.
 *
 * Everything a user can read here is derived from one resolved
 * `AiSettingsState`: section copy, per-provider card data, OAuth panel state,
 * model rows, picker filtering and form option lists. No DOM, no Obsidian and
 * no network, so the rules stay testable without a window — the section and the
 * modals only move these values onto elements.
 *
 * Brand and model names are product data, not UI copy: preset labels and model
 * identifiers pass through untranslated, while every sentence around them comes
 * from the i18n catalog keyed by `settings.ai.providers.*` / `settings.ai.models.*`.
 */
import {
  AI_PICKER_CATEGORIES,
  type AiAdditionalSettingKey,
  type AiApiType,
  type AiBuiltinToolProvider,
  type AiChatModelConfig,
  type AiChatModality,
  type AiCustomParameterType,
  type AiEmbeddingModelConfig,
  type AiOAuthStatus,
  type AiPickerCategory,
  type AiProviderConfig,
  type AiProviderPreset,
  type AiReasoningType,
  type AiSettingsState,
  type AiValidationCode
} from "../../services/ai/contracts";
import { aiPresetInfo, allAiPresets, presetSupportsEmbedding, supportedApiTypes } from "../../services/ai/presets";
import { modelName, resolveProviderBaseUrl } from "../../services/ai/normalize";
import { translate, type TranslationKey, type TranslationVariables } from "../../i18n/catalog";

/** How a configured provider proves it can reach the service. */
export type AiProviderConnectionKind =
  | "oauth-connected"
  | "oauth-pending"
  | "oauth-error"
  | "oauth-disconnected"
  | "api-key"
  | "no-api-key"
  | "no-credential-required";

export interface AiProviderConnectionView {
  kind: AiProviderConnectionKind;
  /** Ready-to-render sentence for the card header and its status line. */
  text: string;
  /** Host-supplied OAuth failure text; kept verbatim. */
  message?: string;
}

/** The OAuth panel inside an expanded provider card. */
export interface AiOAuthPanelView {
  status: AiOAuthStatus["state"];
  statusText: string;
  account?: string;
  /** Device-flow code the user types on the verification page. */
  userCode?: string;
  verificationUri?: string;
  /** Host-supplied failure text for the `error` state. */
  message?: string;
  /** OAuth needs a device browser; the rest of the provider settings do not. */
  actionsDisabled: boolean;
  disabledHint?: string;
  /** Manual token entry stays available as the fallback everywhere. */
  showManualToken: boolean;
}

export interface AiChatModelRowView {
  id: string;
  providerId: string;
  model: string;
  /** Display name; falls back to the model identifier, then the config id. */
  name: string;
  enabled: boolean;
}

export interface AiEmbeddingModelRowView {
  id: string;
  providerId: string;
  model: string;
  name: string;
  dimension: number;
}

export interface AiProviderCardView {
  id: string;
  preset: AiProviderPreset;
  /** Product name from the preset catalog; never translated. */
  presetLabel: string;
  apiType: AiApiType;
  apiTypeLabel: string;
  /** Resolved endpoint, custom or preset default; undefined for Bedrock. */
  baseUrl?: string;
  baseUrlIsDefault: boolean;
  connection: AiProviderConnectionView;
  oauth?: AiOAuthPanelView;
  chatModels: AiChatModelRowView[];
  embeddingModels: AiEmbeddingModelRowView[];
  supportsEmbedding: boolean;
  /** Empty-state sentence for each table. */
  chatEmpty: string;
  embeddingEmpty: string;
}

export interface AiProvidersView {
  heading: string;
  description: string;
  count: number;
  countText: string;
  emptyText: string;
  addLabel: string;
  supported: boolean;
  unsupportedText?: string;
  cards: AiProviderCardView[];
}

/** A picker chip; `all` is the default filter and the catalog's categories follow. */
export type AiPickerFilter = AiPickerCategory | "all";

export interface AiPickerCategoryView {
  id: AiPickerFilter;
  label: string;
}

export interface AiPickerItemView {
  preset: AiProviderPreset;
  /** Brand label, except the custom tile whose label is UI copy. */
  label: string;
  category: AiPickerCategory;
  /** The custom tile maps onto the `openai-compatible` preset. */
  custom: boolean;
}

export interface AiOption<T extends string> {
  value: T;
  label: string;
}

function text(key: TranslationKey, language: string, variables: TranslationVariables = {}): string {
  return translate(key, language, variables);
}

const PICKER_CATEGORY_KEYS: Record<AiPickerCategory, TranslationKey> = {
  main: "settings.ai.models.picker.category.main",
  cn: "settings.ai.models.picker.category.cn",
  gw: "settings.ai.models.picker.category.gw",
  cloud: "settings.ai.models.picker.category.cloud",
  local: "settings.ai.models.picker.category.local"
};

const API_TYPE_KEYS: Record<AiApiType, TranslationKey> = {
  "openai-compatible": "settings.ai.providers.apiType.openai-compatible",
  "openai-responses": "settings.ai.providers.apiType.openai-responses",
  anthropic: "settings.ai.providers.apiType.anthropic",
  gemini: "settings.ai.providers.apiType.gemini",
  "amazon-bedrock": "settings.ai.providers.apiType.amazon-bedrock"
};

const ADDITIONAL_SETTING_KEYS: Record<AiAdditionalSettingKey, TranslationKey> = {
  requestTransportMode: "settings.ai.models.form.requestTransport",
  responseStreamingMode: "settings.ai.models.form.responseStreaming",
  promptCaching: "settings.ai.models.form.promptCaching",
  noStainless: "settings.ai.models.form.noStainless",
  projectId: "settings.ai.models.form.projectId",
  deployment: "settings.ai.models.form.deployment",
  apiVersion: "settings.ai.models.form.apiVersion",
  awsRegion: "settings.ai.models.form.awsRegion",
  oauthClientId: "settings.ai.models.form.oauthClientId",
  oauthClientSecret: "settings.ai.models.form.oauthClientSecret"
};

const REQUEST_TRANSPORT_KEYS: Record<string, TranslationKey> = {
  browser: "settings.ai.models.form.requestTransport.browser",
  obsidian: "settings.ai.models.form.requestTransport.obsidian",
  node: "settings.ai.models.form.requestTransport.node"
};

const STREAMING_KEYS: Record<string, TranslationKey> = {
  auto: "settings.ai.models.form.responseStreaming.auto",
  streaming: "settings.ai.models.form.responseStreaming.streaming",
  "non-streaming": "settings.ai.models.form.responseStreaming.non-streaming"
};

const PROVIDER_VALIDATION_KEYS: Partial<Record<AiValidationCode, TranslationKey>> = {
  "provider-id-required": "settings.ai.providers.error.idRequired",
  "provider-id-invalid": "settings.ai.providers.error.idInvalid",
  "provider-id-duplicate": "settings.ai.providers.error.idDuplicate",
  "provider-api-key-required": "settings.ai.providers.error.apiKeyRequired",
  "provider-base-url-required": "settings.ai.providers.error.baseUrlRequired",
  "provider-base-url-invalid": "settings.ai.providers.error.baseUrlInvalid",
  "provider-oauth-client-required": "settings.ai.providers.error.oauthClientRequired"
};

const MODEL_VALIDATION_KEYS: Partial<Record<AiValidationCode, TranslationKey>> = {
  "model-id-required": "settings.ai.models.error.idRequired",
  "model-id-duplicate": "settings.ai.models.error.idDuplicate",
  "model-name-required": "settings.ai.models.error.modelRequired",
  "model-number-invalid": "settings.ai.models.error.numberInvalid",
  "model-parameter-invalid": "settings.ai.models.error.parameterInvalid"
};

/** Preset label for the form's read-only preset field. */
export function presetLabel(preset: AiProviderPreset): string {
  return aiPresetInfo(preset).label;
}

/** Whether the provider authenticates through an OAuth flow at all. */
export function presetUsesOAuth(preset: AiProviderPreset): boolean {
  return aiPresetInfo(preset).oauth !== null;
}

/** Human label for one API type; the values are the contracts' literals. */
export function apiTypeLabel(apiType: AiApiType, language: string): string {
  return text(API_TYPE_KEYS[apiType], language);
}

/**
 * API types a provider may switch between.
 *
 * The order is the preset's supported list, so the natural protocol comes
 * first; `openai-compatible` is only offered where the preset declares it.
 */
export function apiTypeOptions(preset: AiProviderPreset, language: string): Array<AiOption<AiApiType>> {
  return supportedApiTypes(preset).map((value) => ({ value, label: apiTypeLabel(value, language) }));
}

/** Label for one `additionalSettings` field. */
export function additionalSettingLabel(key: AiAdditionalSettingKey, language: string): string {
  return text(ADDITIONAL_SETTING_KEYS[key], language);
}

/**
 * Translated choices for the two select-shaped additional settings.
 *
 * The preset definitions carry English option labels for documentation; the
 * form shows these localized ones instead. Returns undefined for text/toggle
 * fields, which have no choices.
 */
export function additionalSettingOptions(
  key: AiAdditionalSettingKey,
  language: string
): Array<AiOption<string>> | undefined {
  if (key === "requestTransportMode") {
    return Object.entries(REQUEST_TRANSPORT_KEYS).map(([value, translationKey]) => ({
      value,
      label: text(translationKey, language)
    }));
  }
  if (key === "responseStreamingMode") {
    return Object.entries(STREAMING_KEYS).map(([value, translationKey]) => ({
      value,
      label: text(translationKey, language)
    }));
  }
  return undefined;
}

export function reasoningOptions(language: string): Array<AiOption<AiReasoningType>> {
  return [
    { value: "none", label: text("settings.ai.models.form.reasoning.none", language) },
    { value: "openai", label: text("settings.ai.models.form.reasoning.openai", language) },
    { value: "gemini", label: text("settings.ai.models.form.reasoning.gemini", language) },
    { value: "anthropic", label: text("settings.ai.models.form.reasoning.anthropic", language) }
  ];
}

export function modalityOptions(language: string): Array<AiOption<AiChatModality>> {
  return [
    { value: "text", label: text("settings.ai.models.form.modality.text", language) },
    { value: "vision", label: text("settings.ai.models.form.modality.vision", language) },
    { value: "pdf", label: text("settings.ai.models.form.modality.pdf", language) }
  ];
}

export function builtinToolOptions(language: string): Array<AiOption<AiBuiltinToolProvider>> {
  return [
    { value: "none", label: text("settings.ai.models.form.builtinTools.none", language) },
    { value: "gemini", label: text("settings.ai.models.form.builtinTools.gemini", language) },
    { value: "gpt", label: text("settings.ai.models.form.builtinTools.gpt", language) },
    { value: "openrouter", label: text("settings.ai.models.form.builtinTools.openrouter", language) },
    { value: "grok", label: text("settings.ai.models.form.builtinTools.grok", language) },
    { value: "deepseek", label: text("settings.ai.models.form.builtinTools.deepseek", language) }
  ];
}

export function customParameterTypeOptions(language: string): Array<AiOption<AiCustomParameterType>> {
  return [
    { value: "text", label: text("settings.ai.models.form.customParameters.type.text", language) },
    { value: "number", label: text("settings.ai.models.form.customParameters.type.number", language) },
    { value: "boolean", label: text("settings.ai.models.form.customParameters.type.boolean", language) },
    { value: "json", label: text("settings.ai.models.form.customParameters.type.json", language) }
  ];
}

/**
 * Translate one `AiValidationIssue.code` into the sentence the form shows.
 *
 * Provider and model codes get their own prefixes so the same failure reads
 * naturally in both forms. Codes not yet mapped fall back to the generic
 * sentence rather than leaking the raw enum.
 */
export function validationErrorText(code: AiValidationCode, language: string): string {
  const key = PROVIDER_VALIDATION_KEYS[code] ?? MODEL_VALIDATION_KEYS[code];
  if (key !== undefined) return text(key, language);
  return text(code.startsWith("provider-")
    ? "settings.ai.providers.error.idInvalid"
    : "settings.ai.models.error.numberInvalid", language);
}

function chatModelRow(model: AiChatModelConfig): AiChatModelRowView {
  return {
    id: model.id,
    providerId: model.providerId,
    model: model.model,
    name: modelName(model),
    enabled: model.enable
  };
}

function embeddingModelRow(model: AiEmbeddingModelConfig): AiEmbeddingModelRowView {
  return {
    id: model.id,
    providerId: model.providerId,
    model: model.model,
    name: modelName(model),
    dimension: model.dimension
  };
}

function connectionOf(
  provider: AiProviderConfig,
  state: AiSettingsState,
  language: string
): AiProviderConnectionView {
  if (presetUsesOAuth(provider.preset)) {
    const status: AiOAuthStatus = state.oauth[provider.id] ?? { state: "disconnected" };
    switch (status.state) {
      case "connected":
        return {
          kind: "oauth-connected",
          text: status.account === undefined
            ? text("settings.ai.providers.status.oauthConnected", language)
            : text("settings.ai.providers.status.oauthConnectedAccount", language, { account: status.account })
        };
      case "pending":
        return { kind: "oauth-pending", text: text("settings.ai.providers.status.oauthPending", language) };
      case "error":
        return {
          kind: "oauth-error",
          text: text("settings.ai.providers.status.oauthError", language, { message: status.message }),
          message: status.message
        };
      case "disconnected":
        return { kind: "oauth-disconnected", text: text("settings.ai.providers.status.oauthDisconnected", language) };
    }
  }
  if (provider.apiKey?.trim()) {
    return { kind: "api-key", text: text("settings.ai.providers.status.apiKey", language) };
  }
  if (!aiPresetInfo(provider.preset).requireApiKey) {
    return { kind: "no-credential-required", text: text("settings.ai.providers.status.noKeyRequired", language) };
  }
  return { kind: "no-api-key", text: text("settings.ai.providers.status.noKey", language) };
}

function oauthPanelOf(
  provider: AiProviderConfig,
  state: AiSettingsState,
  language: string
): AiOAuthPanelView | undefined {
  if (!presetUsesOAuth(provider.preset)) return undefined;
  const status: AiOAuthStatus = state.oauth[provider.id] ?? { state: "disconnected" };
  const actionsDisabled = !state.isDesktop;
  // Browser flows report an empty device code (pendingStatus supplies ""), and
  // only a device flow has a code the user must type.
  const userCode = status.state === "pending" && status.userCode.trim() !== ""
    ? status.userCode
    : undefined;
  const verificationUri = status.state === "pending" && status.verificationUri.trim() !== ""
    ? status.verificationUri
    : undefined;
  const base = {
    status: status.state,
    actionsDisabled,
    showManualToken: status.state !== "connected",
    ...(actionsDisabled ? { disabledHint: text("settings.ai.providers.oauth.desktopOnly", language) } : {})
  } as const;
  switch (status.state) {
    case "connected":
      return {
        ...base,
        statusText: status.account === undefined
          ? text("settings.ai.providers.oauth.connected", language)
          : text("settings.ai.providers.oauth.connectedAccount", language, { account: status.account }),
        ...(status.account === undefined ? {} : { account: status.account })
      };
    case "pending":
      return {
        ...base,
        statusText: userCode === undefined
          ? text("settings.ai.providers.oauth.waiting", language)
          : text("settings.ai.providers.oauth.pending", language, { code: userCode }),
        ...(userCode === undefined ? {} : { userCode }),
        ...(verificationUri === undefined ? {} : { verificationUri })
      };
    case "error":
      return {
        ...base,
        statusText: text("settings.ai.providers.oauth.failed", language, { message: status.message }),
        message: status.message
      };
    case "disconnected":
      return { ...base, statusText: text("settings.ai.providers.oauth.disconnected", language) };
  }
}

/** Every provider card, in stored order. */
export function buildProviderCard(
  provider: AiProviderConfig,
  state: AiSettingsState,
  language: string
): AiProviderCardView {
  const baseUrl = resolveProviderBaseUrl(provider);
  const chatModels = state.chatModels.filter((model) => model.providerId === provider.id).map(chatModelRow);
  const embeddingModels = state.embeddingModels
    .filter((model) => model.providerId === provider.id)
    .map(embeddingModelRow);
  const supportsEmbedding = presetSupportsEmbedding(provider.preset);
  const oauth = oauthPanelOf(provider, state, language);
  return {
    id: provider.id,
    preset: provider.preset,
    presetLabel: presetLabel(provider.preset),
    apiType: provider.apiType,
    apiTypeLabel: apiTypeLabel(provider.apiType, language),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    baseUrlIsDefault: !provider.baseUrl?.trim(),
    connection: connectionOf(provider, state, language),
    ...(oauth === undefined ? {} : { oauth }),
    chatModels,
    embeddingModels,
    supportsEmbedding,
    chatEmpty: text("settings.ai.models.chatEmpty", language),
    embeddingEmpty: supportsEmbedding
      ? text("settings.ai.models.embeddingEmpty", language)
      : text("settings.ai.models.embeddingUnsupported", language)
  };
}

/** Section copy plus one card per configured provider. */
export function buildAiProvidersView(state: AiSettingsState, language: string): AiProvidersView {
  return {
    heading: text("settings.ai.providers.heading", language),
    description: text("settings.ai.providers.desc", language),
    count: state.providers.length,
    countText: text("settings.ai.providers.count", language, { count: state.providers.length }),
    emptyText: text("settings.ai.providers.empty", language),
    addLabel: text("settings.ai.providers.add", language),
    supported: state.supported,
    ...(state.supported ? {} : { unsupportedText: text("settings.ai.providers.unsupported", language) }),
    cards: state.providers.map((provider) => buildProviderCard(provider, state, language))
  };
}

/** Category chips, `all` first, in the catalog's stable order. */
export function aiPickerCategories(language: string): AiPickerCategoryView[] {
  return [
    { id: "all", label: text("settings.ai.models.picker.category.all", language) },
    ...AI_PICKER_CATEGORIES.map((id) => ({ id, label: text(PICKER_CATEGORY_KEYS[id], language) }))
  ];
}

function pickerItem(preset: AiProviderPreset, language: string): AiPickerItemView {
  const custom = preset === "openai-compatible";
  return {
    preset,
    label: custom ? text("settings.ai.models.picker.custom", language) : presetLabel(preset),
    category: aiPresetInfo(preset).category,
    custom
  };
}

/** The whole picker catalog, including the custom tile at the end. */
export function aiPickerItems(language: string): AiPickerItemView[] {
  return allAiPresets().map((preset) => pickerItem(preset, language));
}

/**
 * Filter the picker by chip and free-text search.
 *
 * Search is case-insensitive and matches the visible label and the preset id,
 * so "gpt" finds ChatGPT OAuth and "openai-compatible" finds the custom tile.
 * The custom tile is a fallback action, not a catalog entry: it survives a
 * category filter but not a search that fails to match it.
 */
export function filterAiPickerItems(
  query: string,
  category: AiPickerFilter,
  language: string
): AiPickerItemView[] {
  const needle = query.trim().toLowerCase();
  return aiPickerItems(language).filter((item) => {
    if (!item.custom && category !== "all" && item.category !== category) return false;
    if (needle === "") return true;
    return item.label.toLowerCase().includes(needle) || item.preset.includes(needle);
  });
}

/**
 * Config id for a model pulled from a provider's catalog.
 *
 * The convention is `<provider>/<model>`. When that id is already taken (the
 * same model added twice under different display names, or a hand-written
 * config), a numeric suffix keeps the new row addressable instead of silently
 * overwriting the existing one. The caller passes every model id it already has
 * and grows that set as it batches, so two catalog entries cannot collide.
 */
export function modelConfigId(
  providerId: string,
  model: string,
  existingIds: Iterable<string>
): string {
  const base = `${providerId}/${model}`;
  // Always copy: the caller may hold a Set from another realm (a test sandbox),
  // where `instanceof Set` is false even though iteration works.
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Guess the reasoning protocol a model identifier belongs to.
 *
 * The catalog only returns names, so this is a deliberately small heuristic
 * matching the families the chat form knows: OpenAI-style reasoning models
 * (GPT, o3/o4 and DeepSeek's OpenAI-compatible API), Gemini and Claude.
 * Everything else stays `none` and the user can change it afterwards.
 */
export function inferReasoningType(modelId: string): AiReasoningType {
  const value = modelId.toLowerCase();
  if (
    value.includes("deepseek") ||
    value.includes("gpt") ||
    /(^|[^a-z0-9])o[34]([^a-z0-9]|$)/.test(value)
  ) {
    return "openai";
  }
  if (value.includes("gemini")) return "gemini";
  if (value.includes("claude")) return "anthropic";
  return "none";
}
