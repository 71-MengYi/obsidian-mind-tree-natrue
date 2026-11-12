import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PICKER_CATEGORIES,
  AI_PROVIDER_PRESETS,
  type AiChatModelConfig,
  type AiEmbeddingModelConfig,
  type AiOAuthStatus,
  type AiProviderConfig,
  type AiSettingsState,
  type AiValidationCode
} from "../src/services/ai/contracts";
import { aiPresetLabel } from "../src/services/ai/presets";
import {
  additionalSettingLabel,
  additionalSettingOptions,
  aiPickerCategories,
  aiPickerItems,
  apiTypeLabel,
  apiTypeOptions,
  buildAiProvidersView,
  buildProviderCard,
  builtinToolOptions,
  customParameterTypeOptions,
  filterAiPickerItems,
  inferReasoningType,
  modalityOptions,
  modelConfigId,
  presetUsesOAuth,
  reasoningOptions,
  validationErrorText
} from "../src/ui/settings-pages/ai-providers-view";

const openaiProvider: AiProviderConfig = {
  id: "openai",
  preset: "openai",
  apiType: "openai-responses",
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "sk-test"
};

const chatgptProvider: AiProviderConfig = { id: "chatgpt", preset: "chatgpt-oauth", apiType: "openai-responses" };
const deepseekProvider: AiProviderConfig = { id: "deepseek", preset: "deepseek", apiType: "openai-compatible" };
const ollamaProvider: AiProviderConfig = { id: "ollama", preset: "ollama", apiType: "openai-compatible" };

const chatModels: AiChatModelConfig[] = [
  { id: "fast", providerId: "openai", model: "gpt-4o", name: "Fast", enable: true },
  { id: "deep", providerId: "openai", model: "o3", enable: false },
  { id: "chat", providerId: "deepseek", model: "deepseek-chat", enable: true }
];

const embeddingModels: AiEmbeddingModelConfig[] = [
  { id: "small", providerId: "openai", model: "text-embedding-3-small", dimension: 1536 },
  { id: "large", providerId: "openai", model: "text-embedding-3-large", name: "Large", dimension: 3072 }
];

function stateWith(
  providers: AiProviderConfig[],
  oauth: Record<string, AiOAuthStatus> = {},
  options: { supported?: boolean; isDesktop?: boolean } = {}
): AiSettingsState {
  return {
    supported: options.supported ?? true,
    isDesktop: options.isDesktop ?? true,
    providers,
    chatModels,
    embeddingModels,
    oauth
  };
}

test("renders section copy, the count and an empty state without providers", () => {
  const empty = stateWith([]);
  const en = buildAiProvidersView(empty, "en");
  assert.equal(en.heading, "Model providers");
  assert.equal(en.count, 0);
  assert.equal(en.countText, "0 configured");
  assert.equal(en.supported, true);
  assert.equal(en.unsupportedText, undefined);
  assert.deepEqual(en.cards, []);
  assert.match(en.emptyText, /No model providers yet/);

  const zh = buildAiProvidersView(empty, "zh");
  assert.equal(zh.heading, "模型提供商");
  assert.equal(zh.countText, "已配置 0 个");
  assert.match(zh.emptyText, /还没有模型提供商/);
});

test("describes an unsupported platform instead of pretending it is configured", () => {
  const view = buildAiProvidersView(stateWith([], {}, { supported: false }), "en");
  assert.equal(view.supported, false);
  assert.match(view.unsupportedText ?? "", /desktop only/);
});

test("builds one card per provider with its label, API type and resolved endpoint", () => {
  const view = buildAiProvidersView(stateWith([openaiProvider, ollamaProvider]), "en");
  assert.equal(view.cards.length, 2);
  const [openai, ollama] = view.cards;
  assert.equal(openai?.id, "openai");
  assert.equal(openai?.presetLabel, "OpenAI");
  assert.equal(openai?.apiTypeLabel, "OpenAI Responses");
  assert.equal(openai?.baseUrl, "https://gateway.example.com/v1");
  assert.equal(openai?.baseUrlIsDefault, false);
  assert.equal(openai?.connection.kind, "api-key");
  assert.equal(openai?.connection.text, "API key configured");

  assert.equal(ollama?.apiTypeLabel, "OpenAI compatible");
  assert.equal(ollama?.baseUrl, "http://127.0.0.1:11434");
  assert.equal(ollama?.baseUrlIsDefault, true);
  assert.equal(ollama?.connection.kind, "no-credential-required");
});

