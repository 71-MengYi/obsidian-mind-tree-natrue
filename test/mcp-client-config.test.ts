import test from "node:test";
import assert from "node:assert/strict";
import { MCP_ENDPOINT_PATH, DEFAULT_MCP_HOST, mcpUrl } from "../src/services/mcp/connection";
import {
  buildMcpClientConfig,
  buildMcpClientConfigText,
  MCP_CLIENT_SERVER_NAME,
  serializeMcpClientConfig
} from "../src/services/mcp/client-config";

const TOKEN = "S4mpleT0kenValue_1234";

function serverOf(port: number, token: string) {
  const config = buildMcpClientConfig(port, token);
  const server = config.mcpServers[MCP_CLIENT_SERVER_NAME];
  assert.ok(server, "the configuration must contain this server");
  return server;
}

test("the configured URL is the loopback endpoint from the connection contract", () => {
  const server = serverOf(27321, TOKEN);
  assert.equal(server.url, mcpUrl(27321));
  assert.equal(server.url, `http://${DEFAULT_MCP_HOST}:27321${MCP_ENDPOINT_PATH}`);
  assert.equal(MCP_ENDPOINT_PATH, "/mcp");
});

test("the port is used verbatim, without a default being substituted", () => {
  assert.match(serverOf(1024, TOKEN).url, /:1024\/mcp$/);
  assert.match(serverOf(65535, TOKEN).url, /:65535\/mcp$/);
});

test("the token travels in the Authorization header, never in the URL", () => {
  const server = serverOf(27321, TOKEN);
  assert.equal(server.headers.Authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(server.url, new RegExp(TOKEN));
});

test("the client block exposes exactly one server under the shared key", () => {
  const config = buildMcpClientConfig(27321, TOKEN);
  assert.deepEqual(Object.keys(config), ["mcpServers"]);
  assert.deepEqual(Object.keys(config.mcpServers), [MCP_CLIENT_SERVER_NAME]);
  assert.equal(MCP_CLIENT_SERVER_NAME, "mind-tree-nature");
});

test("the serialized form is pretty JSON that round-trips", () => {
  const config = buildMcpClientConfig(27321, TOKEN);
  const text = serializeMcpClientConfig(config);
  assert.match(text, /\n {2}"mcpServers": \{/);
  assert.deepEqual(JSON.parse(text), config);
});

test("the text helper is exactly the serialized block", () => {
  assert.equal(buildMcpClientConfigText(27321, TOKEN), serializeMcpClientConfig(buildMcpClientConfig(27321, TOKEN)));
});

test("a token with control characters stays inside a JSON string", () => {
  const text = buildMcpClientConfigText(27321, 'a\nb"c');
  assert.doesNotMatch(text, /\n.*Bearer a\n/);
  const parsed = JSON.parse(text) as { mcpServers: Record<string, { headers: { Authorization: string } }> };
  assert.equal(parsed.mcpServers[MCP_CLIENT_SERVER_NAME]?.headers.Authorization, 'Bearer a\nb"c');
});
