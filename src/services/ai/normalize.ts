/**
 * Normalization and validation for the model-provider settings.
 *
 * `data.json` is untrusted input: hand-edited files, older versions and sync
 * clients all reach this module. Every field is bounded, unknown enum values
 * fall back to a safe default, and one damaged provider/model never discards
 * the rest. Validation (for the forms) is separate from normalization (for
 * loading), so a form can explain a problem while loading stays forgiving.
 */
import {
  AI_API_TYPES,
  AI_PROVIDER_PRESETS,
  MAX_AI_CHAT_MODELS,
  MAX_AI_CONTEXT_TOKENS,
  MAX_AI_CUSTOM_HEADERS,
  MAX_AI_CUSTOM_PARAMETERS,
  MAX_AI_CUSTOM_PARAM_VALUE_LENGTH,
  MAX_AI_EMBEDDING_MODELS,
  MAX_AI_HEADER_KEY_LENGTH,
  MAX_AI_HEADER_VALUE_LENGTH,
  MAX_AI_ID_LENGTH,
  MAX_AI_MODEL_LENGTH,
  MAX_AI_NAME_LENGTH,
  MAX_AI_PROVIDERS,
  MAX_AI_SECRET_LENGTH,
  MAX_AI_URL_LENGTH,
  type AiApiType,
  type AiChatModelConfig,
  type AiCustomParameter,
  type AiCustomParameterType,
  type AiEmbeddingModelConfig,
  type AiProviderAdditionalSettings,
  type AiProviderConfig,
  type AiProviderHeader,
  type AiProviderPreset,
  type AiReasoningType,
  type AiResponseStreamingMode,
  type AiSettingsSnapshot,
  type AiValidationIssue,
  type AiValidationResult,
  type AiChatModality
} from "./contracts";
import {
  aiPresetInfo,
  defaultApiType,
  defaultBaseUrl,
  isAiApiType,
  isAiProviderPreset,
  supportedApiTypes
} from "./presets";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Model config ids conventionally carry a provider prefix (`openai/gpt-4.1`). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  const number = numberIn(value, min, max);
  return number === undefined ? undefined : Math.round(number);
}

function uniqueStrings<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: T[] = [];
  for (const item of value) {
    if (typeof item === "string" && (allowed as readonly string[]).includes(item) && !result.includes(item as T)) {
      result.push(item as T);
    }
  }
  return result.length > 0 ? result : undefined;
}

/** Only http(s) endpoints are accepted; credentials in the URL are refused. */
export function isSafeProviderUrl(value: string): boolean {
  if (!value || value.length > MAX_AI_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeProviderHeaders(value: unknown): AiProviderHeader[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: AiProviderHeader[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_AI_CUSTOM_HEADERS)) {
    const entry = record(item);
    if (!entry) continue;
    const key = text(entry["key"], MAX_AI_HEADER_KEY_LENGTH);
    const headerValue = optionalText(entry["value"], MAX_AI_HEADER_VALUE_LENGTH);
    if (!key || !HEADER_KEY_PATTERN.test(key) || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    result.push({ key, value: headerValue ?? "" });
  }
  return result.length > 0 ? result : undefined;
}

function normalizeCustomParameters(value: unknown): AiCustomParameter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: AiCustomParameter[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_AI_CUSTOM_PARAMETERS)) {
    const entry = record(item);
    if (!entry) continue;
    const key = text(entry["key"], MAX_AI_HEADER_KEY_LENGTH);
    const type = entry["type"];
    if (!key || seen.has(key)) continue;
    if (type !== "text" && type !== "number" && type !== "boolean" && type !== "json") continue;
    const raw = entry["value"];
    if (typeof raw !== "string" || raw.length > MAX_AI_CUSTOM_PARAM_VALUE_LENGTH) continue;
    seen.add(key);
    result.push({ key, type: type as AiCustomParameterType, value: raw });
  }
  return result.length > 0 ? result : undefined;
}

