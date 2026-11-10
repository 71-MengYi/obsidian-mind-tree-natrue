import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  DEFAULT_MCP_PORT,
  MAX_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  MIN_MCP_PORT
} from "../src/settings-model";
import type { McpEndpointState, McpPageState } from "../src/services/mcp/settings-page-model";

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
// The stub source carries a file-specific marker so this file's module URL is
// unique: `--test-isolation=none` shares one process-wide ESM cache keyed by URL.
const OBSIDIAN_STUB = "data:text/javascript," + encodeURIComponent(
  '// obsidian stub for mcp-settings-page-model.test.ts\nexport const getLanguage = () => "en";\n'
);
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {\n" +
  '  if (specifier === "obsidian" && context.parentURL?.endsWith("/i18n/index.ts")) {\n' +
  `    return { url: ${JSON.stringify(OBSIDIAN_STUB)}, shortCircuit: true };\n` +
  "  }\n" +
  "  return next(specifier, context);\n" +
  "}\n"
));
const {
  buildMcpPageModel,
  describeMcpStatus,
  describePortFallbacks,
  enabledConnections,
  parseMcpPortInput,
  DEFAULT_MCP_HOST: reExportedHost,
  MAX_MCP_PORT: reExportedMax,
  MIN_MCP_PORT: reExportedMin
} = await import("../src/services/mcp/settings-page-model");
const { buildMcpClientConfigText } = await import("../src/services/mcp/client-config");
const { MCP_SERVER_NAME, mcpUrl } = await import("../src/services/mcp/connection");
const { t } = await import("../src/i18n");

const TOKEN = "S4mpleT0kenValue_1234";

function serverEndpoint(overrides: Partial<McpEndpointState> = {}): McpEndpointState {
  return {
    port: DEFAULT_MCP_PORT,
    status: { kind: "running", url: mcpUrl(DEFAULT_MCP_PORT) },
    token: TOKEN,
    ...overrides
  };
}

