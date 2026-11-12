import test from "node:test";
import assert from "node:assert/strict";
import type {
  AiApiType,
  AiChatModelConfig,
  AiEmbeddingModelConfig,
  AiOAuthCredential,
  AiProviderConfig,
  AiProviderPreset
} from "../src/services/ai/contracts";
import { testChatModel, testEmbeddingModel } from "../src/services/ai/connectivity";
import type { AiHttpPort, AiHttpRequest, AiHttpResponse } from "../src/services/ai/oauth";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

type Responder = AiHttpResponse | ((request: AiHttpRequest) => Promise<AiHttpResponse>);

interface HttpHarness {
  http: AiHttpPort;
  requests: AiHttpRequest[];
  enqueue(...responses: Responder[]): void;
}

function jsonResponse(status: number, body: unknown): AiHttpResponse {
  return { status, text: JSON.stringify(body), json: body };
}

function createHttp(): HttpHarness {
  const requests: AiHttpRequest[] = [];
  const queue: Responder[] = [];
  return {
    requests,
    enqueue: (...responses) => {
      queue.push(...responses);
    },
    http: {
      request: async (request) => {
        requests.push(request);
        const next = queue.shift();
        if (!next) throw new Error(`Unexpected request: ${request.url}`);
        return typeof next === "function" ? next(request) : next;
      }
    }
  };
}

const PRESET_API_TYPE: Record<string, AiApiType> = {
  openai: "openai-responses",
  "chatgpt-oauth": "openai-responses",
  anthropic: "anthropic",
  "claude-oauth": "anthropic",
  gemini: "gemini",
  "gemini-oauth": "gemini",
  "github-copilot": "openai-compatible",
  "azure-openai": "openai-compatible",
  "amazon-bedrock": "amazon-bedrock",
  "openai-compatible": "openai-compatible"
};

function provider(
  preset: AiProviderPreset,
  overrides: Partial<AiProviderConfig> = {}
): AiProviderConfig {
  return {
    id: preset,
    preset,
    apiType: PRESET_API_TYPE[preset] ?? "openai-compatible",
    ...overrides
  };
}

function chatModel(model = "test-model"): AiChatModelConfig {
  return { id: "chat-1", providerId: "provider", model, enable: true };
}

function embeddingModel(model = "embed-model"): AiEmbeddingModelConfig {
  return { id: "embedding-1", providerId: "provider", model, dimension: 1_536 };
}

function bodyOf(request: AiHttpRequest | undefined): Record<string, unknown> {
  assert.ok(request, "expected a request");
  return JSON.parse(request.body ?? "{}") as Record<string, unknown>;
}

function clock(values: number[]): () => number {
  return () => values.shift() ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Chat: OpenAI-compatible                                                     */
/* -------------------------------------------------------------------------- */

test("an OpenAI-compatible chat probe sends one tiny user message with the bearer key", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { choices: [] }));

  const result = await testChatModel(
    provider("groq", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "secret-key",
      customHeaders: [{ key: "X-Test", value: "1" }]
    }),
    chatModel("llama-test"),
    harness.http,
    undefined,
    { now: clock([1_000, 1_075]) }
  );

  assert.deepEqual(result, { ok: true, status: 200, latencyMs: 75 });
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.method, "POST");
  assert.equal(request.headers?.["Authorization"], "Bearer secret-key");
  assert.equal(request.headers?.["Content-Type"], "application/json");
  assert.equal(request.headers?.["X-Test"], "1");

  const body = bodyOf(request);
  assert.equal(body["model"], "llama-test");
  assert.equal(body["max_tokens"], 1);
  assert.equal(body["stream"], false);
  assert.deepEqual(body["messages"], [{ role: "user", content: "ping" }]);
});

test("a non-2xx chat probe reports the status and the server message", async () => {
  const harness = createHttp();
  harness.enqueue({
    status: 401,
    text: JSON.stringify({ error: { message: "invalid api key" } }),
    json: { error: { message: "invalid api key" } }
  });

  const result = await testChatModel(
    provider("groq", { baseUrl: "https://api.example.com/v1", apiKey: "bad" }),
    chatModel(),
    harness.http
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message ?? "", /invalid api key/);
});

test("a network failure is returned, not thrown", async () => {
  const harness = createHttp();
  harness.enqueue(async () => {
    throw new Error("socket hang up");
  });

  const result = await testChatModel(
    provider("openai-compatible", { baseUrl: "https://api.example.com/v1" }),
    chatModel(),
    harness.http
  );

  assert.deepEqual(result, { ok: false, message: "socket hang up" });
});

test("a probe that runs past its timeout resolves as a failure", async () => {
  const harness = createHttp();
  harness.enqueue(() => new Promise<AiHttpResponse>(() => undefined));

  const result = await testChatModel(
    provider("openai-compatible", { baseUrl: "https://api.example.com/v1" }),
    chatModel(),
    harness.http,
    undefined,
    { timeoutMs: 5 }
  );

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /timed out after 5ms/);
});