function normalizeAdditionalSettings(value: unknown): AiProviderAdditionalSettings | undefined {
  const recordValue = record(value);
  if (!recordValue) return undefined;
  const result: AiProviderAdditionalSettings = {};

  const transport = record(recordValue["requestTransportMode"]);
  if (transport) {
    const desktop = transport["desktop"];
    const mobile = transport["mobile"];
    const next: NonNullable<AiProviderAdditionalSettings["requestTransportMode"]> = {};
    if (desktop === "browser" || desktop === "obsidian" || desktop === "node") next.desktop = desktop;
    if (mobile === "browser" || mobile === "obsidian") next.mobile = mobile;
    if (next.desktop !== undefined || next.mobile !== undefined) result.requestTransportMode = next;
  }
  if (typeof recordValue["requestTransportMode"] === "string") {
    const legacy = recordValue["requestTransportMode"];
    if (legacy === "browser" || legacy === "obsidian" || legacy === "node") {
      result.requestTransportMode = { desktop: legacy, mobile: legacy === "node" ? "obsidian" : legacy };
    }
  }

  const streaming = recordValue["responseStreamingMode"];
  if (streaming === "auto" || streaming === "streaming" || streaming === "non-streaming") {
    result.responseStreamingMode = streaming as AiResponseStreamingMode;
  }
  for (const key of ["promptCaching", "noStainless"] as const) {
    if (typeof recordValue[key] === "boolean") result[key] = recordValue[key];
  }
  for (const key of ["projectId", "deployment", "apiVersion", "awsRegion", "oauthClientId"] as const) {
    const value = optionalText(recordValue[key], MAX_AI_NAME_LENGTH);
    if (value !== undefined) result[key] = value;
  }
  const secret = optionalText(recordValue["oauthClientSecret"], MAX_AI_SECRET_LENGTH);
  if (secret !== undefined) result.oauthClientSecret = secret;

  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeProvider(value: unknown): AiProviderConfig | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const id = text(entry["id"], MAX_AI_ID_LENGTH);
  if (!id || !ID_PATTERN.test(id)) return undefined;
  const preset = isAiProviderPreset(entry["preset"]) ? entry["preset"] : undefined;
  if (!preset) return undefined;
  const allowedApis = supportedApiTypes(preset);
  const apiType: AiApiType = isAiApiType(entry["apiType"]) && allowedApis.includes(entry["apiType"])
    ? entry["apiType"]
    : defaultApiType(preset);

  const baseUrl = optionalText(entry["baseUrl"], MAX_AI_URL_LENGTH);
  const apiKey = optionalText(entry["apiKey"], MAX_AI_SECRET_LENGTH);
  const additionalSettings = normalizeAdditionalSettings(entry["additionalSettings"]);
  const customHeaders = normalizeProviderHeaders(entry["customHeaders"]);
  return {
    id,
    preset,
    apiType,
    ...(baseUrl !== undefined && isSafeProviderUrl(baseUrl) ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(additionalSettings ? { additionalSettings } : {}),
    ...(customHeaders ? { customHeaders } : {})
  };
}

export function normalizeChatModel(value: unknown, providerIds: readonly string[]): AiChatModelConfig | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const providerId = text(entry["providerId"], MAX_AI_ID_LENGTH);
  const id = text(entry["id"], MAX_AI_ID_LENGTH);
  const model = text(entry["model"], MAX_AI_MODEL_LENGTH);
  if (!providerId || !id || !model || !providerIds.includes(providerId)) return undefined;

  const reasoning = entry["reasoningType"];
  const reasoningType: AiReasoningType | undefined =
    reasoning === "none" || reasoning === "openai" || reasoning === "gemini" || reasoning === "anthropic"
      ? reasoning
      : undefined;
  const modalities = uniqueStrings<AiChatModality>(entry["modalities"], ["text", "vision", "pdf"]);
  const customParameters = normalizeCustomParameters(entry["customParameters"]);
  const builtin = entry["builtinToolProvider"];
  const builtinToolProvider = builtin === "gemini" || builtin === "gpt" || builtin === "openrouter" ||
    builtin === "grok" || builtin === "deepseek" || builtin === "none"
    ? builtin
    : undefined;

  return {
    id,
    providerId,
    model,
    enable: typeof entry["enable"] === "boolean" ? entry["enable"] : true,
    ...(optionalText(entry["name"], MAX_AI_NAME_LENGTH) ? { name: optionalText(entry["name"], MAX_AI_NAME_LENGTH) } : {}),
    ...(reasoningType ? { reasoningType } : {}),
    ...(numberIn(entry["temperature"], 0, 2) !== undefined ? { temperature: numberIn(entry["temperature"], 0, 2) } : {}),
    ...(numberIn(entry["topP"], 0, 1) !== undefined ? { topP: numberIn(entry["topP"], 0, 1) } : {}),
    ...(integerIn(entry["maxContextTokens"], 1, MAX_AI_CONTEXT_TOKENS) !== undefined
      ? { maxContextTokens: integerIn(entry["maxContextTokens"], 1, MAX_AI_CONTEXT_TOKENS) }
      : {}),
    ...(integerIn(entry["maxOutputTokens"], 1, MAX_AI_CONTEXT_TOKENS) !== undefined
      ? { maxOutputTokens: integerIn(entry["maxOutputTokens"], 1, MAX_AI_CONTEXT_TOKENS) }
      : {}),
    ...(modalities ? { modalities } : {}),
    ...(customParameters ? { customParameters } : {}),
    ...(builtinToolProvider ? { builtinToolProvider } : {})
  };
}

