/**
 * The provider catalog and its defaults.
 *
 * The shape follows obsidian-yolo's provider presets so the AI tab offers the
 * same choices. Labels are product names, not translatable UI copy; everything
 * around them (field labels, categories, explanations) is i18n.
 */
import {
  AI_API_TYPES,
  type AiAdditionalSettingKey,
  type AiApiType,
  type AiPickerCategory,
  type AiProviderPreset
} from "./contracts";

export interface AiAdditionalSettingDef {
  key: AiAdditionalSettingKey;
  type: "text" | "toggle" | "select";
  required?: boolean;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
}

export interface AiPresetInfo {
  readonly label: string;
  readonly category: AiPickerCategory;
  readonly defaultProviderId: string | null;
  readonly requireApiKey: boolean;
  readonly requireBaseUrl: boolean;
  readonly supportEmbedding: boolean;
  /** Non-null means the preset authenticates through an OAuth flow. */
  readonly oauth: "chatgpt" | "gemini" | "claude" | "copilot" | null;
  readonly defaultApiType: AiApiType;
  readonly supportedApiTypes: readonly AiApiType[];
  readonly additionalSettings: readonly AiAdditionalSettingDef[];
  /** Where a key can be created, when the provider has a known console URL. */
  readonly apiKeyUrl?: string;
}

const TRANSPORT: AiAdditionalSettingDef = {
  key: "requestTransportMode",
  type: "select",
  options: [
    { value: "browser", label: "Browser request" },
    { value: "obsidian", label: "Obsidian request" },
    { value: "node", label: "Desktop direct" }
  ]
};

const STREAMING: AiAdditionalSettingDef = {
  key: "responseStreamingMode",
  type: "select",
  options: [
    { value: "auto", label: "Auto" },
    { value: "streaming", label: "Streaming" },
    { value: "non-streaming", label: "Non-streaming" }
  ]
};

const PROMPT_CACHING: AiAdditionalSettingDef = {
  key: "promptCaching",
  type: "toggle"
};

const NO_STAINLESS: AiAdditionalSettingDef = {
  key: "noStainless",
  type: "toggle"
};

/** Gemini OAuth uses a Google OAuth client supplied by the user (see oauth.ts). */
const OAUTH_CLIENT_ID: AiAdditionalSettingDef = {
  key: "oauthClientId",
  type: "text",
  required: true,
  placeholder: "1234567890-abc.apps.googleusercontent.com"
};

const OAUTH_CLIENT_SECRET: AiAdditionalSettingDef = {
  key: "oauthClientSecret",
  type: "text",
  required: true
};

const COMMON: readonly AiAdditionalSettingDef[] = [TRANSPORT, STREAMING];

const ALL_APIS: readonly AiApiType[] = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
  "gemini"
];

/** Presets that answer through OpenAI-compatible, Anthropic and Gemini APIs. */
const FLEXIBLE_APIS: readonly AiApiType[] = ALL_APIS;

/** Only the provider's own protocol plus the OpenAI-compatible fallback. */
const DUAL_APIS = (native: AiApiType): readonly AiApiType[] => [native, "openai-compatible"];

let cache: Record<AiProviderPreset, AiPresetInfo> | undefined;

/** All preset metadata, keyed by preset. Static and frozen after first use. */
export function aiPresetInfo(preset: AiProviderPreset): AiPresetInfo {
  cache ??= buildCatalog();
  return cache[preset];
}

export function allAiPresets(): readonly AiProviderPreset[] {
  cache ??= buildCatalog();
  return Object.keys(cache) as AiProviderPreset[];
}

export function aiPresetLabel(preset: AiProviderPreset): string {
  return aiPresetInfo(preset).label;
}

export function defaultApiType(preset: AiProviderPreset): AiApiType {
  return aiPresetInfo(preset).defaultApiType;
}

export function supportedApiTypes(preset: AiProviderPreset): readonly AiApiType[] {
  return aiPresetInfo(preset).supportedApiTypes;
}