/* -------------------------------------------------------------------------- */
/* Chat: OpenAI Responses / Anthropic / Gemini                                  */
/* -------------------------------------------------------------------------- */

test("an OpenAI Responses probe targets /responses with max_output_tokens=1", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { output: [] }));

  const result = await testChatModel(
    provider("openai", { baseUrl: "https://api.openai.com/v1", apiKey: "openai-key" }),
    chatModel("gpt-test"),
    harness.http
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers?.["Authorization"], "Bearer openai-key");
  const body = bodyOf(request);
  assert.equal(body["model"], "gpt-test");
  assert.equal(body["input"], "ping");
  assert.equal(body["max_output_tokens"], 1);
  assert.equal(body["stream"], false);
});

test("an Anthropic API-key probe uses x-api-key and the pinned API version", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { content: [] }));

  const result = await testChatModel(
    provider("anthropic", { baseUrl: "https://api.anthropic.com", apiKey: "anthropic-key" }),
    chatModel("claude-test"),
    harness.http
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers?.["x-api-key"], "anthropic-key");
  assert.equal(request.headers?.["anthropic-version"], "2023-06-01");
  assert.equal(request.headers?.["Authorization"], undefined);
  const body = bodyOf(request);
  assert.equal(body["max_tokens"], 1);
  assert.deepEqual(body["messages"], [{ role: "user", content: "ping" }]);
});

test("an Anthropic OAuth probe uses the stored bearer token instead of an API key", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { content: [] }));

  const credential: AiOAuthCredential = { accessToken: "oauth-token", updatedAt: 0 };
  const result = await testChatModel(
    provider("claude-oauth", { baseUrl: "https://api.anthropic.com" }),
    chatModel("claude-test"),
    harness.http,
    credential
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.headers?.["Authorization"], "Bearer oauth-token");
  assert.equal(request.headers?.["x-api-key"], undefined);
  assert.equal(request.headers?.["anthropic-version"], "2023-06-01");
});

test("a Gemini probe replaces the model placeholder, drops streaming and sends the key in the query", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { candidates: [] }));

  const result = await testChatModel(
    provider("gemini", { apiKey: "gemini-key" }),
    chatModel("gemini-test"),
    harness.http
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=gemini-key"
  );
  assert.equal(request.headers?.["Authorization"], undefined);
  const body = bodyOf(request);
  assert.deepEqual(body["contents"], [{ role: "user", parts: [{ text: "ping" }] }]);
  assert.deepEqual(body["generationConfig"], { maxOutputTokens: 1 });
});

test("an OAuth ChatGPT probe uses the bearer token from the saved login", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { output: [] }));

  const credential: AiOAuthCredential = {
    accessToken: "chatgpt-access",
    accountId: "account-1",
    updatedAt: 0
  };
  const result = await testChatModel(
    provider("chatgpt-oauth", { baseUrl: "https://chatgpt.com/backend-api/codex" }),
    chatModel("gpt-5-codex"),
    harness.http,
    credential
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers?.["Authorization"], "Bearer chatgpt-access");
  assert.equal(bodyOf(request)["input"], "ping");
});

test("a Copilot probe targets the account endpoint with the Copilot token and editor headers", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { choices: [] }));

  const credential: AiOAuthCredential = {
    accessToken: "github-token",
    copilotToken: "copilot-token",
    copilotExpiresAt: Date.now() + 3_600_000,
    copilotApiBaseUrl: "https://api.githubcopilot.com/",
    updatedAt: 0
  };
  const result = await testChatModel(
    provider("github-copilot"),
    chatModel("gpt-4o-copilot"),
    harness.http,
    credential
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.githubcopilot.com/chat/completions");
  assert.equal(request.headers?.["Authorization"], "Bearer copilot-token");
  assert.equal(request.headers?.["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(request.headers?.["X-GitHub-Api-Version"], "2026-08-01");
});

test("an OAuth ChatGPT probe falls back to the Codex endpoint and identifies the account", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { output: [] }));

  const credential: AiOAuthCredential = {
    accessToken: "chatgpt-access",
    accountId: "account-1",
    updatedAt: 0
  };
  const result = await testChatModel(
    provider("chatgpt-oauth"),
    chatModel("gpt-5-codex"),
    harness.http,
    credential
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(request.headers?.["Authorization"], "Bearer chatgpt-access");
  assert.equal(request.headers?.["originator"], "opencode");
  assert.equal(request.headers?.["ChatGPT-Account-Id"], "account-1");
});

test("a Gemini OAuth probe uses the generative-language endpoint with a bearer token, not a query key", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { candidates: [] }));

  const result = await testChatModel(
    provider("gemini-oauth"),
    chatModel("gemini-test"),
    harness.http,
    { accessToken: "google-access", email: "person@example.com", updatedAt: 0 }
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
  );
  assert.equal(request.headers?.["Authorization"], "Bearer google-access");
  assert.equal(request.url.includes("key="), false);
});

