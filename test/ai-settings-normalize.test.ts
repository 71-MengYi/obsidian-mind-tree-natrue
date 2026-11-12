import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDER_PRESETS,
  type AiChatModelConfig,
  type AiEmbeddingModelConfig,
  type AiProviderConfig
} from "../src/services/ai/contracts";
import {
  createProviderDraft,
  isSafeProviderUrl,
  normalizeAiSettings,
  resolvePrimaryRequestUrl,
  suggestProviderId,
  validateChatModel,
  validateEmbeddingModel,
  validateProvider
} from "../src/services/ai/normalize";
import {
  defaultApiType,
  defaultBaseUrl,
  supportedApiTypes,
  aiPresetInfo,
  presetOAuth
} from "../src/services/ai/presets";

const openai: AiProviderConfig = {
  id: "openai",
  preset: "openai",
  apiType: "openai-responses",
  apiKey: "sk-test"
};

const custom: AiProviderConfig = {
  id: "my-gateway",
  preset: "openai-compatible",
  apiType: "openai-compatible",
  baseUrl: "https://gateway.example.com/v1"
};

test("the preset catalog covers every preset with a supported default API type", () => {
  assert.equal(AI_PROVIDER_PRESETS.length, 31);
  for (const preset of AI_PROVIDER_PRESETS) {
    const info = aiPresetInfo(preset);
    assert.ok(info.label.length > 0, preset);
    assert.ok(supportedApiTypes(preset).includes(defaultApiType(preset)), preset);
    assert.ok(supportedApiTypes(preset).length > 0, preset);
  }
  assert.deepEqual(presetOAuth("chatgpt-oauth"), "chatgpt");
  assert.deepEqual(presetOAuth("gemini-oauth"), "gemini");
  assert.deepEqual(presetOAuth("claude-oauth"), "claude");
  assert.deepEqual(presetOAuth("github-copilot"), "copilot");
  assert.equal(presetOAuth("openai"), null);
});

test("default base URLs are safe and the custom preset requires one", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    const url = defaultBaseUrl(preset);
    if (url !== undefined) assert.equal(isSafeProviderUrl(url), true, preset);
  }
  assert.equal(defaultBaseUrl("openai"), "https://api.openai.com/v1");
  assert.equal(defaultBaseUrl("ollama"), "http://127.0.0.1:11434");
  assert.equal(aiPresetInfo("openai-compatible").requireBaseUrl, true);
  assert.equal(aiPresetInfo("openai-compatible").requireApiKey, false);
});

test("a provider draft starts with a suggested id and the preset defaults", () => {
  const draft = createProviderDraft("openai", []);
  assert.equal(draft.id, "openai");
  assert.equal(draft.apiType, "openai-responses");
  assert.equal(draft.baseUrl, "https://api.openai.com/v1");
  assert.equal(suggestProviderId("openai", [openai]), "openai-2");
  assert.equal(suggestProviderId("openai-compatible", []), "");
  assert.equal(createProviderDraft("openai-compatible", []).id, "");
});

test("URL validation only accepts http(s) endpoints without credentials", () => {
  assert.equal(isSafeProviderUrl("https://api.example.com/v1"), true);
  assert.equal(isSafeProviderUrl("http://127.0.0.1:11434"), true);
  assert.equal(isSafeProviderUrl("ftp://api.example.com"), false);
  assert.equal(isSafeProviderUrl("https://user:pass@api.example.com"), false);
  assert.equal(isSafeProviderUrl("not a url"), false);
});

test("normalization keeps valid providers and drops malformed or duplicate ones", () => {
  const snapshot = normalizeAiSettings({
    aiProviders: [
      openai,
      { ...custom },
      { ...custom, id: "duplicate-custom" },
      { ...custom, id: "duplicate-custom" },
      { id: "bad preset", preset: "nope", apiType: "openai-compatible" },
      { id: "unsafe", preset: "openai-compatible", baseUrl: "file:///etc/passwd" }
    ]
  });
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["openai", "my-gateway", "duplicate-custom", "unsafe"]
  );
  assert.equal(snapshot.providers[1]?.baseUrl, "https://gateway.example.com/v1");
  // A file URL is discarded while the provider row survives for repair.
  const unsafe = snapshot.providers.find((provider) => provider.id === "unsafe");
  assert.ok(unsafe);
  assert.equal(unsafe.baseUrl, undefined);
});

test("a damaged api type falls back to the preset default; unknown settings are dropped", () => {
  const snapshot = normalizeAiSettings({
    aiProviders: [{
      id: "openai",
      preset: "openai",
      apiType: "unsupported",
      apiKey: "  sk-test  ",
      customHeaders: [
        { key: "X-Team", value: "docs" },
        { key: "bad header", value: "x" },
        { key: "X-Team", value: "duplicate" }
      ],
      additionalSettings: {
        responseStreamingMode: "non-streaming",
        promptCaching: true,
        unknownSetting: "ignored"
      }
    }]
  });
  const provider = snapshot.providers[0];
  assert.equal(provider?.apiType, "openai-responses");
  assert.equal(provider?.apiKey, "sk-test");
  assert.deepEqual(provider?.customHeaders, [{ key: "X-Team", value: "docs" }]);
  assert.equal(provider?.additionalSettings?.responseStreamingMode, "non-streaming");
  assert.equal(provider?.additionalSettings?.promptCaching, true);
  assert.equal(Object.hasOwn(provider?.additionalSettings ?? {}, "unknownSetting"), false);
});

