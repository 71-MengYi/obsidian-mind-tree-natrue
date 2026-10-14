import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { MAX_MCP_PORT, MCP_PORT_FALLBACK_ATTEMPTS, MIN_MCP_PORT } from "../src/settings-model";

// `describeMcpStatus`, `buildMcpPageModel` and `describePortFallbacks` produce
// display text, so the page model needs the same host language value any real
// render would use. Everything else in the module is pure.
//
// `module.register` (Node >= 20.6) is used instead of `module.registerHooks`
// (Node >= 22.15) because AGENTS.md and the release workflow pin this project at
// Node >= 20: a test that only runs on a newer runtime is not runnable on a
// supported one. The hook is scoped to the i18n facade itself - not to every
// `obsidian` import - so it cannot mask a real resolution failure elsewhere, and
// because async hooks cannot be removed it must never answer for another module.
const OBSIDIAN_STUB = "data:text/javascript," + encodeURIComponent('export const getLanguage = () => "en";\n');
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {\n" +
  '  if (specifier === "obsidian" && context.parentURL?.endsWith("/i18n/index.ts")) {\n' +
  `    return { url: ${JSON.stringify(OBSIDIAN_STUB)}, shortCircuit: true };\n` +
  "  }\n" +
  "  return next(specifier, context);\n" +
  "}\n"
));
const {
  buildMcpConfigText,
  buildMcpPageModel,
  describeMcpStatus,
  describePortFallbacks,
  parseMcpPortInput,
  resolveConfiguredPort,
  MAX_MCP_PORT: reExportedMax,
  MIN_MCP_PORT: reExportedMin
} = await import("../src/services/mcp/settings-page-model");
const { buildMcpClientConfig, buildMcpClientConfigText } = await import("../src/services/mcp/client-config");
const { t } = await import("../src/i18n");


const TOKEN = "S4mpleT0kenValue_1234";

function state(overrides: Partial<Parameters<typeof buildMcpPageModel>[0]> = {}) {
  return {
    supported: true,
    enabled: true,
    allowWrites: true,
    port: 27321,
    status: { kind: "running", url: "http://127.0.0.1:27321/mcp" } as const,
    configuredPort: 27321,
    token: TOKEN,
    ...overrides
  };
}

// ─── port parsing ────────────────────────────────────────────────────────────

test("a whole number inside the bindable range is accepted", () => {
  assert.equal(parseMcpPortInput("27321"), 27321);
  assert.equal(parseMcpPortInput(String(MIN_MCP_PORT)), MIN_MCP_PORT);
  assert.equal(parseMcpPortInput(String(MAX_MCP_PORT)), MAX_MCP_PORT);
  assert.equal(parseMcpPortInput("  8080 "), 8080);
});

test("anything outside the range or not a whole number is rejected", () => {
  for (const raw of ["", " ", "abc", "0", String(MIN_MCP_PORT - 1), String(MAX_MCP_PORT + 1), "999999"]) {
    assert.equal(parseMcpPortInput(raw), undefined, raw);
  }
  for (const raw of ["12.5", "-1", "1e3", "0x100", "27 321", "+27321"]) {
    assert.equal(parseMcpPortInput(raw), undefined, raw);
  }
});

test("the configured port falls back to the lowest bindable port", () => {
  assert.equal(resolveConfiguredPort(27321), 27321);
  assert.equal(resolveConfiguredPort(MIN_MCP_PORT), MIN_MCP_PORT);
  for (const broken of [0, -5, 1023, 70000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveConfiguredPort(broken), MIN_MCP_PORT, String(broken));
  }
});

test("the fallback count and the port bounds are the shared settings values", () => {
  assert.equal(describePortFallbacks(), MCP_PORT_FALLBACK_ATTEMPTS);
  assert.equal(reExportedMin, MIN_MCP_PORT);
  assert.equal(reExportedMax, MAX_MCP_PORT);
});

// ─── client configuration text ───────────────────────────────────────────────

test("the config text is the same block the client-config builder produces", () => {
  assert.equal(buildMcpConfigText(27321, TOKEN), buildMcpClientConfigText(27321, TOKEN));
  assert.deepEqual(JSON.parse(buildMcpConfigText(27321, TOKEN)), buildMcpClientConfig(27321, TOKEN));
});

