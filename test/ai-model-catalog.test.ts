import test from "node:test";
import assert from "node:assert/strict";
import type {
  AiApiType,
  AiOAuthCredential,
  AiProviderConfig,
  AiProviderPreset
} from "../src/services/ai/contracts";
import {
  CHATGPT_FALLBACK_MODELS,
  CLAUDE_FALLBACK_MODELS,
  COPILOT_FALLBACK_MODELS,
  GEMINI_FALLBACK_MODELS,
  fetchChatModelIds
} from "../src/services/ai/model-catalog";
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

function requestsTo(harness: HttpHarness): string[] {
  return harness.requests.map((request) => request.url);
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible / Responses                                               */
/* -------------------------------------------------------------------------- */

test("an OpenAI-compatible base ending in /v1 tries /v1/models before the bare /models", async () => {
  const harness = createHttp();
  harness.enqueue(
    jsonResponse(404, { error: "not found" }),
    jsonResponse(200, { data: [{ id: "gpt-b" }, { id: "gpt-a" }, { id: "gpt-a" }] })
  );

  const result = await fetchChatModelIds(
    provider("openai", { baseUrl: "https://api.example.com/v1", apiKey: "secret-key" }),
    harness.http
  );

  assert.deepEqual(result, { models: ["gpt-a", "gpt-b"], source: "remote" });
  assert.deepEqual(requestsTo(harness), [
    "https://api.example.com/v1/models",
    "https://api.example.com/models"
  ]);
  assert.equal(harness.requests[0]?.method, "GET");
  assert.equal(harness.requests[0]?.headers?.["Authorization"], "Bearer secret-key");
  assert.equal(harness.requests[0]?.headers?.["Accept"], "application/json");
});

test("a base without /v1 tries /models then /v1/models and merges custom headers", async () => {
  const harness = createHttp();
  harness.enqueue(
    { status: 500, text: "boom" },
    jsonResponse(200, { models: [{ id: "m2" }, { id: "m1" }] })
  );

  const result = await fetchChatModelIds(
    provider("openai-compatible", {
      baseUrl: "https://api.example.com/",
      apiKey: "secret-key",
      customHeaders: [{ key: "X-Custom", value: "1" }]
    }),
    harness.http
  );

  assert.deepEqual(result, { models: ["m1", "m2"], source: "remote" });
  assert.deepEqual(requestsTo(harness), [
    "https://api.example.com/models",
    "https://api.example.com/v1/models"
  ]);
  assert.equal(harness.requests[1]?.headers?.["X-Custom"], "1");
  assert.equal(harness.requests[1]?.headers?.["Authorization"], "Bearer secret-key");
});

test("a bare-array catalog is parsed from id, name and model fields", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, [
    { id: "by-id" },
    { name: "by-name" },
    { model: "by-model" },
    "plain-string",
    { displayName: "ignored" }
  ]));

  const result = await fetchChatModelIds(
    provider("openai-compatible", { baseUrl: "https://api.example.com/v1" }),
    harness.http
  );

  assert.deepEqual(result, {
    models: ["by-id", "by-model", "by-name", "plain-string"],
    source: "remote"
  });
});

test("a 200 response with an unreadable body is skipped for the next candidate", async () => {
  const harness = createHttp();
  harness.enqueue(
    { status: 200, text: "not json at all" },
    jsonResponse(200, { data: [{ id: "from-second" }] })
  );

  const result = await fetchChatModelIds(
    provider("openai-compatible", { baseUrl: "https://api.example.com/v1" }),
    harness.http
  );

  assert.deepEqual(result, { models: ["from-second"], source: "remote" });
  assert.equal(harness.requests.length, 2);
});

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                   */
/* -------------------------------------------------------------------------- */

test("an Anthropic provider reads /v1/models with x-api-key and the pinned API version", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, {
    data: [{ id: "claude-3-7-sonnet-latest" }, { id: "claude-3-5-sonnet-latest" }]
  }));

  const result = await fetchChatModelIds(
    provider("anthropic", { apiKey: "anthropic-key" }),
    harness.http
  );

  assert.deepEqual(result, {
    models: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"],
    source: "remote"
  });
  assert.deepEqual(requestsTo(harness), ["https://api.anthropic.com/v1/models?limit=1000"]);
  assert.equal(harness.requests[0]?.headers?.["x-api-key"], "anthropic-key");
  assert.equal(harness.requests[0]?.headers?.["anthropic-version"], "2023-06-01");
});

