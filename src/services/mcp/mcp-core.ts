/**
 * The MCP server logic: method semantics on top of the JSON-RPC envelope.
 *
 * This module is the whole protocol surface - it owns what `initialize`,
 * `tools/list` and `tools/call` mean, resolves the user's tree intent through
 * the injected locator, and turns every failure into a tool result the calling
 * model can read. It never imports Obsidian: all vault work goes through the
 * ports of `contracts.ts`, which is also what makes the capability gate
 * (write tools while the user's switch is off) testable without a runtime.
 */
import { t } from "../../i18n";
import { DEFAULT_MCP_FIND_LIMIT, DEFAULT_MCP_READ_MAX_NODES } from "./connection";
import type { McpToolHost } from "./contracts";
import {
  buildToolErrorResult,
  buildToolResult,
  buildToolsListResult,
  dispatchJsonRpcMessage,
  JSON_RPC_ERROR_CODES,
  JsonRpcFault,
  negotiateProtocolVersion,
  parseJsonRpcText,
  type JsonRpcMethodTable,
  type JsonRpcNotificationTable,
  type JsonRpcResponse,
  type McpToolResult
} from "./json-rpc-core";
import { McpToolError, normalizeToolError, type McpToolErrorCode } from "./tool-error";
import { collectArgumentProblems, getAllToolDefinitions, getToolDefinition, type McpToolDefinition } from "./tool-schemas";

/** Advertised to clients as the server identity; informational only. */
export const MCP_SERVER_NAME = "mind-tree-nature";

/**
 * Reported when the host supplies no version.
 *
 * Deliberately not a release-looking number: a real version comes from
 * `manifest.json` through `McpHostEnvironment.version`, and a missing provider
 * must be visible in a client's diagnostics instead of looking plausible.
 */
export const MCP_DEV_SERVER_VERSION = "0.0.0-dev";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function integerArgument(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function booleanArgument(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayArgument(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Read a property the schema marked required.
 *
 * Argument validation already proved it is present; re-checking keeps the
 * "validated means safe to index" invariant local to the reader instead of
 * forcing a cast at every call site.
 */
function requiredString(args: Record<string, unknown>, name: string): string {
  const value = stringArgument(args, name);
  if (value === undefined) throw new McpToolError("invalid-arguments", `"${name}" is required`);
  return value;
}

/**
 * A failure the model can read: the code for branching, the sentence for the
 * user. `message` is already display-ready - whoever throws it localizes it.
 */
function toolFailure(code: McpToolErrorCode, message: string): McpToolResult {
  return buildToolErrorResult({ error: { code, message } });
}

/**
 * `documentId` wins over `treePath`, and neither falls back here: the locator
 * owns that rule, so this only forwards what the caller actually selected.
 */
async function resolveTreePath(host: McpToolHost, args: Record<string, unknown>): Promise<string> {
  const selection: { treePath?: string; documentId?: string } = {};
  const treePath = stringArgument(args, "treePath");
  const documentId = stringArgument(args, "documentId");
  if (treePath !== undefined) selection.treePath = treePath;
  if (documentId !== undefined) selection.documentId = documentId;
  return host.locator.resolve(selection);
}

/**
 * Run one tool body and build its structured payload.
 *
 * Exhaustive over the catalog: adding a tool without a body is a compile error,
 * which is what keeps `tools/list` and the implementations inseparable.
 */
async function executeTool(
  host: McpToolHost,
  definition: McpToolDefinition,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (definition.name) {
    case "list_trees":
      return { trees: await host.read.listTrees() };

    case "read_tree": {
      const treePath = await resolveTreePath(host, args);
      const page = await host.read.readTree(
        treePath,
        integerArgument(args, "maxNodes") ?? DEFAULT_MCP_READ_MAX_NODES,
        integerArgument(args, "offset") ?? 0
      );
      return { treePath, ...page };
    }

    case "find_nodes": {
      const treePath = await resolveTreePath(host, args);
      const query = requiredString(args, "query");
      const limit = integerArgument(args, "limit") ?? DEFAULT_MCP_FIND_LIMIT;
      return { treePath, query, limit, nodes: await host.read.findNodes(treePath, query, limit) };
    }

    case "get_node": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      return { treePath, nodeId, node: await host.read.getNode(treePath, nodeId) };
    }

    case "get_parent": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      return { treePath, nodeId, parent: await host.read.getParent(treePath, nodeId) };
    }

    case "get_children": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const recursive = booleanArgument(args, "recursive") ?? false;
      const nodes = await host.read.getChildren(treePath, nodeId, recursive);
      return { treePath, nodeId, recursive, nodes };
    }

    case "get_node_path": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      return { treePath, nodeId, path: await host.read.getNodePath(treePath, nodeId) };
    }

    case "get_linked_files": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const linked = await host.read.getLinkedFiles(treePath, nodeId);
      return { treePath, nodeId, resource: linked.resource, nodeLink: linked.nodeLink };
    }

    case "get_tree_stats": {
      const treePath = await resolveTreePath(host, args);
      return { treePath, ...(await host.read.getTreeStats(treePath)) };
    }

    case "create_tree": {
      const input: { title: string; folder?: string; children?: string[] } = {
        title: requiredString(args, "title")
      };
      const folder = stringArgument(args, "folder");
      if (folder !== undefined) input.folder = folder;
      const children = stringArrayArgument(args, "children");
      if (children !== undefined) input.children = children;
      return host.write.createTree(input);
    }

    case "move_node": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const targetId = requiredString(args, "targetId");
      return { treePath, node: await host.write.moveNode(treePath, nodeId, targetId) };
    }

    case "add_node": {
      const treePath = await resolveTreePath(host, args);
      const parentId = requiredString(args, "parentId");
      const title = requiredString(args, "title");
      const index = integerArgument(args, "index");
      const node = index === undefined
        ? await host.write.addNode(treePath, parentId, title)
        : await host.write.addNode(treePath, parentId, title, index);
      return { treePath, node };
    }

    case "rename_node": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const title = requiredString(args, "title");
      return { treePath, node: await host.write.renameNode(treePath, nodeId, title) };
    }

    case "delete_node": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const removed = await host.write.deleteNode(treePath, nodeId);
      return { treePath, removedId: removed.removedId, promotedChildIds: removed.promotedChildIds };
    }

    case "link_file": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      const filePath = requiredString(args, "filePath");
      return { treePath, node: await host.write.linkFile(treePath, nodeId, filePath) };
    }

    case "unlink_file": {
      const treePath = await resolveTreePath(host, args);
      const nodeId = requiredString(args, "nodeId");
      return { treePath, node: await host.write.unlinkFile(treePath, nodeId) };
    }

    case "link_node": {
      const treePath = await resolveTreePath(host, args);
      const sourceId = requiredString(args, "sourceId");
      const targetId = requiredString(args, "targetId");
      return { treePath, node: await host.write.linkNode(treePath, sourceId, targetId) };
    }

    case "unlink_node": {
      const treePath = await resolveTreePath(host, args);
      const sourceId = requiredString(args, "sourceId");
      return { treePath, node: await host.write.unlinkNode(treePath, sourceId) };
    }
  }
}

