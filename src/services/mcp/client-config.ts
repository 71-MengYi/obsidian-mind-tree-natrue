/**
 * One-click MCP client configuration.
 *
 * Pure data derived from the live port and token, so the settings page, the
 * tests and any future CLI helper all emit exactly the same JSON. The URL comes
 * from `connection.ts` so the loopback host and endpoint path have one source.
 *
 * The block carries the single local server. That is the product shape: one
 * endpoint holding every tool, with one client-side approval policy. The entry
 * name comes from `MCP_SERVER_NAME` so the client-facing identity and the
 * plugin's own model cannot drift apart.
 */
import { MCP_SERVER_NAME, mcpUrl } from "./connection";

export type McpClientServerConfig = {
  url: string;
  headers: { Authorization: string };
};

export type McpClientConfig = {
  mcpServers: Record<string, McpClientServerConfig>;
};

/** The one running (or configured) server: its port and access token. */
export interface McpClientServerConnection {
  port: number;
  token: string;
}

/**
 * Build the `mcpServers` block clients such as Claude Desktop and Cursor read.
 *
 * Only the connection the caller passes is listed, so a copied configuration
 * never advertises a server the user has switched off. The token travels in the
 * `Authorization` header because the endpoint is a plain HTTP loopback
 * listener: the path carries no secret, so a stray log line cannot leak one.
 */
export function buildMcpClientConfig(connections: readonly McpClientServerConnection[]): McpClientConfig {
  const mcpServers: Record<string, McpClientServerConfig> = {};
  for (const connection of connections) {
    mcpServers[MCP_SERVER_NAME] = {
      url: mcpUrl(connection.port),
      headers: { Authorization: `Bearer ${connection.token}` }
    };
  }
  return { mcpServers };
}

/** Pretty JSON so the user can paste it straight into a config file. */
export function serializeMcpClientConfig(config: McpClientConfig): string {
  return JSON.stringify(config, null, 2);
}

export function buildMcpClientConfigText(connections: readonly McpClientServerConnection[]): string {
  return serializeMcpClientConfig(buildMcpClientConfig(connections));
}
