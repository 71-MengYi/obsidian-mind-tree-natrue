import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MCP_HOST,
  MCP_ENDPOINT_PATH,
  MCP_SERVER_NAME,
  mcpUrl
} from "../src/services/mcp/connection";
import {
  buildMcpClientConfig,
  buildMcpClientConfigText,
  serializeMcpClientConfig,
  type McpClientServerConnection
} from "../src/services/mcp/client-config";

const TOKEN = "S4mpleT0kenValue_1234";
const OTHER_TOKEN = "0therT0kenValue_5678";

/** The one live server: a single port and token. */
const CONNECTION: McpClientServerConnection = { port: 27321, token: TOKEN };

function serverOf(connections: readonly McpClientServerConnection[]) {
  const config = buildMcpClientConfig(connections);
  const server = config.mcpServers[MCP_SERVER_NAME];
  assert.ok(server, `the configuration must contain ${MCP_SERVER_NAME}`);
  return server;
}

test("the configured URL is the loopback endpoint from the connection contract", () => {
  const server = serverOf([CONNECTION]);
  assert.equal(server.url, mcpUrl(27321));
  assert.equal(server.url, `http://${DEFAULT_MCP_HOST}:27321${MCP_ENDPOINT_PATH}`);
  assert.equal(MCP_ENDPOINT_PATH, "/mcp");
});

test("the port is used verbatim, without a default being substituted", () => {
  assert.match(serverOf([{ port: 1024, token: TOKEN }]).url, /:1024\/mcp$/);
  assert.match(serverOf([{ port: 65535, token: TOKEN }]).url, /:65535\/mcp$/);
});

test("the token travels in the Authorization header, never in the URL", () => {
  const server = serverOf([CONNECTION]);
  assert.equal(server.headers.Authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(server.url, new RegExp(TOKEN));
});

test("the one entry is named mind-tree-nature and keyed by that name", () => {
  const config = buildMcpClientConfig([CONNECTION]);
  assert.equal(MCP_SERVER_NAME, "mind-tree-nature");
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  assert.deepEqual(Object.keys(config.mcpServers), ["mind-tree-nature"]);
  // The retired split exposed one entry per server; a single server means the
  // suffixed names must never appear again.
  for (const retired of ["mind-tree-nature-read", "mind-tree-nature-write"]) {
    assert.equal(Object.hasOwn(config.mcpServers, retired), false, retired);
  }
});

test("two connections collapse into the single entry, the last one winning", () => {
  // There is nowhere to put a second entry: one endpoint carries every tool, so
  // a repeated connection overwrites the same key instead of adding a `-read` /
  // `-write` sibling.
  const config = buildMcpClientConfig([
    { port: 27321, token: TOKEN },
    { port: 27322, token: OTHER_TOKEN }
  ]);
  assert.deepEqual(Object.keys(config.mcpServers), ["mind-tree-nature"]);
  assert.equal(config.mcpServers["mind-tree-nature"]?.url, mcpUrl(27322));
  assert.equal(config.mcpServers["mind-tree-nature"]?.headers.Authorization, `Bearer ${OTHER_TOKEN}`);
});

test("only a live connection is advertised", () => {
  // A client configuration must never point at an endpoint the plugin is not
  // actually serving: an empty list yields an empty block.
  assert.deepEqual(buildMcpClientConfig([]).mcpServers, {});
  assert.deepEqual(Object.keys(buildMcpClientConfig([])), ["mcpServers"]);
  assert.deepEqual(Object.keys(buildMcpClientConfig([CONNECTION]).mcpServers), ["mind-tree-nature"]);
});

test("the serialized form is pretty JSON that round-trips", () => {
  const config = buildMcpClientConfig([CONNECTION]);
  const text = serializeMcpClientConfig(config);
  assert.match(text, /\n {2}"mcpServers": \{/);
  assert.deepEqual(JSON.parse(text), config);
});

test("the text helper is exactly the serialized block", () => {
  assert.equal(
    buildMcpClientConfigText([CONNECTION]),
    serializeMcpClientConfig(buildMcpClientConfig([CONNECTION]))
  );
});

test("the config text names the single server and carries its port", () => {
  const text = buildMcpClientConfigText([CONNECTION]);
  assert.match(text, /mind-tree-nature/);
  assert.doesNotMatch(text, /mind-tree-nature-(read|write)/);
  const parsed = JSON.parse(text) as {
    mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
  };
  assert.deepEqual(Object.keys(parsed.mcpServers), ["mind-tree-nature"]);
  assert.equal(parsed.mcpServers["mind-tree-nature"]?.url, "http://127.0.0.1:27321/mcp");
  assert.equal(parsed.mcpServers["mind-tree-nature"]?.headers.Authorization, `Bearer ${TOKEN}`);
});

test("a token with control characters stays inside a JSON string", () => {
  const text = buildMcpClientConfigText([{ port: 27321, token: 'a\nb"c' }]);
  assert.doesNotMatch(text, /\n.*Bearer a\n/);
  const parsed = JSON.parse(text) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
  assert.equal(parsed.mcpServers[MCP_SERVER_NAME]?.headers.Authorization, 'Bearer a\nb"c');
});