test("lists models by provider, in stored order, with a display-name fallback", () => {
  const card = buildProviderCard(openaiProvider, stateWith([openaiProvider]), "en");
  assert.deepEqual(card.chatModels, [
    { id: "fast", providerId: "openai", model: "gpt-4o", name: "Fast", enabled: true },
    { id: "deep", providerId: "openai", model: "o3", name: "o3", enabled: false }
  ]);
  assert.deepEqual(card.embeddingModels, [
    { id: "small", providerId: "openai", model: "text-embedding-3-small", name: "text-embedding-3-small", dimension: 1536 },
    { id: "large", providerId: "openai", model: "text-embedding-3-large", name: "Large", dimension: 3072 }
  ]);
  assert.equal(card.supportsEmbedding, true);
  assert.equal(card.chatEmpty, "No chat models yet.");
  assert.equal(card.embeddingEmpty, "No embedding models yet.");
});

test("a provider without models still says what its tables are for", () => {
  const deepseek = buildProviderCard(deepseekProvider, stateWith([deepseekProvider]), "en");
  assert.deepEqual(deepseek.chatModels, [
    { id: "chat", providerId: "deepseek", model: "deepseek-chat", name: "deepseek-chat", enabled: true }
  ]);
  assert.equal(deepseek.supportsEmbedding, false);
  assert.equal(deepseek.embeddingEmpty, "This provider does not offer embedding models.");
  assert.equal(deepseek.connection.kind, "no-api-key");

  const empty = buildProviderCard(ollamaProvider, stateWith([ollamaProvider]), "en");
  assert.deepEqual(empty.chatModels, []);
  assert.deepEqual(empty.embeddingModels, []);
  assert.equal(empty.chatEmpty, "No chat models yet.");
  assert.equal(empty.embeddingEmpty, "No embedding models yet.");

  const supported = buildProviderCard(openaiProvider, stateWith([openaiProvider]), "en");
  assert.equal(supported.embeddingEmpty, "No embedding models yet.");
});

test("maps every OAuth state onto a card status and panel", () => {
  const connected = buildProviderCard(
    chatgptProvider,
    stateWith([chatgptProvider], { chatgpt: { state: "connected", account: "me@example.com" } }),
    "en"
  );
  assert.equal(connected.connection.kind, "oauth-connected");
  assert.equal(connected.connection.text, "OAuth connected as me@example.com");
  assert.equal(connected.oauth?.status, "connected");
  assert.equal(connected.oauth?.statusText, "Connected as me@example.com.");
  assert.equal(connected.oauth?.showManualToken, false);
  assert.equal(connected.oauth?.actionsDisabled, false);

  const pending = buildProviderCard(
    chatgptProvider,
    stateWith([chatgptProvider], {
      chatgpt: { state: "pending", userCode: "ABCD-1234", verificationUri: "https://example.com/device" }
    }),
    "en"
  );
  assert.equal(pending.connection.kind, "oauth-pending");
  assert.equal(pending.oauth?.userCode, "ABCD-1234");
  assert.equal(pending.oauth?.verificationUri, "https://example.com/device");
  assert.equal(pending.oauth?.statusText, "Enter the code ABCD-1234 on the verification page.");
  assert.equal(pending.oauth?.showManualToken, true);

  // Browser flows have no device code: an empty user code must not render an
  // empty "Enter the code ..." sentence.
  const browserPending = buildProviderCard(
    chatgptProvider,
    stateWith([chatgptProvider], {
      chatgpt: { state: "pending", userCode: "", verificationUri: "https://example.com/authorize" }
    }),
    "en"
  );
  assert.equal(browserPending.oauth?.userCode, undefined);
  assert.equal(browserPending.oauth?.statusText, "Waiting for you to finish signing in…");
  assert.equal(browserPending.oauth?.verificationUri, "https://example.com/authorize");

  const failed = buildProviderCard(
    chatgptProvider,
    stateWith([chatgptProvider], { chatgpt: { state: "error", message: "denied" } }),
    "en"
  );
  assert.equal(failed.connection.kind, "oauth-error");
  assert.equal(failed.connection.text, "OAuth error: denied");
  assert.equal(failed.oauth?.statusText, "Sign-in failed: denied");
  assert.equal(failed.oauth?.message, "denied");

  const disconnected = buildProviderCard(chatgptProvider, stateWith([chatgptProvider]), "en");
  assert.equal(disconnected.connection.kind, "oauth-disconnected");
  assert.equal(disconnected.connection.text, "Not connected");
  assert.equal(disconnected.oauth?.statusText, "Not connected.");
});

