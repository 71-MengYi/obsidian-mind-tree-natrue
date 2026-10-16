import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import {
  DEFAULT_MCP_READ_PORT,
  DEFAULT_MCP_WRITE_PORT,
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
  describeMcpServerStatus,
  describeMcpStatus,
  describePortFallbacks,
  enabledConnections,
  parseMcpPortInput,
  DEFAULT_MCP_HOST: reExportedHost,
  MAX_MCP_PORT: reExportedMax,
  MIN_MCP_PORT: reExportedMin
} = await import("../src/services/mcp/settings-page-model");
const { buildMcpClientConfigText } = await import("../src/services/mcp/client-config");
const { mcpUrl } = await import("../src/services/mcp/connection");
const { t } = await import("../src/i18n");

const TOKEN = "S4mpleT0kenValue_1234";
const WRITE_TOKEN = "Wr1teT0kenValue_5678";

function readEndpoint(overrides: Partial<McpEndpointState> = {}): McpEndpointState {
  return {
    port: DEFAULT_MCP_READ_PORT,
    status: { kind: "running", url: mcpUrl(DEFAULT_MCP_READ_PORT) },
    token: TOKEN,
    ...overrides
  };
}

function writeEndpoint(overrides: Partial<McpEndpointState> = {}): McpEndpointState {
  return {
    port: DEFAULT_MCP_WRITE_PORT,
    status: { kind: "running", url: mcpUrl(DEFAULT_MCP_WRITE_PORT) },
    token: WRITE_TOKEN,
    ...overrides
  };
}