test("models are kept only when their provider survived normalization", () => {
  const snapshot = normalizeAiSettings({
    aiProviders: [openai],
    aiChatModels: [
      { id: "openai/gpt", providerId: "openai", model: "gpt", enable: true },
      { id: "orphan/gpt", providerId: "missing", model: "gpt", enable: true },
      { id: "openai/gpt", providerId: "openai", model: "duplicate", enable: true }
    ],
    aiEmbeddingModels: [
      { id: "openai/emb", providerId: "openai", model: "text-embedding-3-small", dimension: 1536 },
      { id: "openai/bad-emb", providerId: "openai", model: "x", dimension: 0 }
    ]
  });
  assert.deepEqual(snapshot.chatModels.map((model) => model.id), ["openai/gpt"]);
  assert.equal(snapshot.chatModels[0]?.enable, true);
  assert.deepEqual(snapshot.embeddingModels.map((model) => model.id), ["openai/emb"]);
  assert.equal(snapshot.embeddingModels[0]?.dimension, 1536);
});

test("an absent or hostile AI settings block becomes empty arrays", () => {
  assert.deepEqual(normalizeAiSettings(undefined), { providers: [], chatModels: [], embeddingModels: [] });
  assert.deepEqual(normalizeAiSettings("nope"), { providers: [], chatModels: [], embeddingModels: [] });
  assert.deepEqual(
    normalizeAiSettings({ aiProviders: "nope", aiChatModels: {}, aiEmbeddingModels: 7 }),
    { providers: [], chatModels: [], embeddingModels: [] }
  );
});

test("provider validation explains required fields and duplicate ids", () => {
  const missing = validateProvider({ ...openai, id: "", apiKey: "" }, []);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(missing.issues.map((issue) => issue.code).sort(), ["provider-api-key-required", "provider-id-required"]);
  }

  const duplicate = validateProvider(openai, [openai]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.issues[0]?.code, "provider-id-duplicate");

  const invalidUrl = validateProvider({ ...custom, baseUrl: "file:///x" }, []);
  assert.equal(invalidUrl.ok, false);
  if (!invalidUrl.ok) assert.equal(invalidUrl.issues[0]?.code, "provider-base-url-invalid");

  const ok = validateProvider({ ...openai, id: "  openai  " }, []);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.id, "openai");
});

test("custom providers require a base URL and allow an empty API key", () => {
  const missing = validateProvider({ id: "gateway", preset: "openai-compatible", apiType: "openai-compatible" }, []);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.issues.some((issue) => issue.code === "provider-base-url-required"));

  const ok = validateProvider({
    id: "gateway",
    preset: "openai-compatible",
    apiType: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1"
  }, []);
  assert.equal(ok.ok, true);
});

test("Gemini OAuth requires the user's own Google OAuth client credentials", () => {
  const gemini: AiProviderConfig = { id: "gemini-oauth", preset: "gemini-oauth", apiType: "gemini" };
  const missing = validateProvider(gemini, []);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(missing.issues.map((issue) => issue.code), ["provider-oauth-client-required"]);
  }

  const ok = validateProvider({
    ...gemini,
    additionalSettings: {
      oauthClientId: "client-id.apps.googleusercontent.com",
      oauthClientSecret: "client-secret"
    }
  }, []);
  assert.equal(ok.ok, true);
});

test("chat model validation covers id, model, numbers and custom parameter keys", () => {
  const base: AiChatModelConfig = { id: "openai/gpt", providerId: "openai", model: "gpt", enable: true };
  assert.equal(validateChatModel(base, [], ["openai"]).ok, true);

  const duplicate = validateChatModel(base, [base], ["openai"]);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.issues[0]?.code, "model-id-duplicate");

  const empty = validateChatModel({ ...base, id: "", model: "" }, [], ["openai"]);
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.ok(empty.issues.some((issue) => issue.code === "model-id-required"));
    assert.ok(empty.issues.some((issue) => issue.code === "model-name-required"));
  }

  const badProvider = validateChatModel({ ...base, providerId: "missing" }, [], ["openai"]);
  assert.equal(badProvider.ok, false);

  const badNumber = validateChatModel({ ...base, temperature: 3 }, [], ["openai"]);
  assert.equal(badNumber.ok, false);

  const badParameter = validateChatModel({
    ...base,
    customParameters: [{ key: "bad key", type: "text", value: "x" }]
  }, [], ["openai"]);
  assert.equal(badParameter.ok, false);
});

test("embedding model validation requires a positive dimension", () => {
  const base: AiEmbeddingModelConfig = {
    id: "openai/emb",
    providerId: "openai",
    model: "text-embedding-3-small",
    dimension: 1536
  };
  assert.equal(validateEmbeddingModel(base, [], ["openai"]).ok, true);
  assert.equal(validateEmbeddingModel({ ...base, dimension: 0 }, [], ["openai"]).ok, false);
  assert.equal(validateEmbeddingModel({ ...base, dimension: 1.5 }, [], ["openai"]).ok, false);
  assert.equal(validateEmbeddingModel({ ...base, model: "" }, [], ["openai"]).ok, false);
});

test("the request preview follows each API family and appends provider suffixes", () => {
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "openai", apiType: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "openai-compatible", apiType: "openai-compatible", baseUrl: "https://gw.example.com/v1" }),
    "https://gw.example.com/v1/chat/completions"
  );
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "ollama", apiType: "openai-compatible", baseUrl: "http://127.0.0.1:11434" }),
    "http://127.0.0.1:11434/v1/chat/completions"
  );
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "anthropic", apiType: "anthropic", baseUrl: "https://api.anthropic.com" }),
    "https://api.anthropic.com/v1/messages"
  );
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "gemini", apiType: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
  );
  assert.equal(
    resolvePrimaryRequestUrl({ preset: "amazon-bedrock", apiType: "amazon-bedrock" }),
    undefined
  );
});