test("non-OAuth providers carry no OAuth panel", () => {
  const card = buildProviderCard(openaiProvider, stateWith([openaiProvider]), "en");
  assert.equal(card.oauth, undefined);
  assert.equal(presetUsesOAuth("openai"), false);
  assert.equal(presetUsesOAuth("chatgpt-oauth"), true);
  assert.equal(presetUsesOAuth("claude-oauth"), true);
  assert.equal(presetUsesOAuth("gemini-oauth"), true);
  assert.equal(presetUsesOAuth("github-copilot"), true);
});

test("disables OAuth actions off desktop and says why", () => {
  const card = buildProviderCard(
    chatgptProvider,
    stateWith([chatgptProvider], {}, { isDesktop: false }),
    "en"
  );
  assert.equal(card.oauth?.actionsDisabled, true);
  assert.match(card.oauth?.disabledHint ?? "", /desktop only/);
  // The rest of the provider settings stay usable on mobile.
  assert.equal(card.oauth?.showManualToken, true);
});

test("the picker offers every preset under translated category chips", () => {
  const categories = aiPickerCategories("en");
  assert.deepEqual(categories.map((category) => category.id), ["all", ...AI_PICKER_CATEGORIES]);
  assert.equal(categories[0]?.label, "All");
  assert.equal(categories[1]?.label, "Main");
  const zh = aiPickerCategories("zh");
  assert.equal(zh[0]?.label, "全部");
  assert.equal(zh[3]?.label, "网关");

  const items = aiPickerItems("en");
  assert.equal(items.length, AI_PROVIDER_PRESETS.length);
  assert.equal(items[0]?.label, aiPresetLabel("openai"));
  const custom = items[items.length - 1];
  assert.equal(custom?.preset, "openai-compatible");
  assert.equal(custom?.custom, true);
  assert.equal(custom?.label, "Custom provider");
  // Brand labels stay untranslated; only the custom tile is UI copy.
  assert.equal(items.find((item) => item.preset === "deepseek")?.label, "DeepSeek");
  assert.equal(aiPickerItems("zh").find((item) => item.preset === "deepseek")?.label, "DeepSeek");
  assert.equal(aiPickerItems("zh")[aiPickerItems("zh").length - 1]?.label, "自定义提供商");
});

test("filters the picker by category and search, keeping the custom fallback", () => {
  const cn = filterAiPickerItems("", "cn", "en");
  assert.ok(cn.some((item) => item.preset === "deepseek"));
  assert.ok(cn.every((item) => item.category === "cn" || item.custom));
  assert.ok(!cn.some((item) => item.preset === "openai"));

  const all = filterAiPickerItems("", "all", "en");
  assert.equal(all.length, AI_PROVIDER_PRESETS.length);
  assert.equal(all[all.length - 1]?.custom, true, "the custom tile stays last");

  const gpt = filterAiPickerItems("GPT", "all", "en").map((item) => item.preset);
  assert.deepEqual(gpt, ["chatgpt-oauth"]);

  const customSearch = filterAiPickerItems("openai-compatible", "local", "en").map((item) => item.preset);
  assert.deepEqual(customSearch, ["openai-compatible"], "the custom tile ignores a category filter");

  const customLabel = filterAiPickerItems("custom provider", "cloud", "en").map((item) => item.preset);
  assert.deepEqual(customLabel, ["openai-compatible"]);

  assert.deepEqual(filterAiPickerItems("no-such-provider", "all", "en"), []);
  assert.deepEqual(filterAiPickerItems("  ", "all", "en"), all, "blank search keeps everything");
});