/**
 * Call one tool by name.
 *
 * Argument faults are answers, not protocol errors: the model is the caller and
 * a readable `isError` result is the only way it can correct itself. The
 * capability gate runs before validation and before any port is touched, so a
 * refused write cannot even look at the vault.
 *
 * Localization rule: only the errors originated here (`writes-disabled`,
 * `tree-creation-disabled`, `invalid-arguments`) are translated. A `McpToolError`
 * thrown by the host owns its own already-localized sentence and is forwarded
 * verbatim - the code is for branching, the message is for display.
 */
/**
 * The capability gate, as one table so a new access tier cannot be half-wired.
 *
 * Every check reads the host at call time (never at construction), which is what
 * lets the user flip a switch and have the very next tool call honour it.
 */
function permissionRefusal(definition: McpToolDefinition, host: McpToolHost): McpToolResult | undefined {
  switch (definition.access) {
    case "read":
      return undefined;
    case "create-tree":
      return host.environment.allowsTreeCreation()
        ? undefined
        : toolFailure("tree-creation-disabled", t("mcp.error.treeCreationDisabled"));
    case "write":
      return host.environment.allowsWrites()
        ? undefined
        : toolFailure("writes-disabled", t("mcp.error.writesDisabled"));
  }
}

export async function callTool(
  host: McpToolHost,
  name: string,
  rawArguments: unknown
): Promise<McpToolResult> {
  const definition = getToolDefinition(name);
  if (definition === undefined) {
    return toolFailure(
      "invalid-arguments",
      t("mcp.error.invalidArguments", { detail: `unknown tool "${name}"` })
    );
  }

  const refusal = permissionRefusal(definition, host);
  if (refusal !== undefined) return refusal;

  const problems = collectArgumentProblems(definition, rawArguments);
  if (problems.length > 0) {
    return toolFailure("invalid-arguments", t("mcp.error.invalidArguments", { detail: problems.join("; ") }));
  }

  const args = isRecord(rawArguments) ? rawArguments : {};
  try {
    return buildToolResult(await executeTool(host, definition, args));
  } catch (error) {
    const toolError = normalizeToolError(error);
    return toolFailure(toolError.code, toolError.message);
  }
}

function buildInitializeResult(host: McpToolHost, params: Record<string, unknown>): unknown {
  return {
    protocolVersion: negotiateProtocolVersion(params["protocolVersion"]),
    capabilities: { tools: { listChanged: false } },
    // The release version is a host fact, not a protocol constant: the pure
    // layer must not import manifest.json and a copy here would drift.
    serverInfo: { name: MCP_SERVER_NAME, version: host.environment.version?.() ?? MCP_DEV_SERVER_VERSION }
  };
}

async function handleToolCall(host: McpToolHost, params: Record<string, unknown>): Promise<McpToolResult> {
  const name = params["name"];
  if (typeof name !== "string" || name.trim() === "") {
    // The tool selector is part of the request envelope, not of the tool's own
    // arguments, so a missing name is a protocol fault rather than a tool result.
    throw new JsonRpcFault(JSON_RPC_ERROR_CODES.invalidParams, "Invalid params");
  }
  return callTool(host, name, params["arguments"]);
}

function createMethodTable(host: McpToolHost): JsonRpcMethodTable {
  return {
    initialize: (params) => buildInitializeResult(host, params),
    ping: () => ({}),
    // Write tools are always advertised and refused at call time instead: a
    // client that caches `tools/list` must still learn why the write failed.
    "tools/list": () => buildToolsListResult(getAllToolDefinitions()),
    "tools/call": (params) => handleToolCall(host, params)
  };
}

function createNotificationTable(): JsonRpcNotificationTable {
  // Recognised so the handshake is documented; it carries no payload to store.
  return { "notifications/initialized": () => undefined };
}

/**
 * Pure protocol entry point: raw request text in, reply out.
 *
 * `undefined` means nothing is owed - a notification, a client reply, or an
 * `initialize` follow-up - which the transport turns into an empty 202.
 */
export async function handleMcpMessage(
  raw: string,
  host: McpToolHost
): Promise<JsonRpcResponse | undefined> {
  const message = parseJsonRpcText(raw);
  return dispatchJsonRpcMessage(message, createMethodTable(host), createNotificationTable());
}