function state(overrides: Partial<McpPageState> = {}): McpPageState {
  return {
    supported: true,
    enabled: true,
    server: serverEndpoint(),
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

test("the fallback count and the port bounds are the shared settings values", () => {
  assert.equal(describePortFallbacks(), MCP_PORT_FALLBACK_ATTEMPTS);
  assert.equal(reExportedMin, MIN_MCP_PORT);
  assert.equal(reExportedMax, MAX_MCP_PORT);
  assert.equal(reExportedHost, "127.0.0.1");
  // The merged single server reuses the original port so installed client
  // configurations keep working after the upgrade.
  assert.equal(DEFAULT_MCP_PORT, 27321);
});

// ─── status wording ──────────────────────────────────────────────────────────

test("every status kind is described through the catalog", () => {
  const running = describeMcpStatus({ kind: "running", url: mcpUrl(27321) });
  assert.equal(running, t("settings.ai.mcp.status.running", { url: mcpUrl(27321) }));
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

test("a running desktop setup enables the master switch and the one server", () => {
  const model = buildMcpPageModel(state());
  assert.equal(model.supported, true);
  assert.equal(model.heading, t("settings.ai.mcp.heading"));
  assert.equal(model.description, t("settings.ai.mcp.desc"));
  assert.deepEqual(model.enable, { value: true, disabled: false });

  assert.equal(model.server.heading, t("settings.ai.mcp.server.heading"));
  assert.equal(model.server.scope, t("settings.ai.mcp.server.scope"));
  assert.deepEqual(model.server.port, { value: DEFAULT_MCP_PORT, disabled: false });
  assert.deepEqual(model.server.status, {
    kind: "running",
    text: t("settings.ai.mcp.status.running", { url: mcpUrl(DEFAULT_MCP_PORT) })
  });
  assert.equal(model.server.disabled, false);

  assert.equal(model.config.visible, true);
  assert.equal(model.config.text, buildMcpClientConfigText(enabledConnections(state())));
});

test("the server heading and scope are the dedicated merged-server strings", () => {
  const model = buildMcpPageModel(state());
  assert.ok(model.server.heading.length > 0);
  assert.ok(model.server.scope.length > 0);
  // The merged model has one scope, and it is not the page's own heading.
  assert.notEqual(model.server.heading, model.heading);
  assert.equal(model.server.heading, t("settings.ai.mcp.server.heading"));
  assert.equal(model.server.scope, t("settings.ai.mcp.server.scope"));
});

test("an unsupported platform disables every control and hides the secret", () => {
  const model = buildMcpPageModel(state({
    supported: false,
    server: serverEndpoint({ status: { kind: "unsupported" } })
  }));
  assert.deepEqual(model.enable, { value: true, disabled: true });
  assert.deepEqual(model.server.port, { value: DEFAULT_MCP_PORT, disabled: true });
  assert.equal(model.server.disabled, true);
  assert.equal(model.config.visible, false);
  assert.equal(model.server.status.text, t("settings.ai.mcp.status.desktopOnly"));
  // No token may be handed out by a platform that cannot serve one.
  assert.doesNotMatch(model.config.text, new RegExp(TOKEN));
});

test("the server is shown but inert while the master switch is off", () => {
  const model = buildMcpPageModel(state({
    enabled: false,
    server: serverEndpoint({ status: { kind: "stopped" } })
  }));
  assert.deepEqual(model.enable, { value: false, disabled: false });
  assert.deepEqual(model.server.port, { value: DEFAULT_MCP_PORT, disabled: true });
  assert.equal(model.server.disabled, true);
  assert.equal(model.server.status.kind, "stopped");
});

test("the preferred port is shown, and the client gets the port that actually bound", () => {
  const model = buildMcpPageModel(state({ server: serverEndpoint({ port: 1234, boundPort: 27321 }) }));
  assert.equal(model.server.port.value, 1234);

  const parsed = JSON.parse(model.config.text) as {
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  assert.deepEqual(Object.keys(parsed.mcpServers), [MCP_SERVER_NAME]);
  assert.equal(parsed.mcpServers[MCP_SERVER_NAME]?.url, mcpUrl(27321));
  assert.equal(parsed.mcpServers[MCP_SERVER_NAME]?.headers.Authorization, `Bearer ${TOKEN}`);
});

test("the configuration advertises exactly the one merged server", () => {
  const model = buildMcpPageModel(state());
  const parsed = JSON.parse(model.config.text) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed.mcpServers), [MCP_SERVER_NAME]);
  assert.equal(MCP_SERVER_NAME, "mind-tree-nature");
  // The retired read/write entries must never come back.
  assert.doesNotMatch(model.config.text, /mind-tree-nature-(?:read|write)/);
});

test("a failed start keeps the failure message in the server status line", () => {
  const model = buildMcpPageModel(state({
    server: serverEndpoint({ status: { kind: "failed", message: "EADDRINUSE" } })
  }));
  assert.equal(model.server.status.kind, "failed");
  assert.match(model.server.status.text, /EADDRINUSE/);
});

test("the config block stays visible while the server is merely stopped", () => {
  const model = buildMcpPageModel(state({ server: serverEndpoint({ status: { kind: "stopped" } }) }));
  assert.equal(model.server.status.kind, "stopped");
  // Visibility follows support, not the live status: an enabled server that is
  // between restarts still documents its configuration.
  assert.equal(model.config.visible, true);
  const parsed = JSON.parse(model.config.text) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(parsed.mcpServers), [MCP_SERVER_NAME]);
});

// ─── client connections handed to the config builder ─────────────────────────

test("no connection is advertised unless the server is supported and enabled", () => {
  assert.deepEqual(enabledConnections(state({ enabled: false })), []);
  assert.deepEqual(enabledConnections(state({ supported: false })), []);
});

test("one enabled server advertises one connection", () => {
  assert.deepEqual(enabledConnections(state()), [{ port: DEFAULT_MCP_PORT, token: TOKEN }]);
});

test("the connection prefers the bound port and falls back to the preference", () => {
  assert.deepEqual(
    enabledConnections(state({ server: serverEndpoint({ port: 1234, boundPort: 27321 }) })),
    [{ port: 27321, token: TOKEN }]
  );
  assert.deepEqual(
    enabledConnections(state({ server: serverEndpoint({ port: 4321, boundPort: undefined }) })),
    [{ port: 4321, token: TOKEN }]
  );
});