export function normalizeEmbeddingModel(value: unknown, providerIds: readonly string[]): AiEmbeddingModelConfig | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const providerId = text(entry["providerId"], MAX_AI_ID_LENGTH);
  const id = text(entry["id"], MAX_AI_ID_LENGTH);
  const model = text(entry["model"], MAX_AI_MODEL_LENGTH);
  const dimension = integerIn(entry["dimension"], 1, 1_000_000);
  if (!providerId || !id || !model || dimension === undefined || !providerIds.includes(providerId)) {
    return undefined;
  }
  const name = optionalText(entry["name"], MAX_AI_NAME_LENGTH);
  return { id, providerId, model, dimension, ...(name ? { name } : {}) };
}

export function normalizeAiSettings(value: unknown): AiSettingsSnapshot {
  const root = record(value);
  const providers: AiProviderConfig[] = [];
  const providerIds = new Set<string>();
  if (Array.isArray(root?.["aiProviders"])) {
    for (const item of root["aiProviders"].slice(0, MAX_AI_PROVIDERS)) {
      const provider = normalizeProvider(item);
      if (!provider || providerIds.has(provider.id)) continue;
      providerIds.add(provider.id);
      providers.push(provider);
    }
  }

  const chatModels: AiChatModelConfig[] = [];
  const embeddingModels: AiEmbeddingModelConfig[] = [];
  const modelIds = new Set<string>();
  if (Array.isArray(root?.["aiChatModels"])) {
    for (const item of root["aiChatModels"].slice(0, MAX_AI_CHAT_MODELS)) {
      const model = normalizeChatModel(item, [...providerIds]);
      if (!model || modelIds.has(model.id)) continue;
      modelIds.add(model.id);
      chatModels.push(model);
    }
  }
  if (Array.isArray(root?.["aiEmbeddingModels"])) {
    for (const item of root["aiEmbeddingModels"].slice(0, MAX_AI_EMBEDDING_MODELS)) {
      const model = normalizeEmbeddingModel(item, [...providerIds]);
      if (!model || modelIds.has(model.id)) continue;
      modelIds.add(model.id);
      embeddingModels.push(model);
    }
  }
  return { providers, chatModels, embeddingModels };
}

