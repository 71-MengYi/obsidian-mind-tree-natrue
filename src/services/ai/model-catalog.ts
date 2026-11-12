/**
 * Discovery of the chat-model ids a provider currently serves.
 *
 * The settings page offers a "fetch models" action so users do not have to
 * type ids from memory. Discovery is best-effort by design: providers expose
 * the catalog differently (and some not at all), so every failure path returns
 * a built-in fallback list plus a diagnostic message instead of throwing. The
 * UI can therefore stay a plain list/select.
 *
 * Everything goes through the injected `AiHttpPort`; this module never imports
 * Obsidian and makes no network request on its own.
 *
 * The endpoint shapes and fallback ids are ported from obsidian-yolo (MIT).
 */
import {
  type AiOAuthCredential,
  type AiProviderConfig,
  type AiRemoteModelList
} from "./contracts";
import { providerHeaders, resolveProviderBaseUrl } from "./normalize";
import { presetOAuth, presetRequiresApiKey } from "./presets";
import type { AiHttpPort, AiHttpResponse } from "./oauth";

export interface FetchChatModelIdsOptions {
  /** Per-request budget; defaults to 10 seconds. */
  timeoutMs?: number;
}

export const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 10_000;

/** Codex ids that work even when the account catalog cannot be read. */
export const CHATGPT_FALLBACK_MODELS: readonly string[] = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini"
];

/** Stable Gemini chat ids; also what a failed OAuth discovery falls back to. */
export const GEMINI_FALLBACK_MODELS: readonly string[] = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash"
];

/** Copilot's only universally available model id (routing by plan). */
export const COPILOT_FALLBACK_MODELS: readonly string[] = ["auto"];

/** Claude Code aliases that stay valid across account catalog changes. */
export const CLAUDE_FALLBACK_MODELS: readonly string[] = [
  "claude-sonnet-4-0",
  "claude-3-7-sonnet-latest",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest"
];

const CHATGPT_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const UNSUPPORTED_MESSAGE = "unsupported";
const ID_KEYS = ["id", "name", "model", "slug"] as const;

/**
 * Editor identification headers GitHub expects from a Copilot client. Kept in
 * sync with `connectivity.ts` and the OAuth exchange.
 */
const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "vscode/1.120.0",
  "Editor-Plugin-Version": "copilot-chat/0.70.0",
  "User-Agent": "GitHubCopilotChat/0.70.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2026-08-01"
};

interface CandidateRequest {
  url: string;
  headers: Record<string, string>;
}

interface AttemptResult {
  models: string[];
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function stripVersionSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function fallback(models: readonly string[], message: string): AiRemoteModelList {
  return { models: [...models], source: "fallback", message };
}

function remote(models: readonly string[]): AiRemoteModelList {
  return { models: [...models], source: "remote" };
}

function dedupeSorted(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") unique.add(trimmed);
  }
  return [...unique].sort();
}

