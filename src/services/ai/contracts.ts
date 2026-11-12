/**
 * The settings model for external model providers.
 *
 * This module is pure data: it defines what the AI tab can configure and what
 * the plugin persists. It deliberately contains no network or Obsidian code —
 * provider presets, normalization and validation live beside it, while the
 * Obsidian-facing host wiring lives in `src/main.ts`.
 *
 * Nothing here decides which model to run: the plugin has no chat surface yet,
 * so the settings are the entire product contract for now.
 */

/** Every provider preset the picker offers, in stable declaration order. */
export const AI_PROVIDER_PRESETS = [
  "openai",
  "chatgpt-oauth",
  "anthropic",
  "claude-oauth",
  "gemini",
  "gemini-oauth",
  "github-copilot",
  "openrouter",
  "fluxion",
  "xai",
  "mistral",
  "perplexity",
  "groq",
  "cerebras",
  "sambanova",
  "together-ai",
  "morph",
  "deepseek",
  "moonshot",
  "zhipu",
  "doubao",
  "siliconflow",
  "stepfun",
  "minimax",
  "hunyuan",
  "xiaomimimo",
  "azure-openai",
  "amazon-bedrock",
  "ollama",
  "lm-studio",
  "openai-compatible"
] as const;

export type AiProviderPreset = (typeof AI_PROVIDER_PRESETS)[number];

export const AI_API_TYPES = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
  "gemini",
  "amazon-bedrock"
] as const;

export type AiApiType = (typeof AI_API_TYPES)[number];

export const AI_PICKER_CATEGORIES = ["main", "cn", "gw", "cloud", "local"] as const;

export type AiPickerCategory = (typeof AI_PICKER_CATEGORIES)[number];

export type AiRequestTransportMode = "browser" | "obsidian" | "node";

export type AiResponseStreamingMode = "auto" | "streaming" | "non-streaming";

export type AiChatModality = "text" | "vision" | "pdf";

export type AiReasoningType = "none" | "openai" | "gemini" | "anthropic";

export type AiBuiltinToolProvider = "none" | "gemini" | "gpt" | "openrouter" | "grok" | "deepseek";

export interface AiProviderHeader {
  key: string;
  value: string;
}

export type AiCustomParameterType = "text" | "number" | "boolean" | "json";

export interface AiCustomParameter {
  key: string;
  type: AiCustomParameterType;
  value: string;
}

/** Per-platform transport preference, mirroring YOLO's shape. */
export interface AiTransportPreference {
  desktop?: AiRequestTransportMode;
  mobile?: Extract<AiRequestTransportMode, "browser" | "obsidian">;
}

/** Free-form provider options; each preset documents which keys it reads. */
export type AiAdditionalSettingKey =
  | "requestTransportMode"
  | "responseStreamingMode"
  | "promptCaching"
  | "noStainless"
  | "projectId"
  | "deployment"
  | "apiVersion"
  | "awsRegion"
  | "oauthClientId"
  | "oauthClientSecret";

export interface AiProviderAdditionalSettings {
  requestTransportMode?: AiTransportPreference;
  responseStreamingMode?: AiResponseStreamingMode;
  promptCaching?: boolean;
  noStainless?: boolean;
  projectId?: string;
  deployment?: string;
  apiVersion?: string;
  awsRegion?: string;
  /** OAuth app credentials; empty means "this device has none configured". */
  oauthClientId?: string;
  oauthClientSecret?: string;
}

export interface AiProviderConfig {
  id: string;
  preset: AiProviderPreset;
  apiType: AiApiType;
  baseUrl?: string;
  apiKey?: string;
  additionalSettings?: AiProviderAdditionalSettings;
  customHeaders?: AiProviderHeader[];
}

export interface AiChatModelConfig {
  id: string;
  providerId: string;
  model: string;
  name?: string;
  enable: boolean;
  reasoningType?: AiReasoningType;
  temperature?: number;
  topP?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  modalities?: AiChatModality[];
  customParameters?: AiCustomParameter[];
  builtinToolProvider?: AiBuiltinToolProvider;
}

export interface AiEmbeddingModelConfig {
  id: string;
  providerId: string;
  model: string;
  name?: string;
  dimension: number;
}

export interface AiSettingsSnapshot {
  providers: AiProviderConfig[];
  chatModels: AiChatModelConfig[];
  embeddingModels: AiEmbeddingModelConfig[];
}

/** Result of an explicit connectivity test, surfaced in the provider card. */
export interface AiTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  message?: string;
}

export type AiOAuthStatus =
  | { state: "disconnected" }
  | { state: "connected"; account?: string; expiresAt?: number }
  | { state: "pending"; userCode: string; verificationUri: string }
  | { state: "error"; message: string };

/** A credential that lives in device-local storage, never in `data.json`. */
export interface AiOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  email?: string;
  projectId?: string;
  managedProjectId?: string;
  copilotToken?: string;
  copilotExpiresAt?: number;
  copilotApiBaseUrl?: string;
  updatedAt: number;
}

export interface AiConnectStart {
  mode: "device" | "browser" | "manual";
  userCode?: string;
  verificationUri?: string;
  intervalMs?: number;
}

