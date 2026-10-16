/**
 * One-click MCP client configuration.
 *
 * Pure data derived from the live ports and tokens, so the settings page, the
 * tests and any future CLI helper all emit exactly the same JSON. The URL comes
 * from `connection.ts` so the loopback host and endpoint path have one source.
 *
 * The block carries *both* servers as separate entries. That is the whole point
 * of the split: a client treats each entry as its own server, so it can leave
 * the read-only entry unattended while requiring approval for the write entry.
 * The entry names come from `mcpServerName` so the client-facing identity and
 * the plugin's own model cannot drift apart.
 */
import { mcpServerName, mcpUrl, type McpServerGroup } from "./connection";

export type McpClientServerConfig = {
  url: string;
  headers: { Authorization: string };
};

export type McpClientConfig = {
  mcpServers: Record<string, McpClientServerConfig>;
};

/** One running (or configured) server: which group, on which port, with which token. */
export interface McpClientServerConnection {
  group: McpServerGroup;
  port: number;
  token: string;
}

/**
 * Build the `mcpServers` block clients such as Claude Desktop and Cursor read.
 *
 * Only the servers the caller passes are listed, so a configuration never
 * advertises an entry the plugin is not actually serving. Tokens travel in the
 * `Authorization` header because the endpoint is a plain HTTP loopback
 * listener: the path carries no secret, so a stray log line cannot leak one.
 */
export function buildMcpClientConfig(connections: readonly McpClientServerConnection[]): McpClientConfig {
  const mcpServers: Record<string, McpClientServerConfig> = {};
  for (const connection of connections) {
    mcpServers[mcpServerName(connection.group)] = {
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