export function presetSupportsEmbedding(preset: AiProviderPreset): boolean {
  return aiPresetInfo(preset).supportEmbedding;
}

export function defaultBaseUrl(preset: AiProviderPreset): string | undefined {
  return DEFAULT_BASE_URLS[preset];
}

export function presetOAuth(preset: AiProviderPreset): AiPresetInfo["oauth"] {
  return aiPresetInfo(preset).oauth;
}

/** Whether the provider needs an API key to make a request. */
export function presetRequiresApiKey(preset: AiProviderPreset): boolean {
  return aiPresetInfo(preset).requireApiKey;
}

const DEFAULT_BASE_URLS: Partial<Record<AiProviderPreset, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  fluxion: "https://sidrune.ai",
  ollama: "http://127.0.0.1:11434",
  "lm-studio": "http://127.0.0.1:1234",
  moonshot: "https://api.moonshot.cn/v1",
  perplexity: "https://api.perplexity.ai",
  mistral: "https://api.mistral.ai/v1",
  morph: "https://api.morphllm.com",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  siliconflow: "https://api.siliconflow.cn/v1",
  stepfun: "https://api.stepfun.com/v1",
  minimax: "https://api.minimax.chat/v1",
  hunyuan: "https://api.hunyuan.cloud.tencent.com/v1",
  xai: "https://api.x.ai/v1",
  "together-ai": "https://api.together.xyz/v1",
  cerebras: "https://api.cerebras.ai/v1",
  sambanova: "https://api.sambanova.ai/v1",
  xiaomimimo: "https://api.xiaomimimo.com/v1"
};