export interface AiOAuthAuthorization {
  /** Device flow fields, supplied by the caller after `begin` showed them. */
  deviceCode?: string;
  intervalMs?: number;
  /** Browser flow fields, supplied by the caller after the redirect fired. */
  code?: string;
  codeVerifier?: string;
}

/** What the settings page sees; already resolved by the host. */
export interface AiSettingsState extends AiSettingsSnapshot {
  supported: boolean;
  isDesktop: boolean;
  oauth: Record<string, AiOAuthStatus>;
}

export type AiValidationCode =
  | "provider-id-required"
  | "provider-id-invalid"
  | "provider-id-duplicate"
  | "provider-api-key-required"
  | "provider-base-url-required"
  | "provider-base-url-invalid"
  | "provider-oauth-client-required"
  | "model-id-required"
  | "model-id-duplicate"
  | "model-name-required"
  | "model-number-invalid"
  | "model-parameter-invalid";

export interface AiValidationIssue {
  code: AiValidationCode;
  field?: string;
}

export type AiValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: AiValidationIssue[] };

export interface AiSettingsPagePort {
  state(): AiSettingsState;
  addProvider(input: AiProviderConfig): Promise<AiValidationResult<AiProviderConfig>>;
  updateProvider(previousId: string, input: AiProviderConfig): Promise<AiValidationResult<AiProviderConfig>>;
  deleteProvider(providerId: string): Promise<void>;
  addChatModel(input: AiChatModelConfig): Promise<AiValidationResult<AiChatModelConfig>>;
  updateChatModel(previousId: string, input: AiChatModelConfig): Promise<AiValidationResult<AiChatModelConfig>>;
  deleteChatModel(modelId: string): Promise<void>;
  setChatModelEnabled(modelId: string, enabled: boolean): Promise<void>;
  addEmbeddingModel(input: AiEmbeddingModelConfig): Promise<AiValidationResult<AiEmbeddingModelConfig>>;
  updateEmbeddingModel(previousId: string, input: AiEmbeddingModelConfig): Promise<AiValidationResult<AiEmbeddingModelConfig>>;
  deleteEmbeddingModel(modelId: string): Promise<void>;
  testChatModel(modelId: string): Promise<AiTestResult>;
  testEmbeddingModel(modelId: string): Promise<AiTestResult>;
  oauthStatus(providerId: string): AiOAuthStatus;
  oauthBegin(providerId: string): Promise<AiConnectStart>;
  oauthComplete(providerId: string, authorization: AiOAuthAuthorization): Promise<AiOAuthStatus>;
  oauthCancel(providerId: string): void;
  oauthDisconnect(providerId: string): Promise<void>;
  /** Manual token entry (Claude / any OAuth provider that hands out tokens). */
  oauthSaveManualToken(providerId: string, token: string): Promise<AiOAuthStatus>;
}

/** A platform that cannot host the settings still needs a typed empty port. */
export function unsupportedAiSettingsPort(): AiSettingsPagePort {
  const refuse = async <T>(): Promise<AiValidationResult<T>> =>
    ({ ok: false, issues: [{ code: "provider-id-required" }] });
  const test = async (): Promise<AiTestResult> => ({ ok: false, message: "unsupported" });
  return {
    state: () => ({
      supported: false,
      isDesktop: false,
      providers: [],
      chatModels: [],
      embeddingModels: [],
      oauth: {}
    }),
    addProvider: refuse,
    updateProvider: refuse,
    deleteProvider: async () => undefined,
    addChatModel: refuse,
    updateChatModel: refuse,
    deleteChatModel: async () => undefined,
    setChatModelEnabled: async () => undefined,
    addEmbeddingModel: refuse,
    updateEmbeddingModel: refuse,
    deleteEmbeddingModel: async () => undefined,
    testChatModel: test,
    testEmbeddingModel: test,
    oauthStatus: () => ({ state: "disconnected" }),
    oauthBegin: async () => ({ mode: "manual" }),
    oauthComplete: async () => ({ state: "disconnected" }),
    oauthCancel: () => undefined,
    oauthDisconnect: async () => undefined,
    oauthSaveManualToken: async () => ({ state: "disconnected" })
  };
}

/** Hard caps that keep `data.json` and the rendered list bounded. */
export const MAX_AI_PROVIDERS = 64;
export const MAX_AI_CHAT_MODELS = 512;
export const MAX_AI_EMBEDDING_MODELS = 128;
export const MAX_AI_CUSTOM_HEADERS = 32;
export const MAX_AI_CUSTOM_PARAMETERS = 64;
export const MAX_AI_ID_LENGTH = 96;
export const MAX_AI_NAME_LENGTH = 160;
export const MAX_AI_MODEL_LENGTH = 256;
export const MAX_AI_URL_LENGTH = 2_048;
export const MAX_AI_SECRET_LENGTH = 8_192;
export const MAX_AI_HEADER_KEY_LENGTH = 256;
export const MAX_AI_HEADER_VALUE_LENGTH = 2_048;
export const MAX_AI_CUSTOM_PARAM_VALUE_LENGTH = 4_096;
export const MAX_AI_CONTEXT_TOKENS = 10_000_000;
