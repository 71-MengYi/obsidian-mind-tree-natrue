/**
 * The "Test" button for a chat or embedding model.
 *
 * A connectivity test sends one minimal, non-streaming request through the
 * same URL/auth rules the real client will use and reports the HTTP outcome.
 * It is pure orchestration: every request goes through the injected
 * `AiHttpPort`, nothing here imports Obsidian, and a failure is a result —
 * never a thrown error — so the provider card can render it.
 *
 * Scope: OpenAI-compatible, OpenAI Responses, Anthropic Messages and Gemini.
 * Azure OpenAI and Amazon Bedrock need provider-specific signing/deployment
 * URLs, so they report "not supported" rather than a misleading 401.
 */
import {
  type AiChatModelConfig,
  type AiEmbeddingModelConfig,
  type AiOAuthCredential,
  type AiProviderConfig,
  type AiProviderPreset,
  type AiTestResult
} from "./contracts";
import { providerHeaders, resolvePrimaryRequestUrl, resolveProviderBaseUrl } from "./normalize";
import { presetOAuth, presetRequiresApiKey } from "./presets";
import type { AiHttpPort, AiHttpRequest, AiHttpResponse } from "./oauth";

export interface AiConnectivityOptions {
  /** Total budget for one probe; defaults to 10 seconds. */
  timeoutMs?: number;
  /** Injectable clock so tests can assert the measured latency. */
  now?: () => number;
}

export const DEFAULT_AI_CONNECTIVITY_TIMEOUT_MS = 10_000;

const TEST_PROMPT = "ping";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ERROR_SNIPPET = 300;
const UNSUPPORTED_MESSAGE =
  "Connectivity tests are not supported for Azure OpenAI or Amazon Bedrock providers.";

/**
 * OAuth presets have no user-editable console URL: their provider's own client
 * hard-codes the account endpoint, and `presets.ts` leaves `baseUrl` unset.
 * Probe that endpoint unless the user configured one explicitly.
 */
const OAUTH_PROBE_BASE_URLS: Partial<Record<AiProviderPreset, string>> = {
  "chatgpt-oauth": "https://chatgpt.com/backend-api/codex",
  "claude-oauth": "https://api.anthropic.com",
  "gemini-oauth": "https://generativelanguage.googleapis.com"
};

/** Editor headers GitHub expects from a Copilot client on every API call. */
const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "vscode/1.120.0",
  "Editor-Plugin-Version": "copilot-chat/0.70.0",
  "User-Agent": "GitHubCopilotChat/0.70.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2026-08-01"
};

interface PreparedProbe {
  request: AiHttpRequest;
}

class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  return `${stripTrailingSlashes(base)}/${path.replace(/^\/+/, "")}`;
}

function isUnsupportedProvider(provider: AiProviderConfig): boolean {
  return provider.preset === "azure-openai" ||
    provider.preset === "amazon-bedrock" ||
    provider.apiType === "amazon-bedrock";
}

function unsupportedResult(): AiTestResult {
  return { ok: false, message: UNSUPPORTED_MESSAGE };
}

function customHeaders(provider: AiProviderConfig): Record<string, string> {
  return providerHeaders(provider);
}

/** Fills the OAuth preset's fixed account endpoint when the user left it empty. */
function probeProvider(provider: AiProviderConfig): AiProviderConfig {
  if (provider.baseUrl?.trim()) return provider;
  const fallback = OAUTH_PROBE_BASE_URLS[provider.preset];
  return fallback === undefined ? provider : { ...provider, baseUrl: fallback };
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_ERROR_SNIPPET ? `${trimmed.slice(0, MAX_ERROR_SNIPPET)}…` : trimmed;
}