test("a Claude OAuth probe falls back to the Anthropic Messages endpoint", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { content: [] }));

  const result = await testChatModel(
    provider("claude-oauth"),
    chatModel("claude-test"),
    harness.http,
    { accessToken: "sk-ant-oat01-example", updatedAt: 0 }
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers?.["Authorization"], "Bearer sk-ant-oat01-example");
  assert.equal(request.headers?.["x-api-key"], undefined);
});

/* -------------------------------------------------------------------------- */
/* Refusals and missing configuration                                          */
/* -------------------------------------------------------------------------- */

test("an OAuth provider without a saved login is refused before any request", async () => {
  const harness = createHttp();
  const result = await testChatModel(
    provider("chatgpt-oauth", { baseUrl: "https://chatgpt.com/backend-api/codex" }),
    chatModel(),
    harness.http
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /not connected/i);
  assert.equal(harness.requests.length, 0);
});

test("a Copilot login without a Copilot token is refused before any request", async () => {
  const harness = createHttp();
  const result = await testChatModel(
    provider("github-copilot"),
    chatModel(),
    harness.http,
    { accessToken: "github-token", updatedAt: 0 }
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /not connected/i);
  assert.equal(harness.requests.length, 0);
});

test("a required API key that is missing is refused before any request", async () => {
  const harness = createHttp();
  const result = await testChatModel(provider("openai"), chatModel(), harness.http);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /API key/i);
  assert.equal(harness.requests.length, 0);
});

test("a provider without a base URL is refused before any request", async () => {
  const harness = createHttp();
  const result = await testChatModel(
    provider("openai-compatible"),
    chatModel(),
    harness.http
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /base URL/i);
  assert.equal(harness.requests.length, 0);
});

test("Azure OpenAI and Amazon Bedrock report that connectivity tests are unsupported", async () => {
  const harness = createHttp();
  const azure = await testChatModel(
    provider("azure-openai", { baseUrl: "https://resource.openai.azure.com", apiKey: "k" }),
    chatModel(),
    harness.http
  );
  assert.equal(azure.ok, false);
  assert.match(azure.message ?? "", /not supported/i);

  const bedrock = await testChatModel(
    provider("amazon-bedrock", { apiKey: "k" }),
    chatModel(),
    harness.http
  );
  assert.equal(bedrock.ok, false);
  assert.match(bedrock.message ?? "", /not supported/i);
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Embeddings                                                                  */
/* -------------------------------------------------------------------------- */

test("an OpenAI-compatible embedding probe targets /embeddings with one input", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { data: [{ embedding: [0.1] }] }));

  const result = await testEmbeddingModel(
    provider("openai-compatible", {
      baseUrl: "https://api.example.com/v1",
      apiKey: "embedding-key"
    }),
    embeddingModel("text-embedding-3-small"),
    harness.http,
    undefined,
    { now: clock([5, 20]) }
  );

  assert.deepEqual(result, { ok: true, status: 200, latencyMs: 15 });
  const request = harness.requests[0]!;
  assert.equal(request.url, "https://api.example.com/v1/embeddings");
  assert.equal(request.headers?.["Authorization"], "Bearer embedding-key");
  const body = bodyOf(request);
  assert.equal(body["model"], "text-embedding-3-small");
  assert.equal(body["input"], "ping");
});

test("a Gemini embedding probe uses embedContent with the key in the query", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, { embedding: { values: [0.1] } }));

  const result = await testEmbeddingModel(
    provider("gemini", { apiKey: "gemini-key" }),
    embeddingModel("text-embedding-004"),
    harness.http
  );

  assert.equal(result.ok, true);
  const request = harness.requests[0]!;
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=gemini-key"
  );
  assert.deepEqual(bodyOf(request)["content"], { parts: [{ text: "ping" }] });
});

test("an embedding probe fails for models without an embeddings endpoint", async () => {
  const harness = createHttp();
  const anthropic = await testEmbeddingModel(
    provider("anthropic", { baseUrl: "https://api.anthropic.com", apiKey: "k" }),
    embeddingModel(),
    harness.http
  );
  assert.equal(anthropic.ok, false);
  assert.match(anthropic.message ?? "", /embeddings/i);

  const copilot = await testEmbeddingModel(
    provider("github-copilot"),
    embeddingModel(),
    harness.http,
    {
      accessToken: "github",
      copilotToken: "copilot",
      copilotApiBaseUrl: "https://api.githubcopilot.com",
      updatedAt: 0
    }
  );
  assert.equal(copilot.ok, false);
  assert.match(copilot.message ?? "", /embeddings/i);
  assert.equal(harness.requests.length, 0);
});

test("an embedding probe for Azure OpenAI is unsupported", async () => {
  const harness = createHttp();
  const result = await testEmbeddingModel(
    provider("azure-openai", { baseUrl: "https://resource.openai.azure.com", apiKey: "k" }),
    embeddingModel(),
    harness.http
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /not supported/i);
  assert.equal(harness.requests.length, 0);
});
