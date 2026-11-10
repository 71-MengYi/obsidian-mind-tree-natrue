/** Loopback only: the MCP transport must never listen on a routable address. */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/** Hosts accepted in `Host`/`Origin` headers before a request is refused. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"] as const;

/** Endpoint path of an MCP endpoint, as required by the transport spec. */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * The one local MCP server.
 *
 * The plugin used to expose two servers (`read` / `write`) so a client could
 * attach a different approval policy to each. The product now offers a single
 * server carrying every tool, so the client applies one policy to reading and
 * editing alike. The name is both `serverInfo.name` and the `mcpServers` key in
 * the copied configuration, so it must stay stable across releases.
 */
export const MCP_SERVER_NAME = "mind-tree-nature";

/**
 * The device-local record key of that server.
 *
 * The record holds the bound port and the access token; it is per machine and
 * never part of `data.json`, because a synced token would unlock another
 * device's endpoint.
 */
export function mcpServerRecordKey(pluginId: string): string {
  return `${pluginId}:mcp-server`;
}

/**
 * The record key of the retired read-only server.
 *
 * Readable so the merge can adopt the port and token an installed client
 * configuration already carries instead of invalidating it. Deliberately not
 * the write record: only the read server was guaranteed to be listening, and
 * its configuration is the one users actually have today.
 */
export function legacyMcpServerRecordKey(pluginId: string): string {
  return `${pluginId}:mcp-server:read`;
}

/** MCP protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Above this a single tool request is refused before it is parsed. */
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;
/** `read_tree` page bounds keep one response from carrying a whole large tree. */
export const DEFAULT_MCP_READ_MAX_NODES = 500;
export const MAX_MCP_READ_MAX_NODES = 2000;
export const DEFAULT_MCP_FIND_LIMIT = 50;
export const MAX_MCP_FIND_LIMIT = 200;

export function mcpUrl(port: number): string {
  return `http://${DEFAULT_MCP_HOST}:${port}${MCP_ENDPOINT_PATH}`;
}

/**
 * The device-local record that survives restarts. It is deliberately separate
 * from plugin data: a port is per-machine and a shared access token would let
 * one device's configuration unlock another.
 */
export interface McpServerRecord {
  port: number;
  token: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidMcpToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function normalizeMcpServerRecord(value: unknown): McpServerRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const port = record["port"];
  if (typeof port !== "number" || !Number.isInteger(port)) return undefined;
  if (!isValidMcpToken(record["token"])) return undefined;
  return { port, token: record["token"] };
}