test("an Anthropic provider without a key returns a fallback message without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(provider("anthropic"), harness.http);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.message ?? "", /API key/i);
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Gemini                                                                      */
/* -------------------------------------------------------------------------- */

test("a Gemini API-key provider asks /v1beta/models, strips the prefix and keeps only gemini ids", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, {
    models: [
      { name: "models/gemini-2.5-pro" },
      { name: "models/text-embedding-004" },
      { name: "models/gemini-2.5-flash" },
      { name: "models/gemini-2.5-pro" }
    ]
  }));

  const result = await fetchChatModelIds(
    provider("gemini", { apiKey: "gemini-key" }),
    harness.http
  );

  assert.deepEqual(result, {
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    source: "remote"
  });
  assert.deepEqual(requestsTo(harness), [
    "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key"
  ]);
});

test("Gemini OAuth uses a bearer token and never puts the API key in the query", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, {
    models: [{ name: "models/gemini-2.5-pro" }, { name: "models/gemini-2.0-flash" }]
  }));

  const result = await fetchChatModelIds(
    provider("gemini-oauth", { apiKey: "must-not-appear" }),
    harness.http,
    { accessToken: "google-access", email: "person@example.com", updatedAt: 0 }
  );

  assert.deepEqual(result, {
    models: ["gemini-2.0-flash", "gemini-2.5-pro"],
    source: "remote"
  });
  assert.equal(harness.requests[0]?.url.includes("key="), false);
  assert.equal(harness.requests[0]?.headers?.["Authorization"], "Bearer google-access");
});

test("Gemini OAuth falls back to the built-in list when discovery fails", async () => {
  const harness = createHttp();
  harness.enqueue({ status: 500, text: "boom" });

  const result = await fetchChatModelIds(
    provider("gemini-oauth"),
    harness.http,
    { accessToken: "google-access", updatedAt: 0 }
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...GEMINI_FALLBACK_MODELS]);
  assert.match(result.message ?? "", /HTTP 500/);
  assert.equal(harness.requests.length, 1);
});

test("Gemini OAuth without a login returns the fallback list without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(provider("gemini-oauth"), harness.http);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...GEMINI_FALLBACK_MODELS]);
  assert.match(result.message ?? "", /not connected/i);
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* ChatGPT OAuth                                                               */
/* -------------------------------------------------------------------------- */

test("ChatGPT OAuth reads the Codex /models catalog with account headers", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, {
    models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.3-codex-spark" }]
  }));

  const result = await fetchChatModelIds(
    provider("chatgpt-oauth"),
    harness.http,
    { accessToken: "chatgpt-access", accountId: "account-1", updatedAt: 0 }
  );

  assert.deepEqual(result, {
    models: ["gpt-5.3-codex-spark", "gpt-5.4"],
    source: "remote"
  });
  assert.deepEqual(requestsTo(harness), ["https://chatgpt.com/backend-api/codex/models"]);
  assert.equal(harness.requests[0]?.headers?.["Authorization"], "Bearer chatgpt-access");
  assert.equal(harness.requests[0]?.headers?.["originator"], "opencode");
  assert.equal(harness.requests[0]?.headers?.["ChatGPT-Account-Id"], "account-1");
});

test("ChatGPT OAuth falls back to the built-in Codex ids when discovery fails", async () => {
  const harness = createHttp();
  harness.enqueue({ status: 401, text: "unauthorized" });

  const result = await fetchChatModelIds(
    provider("chatgpt-oauth"),
    harness.http,
    { accessToken: "chatgpt-access", updatedAt: 0 }
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...CHATGPT_FALLBACK_MODELS]);
  assert.ok(result.models.includes("gpt-5.4"));
  assert.ok(result.models.includes("gpt-5.4-mini"));
  assert.ok(result.models.includes("gpt-5.3-codex-spark"));
  assert.match(result.message ?? "", /HTTP 401/);
});