test("provider form offers only the API types the preset supports", () => {
  assert.deepEqual(apiTypeOptions("chatgpt-oauth", "en").map((option) => option.value), ["openai-responses"]);
  assert.deepEqual(apiTypeOptions("gemini-oauth", "en").map((option) => option.value), ["gemini"]);
  assert.deepEqual(apiTypeOptions("azure-openai", "en").map((option) => option.value), ["openai-compatible"]);
  assert.deepEqual(apiTypeOptions("amazon-bedrock", "en").map((option) => option.value), [
    "amazon-bedrock",
    "openai-compatible"
  ]);
  assert.deepEqual(apiTypeOptions("openai", "en").map((option) => option.value), [
    "openai-compatible",
    "openai-responses",
    "anthropic",
    "gemini"
  ]);
  assert.equal(apiTypeOptions("openai", "en")[1]?.label, "OpenAI Responses");
  assert.equal(apiTypeLabel("anthropic", "zh"), "Anthropic Messages");
});

test("additional-setting labels and select choices are localized", () => {
  for (const key of [
    "requestTransportMode",
    "responseStreamingMode",
    "promptCaching",
    "noStainless",
    "projectId",
    "deployment",
    "apiVersion",
    "awsRegion",
    "oauthClientId",
    "oauthClientSecret"
  ] as const) {
    assert.notEqual(additionalSettingLabel(key, "en"), key);
    assert.ok(additionalSettingLabel(key, "zh").length > 0);
  }
  assert.equal(additionalSettingLabel("promptCaching", "en"), "Prompt caching");
  assert.equal(additionalSettingLabel("noStainless", "zh"), "跳过 Stainless SDK");

  const transport = additionalSettingOptions("requestTransportMode", "en");
  assert.deepEqual(transport?.map((option) => option.value), ["browser", "obsidian", "node"]);
  assert.equal(transport?.[0]?.label, "Browser request");
  assert.equal(additionalSettingOptions("requestTransportMode", "zh")?.[2]?.label, "桌面端直连");
  assert.deepEqual(additionalSettingOptions("responseStreamingMode", "en")?.map((option) => option.value), [
    "auto",
    "streaming",
    "non-streaming"
  ]);
  assert.equal(additionalSettingOptions("projectId", "en"), undefined);
});

test("model form option lists are complete and localized", () => {
  assert.deepEqual(reasoningOptions("en").map((option) => option.value), ["none", "openai", "gemini", "anthropic"]);
  assert.deepEqual(modalityOptions("en").map((option) => option.value), ["text", "vision", "pdf"]);
  assert.deepEqual(builtinToolOptions("en").map((option) => option.value), [
    "none",
    "gemini",
    "gpt",
    "openrouter",
    "grok",
    "deepseek"
  ]);
  assert.deepEqual(customParameterTypeOptions("en").map((option) => option.value), [
    "text",
    "number",
    "boolean",
    "json"
  ]);
  assert.equal(modalityOptions("zh")[1]?.label, "图片");
  assert.equal(reasoningOptions("zh")[0]?.label, "无");
});

