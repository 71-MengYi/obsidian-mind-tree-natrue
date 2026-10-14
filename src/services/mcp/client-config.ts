/**
 * One-click MCP client configuration.
 *
 * Pure data derived from the live port and token, so the settings page, the
 * tests and any future CLI helper all emit exactly the same JSON. The URL comes
 * from `connection.ts` so the loopback host and endpoint path have one source.
 */
import { mcpUrl } from "./connection";

/** Key the client configuration uses for this server. */
export const MCP_CLIENT_SERVER_NAME = "mind-tree-nature";

export type McpClientServerConfig = {
  url: string;
  headers: { Authorization: string };
};

export type McpClientConfig = {
  mcpServers: Record<string, McpClientServerConfig>;
};

/**
 * Build the `mcpServers` block clients such as Claude Desktop and Cursor read.
 *
 * The token travels in the `Authorization` header because the endpoint is a
 * plain HTTP loopback listener: the path carries no secret, so a stray log line
 * cannot leak the token.
 */
export function buildMcpClientConfig(port: number, token: string): McpClientConfig {
  return {
    mcpServers: {
      [MCP_CLIENT_SERVER_NAME]: {
        url: mcpUrl(port),
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  };
}

/** Pretty JSON so the user can paste it straight into a config file. */
export function serializeMcpClientConfig(config: McpClientConfig): string {
  return JSON.stringify(config, null, 2);
}

export function buildMcpClientConfigText(port: number, token: string): string {
  return serializeMcpClientConfig(buildMcpClientConfig(port, token));
}