function responseSnippet(response: AiHttpResponse): string | undefined {
  if (typeof response.text === "string" && response.text.trim() !== "") {
    return truncate(response.text);
  }
  if (response.json !== undefined) {
    try {
      return truncate(JSON.stringify(response.json));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Adds the Gemini `?key=` parameter without disturbing any existing query. */
function withGeminiKey(url: string, apiKey: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("key", apiKey);
  return parsed.toString();
}

function geminiModelUrl(url: string, model: string, streaming: boolean): string {
  const replaced = url.replace("{model}", encodeURIComponent(model));
  return streaming ? replaced : replaced.replace(":streamGenerateContent", ":generateContent");
}

interface AuthResolution {
  headers: Record<string, string>;
  /** Gemini API-key auth goes in the query string, not a header. */
  queryApiKey?: string;
}

/**
 * Chooses the credential for a probe. OAuth sign-ins win over a stored key,
 * because an OAuth provider that has a login must use its bearer token.
 */
function resolveAuth(
  provider: AiProviderConfig,
  credential: AiOAuthCredential | undefined
): AuthResolution {
  const headers = customHeaders(provider);
  headers["Content-Type"] = "application/json";
  const oauth = presetOAuth(provider.preset) !== null;
  const accessToken = credential?.accessToken?.trim();

  if (provider.preset === "github-copilot") {
    const copilotToken = credential?.copilotToken?.trim();
    if (!copilotToken) throw new ProbeError("GitHub Copilot is not connected; sign in before testing.");
    Object.assign(headers, COPILOT_EDITOR_HEADERS);
    headers["Authorization"] = `Bearer ${copilotToken}`;
    return { headers };
  }

  if (oauth) {
    if (!accessToken) throw new ProbeError("This provider is not connected; sign in before testing.");
    headers["Authorization"] = `Bearer ${accessToken}`;
    if (provider.preset === "chatgpt-oauth") {
      // The Codex endpoint rejects requests that do not identify the client.
      headers["originator"] = "opencode";
      if (credential?.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
    }
  }

  const apiKey = provider.apiKey?.trim();
  switch (provider.apiType) {
    case "anthropic": {
      headers["anthropic-version"] = headers["anthropic-version"] ?? ANTHROPIC_VERSION;
      if (!oauth) {
        if (!apiKey) throw new ProbeError("Anthropic requires an API key.");
        headers["x-api-key"] = apiKey;
      }
      return { headers };
    }
    case "gemini": {
      if (!oauth) {
        if (!apiKey) throw new ProbeError("Gemini requires an API key.");
        return { headers, queryApiKey: apiKey };
      }
      return { headers };
    }
    case "openai-compatible":
    case "openai-responses": {
      if (!oauth) {
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        else if (presetRequiresApiKey(provider.preset)) throw new ProbeError("This provider requires an API key.");
      }
      return { headers };
    }
    case "amazon-bedrock":
      throw new ProbeError(UNSUPPORTED_MESSAGE);
  }
}

function chatBody(provider: AiProviderConfig, model: AiChatModelConfig): unknown {
  switch (provider.apiType) {
    case "openai-compatible":
      return {
        model: model.model,
        messages: [{ role: "user", content: TEST_PROMPT }],
        max_tokens: 1,
        stream: false
      };
    case "openai-responses":
      return {
        model: model.model,
        input: TEST_PROMPT,
        max_output_tokens: 1,
        stream: false
      };
    case "anthropic":
      return {
        model: model.model,
        max_tokens: 1,
        messages: [{ role: "user", content: TEST_PROMPT }],
        stream: false
      };
    case "gemini":
      return {
        contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 1 }
      };
    case "amazon-bedrock":
      throw new ProbeError(UNSUPPORTED_MESSAGE);
  }
}

function chatUrl(provider: AiProviderConfig, model: string): string {
  const resolved = resolvePrimaryRequestUrl(probeProvider(provider));
  if (!resolved) {
    throw new ProbeError("This provider has no base URL; set one before testing.");
  }
  return provider.apiType === "gemini"
    ? geminiModelUrl(resolved, model, false)
    : resolved;
}

function copilotChatUrl(provider: AiProviderConfig, credential: AiOAuthCredential | undefined): string {
  const base = credential?.copilotApiBaseUrl?.trim();
  if (!base) throw new ProbeError("GitHub Copilot is not connected; sign in before testing.");
  const path = provider.apiType === "openai-responses"
    ? "responses"
    : provider.apiType === "anthropic"
      ? "v1/messages"
      : "chat/completions";
  return joinUrl(base, path);
}

function prepareChat(
  provider: AiProviderConfig,
  model: AiChatModelConfig,
  credential: AiOAuthCredential | undefined
): PreparedProbe {
  if (isUnsupportedProvider(provider)) throw new ProbeError(UNSUPPORTED_MESSAGE);
  const auth = resolveAuth(provider, credential);
  const url = provider.preset === "github-copilot"
    ? copilotChatUrl(provider, credential)
    : chatUrl(provider, model.model);
  return {
    request: {
      url: auth.queryApiKey ? withGeminiKey(url, auth.queryApiKey) : url,
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify(chatBody(provider, model))
    }
  };
}

function embeddingUrl(provider: AiProviderConfig, model: AiEmbeddingModelConfig): string {
  if (provider.apiType === "anthropic") {
    throw new ProbeError("Anthropic does not expose an embeddings endpoint.");
  }
  if (provider.apiType === "amazon-bedrock" || provider.preset === "amazon-bedrock") {
    throw new ProbeError(UNSUPPORTED_MESSAGE);
  }
  if (provider.preset === "github-copilot") {
    throw new ProbeError("GitHub Copilot does not expose an embeddings endpoint.");
  }

  const base = resolveProviderBaseUrl(probeProvider(provider));
  if (!base) throw new ProbeError("This provider has no base URL; set one before testing.");

  if (provider.apiType === "gemini") {
    const root = stripTrailingSlashes(base).replace(/\/v1beta$/, "");
    return `${root}/v1beta/models/${encodeURIComponent(model.model)}:embedContent`;
  }

  // OpenAI-compatible providers that serve the API under `/v1`.
  const normalized = provider.preset === "ollama" ||
    provider.preset === "lm-studio" ||
    provider.preset === "morph"
    ? joinUrl(base, "v1")
    : stripTrailingSlashes(base);
  return joinUrl(normalized, "embeddings");
}

function embeddingBody(provider: AiProviderConfig, model: AiEmbeddingModelConfig): unknown {
  return provider.apiType === "gemini"
    ? { content: { parts: [{ text: TEST_PROMPT }] } }
    : { model: model.model, input: TEST_PROMPT };
}

function prepareEmbedding(
  provider: AiProviderConfig,
  model: AiEmbeddingModelConfig,
  credential: AiOAuthCredential | undefined
): PreparedProbe {
  if (isUnsupportedProvider(provider)) throw new ProbeError(UNSUPPORTED_MESSAGE);
  const auth = resolveAuth(provider, credential);
  const url = embeddingUrl(provider, model);
  return {
    request: {
      url: auth.queryApiKey ? withGeminiKey(url, auth.queryApiKey) : url,
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify(embeddingBody(provider, model))
    }
  };
}

async function executeProbe(
  http: AiHttpPort,
  prepared: PreparedProbe,
  options: AiConnectivityOptions
): Promise<AiTestResult> {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_AI_CONNECTIVITY_TIMEOUT_MS;
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const outcome = await Promise.race<AiHttpResponse | "timeout">([
      http.request(prepared.request),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      })
    ]);

    if (outcome === "timeout") {
      return { ok: false, message: `Request timed out after ${timeoutMs}ms.` };
    }

    const latencyMs = Math.max(0, now() - startedAt);
    if (isSuccess(outcome.status)) {
      return { ok: true, status: outcome.status, latencyMs };
    }
    return {
      ok: false,
      status: outcome.status,
      latencyMs,
      message: responseSnippet(outcome) ?? `Request failed with HTTP ${outcome.status}.`
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function testChatModel(
  provider: AiProviderConfig,
  model: AiChatModelConfig,
  http: AiHttpPort,
  credential?: AiOAuthCredential,
  options: AiConnectivityOptions = {}
): Promise<AiTestResult> {
  try {
    return await executeProbe(http, prepareChat(provider, model, credential), options);
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function testEmbeddingModel(
  provider: AiProviderConfig,
  model: AiEmbeddingModelConfig,
  http: AiHttpPort,
  credential?: AiOAuthCredential,
  options: AiConnectivityOptions = {}
): Promise<AiTestResult> {
  try {
    return await executeProbe(http, prepareEmbedding(provider, model, credential), options);
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}
