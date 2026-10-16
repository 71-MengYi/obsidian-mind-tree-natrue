/** Loopback only: the MCP transport must never listen on a routable address. */
export const DEFAULT_MCP_HOST = "127.0.0.1";

/** Hosts accepted in `Host`/`Origin` headers before a request is refused. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"] as const;

/** Endpoint path of an MCP endpoint, as required by the transport spec. */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * The two servers, split by whether a tool can change a file.
 *
 * A client's tool-approval policy is attached to an MCP *server*, not to a tool,
 * so the only way to let reads run unattended while writes require approval is
 * to offer them as two servers. This is therefore the security boundary: the
 * read catalog must never contain a tool that writes, and each server gets its
 * own port and its own token so a client cannot confuse them.
 */
export type McpServerGroup = "read" | "write";

export const MCP_SERVER_GROUPS: readonly McpServerGroup[] = ["read", "write"];

/** How a group is named in a client's `mcpServers` map. */
export function mcpServerName(group: McpServerGroup): string {
  return `mind-tree-nature-${group}`;
}

/**
 * The device-local record key for one group.
 *
 * Per group, so the two servers cannot share a port or a token: a token that
 * unlocked writes must not be the token the read-only configuration carries.
 */
export function mcpServerRecordKey(pluginId: string, group: McpServerGroup): string {
  return `${pluginId}:mcp-server:${group}`;
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