function isUnsupportedProvider(provider: AiProviderConfig): boolean {
  return provider.preset === "azure-openai" ||
    provider.preset === "amazon-bedrock" ||
    provider.apiType === "amazon-bedrock";
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                            */
/* -------------------------------------------------------------------------- */

function collectEntryIdentifiers(entries: readonly unknown[]): string[] {
  const values: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      values.push(entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    for (const key of ID_KEYS) {
      const value = textValue(entry[key]);
      if (value) {
        values.push(value);
        break;
      }
    }
  }
  return values;
}

/**
 * OpenAI-compatible / Anthropic / Copilot shape: `{ data: [{ id }] }`,
 * `{ models: [{ id }] }`, or a bare array of ids/objects.
 */
function parseModelIdentifiers(json: unknown): string[] {
  if (Array.isArray(json)) return dedupeSorted(collectEntryIdentifiers(json));
  if (!isRecord(json)) return [];
  const values: string[] = [];
  for (const key of ["data", "models"]) {
    const list = json[key];
    if (Array.isArray(list)) values.push(...collectEntryIdentifiers(list));
  }
  return dedupeSorted(values);
}

/** Gemini lists `{ models: [{ name: "models/gemini-2.5-pro" }] }`. */
function parseGeminiIdentifiers(json: unknown): string[] {
  const entries = Array.isArray(json)
    ? json
    : isRecord(json) && Array.isArray(json["models"])
      ? json["models"]
      : [];
  const values: string[] = [];
  for (const entry of entries) {
    let raw: string | undefined;
    if (typeof entry === "string") {
      raw = entry;
    } else if (isRecord(entry)) {
      raw = textValue(entry["name"]) ?? textValue(entry["id"]) ?? textValue(entry["model"]);
    }
    if (!raw) continue;
    const stripped = raw.replace(/^models\//, "").trim();
    if (!stripped || !stripped.toLowerCase().includes("gemini")) continue;
    values.push(stripped);
  }
  return dedupeSorted(values);
}

function readJson(response: AiHttpResponse): unknown {
  if (response.json !== undefined) return response.json;
  if (typeof response.text !== "string" || response.text.trim() === "") return undefined;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP plumbing                                                               */
/* -------------------------------------------------------------------------- */

async function requestWithTimeout(
  http: AiHttpPort,
  request: CandidateRequest,
  options: FetchChatModelIdsOptions
): Promise<{ response?: AiHttpResponse; error?: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_CATALOG_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race<AiHttpResponse | "timeout">([
      http.request({ url: request.url, method: "GET", headers: request.headers }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);
    if (outcome === "timeout") {
      return { error: `Request timed out after ${timeoutMs}ms.` };
    }
    return { response: outcome };
  } catch (error) {
    return { error: describeError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Tries each candidate URL in order. A non-2xx response, a network error, an
 * unreadable body or an empty catalog moves on to the next candidate.
 */
async function tryCandidates(
  http: AiHttpPort,
  candidates: readonly CandidateRequest[],
  parse: (json: unknown) => string[],
  options: FetchChatModelIdsOptions
): Promise<AttemptResult> {
  let lastMessage = "No model catalog endpoint answered.";
  for (const candidate of candidates) {
    const outcome = await requestWithTimeout(http, candidate, options);
    if (outcome.error !== undefined) {
      lastMessage = outcome.error;
      continue;
    }
    const response = outcome.response;
    if (!response) {
      lastMessage = "No response received.";
      continue;
    }
    if (!isSuccess(response.status)) {
      lastMessage = `HTTP ${response.status}`;
      continue;
    }
    const json = readJson(response);
    if (json === undefined) {
      lastMessage = "The model catalog response was not valid JSON.";
      continue;
    }
    const models = parse(json);
    if (models.length === 0) {
      lastMessage = "The model catalog response contained no models.";
      continue;
    }
    return { models };
  }
  return { models: [], message: lastMessage };
}

/* -------------------------------------------------------------------------- */
/* Headers                                                                     */
/* -------------------------------------------------------------------------- */

function baseHeaders(provider: AiProviderConfig): Record<string, string> {
  return { Accept: "application/json", ...providerHeaders(provider) };
}

function bearerHeaders(
  provider: AiProviderConfig,
  token: string | undefined
): Record<string, string> {
  const headers = baseHeaders(provider);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Per-provider discovery                                                      */
/* -------------------------------------------------------------------------- */

function openAiCandidates(provider: AiProviderConfig): CandidateRequest[] {
  const base = resolveProviderBaseUrl(provider);
  if (!base) return [];
  const trimmed = stripTrailingSlashes(base);
  const headers = bearerHeaders(provider, provider.apiKey?.trim());
  const urls = trimmed.endsWith("/v1")
    ? [`${trimmed}/models`, `${stripVersionSuffix(trimmed, "/v1")}/models`]
    : [`${trimmed}/models`, `${trimmed}/v1/models`];
  return urls.map((url) => ({ url, headers }));
}

async function fetchOpenAiCompatible(
  provider: AiProviderConfig,
  http: AiHttpPort,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey && presetRequiresApiKey(provider.preset)) {
    return fallback([], "This provider requires an API key before its model catalog can be read.");
  }
  const candidates = openAiCandidates(provider);
  if (candidates.length === 0) {
    return fallback([], "This provider has no base URL; set one before fetching models.");
  }
  const result = await tryCandidates(http, candidates, parseModelIdentifiers, options);
  return result.models.length > 0
    ? remote(result.models)
    : fallback([], `Could not load the model catalog: ${result.message ?? "no models"}`);
}

async function fetchAnthropic(
  provider: AiProviderConfig,
  http: AiHttpPort,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) {
    return fallback([], "Anthropic requires an API key before its model catalog can be read.");
  }
  const base = resolveProviderBaseUrl(provider) ?? ANTHROPIC_DEFAULT_BASE_URL;
  const root = stripVersionSuffix(stripTrailingSlashes(base), "/v1");
  const headers = {
    ...baseHeaders(provider),
    "anthropic-version": headersValue(provider, "anthropic-version") ?? ANTHROPIC_VERSION,
    "x-api-key": apiKey
  };
  const result = await tryCandidates(
    http,
    [{ url: `${root}/v1/models?limit=1000`, headers }],
    parseModelIdentifiers,
    options
  );
  return result.models.length > 0
    ? remote(result.models)
    : fallback([], `Could not load the Anthropic model catalog: ${result.message ?? "no models"}`);
}

/** Honors a user header of the same name, matching the connectivity test. */
function headersValue(provider: AiProviderConfig, key: string): string | undefined {
  return provider.customHeaders?.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value;
}

function geminiModelUrl(provider: AiProviderConfig, base: string, withApiKey: boolean): string {
  const root = stripVersionSuffix(stripTrailingSlashes(base), "/v1beta");
  const url = new URL(`${root}/v1beta/models`);
  const apiKey = withApiKey ? provider.apiKey?.trim() : undefined;
  if (apiKey) url.searchParams.set("key", apiKey);
  return url.toString();
}

async function fetchGeminiApiKey(
  provider: AiProviderConfig,
  http: AiHttpPort,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  if (!provider.apiKey?.trim()) {
    return fallback([], "Gemini requires an API key before its model catalog can be read.");
  }
  const base = resolveProviderBaseUrl(provider) ?? GEMINI_DEFAULT_BASE_URL;
  const result = await tryCandidates(
    http,
    [{ url: geminiModelUrl(provider, base, true), headers: baseHeaders(provider) }],
    parseGeminiIdentifiers,
    options
  );
  return result.models.length > 0
    ? remote(result.models)
    : fallback([], `Could not load the Gemini model catalog: ${result.message ?? "no models"}`);
}

async function fetchChatGPT(
  provider: AiProviderConfig,
  http: AiHttpPort,
  credential: AiOAuthCredential | undefined,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  const accessToken = credential?.accessToken?.trim();
  if (!accessToken) {
    return fallback(CHATGPT_FALLBACK_MODELS, "ChatGPT OAuth is not connected; showing built-in models.");
  }
  const base = stripTrailingSlashes(
    textValue(provider.baseUrl) ?? CHATGPT_DEFAULT_BASE_URL
  );
  const headers = bearerHeaders(provider, accessToken);
  headers["originator"] = "opencode";
  if (credential?.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const result = await tryCandidates(
    http,
    [{ url: `${base}/models`, headers }],
    parseModelIdentifiers,
    options
  );
  return result.models.length > 0
    ? remote(result.models)
    : fallback(
        CHATGPT_FALLBACK_MODELS,
        `Could not load the ChatGPT model catalog: ${result.message ?? "no models"}`
      );
}

async function fetchGeminiOAuth(
  provider: AiProviderConfig,
  http: AiHttpPort,
  credential: AiOAuthCredential | undefined,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  const accessToken = credential?.accessToken?.trim();
  if (!accessToken) {
    return fallback(GEMINI_FALLBACK_MODELS, "Gemini OAuth is not connected; showing built-in models.");
  }
  const base = stripTrailingSlashes(textValue(provider.baseUrl) ?? GEMINI_DEFAULT_BASE_URL);
  const result = await tryCandidates(
    http,
    [{ url: geminiModelUrl(provider, base, false), headers: bearerHeaders(provider, accessToken) }],
    parseGeminiIdentifiers,
    options
  );
  return result.models.length > 0
    ? remote(result.models)
    : fallback(
        GEMINI_FALLBACK_MODELS,
        `Could not load the Gemini model catalog: ${result.message ?? "no models"}`
      );
}

async function fetchCopilot(
  provider: AiProviderConfig,
  http: AiHttpPort,
  credential: AiOAuthCredential | undefined,
  options: FetchChatModelIdsOptions
): Promise<AiRemoteModelList> {
  const copilotToken = credential?.copilotToken?.trim();
  const base = textValue(credential?.copilotApiBaseUrl);
  if (!copilotToken || !base) {
    return fallback(COPILOT_FALLBACK_MODELS, "GitHub Copilot is not connected; showing the Auto model.");
  }
  const headers: Record<string, string> = {
    ...baseHeaders(provider),
    ...COPILOT_EDITOR_HEADERS,
    Authorization: `Bearer ${copilotToken}`
  };
  const result = await tryCandidates(
    http,
    [{ url: `${stripTrailingSlashes(base)}/models`, headers }],
    parseModelIdentifiers,
    options
  );
  return result.models.length > 0
    ? remote(result.models)
    : fallback(
        COPILOT_FALLBACK_MODELS,
        `Could not load the Copilot model catalog: ${result.message ?? "no models"}`
      );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns the chat-model ids the provider currently serves, or a built-in
 * fallback when discovery is unavailable. Never throws.
 */
export async function fetchChatModelIds(
  provider: AiProviderConfig,
  http: AiHttpPort,
  credential?: AiOAuthCredential,
  options: FetchChatModelIdsOptions = {}
): Promise<AiRemoteModelList> {
  try {
    if (isUnsupportedProvider(provider)) {
      return { models: [], source: "fallback", message: UNSUPPORTED_MESSAGE };
    }

    switch (presetOAuth(provider.preset)) {
      case "chatgpt":
        return await fetchChatGPT(provider, http, credential, options);
      case "gemini":
        return await fetchGeminiOAuth(provider, http, credential, options);
      case "copilot":
        return await fetchCopilot(provider, http, credential, options);
      case "claude":
        // Claude Code owns its model routing; there is no HTTP catalog to read.
        return fallback(CLAUDE_FALLBACK_MODELS, "Claude OAuth does not expose a model catalog.");
      case null:
        break;
    }

    switch (provider.apiType) {
      case "anthropic":
        return await fetchAnthropic(provider, http, options);
      case "gemini":
        return await fetchGeminiApiKey(provider, http, options);
      case "openai-compatible":
      case "openai-responses":
        return await fetchOpenAiCompatible(provider, http, options);
      case "amazon-bedrock":
        return { models: [], source: "fallback", message: UNSUPPORTED_MESSAGE };
    }
  } catch (error) {
    return { models: [], source: "fallback", message: describeError(error) };
  }
}