export function suggestProviderId(preset: AiProviderPreset, existing: readonly AiProviderConfig[]): string {
  const base = aiPresetInfo(preset).defaultProviderId;
  if (!base) return "";
  const taken = new Set(existing.map((provider) => provider.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function createProviderDraft(preset: AiProviderPreset, existing: readonly AiProviderConfig[]): AiProviderConfig {
  return {
    id: suggestProviderId(preset, existing),
    preset,
    apiType: defaultApiType(preset),
    ...(defaultBaseUrl(preset) ? { baseUrl: defaultBaseUrl(preset) } : {})
  };
}

export function createChatModelDraft(providerId: string): AiChatModelConfig {
  return { id: "", providerId, model: "", enable: true, modalities: ["text"] };
}

export function createEmbeddingModelDraft(providerId: string): AiEmbeddingModelConfig {
  return { id: "", providerId, model: "", dimension: 1536 };
}

export function modelName(model: AiChatModelConfig | AiEmbeddingModelConfig): string {
  return model.name || model.model || model.id;
}

export function validateProvider(
  input: AiProviderConfig,
  existing: readonly AiProviderConfig[],
  previousId?: string
): AiValidationResult<AiProviderConfig> {
  const issues: AiValidationIssue[] = [];
  const id = input.id.trim();
  if (!id) issues.push({ code: "provider-id-required", field: "id" });
  else if (!ID_PATTERN.test(id) || id.length > MAX_AI_ID_LENGTH) issues.push({ code: "provider-id-invalid", field: "id" });
  else if (existing.some((provider) => provider.id === id && provider.id !== previousId)) {
    issues.push({ code: "provider-id-duplicate", field: "id" });
  }

  const info = aiPresetInfo(input.preset);
  // Gemini OAuth runs through a client owned by the user, so the provider must
  // carry both halves; the form renders the fields from the preset definition.
  if (info.oauth === "gemini"
    && (!input.additionalSettings?.oauthClientId?.trim()
      || !input.additionalSettings?.oauthClientSecret?.trim())) {
    issues.push({ code: "provider-oauth-client-required", field: "oauthClientId" });
  }
  if (info.requireApiKey && !input.apiKey?.trim()) issues.push({ code: "provider-api-key-required", field: "apiKey" });
  const baseUrl = input.baseUrl?.trim();
  if (info.requireBaseUrl && !baseUrl) issues.push({ code: "provider-base-url-required", field: "baseUrl" });
  if (baseUrl && !isSafeProviderUrl(baseUrl)) issues.push({ code: "provider-base-url-invalid", field: "baseUrl" });

  for (const setting of info.additionalSettings) {
    if (setting.required && !input.additionalSettings?.[setting.key]
      && setting.key !== "oauthClientId" && setting.key !== "oauthClientSecret") {
      issues.push({ code: "model-parameter-invalid", field: setting.key });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...input,
      id,
      ...(baseUrl ? { baseUrl } : {})
    }
  };
}

export function validateChatModel(
  input: AiChatModelConfig,
  existing: readonly AiChatModelConfig[],
  providerIds: readonly string[],
  previousId?: string
): AiValidationResult<AiChatModelConfig> {
  const issues: AiValidationIssue[] = [];
  const id = input.id.trim();
  const model = input.model.trim();
  if (!id) issues.push({ code: "model-id-required", field: "id" });
  else if (!MODEL_ID_PATTERN.test(id) || id.length > MAX_AI_ID_LENGTH) issues.push({ code: "model-id-required", field: "id" });
  else if (existing.some((entry) => entry.id === id && entry.id !== previousId)) {
    issues.push({ code: "model-id-duplicate", field: "id" });
  }
  if (!model) issues.push({ code: "model-name-required", field: "model" });
  if (!providerIds.includes(input.providerId)) issues.push({ code: "model-parameter-invalid", field: "providerId" });
  for (const [field, value] of [
    ["temperature", input.temperature],
    ["topP", input.topP],
    ["maxContextTokens", input.maxContextTokens],
    ["maxOutputTokens", input.maxOutputTokens]
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      issues.push({ code: "model-number-invalid", field });
    }
  }
  if (input.temperature !== undefined && input.temperature > 2) issues.push({ code: "model-number-invalid", field: "temperature" });
  if (input.topP !== undefined && input.topP > 1) issues.push({ code: "model-number-invalid", field: "topP" });
  for (const parameter of input.customParameters ?? []) {
    if (!parameter.key || !HEADER_KEY_PATTERN.test(parameter.key)) {
      issues.push({ code: "model-parameter-invalid", field: "customParameters" });
      break;
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...input, id, model } };
}

export function validateEmbeddingModel(
  input: AiEmbeddingModelConfig,
  existing: readonly AiEmbeddingModelConfig[],
  providerIds: readonly string[],
  previousId?: string
): AiValidationResult<AiEmbeddingModelConfig> {
  const issues: AiValidationIssue[] = [];
  const id = input.id.trim();
  const model = input.model.trim();
  if (!id) issues.push({ code: "model-id-required", field: "id" });
  else if (!MODEL_ID_PATTERN.test(id) || id.length > MAX_AI_ID_LENGTH) issues.push({ code: "model-id-required", field: "id" });
  else if (existing.some((entry) => entry.id === id && entry.id !== previousId)) {
    issues.push({ code: "model-id-duplicate", field: "id" });
  }
  if (!model) issues.push({ code: "model-name-required", field: "model" });
  if (!providerIds.includes(input.providerId)) issues.push({ code: "model-parameter-invalid", field: "providerId" });
  if (!Number.isInteger(input.dimension) || input.dimension <= 0) {
    issues.push({ code: "model-number-invalid", field: "dimension" });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...input, id, model } };
}

export function resolveProviderBaseUrl(provider: Pick<AiProviderConfig, "preset" | "apiType" | "baseUrl">): string | undefined {
  const custom = provider.baseUrl?.trim().replace(/\/+$/, "");
  if (custom) return custom;
  if (provider.preset === "amazon-bedrock" && provider.apiType === "amazon-bedrock") return undefined;
  return defaultBaseUrl(provider.preset);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The URL a connectivity test would call, for the form's preview line. */
export function resolvePrimaryRequestUrl(provider: Pick<AiProviderConfig, "preset" | "apiType" | "baseUrl" | "additionalSettings">): string | undefined {
  const base = resolveProviderBaseUrl(provider);
  if (!base) return undefined;
  switch (provider.apiType) {
    case "openai-compatible": {
      const normalized = provider.preset === "ollama" || provider.preset === "lm-studio" || provider.preset === "morph"
        ? joinUrl(base, "v1")
        : base;
      return joinUrl(normalized, "chat/completions");
    }
    case "openai-responses":
      return joinUrl(base, "responses");
    case "anthropic": {
      const root = base.replace(/\/+$/, "").replace(/\/v1$/, "");
      return joinUrl(root, "v1/messages");
    }
    case "gemini":
      return joinUrl(base.replace(/\/+$/, "").replace(/\/v1beta$/, ""), "v1beta/models/{model}:streamGenerateContent");
    case "amazon-bedrock":
      return undefined;
  }
}

/** Headers shared by every request; never include a key in a URL. */
export function providerHeaders(provider: AiProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of provider.customHeaders ?? []) headers[header.key] = header.value;
  if (provider.preset === "openai" || provider.preset === "chatgpt-oauth" || provider.apiType === "openai-compatible") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  return headers;
}

export function transportMode(provider: AiProviderConfig, isDesktop: boolean): "browser" | "obsidian" | "node" {
  const preference = provider.additionalSettings?.requestTransportMode;
  const selected = isDesktop ? preference?.desktop : preference?.mobile;
  if (selected === "obsidian" || selected === "browser") return selected;
  if (selected === "node") return isDesktop ? "node" : "browser";
  return isDesktop ? "node" : "browser";
}

export { AI_API_TYPES, AI_PROVIDER_PRESETS };