function state(overrides: Partial<McpPageState> = {}): McpPageState {
  return {
    supported: true,
    enabled: true,
    read: readEndpoint(),
    writeEnabled: true,
    write: writeEndpoint(),
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

test("a server's status line is the status wording, for either group", () => {
  const running = { kind: "running", url: mcpUrl(27322) } as const;
  assert.equal(describeMcpServerStatus("read", running), describeMcpStatus(running));
  assert.equal(describeMcpServerStatus("write", running), describeMcpStatus(running));
  assert.equal(describeMcpServerStatus("write", { kind: "stopped" }), t("settings.ai.mcp.status.stopped"));
  assert.equal(
    describeMcpServerStatus("read", { kind: "failed", message: "EADDRINUSE" }),
    t("settings.ai.mcp.status.failed", { message: "EADDRINUSE" })
  );
});

// ─── page model ──────────────────────────────────────────────────────────────

test("a running, write-capable desktop setup enables every control", () => {
  const model = buildMcpPageModel(state());
  assert.equal(model.supported, true);
  assert.equal(model.heading, t("settings.ai.mcp.heading"));
  assert.equal(model.description, t("settings.ai.mcp.desc"));
  assert.deepEqual(model.enable, { value: true, disabled: false });

  assert.equal(model.read.heading, t("settings.ai.mcp.read.heading"));
  assert.equal(model.read.scope, t("settings.ai.mcp.read.scope"));
  assert.deepEqual(model.read.port, { value: DEFAULT_MCP_READ_PORT, disabled: false });
  assert.deepEqual(model.read.status, { kind: "running", text: t("settings.ai.mcp.status.running", { url: mcpUrl(27321) }) });

  assert.equal(model.write.heading, t("settings.ai.mcp.write.heading"));
  assert.equal(model.write.scope, t("settings.ai.mcp.write.scope"));
  assert.equal(model.write.value, true);
  assert.deepEqual(model.write.port, { value: DEFAULT_MCP_WRITE_PORT, disabled: false });
  assert.deepEqual(model.write.status, { kind: "running", text: t("settings.ai.mcp.status.running", { url: mcpUrl(27322) }) });

  assert.equal(model.config.visible, true);
  assert.equal(model.config.text, buildMcpClientConfigText(enabledConnections(state())));
});

test("the two server scopes are distinct and non-empty", () => {
  const model = buildMcpPageModel(state());
  assert.ok(model.read.scope.length > 0);
  assert.ok(model.write.scope.length > 0);
  assert.notEqual(model.read.scope, model.write.scope);
  assert.notEqual(model.read.heading, model.write.heading);
});

test("an unsupported platform disables every control and hides the secret", () => {
  const model = buildMcpPageModel(state({
    supported: false,
    read: readEndpoint({ status: { kind: "unsupported" } }),
    write: writeEndpoint({ status: { kind: "unsupported" } })
  }));
  assert.deepEqual(model.enable, { value: true, disabled: true });
  assert.deepEqual(model.read.port, { value: DEFAULT_MCP_READ_PORT, disabled: true });
  assert.deepEqual(model.write.port, { value: DEFAULT_MCP_WRITE_PORT, disabled: true });
  assert.equal(model.config.visible, false);
  assert.equal(model.read.status.text, t("settings.ai.mcp.status.desktopOnly"));
  // No token may be handed out by a platform that cannot serve one.
  assert.doesNotMatch(model.config.text, new RegExp(TOKEN));
  assert.doesNotMatch(model.config.text, new RegExp(WRITE_TOKEN));
});

test("both servers are shown but inert while the master switch is off", () => {
  const model = buildMcpPageModel(state({
    enabled: false,
    writeEnabled: true,
    read: readEndpoint({ status: { kind: "stopped" } }),
    write: writeEndpoint({ status: { kind: "stopped" } })
  }));
  assert.deepEqual(model.enable, { value: false, disabled: false });
  assert.deepEqual(model.read.port, { value: DEFAULT_MCP_READ_PORT, disabled: true });
  assert.equal(model.write.value, true);
  assert.deepEqual(model.write.port, { value: DEFAULT_MCP_WRITE_PORT, disabled: true });
  assert.equal(model.read.status.kind, "stopped");
  assert.equal(model.write.status.kind, "stopped");
});

test("the write switch never disables the read server, and vice versa", () => {
  // There is no per-tool permission any more: the read server runs unattended
  // whatever the write switch says, so the two controls must stay independent.
  const readOnly = buildMcpPageModel(state({ writeEnabled: false }));
  assert.deepEqual(readOnly.enable, { value: true, disabled: false });
  assert.deepEqual(readOnly.read.port, { value: DEFAULT_MCP_READ_PORT, disabled: false });
  assert.equal(readOnly.write.value, false);
  // A write server that is off cannot have its port edited into a running state.
  assert.deepEqual(readOnly.write.port, { value: DEFAULT_MCP_WRITE_PORT, disabled: true });

  const writeOnly = buildMcpPageModel(state({ writeEnabled: true }));
  assert.deepEqual(writeOnly.read.port, { value: DEFAULT_MCP_READ_PORT, disabled: false });
  assert.equal(writeOnly.write.value, true);
  assert.deepEqual(writeOnly.write.port, { value: DEFAULT_MCP_WRITE_PORT, disabled: false });
});

test("each server reports its own port and its own bound port is what the client gets", () => {
  const model = buildMcpPageModel(state({
    read: readEndpoint({ port: 1234, boundPort: 27321 }),
    write: writeEndpoint({
      port: 4321,
      boundPort: 27324,
      status: { kind: "running", url: mcpUrl(27324) },
      token: WRITE_TOKEN
    })
  }));
  // The preference is shown; the configuration must carry the port that bound.
  assert.equal(model.read.port.value, 1234);
  assert.equal(model.write.port.value, 4321);
  const parsed = JSON.parse(model.config.text) as { mcpServers: Record<string, { url: string }> };
  assert.equal(parsed.mcpServers["mind-tree-nature-read"]?.url, mcpUrl(27321));
  assert.equal(parsed.mcpServers["mind-tree-nature-write"]?.url, mcpUrl(27324));
});

test("a failed start keeps the failure message in that server's status line", () => {
  const model = buildMcpPageModel(state({
    read: readEndpoint({ status: { kind: "failed", message: "EADDRINUSE" } }),
    write: writeEndpoint({ status: { kind: "running", url: mcpUrl(27322) } })
  }));
  assert.equal(model.read.status.kind, "failed");
  assert.match(model.read.status.text, /EADDRINUSE/);
  assert.equal(model.write.status.kind, "running");
});

test("the config block stays visible while the servers are merely stopped", () => {
  const model = buildMcpPageModel(state({
    enabled: true,
    read: readEndpoint({ status: { kind: "stopped" } }),
    write: writeEndpoint({ status: { kind: "stopped" } })
  }));
  assert.equal(model.read.status.kind, "stopped");
  assert.equal(model.write.status.kind, "stopped");
  assert.equal(model.config.visible, true);
});

// ─── client connections handed to the config builder ─────────────────────────

test("no connection is advertised unless the servers are supported and enabled", () => {
  assert.deepEqual(enabledConnections(state({ enabled: false })), []);
  assert.deepEqual(enabledConnections(state({ supported: false })), []);
  assert.deepEqual(enabledConnections(state({ enabled: false, writeEnabled: true })), []);
});

test("the read entry is always there; the write entry only once its server is on", () => {
  const readOnly = enabledConnections(state({ writeEnabled: false }));
  assert.deepEqual(readOnly, [{ group: "read", port: DEFAULT_MCP_READ_PORT, token: TOKEN }]);

  const both = enabledConnections(state({ writeEnabled: true }));
  assert.deepEqual(both, [
    { group: "read", port: DEFAULT_MCP_READ_PORT, token: TOKEN },
    { group: "write", port: DEFAULT_MCP_WRITE_PORT, token: WRITE_TOKEN }
  ]);
  // Distinct tokens: the read-only entry must never carry write authority.
  assert.notEqual(both[0]?.token, both[1]?.token);
});

test("each connection prefers the bound port and falls back to the preference", () => {
  const connections = enabledConnections(state({
    read: readEndpoint({ port: 1234, boundPort: 27321 }),
    writeEnabled: true,
    write: writeEndpoint({ port: 4321, boundPort: undefined, token: WRITE_TOKEN })
  }));
  assert.deepEqual(connections, [
    { group: "read", port: 27321, token: TOKEN },
    { group: "write", port: 4321, token: WRITE_TOKEN }
  ]);
});