test("ChatGPT OAuth without a login returns the fallback list without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(provider("chatgpt-oauth"), harness.http);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...CHATGPT_FALLBACK_MODELS]);
  assert.match(result.message ?? "", /not connected/i);
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* GitHub Copilot                                                              */
/* -------------------------------------------------------------------------- */

test("Copilot reads /models with the Copilot token and editor headers", async () => {
  const harness = createHttp();
  harness.enqueue(jsonResponse(200, {
    data: [{ id: "gpt-4o" }, { id: "claude-sonnet-4" }]
  }));

  const result = await fetchChatModelIds(
    provider("github-copilot"),
    harness.http,
    {
      accessToken: "github-token",
      copilotToken: "copilot-token",
      copilotApiBaseUrl: "https://api.githubcopilot.com/",
      copilotExpiresAt: Date.now() + 3_600_000,
      updatedAt: 0
    }
  );

  assert.deepEqual(result, {
    models: ["claude-sonnet-4", "gpt-4o"],
    source: "remote"
  });
  assert.deepEqual(requestsTo(harness), ["https://api.githubcopilot.com/models"]);
  assert.equal(harness.requests[0]?.headers?.["Authorization"], "Bearer copilot-token");
  assert.equal(harness.requests[0]?.headers?.["Copilot-Integration-Id"], "vscode-chat");
  assert.equal(harness.requests[0]?.headers?.["X-GitHub-Api-Version"], "2026-08-01");
});

test("Copilot falls back to Auto when discovery fails", async () => {
  const harness = createHttp();
  harness.enqueue({ status: 403, text: "policy" });

  const result = await fetchChatModelIds(
    provider("github-copilot"),
    harness.http,
    {
      accessToken: "github-token",
      copilotToken: "copilot-token",
      copilotApiBaseUrl: "https://api.githubcopilot.com",
      updatedAt: 0
    }
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...COPILOT_FALLBACK_MODELS]);
  assert.match(result.message ?? "", /HTTP 403/);
});

test("Copilot without a login returns Auto without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(provider("github-copilot"), harness.http);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, ["auto"]);
  assert.match(result.message ?? "", /not connected/i);
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Claude OAuth / unsupported providers                                        */
/* -------------------------------------------------------------------------- */

test("Claude OAuth returns the conservative fallback list without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(
    provider("claude-oauth"),
    harness.http,
    { accessToken: "sk-ant-oat01-example", updatedAt: 0 }
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, [...CLAUDE_FALLBACK_MODELS]);
  assert.ok(result.models.includes("claude-sonnet-4-0"));
  assert.match(result.message ?? "", /Claude OAuth/i);
  assert.equal(harness.requests.length, 0);
});

test("Azure OpenAI and Amazon Bedrock report unsupported without a request", async () => {
  const harness = createHttp();
  const azure = await fetchChatModelIds(
    provider("azure-openai", { baseUrl: "https://resource.openai.azure.com", apiKey: "k" }),
    harness.http
  );
  assert.deepEqual(azure, { models: [], source: "fallback", message: "unsupported" });

  const bedrock = await fetchChatModelIds(
    provider("amazon-bedrock", { apiKey: "k" }),
    harness.http
  );
  assert.deepEqual(bedrock, { models: [], source: "fallback", message: "unsupported" });
  assert.equal(harness.requests.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

test("when every candidate fails the last failure is reported with an empty fallback", async () => {
  const harness = createHttp();
  harness.enqueue({ status: 404, text: "nope" }, { status: 500, text: "boom" });

  const result = await fetchChatModelIds(
    provider("openai-compatible", { baseUrl: "https://api.example.com/v1", apiKey: "key" }),
    harness.http
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.message ?? "", /HTTP 500/);
  assert.equal(harness.requests.length, 2);
});

test("a network rejection is returned as a fallback, not thrown", async () => {
  const harness = createHttp();
  harness.enqueue(async () => {
    throw new Error("ECONNREFUSED");
  });

  const result = await fetchChatModelIds(
    provider("anthropic", { apiKey: "key" }),
    harness.http
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.message ?? "", /ECONNREFUSED/);
});

test("a provider that runs past the timeout falls back", async () => {
  const harness = createHttp();
  harness.enqueue(() => new Promise<AiHttpResponse>(() => undefined));

  const result = await fetchChatModelIds(
    provider("anthropic", { apiKey: "key" }),
    harness.http,
    undefined,
    { timeoutMs: 5 }
  );

  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.message ?? "", /timed out after 5ms/);
});

test("a custom provider without a base URL returns a fallback message without a request", async () => {
  const harness = createHttp();
  const result = await fetchChatModelIds(provider("openai-compatible"), harness.http);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.message ?? "", /base URL/i);
  assert.equal(harness.requests.length, 0);
});
