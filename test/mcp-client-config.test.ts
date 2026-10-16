import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MCP_HOST, MCP_ENDPOINT_PATH, mcpServerName, mcpUrl } from "../src/services/mcp/connection";
import {
  buildMcpClientConfig,
  buildMcpClientConfigText,
  serializeMcpClientConfig,
  type McpClientServerConnection
} from "../src/services/mcp/client-config";

const TOKEN = "S4mpleT0kenValue_1234";
const WRITE_TOKEN = "Wr1teT0kenValue_5678";

const READ: McpClientServerConnection = { group: "read", port: 27321, token: TOKEN };
const WRITE: McpClientServerConnection = { group: "write", port: 27322, token: WRITE_TOKEN };

function serverOf(connections: readonly McpClientServerConnection[], group: "read" | "write") {
  const config = buildMcpClientConfig(connections);
  const server = config.mcpServers[mcpServerName(group)];
  assert.ok(server, `the configuration must contain the ${group} server`);
  return server;
}

test("the configured URL is the loopback endpoint from the connection contract", () => {
  const server = serverOf([READ], "read");
  assert.equal(server.url, mcpUrl(27321));
  assert.equal(server.url, `http://${DEFAULT_MCP_HOST}:27321${MCP_ENDPOINT_PATH}`);
  assert.equal(MCP_ENDPOINT_PATH, "/mcp");
});

test("the port is used verbatim, without a default being substituted", () => {
  assert.match(serverOf([{ group: "read", port: 1024, token: TOKEN }], "read").url, /:1024\/mcp$/);
  assert.match(serverOf([{ group: "write", port: 65535, token: TOKEN }], "write").url, /:65535\/mcp$/);
});

test("the token travels in the Authorization header, never in the URL", () => {
  const server = serverOf([READ], "read");
  assert.equal(server.headers.Authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(server.url, new RegExp(TOKEN));
});

test("each entry is named after its own group and keyed by that name", () => {
  const config = buildMcpClientConfig([READ, WRITE]);
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["mind-tree-nature-read", "mind-tree-nature-write"]);
  assert.equal(mcpServerName("read"), "mind-tree-nature-read");
  assert.equal(mcpServerName("write"), "mind-tree-nature-write");
});

test("each entry keeps its own port and token, so the two servers never swap", () => {
  const config = buildMcpClientConfig([READ, WRITE]);
  const read = config.mcpServers[mcpServerName("read")];
  const write = config.mcpServers[mcpServerName("write")];
  assert.equal(read?.url, mcpUrl(27321));
  assert.equal(read?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(write?.url, mcpUrl(27322));
  assert.equal(write?.headers.Authorization, `Bearer ${WRITE_TOKEN}`);
  // A read-only configuration must never carry the token that unlocks writes.
  assert.notEqual(read?.headers.Authorization, write?.headers.Authorization);
});

test("only the servers the caller passes are advertised", () => {
  // The write entry is opt-in: a client configuration must never point at a
  // server the plugin is not serving.
  const readOnly = buildMcpClientConfig([READ]);
  assert.deepEqual(Object.keys(readOnly.mcpServers), [mcpServerName("read")]);
  assert.equal(Object.hasOwn(readOnly.mcpServers, mcpServerName("write")), false);

  const both = buildMcpClientConfig([READ, WRITE]);
  assert.equal(Object.hasOwn(both.mcpServers, mcpServerName("write")), true);

  assert.deepEqual(buildMcpClientConfig([]).mcpServers, {});
  assert.deepEqual(Object.keys(buildMcpClientConfig([])), ["mcpServers"]);
});

test("the serialized form is pretty JSON that round-trips", () => {
  const config = buildMcpClientConfig([READ, WRITE]);
  const text = serializeMcpClientConfig(config);
  assert.match(text, /\n {2}"mcpServers": \{/);
  assert.deepEqual(JSON.parse(text), config);
});

test("the text helper is exactly the serialized block", () => {
  assert.equal(
    buildMcpClientConfigText([READ, WRITE]),
    serializeMcpClientConfig(buildMcpClientConfig([READ, WRITE]))
  );
});

test("the config text names both servers and carries each one's own port", () => {
  const text = buildMcpClientConfigText([READ, WRITE]);
  assert.match(text, /mind-tree-nature-read/);
  assert.match(text, /mind-tree-nature-write/);
  const parsed = JSON.parse(text) as {
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  assert.equal(parsed.mcpServers["mind-tree-nature-read"]?.url, "http://127.0.0.1:27321/mcp");
  assert.equal(parsed.mcpServers["mind-tree-nature-write"]?.url, "http://127.0.0.1:27322/mcp");

  // Without the write server the text must not mention its name at all.
  const readOnlyText = buildMcpClientConfigText([READ]);
  assert.match(readOnlyText, /mind-tree-nature-read/);
  assert.doesNotMatch(readOnlyText, /mind-tree-nature-write/);
});

test("a token with control characters stays inside a JSON string", () => {
  const text = buildMcpClientConfigText([{ group: "read", port: 27321, token: 'a\nb"c' }]);
  assert.doesNotMatch(text, /\n.*Bearer a\n/);
  const parsed = JSON.parse(text) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
  assert.equal(parsed.mcpServers[mcpServerName("read")]?.headers.Authorization, 'Bearer a\nb"c');
});