function buildCatalog(): Record<AiProviderPreset, AiPresetInfo> {
  const make = (
    label: string,
    category: AiPickerCategory,
    extra: Partial<AiPresetInfo> & Pick<AiPresetInfo, "defaultApiType" | "supportedApiTypes">
  ): AiPresetInfo => ({
    label,
    category,
    defaultProviderId: null,
    requireApiKey: true,
    requireBaseUrl: false,
    supportEmbedding: false,
    oauth: null,
    additionalSettings: COMMON,
    ...extra
  });

  return {
    openai: make("OpenAI", "main", {
      defaultProviderId: "openai",
      defaultApiType: "openai-responses",
      supportedApiTypes: FLEXIBLE_APIS,
      supportEmbedding: true,
      apiKeyUrl: "https://platform.openai.com/api-keys"
    }),
    "chatgpt-oauth": make("ChatGPT OAuth", "main", {
      defaultProviderId: "chatgpt-oauth",
      oauth: "chatgpt",
      requireApiKey: false,
      defaultApiType: "openai-responses",
      supportedApiTypes: ["openai-responses"]
    }),
    anthropic: make("Anthropic", "main", {
      defaultProviderId: "anthropic",
      defaultApiType: "anthropic",
      supportedApiTypes: DUAL_APIS("anthropic"),
      additionalSettings: [PROMPT_CACHING, TRANSPORT, STREAMING],
      apiKeyUrl: "https://console.anthropic.com/settings/keys"
    }),
    "claude-oauth": make("Claude OAuth", "main", {
      defaultProviderId: "claude-oauth",
      oauth: "claude",
      requireApiKey: false,
      defaultApiType: "anthropic",
      supportedApiTypes: ["anthropic"],
      additionalSettings: []
    }),
    gemini: make("Gemini", "main", {
      defaultProviderId: "gemini",
      defaultApiType: "gemini",
      supportedApiTypes: DUAL_APIS("gemini"),
      supportEmbedding: true,
      apiKeyUrl: "https://aistudio.google.com/apikey"
    }),
    "gemini-oauth": make("Gemini OAuth", "main", {
      defaultProviderId: "gemini-oauth",
      oauth: "gemini",
      requireApiKey: false,
      defaultApiType: "gemini",
      supportedApiTypes: ["gemini"],
      additionalSettings: [
        OAUTH_CLIENT_ID,
        OAUTH_CLIENT_SECRET,
        {
          key: "projectId",
          type: "text",
          placeholder: "my-gcp-project-id"
        },
        TRANSPORT,
        STREAMING
      ]
    }),
    "github-copilot": make("GitHub Copilot", "main", {
      defaultProviderId: "github-copilot",
      oauth: "copilot",
      requireApiKey: false,
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    openrouter: make("OpenRouter", "gw", {
      defaultProviderId: "openrouter",
      defaultApiType: "openai-compatible",
      supportedApiTypes: FLEXIBLE_APIS,
      supportEmbedding: true,
      apiKeyUrl: "https://openrouter.ai/keys"
    }),
    fluxion: make("Sidrune AI", "gw", {
      defaultProviderId: "fluxion",
      defaultApiType: "anthropic",
      supportedApiTypes: FLEXIBLE_APIS
    }),
    xai: make("xAI", "main", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: FLEXIBLE_APIS,
      apiKeyUrl: "https://console.x.ai"
    }),
    mistral: make("Mistral", "main", {
      defaultProviderId: "mistral",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ALL_APIS,
      apiKeyUrl: "https://console.mistral.ai/api-keys"
    }),
    perplexity: make("Perplexity", "main", {
      defaultProviderId: "perplexity",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    groq: make("Groq", "main", {
      defaultProviderId: "groq",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      apiKeyUrl: "https://console.groq.com/keys"
    }),
    cerebras: make("Cerebras", "main", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    sambanova: make("SambaNova", "main", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    "together-ai": make("Together AI", "main", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true,
      apiKeyUrl: "https://api.together.xyz/settings/api-keys"
    }),
    morph: make("Morph", "main", {
      defaultProviderId: "morph",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    deepseek: make("DeepSeek", "cn", {
      defaultProviderId: "deepseek",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible", "anthropic", "openai-responses"],
      apiKeyUrl: "https://platform.deepseek.com/api_keys"
    }),
    moonshot: make("Moonshot", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible", "anthropic"],
      apiKeyUrl: "https://platform.moonshot.cn/console/api-keys"
    }),
    zhipu: make("Zhipu", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible", "anthropic"],
      supportEmbedding: true
    }),
    doubao: make("Doubao", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true
    }),
    siliconflow: make("SiliconFlow", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true
    }),
    stepfun: make("StepFun", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    minimax: make("MiniMax", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true
    }),
    hunyuan: make("Hunyuan", "cn", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    xiaomimimo: make("Xiaomi MiMo", "cn", {
      defaultProviderId: "xiaomimimo",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"]
    }),
    "azure-openai": make("Azure OpenAI", "cloud", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      requireBaseUrl: true,
      additionalSettings: [
        { key: "deployment", type: "text", required: true },
        { key: "apiVersion", type: "text", required: true },
        TRANSPORT,
        STREAMING
      ]
    }),
    "amazon-bedrock": make("Amazon Bedrock", "cloud", {
      defaultApiType: "amazon-bedrock",
      supportedApiTypes: ["amazon-bedrock", "openai-compatible"],
      supportEmbedding: true,
      additionalSettings: [
        { key: "awsRegion", type: "text", required: true },
        TRANSPORT,
        STREAMING
      ]
    }),
    ollama: make("Ollama", "local", {
      defaultProviderId: "ollama",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true,
      requireApiKey: false
    }),
    "lm-studio": make("LM Studio", "local", {
      defaultProviderId: "lm-studio",
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true,
      requireApiKey: false
    }),
    "openai-compatible": make("Custom provider", "main", {
      defaultApiType: "openai-compatible",
      supportedApiTypes: ["openai-compatible"],
      supportEmbedding: true,
      requireApiKey: false,
      requireBaseUrl: true,
      additionalSettings: [NO_STAINLESS, TRANSPORT, STREAMING]
    })
  };
}

export function isAiProviderPreset(value: unknown): value is AiProviderPreset {
  return typeof value === "string" && allAiPresets().includes(value as AiProviderPreset);
}

export function isAiApiType(value: unknown): value is AiApiType {
  return typeof value === "string" && (AI_API_TYPES as readonly string[]).includes(value);
}