test("maps every validation code to a sentence, never to the raw code", () => {
  const codes: AiValidationCode[] = [
    "provider-id-required",
    "provider-id-invalid",
    "provider-id-duplicate",
    "provider-api-key-required",
    "provider-base-url-required",
    "provider-base-url-invalid",
    "provider-oauth-client-required",
    "model-id-required",
    "model-id-duplicate",
    "model-name-required",
    "model-number-invalid",
    "model-parameter-invalid"
  ];
  for (const code of codes) {
    for (const language of ["en", "zh"]) {
      const sentence = validationErrorText(code, language);
      assert.ok(sentence.length > 0, language + ": " + code);
      assert.notEqual(sentence, code, language + ": " + code);
      assert.doesNotMatch(sentence, /\{\w+\}/, language + ": " + code);
    }
  }
  assert.equal(validationErrorText("provider-id-required", "en"), "Enter a provider ID.");
  assert.equal(validationErrorText("provider-base-url-invalid", "zh"), "请填写有效的 http 或 https 地址，且不能包含凭据。");
  assert.equal(validationErrorText("model-id-required", "en"), "Enter a model ID.");
  assert.equal(validationErrorText("model-name-required", "zh"), "请填写模型标识。");
  assert.notEqual(validationErrorText("model-number-invalid", "zh"), validationErrorText("model-number-invalid", "en"));
});

test("the card heading uses the stored provider id, not a translated placeholder", () => {
  const card = buildProviderCard({ ...openaiProvider, id: "work-openai" }, stateWith([]), "zh");
  assert.equal(card.id, "work-openai");
  assert.equal(card.presetLabel, "OpenAI");
  assert.equal(card.apiTypeLabel, "OpenAI Responses");
  assert.equal(card.connection.text, "已配置 API Key");
});

test("catalog model ids use provider/model and grow a numeric suffix only when taken", () => {
  assert.equal(modelConfigId("openai", "gpt-4o", []), "openai/gpt-4o");
  assert.equal(modelConfigId("openai", "gpt-4o", ["openai/other"]), "openai/gpt-4o");
  assert.equal(modelConfigId("openai", "gpt-4o", new Set(["openai/gpt-4o"])), "openai/gpt-4o-2");
  assert.equal(
    modelConfigId("openai", "gpt-4o", ["openai/gpt-4o", "openai/gpt-4o-2"]),
    "openai/gpt-4o-3"
  );
  assert.equal(
    modelConfigId("openai", "gpt-4o", new Set(["openai/gpt-4o", "openai/gpt-4o-2", "openai/gpt-4o-3"])),
    "openai/gpt-4o-4",
    "the suffix keeps growing past the first collision"
  );
  // The generated ids must satisfy the model id pattern the host validates.
  for (const id of [
    modelConfigId("deepseek", "deepseek-chat", []),
    modelConfigId("gemini", "models/gemini-2.5-pro", []),
    modelConfigId("openrouter", "anthropic/claude-sonnet-4", ["openrouter/anthropic/claude-sonnet-4"])
  ]) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/);
  }
});

test("infers the reasoning protocol from the catalog model name", () => {
  assert.equal(inferReasoningType("gpt-4o"), "openai");
  assert.equal(inferReasoningType("GPT-4.1-mini"), "openai");
  assert.equal(inferReasoningType("o3-mini"), "openai");
  assert.equal(inferReasoningType("openai/o4-mini"), "openai");
  assert.equal(inferReasoningType("deepseek-chat"), "openai");
  assert.equal(inferReasoningType("DeepSeek-V3"), "openai");
  assert.equal(inferReasoningType("gemini-2.5-pro"), "gemini");
  assert.equal(inferReasoningType("models/gemini-2.5-flash"), "gemini");
  assert.equal(inferReasoningType("claude-sonnet-4"), "anthropic");
  assert.equal(inferReasoningType("anthropic/claude-opus-4"), "anthropic");
  assert.equal(inferReasoningType("mistral-large-latest"), "none");
  assert.equal(inferReasoningType("llama-3.3-70b-instruct"), "none");
  assert.equal(inferReasoningType("qwen2.5-coder"), "none");
  // "o3"/"o4" only count as trimmed tokens, so an embedded letter pair stays none.
  assert.equal(inferReasoningType("command-a3b"), "none");
});