test("the config text points at the live loopback endpoint with the token in a header", () => {
  const parsed = JSON.parse(buildMcpConfigText(27321, TOKEN)) as {
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  const server = parsed.mcpServers["mind-tree-nature"];
  assert.equal(server?.url, "http://127.0.0.1:27321/mcp");
  assert.equal(server?.headers.Authorization, `Bearer ${TOKEN}`);
});

// ─── status wording ──────────────────────────────────────────────────────────

test("every status kind is described through the catalog", () => {
  const running = describeMcpStatus({ kind: "running", url: "http://127.0.0.1:27321/mcp" });
  assert.equal(running, t("settings.ai.mcp.status.running", { url: "http://127.0.0.1:27321/mcp" }));
  assert.match(running, /127\.0\.0\.1:27321/);

  assert.equal(describeMcpStatus({ kind: "stopped" }), t("settings.ai.mcp.status.stopped"));
  assert.equal(describeMcpStatus({ kind: "unsupported" }), t("settings.ai.mcp.status.desktopOnly"));
  assert.equal(
    describeMcpStatus({ kind: "failed", message: "port busy" }),
    t("settings.ai.mcp.status.failed", { message: "port busy" })
  );

  for (const text of [running, describeMcpStatus({ kind: "stopped" })]) {
    assert.doesNotMatch(text, /^settings\./, "raw i18n keys must never reach the page");
  }
});

// ─── page model ──────────────────────────────────────────────────────────────

test("a running, writable desktop server enables every control", () => {
  const model = buildMcpPageModel(state());
  assert.equal(model.supported, true);
  assert.equal(model.heading, t("settings.ai.mcp.heading"));
  assert.equal(model.description, t("settings.ai.mcp.desc"));
  assert.deepEqual(model.enable, { value: true, disabled: false });
  assert.deepEqual(model.writes, { value: true, disabled: false });
  assert.deepEqual(model.port, { value: 27321, disabled: false });
  assert.deepEqual(model.status, { kind: "running", text: t("settings.ai.mcp.status.running", { url: "http://127.0.0.1:27321/mcp" }) });
  assert.equal(model.config.visible, true);
});

test("an unsupported platform disables the controls and hides the secret", () => {
  const model = buildMcpPageModel(state({ supported: false, status: { kind: "unsupported" } }));
  assert.deepEqual(model.enable, { value: true, disabled: true });
  assert.deepEqual(model.port, { value: 27321, disabled: true });
  assert.deepEqual(model.writes, { value: true, disabled: true });
  assert.equal(model.config.visible, false);
  assert.equal(model.status.text, t("settings.ai.mcp.status.desktopOnly"));
});

test("the write switch is shown but inert while the server is off", () => {
  const model = buildMcpPageModel(state({ enabled: false, allowWrites: true, status: { kind: "stopped" } }));
  assert.deepEqual(model.writes, { value: true, disabled: true });
  assert.deepEqual(model.enable, { value: false, disabled: false });
  assert.equal(model.status.kind, "stopped");
});

test("a writable-capable server still reports the user's write preference", () => {
  const model = buildMcpPageModel(state({ allowWrites: false }));
  assert.deepEqual(model.writes, { value: false, disabled: false });
});

test("the config text uses the port the server actually bound", () => {
  const model = buildMcpPageModel(state({ port: 1234, configuredPort: 27321 }));
  assert.equal(model.config.text, buildMcpConfigText(27321, TOKEN));
  assert.equal(model.port.value, 1234);
});

test("a failed start keeps the failure message in the status line", () => {
  const model = buildMcpPageModel(state({ enabled: true, status: { kind: "failed", message: "EADDRINUSE" } }));
  assert.equal(model.status.kind, "failed");
  assert.match(model.status.text, /EADDRINUSE/);
});

test("the config block stays visible while the server is merely stopped", () => {
  const model = buildMcpPageModel(state({ enabled: false, status: { kind: "stopped" } }));
  assert.equal(model.status.kind, "stopped");
  assert.equal(model.config.visible, true);
});
