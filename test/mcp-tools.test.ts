import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import type {
  McpHostEnvironment,
  McpNodeView,
  McpReadPort,
  McpToolHost,
  McpTreeLocator,
  McpTreePage,
  McpWritePort
} from "../src/services/mcp/contracts";

// The protocol layer is pure, but `t()` asks the host for the current language
// through the i18n facade, which imports `getLanguage` from the real Obsidian
// runtime. A resolve hook supplies that single value.
//
// `module.register` (Node >= 20.6) is used instead of `module.registerHooks`
// (Node >= 22.15) because AGENTS.md and the release workflow pin this project at
// Node >= 20: a test that only runs on a newer runtime is not runnable on a
// supported one. The hook is scoped to the facade itself - not to every
// `obsidian` import - so it cannot mask a real resolution failure elsewhere, and
// because async hooks cannot be removed it must never answer for another module.
const OBSIDIAN_STUB = "data:text/javascript," + encodeURIComponent('export const getLanguage = () => "en";\n');
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {\n" +
  '  if (specifier === "obsidian" && context.parentURL?.endsWith("/i18n/index.ts")) {\n' +
  `    return { url: ${JSON.stringify(OBSIDIAN_STUB)}, shortCircuit: true };\n` +
  "  }\n" +
  "  return next(specifier, context);\n" +
  "}\n"
));
const { callTool, handleMcpMessage } = await import("../src/services/mcp/mcp-core");
const { collectArgumentProblems, getAllToolDefinitions, getToolDefinition, isWriteTool, MCP_TOOL_NAMES } =
  await import("../src/services/mcp/tool-schemas");
const { t } = await import("../src/i18n");

const TREE_PATH = "trees/plan.mtn.md";

// ─── recording host fake ──────────────────────────────────────────────────────

type Recorder = { calls: string[] };

function nodeView(id: string, overrides: Partial<McpNodeView> = {}): McpNodeView {
  return {
    id,
    title: `Node ${id}`,
    parentId: null,
    childIds: [],
    depth: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    ...overrides
  };
}

function page(nodes: McpTreePage["nodes"]): McpTreePage {
  return {
    path: TREE_PATH,
    title: "Plan",
    rootId: "root",
    nodeCount: nodes.length,
    returned: nodes.length,
    total: nodes.length,
    nodes
  };
}

/**
 * A host that records every port call.
 *
 * The write gate is only trustworthy if a refused call cannot reach a port, so
 * the assertion is on this list staying empty - not on the returned text.
 */
function createHost(options: { allowsWrites?: boolean; failure?: unknown; version?: () => string } = {}) {
  const calls: string[] = [];
  const note = (name: string) => {
    calls.push(name);
    if (options.failure !== undefined && name.startsWith("getNode:")) throw options.failure;
  };

  const read: McpReadPort = {
    listTrees: async () => {
      note("listTrees");
      return [{ path: TREE_PATH, title: "Plan", nodeCount: 2 }];
    },
    readTree: async (treePath, maxNodes, offset) => {
      note(`readTree:${treePath}:${maxNodes}:${offset}`);
      return page([{ id: "root", title: "Root", parentId: null, depth: 0 }]);
    },
    findNodes: async (treePath, query, limit) => {
      note(`findNodes:${treePath}:${query}:${limit}`);
      return [{ id: "n1", title: "Match", parentId: "root", depth: 1 }];
    },
    getNode: async (treePath, nodeId) => {
      note(`getNode:${treePath}:${nodeId}`);
      return nodeView(nodeId, { parentId: "root", depth: 1 });
    },
    getParent: async (treePath, nodeId) => {
      note(`getParent:${treePath}:${nodeId}`);
      return nodeId === "root" ? null : nodeView("root");
    },
    getChildren: async (treePath, nodeId, recursive) => {
      note(`getChildren:${treePath}:${nodeId}:${recursive}`);
      return [nodeView("c1", { parentId: nodeId, depth: 1 })];
    },
    getNodePath: async (treePath, nodeId) => {
      note(`getNodePath:${treePath}:${nodeId}`);
      return [{ id: "root", title: "Root" }, { id: nodeId, title: "Match" }];
    },
    getLinkedFiles: async (treePath, nodeId) => {
      note(`getLinkedFiles:${treePath}:${nodeId}`);
      return {
        id: nodeId,
        resource: { type: "file", resourceId: "ab12c", pathHint: "Notes/a.md", fileKind: "note" },
        nodeLink: "other"
      };
    },
    getTreeStats: async (treePath) => {
      note(`getTreeStats:${treePath}`);
      return { path: treePath, title: "Plan", nodeCount: 3, fileCount: 1, depth: 2 };
    }
  };

  const write: McpWritePort = {
    createTree: async (input) => {
      note(`createTree:${JSON.stringify(input)}`);
      return { path: `${input.folder ?? ""}/new.mtn.md`, rootId: "root", childIds: ["a"] };
    },
    moveNode: async (treePath, nodeId, targetId) => {
      note(`moveNode:${treePath}:${nodeId}:${targetId}`);
      return nodeView(nodeId, { parentId: targetId });
    },
    addNode: async (treePath, parentId, title, index) => {
      note(`addNode:${treePath}:${parentId}:${title}:${index ?? "-"}`);
      return nodeView("new", { title, parentId });
    },
    renameNode: async (treePath, nodeId, title) => {
      note(`renameNode:${treePath}:${nodeId}:${title}`);
      return nodeView(nodeId, { title });
    },
    deleteNode: async (treePath, nodeId) => {
      note(`deleteNode:${treePath}:${nodeId}`);
      return { removedId: nodeId, promotedChildIds: ["c1", "c2"] };
    },
    linkFile: async (treePath, nodeId, filePath) => {
      note(`linkFile:${treePath}:${nodeId}:${filePath}`);
      return nodeView(nodeId, { resource: { type: "file", resourceId: "ab12c", pathHint: filePath, fileKind: "note" } });
    },
    unlinkFile: async (treePath, nodeId) => {
      note(`unlinkFile:${treePath}:${nodeId}`);
      return nodeView(nodeId);
    },
    linkNode: async (treePath, sourceId, targetId) => {
      note(`linkNode:${treePath}:${sourceId}:${targetId}`);
      return nodeView(sourceId, { nodeLink: targetId });
    },
    unlinkNode: async (treePath, sourceId) => {
      note(`unlinkNode:${treePath}:${sourceId}`);
      return nodeView(sourceId);
    }
  };

  const locator: McpTreeLocator = {
    resolve: async (selection) => {
      note(`resolve:${JSON.stringify(selection)}`);
      return TREE_PATH;
    }
  };

  const environment: McpHostEnvironment = {
    isSupported: () => true,
    allowsWrites: () => options.allowsWrites ?? false,
    connection: () => ({ port: 27321, token: "token" })
  };
  // Only the hosts that are meant to report a release version provide one.
  if (options.version !== undefined) environment.version = options.version;

  const host: McpToolHost = { read, write, locator, environment };
  const recorder: Recorder = { calls };
  return { host, recorder };
}

/** Build a `tools/call` request body for the given tool. */
function callBody(name: string, args?: unknown, id: number | string = 1): string {
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params["arguments"] = args;
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params });
}

/** The raw `result` of a successful JSON-RPC reply (tools/list, initialize, ping). */
function rpcResultOf(response: Awaited<ReturnType<typeof handleMcpMessage>>): unknown {
  if (!response || !("result" in response)) {
    throw new Error(`expected a result reply, got ${JSON.stringify(response)}`);
  }
  return response.result;
}

function toolResultOf(response: Awaited<ReturnType<typeof handleMcpMessage>>) {
  const result = rpcResultOf(response) as { content?: { type: string; text: string }[]; isError?: true };
  assert.ok(result.content?.[0], `expected a tool result, got ${JSON.stringify(result)}`);
  return result as { content: { type: string; text: string }[]; isError?: true };
}

function payloadOf(response: Awaited<ReturnType<typeof handleMcpMessage>>): Record<string, unknown> {
  const result = toolResultOf(response);
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

function errorCodeOf(response: Awaited<ReturnType<typeof handleMcpMessage>>): string {
  const payload = payloadOf(response);
  const error = payload["error"] as { code?: string; message?: string } | undefined;
  assert.ok(error?.code, `expected an error payload, got ${JSON.stringify(payload)}`);
  return error.code;
}

function protocolErrorOf(response: Awaited<ReturnType<typeof handleMcpMessage>>) {
  if (!response || !("error" in response)) {
    throw new Error(`expected a protocol error, got ${JSON.stringify(response)}`);
  }
  return response;
}

// ─── catalog shape ───────────────────────────────────────────────────────────

const READ_TOOL_NAMES = [
  "list_trees",
  "read_tree",
  "find_nodes",
  "get_node",
  "get_parent",
  "get_children",
  "get_node_path",
  "get_linked_files",
  "get_tree_stats"
];
const WRITE_TOOL_NAMES = [
  "create_tree",
  "move_node",
  "add_node",
  "rename_node",
  "delete_node",
  "link_file",
  "unlink_file",
  "link_node",
  "unlink_node"
];

test("the catalog exposes exactly the documented tools in order", () => {
  assert.deepEqual([...MCP_TOOL_NAMES], [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
  assert.deepEqual(getAllToolDefinitions().map((tool) => tool.name), [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
});

test("read and write tools are split exactly as documented", () => {
  for (const name of READ_TOOL_NAMES) assert.equal(isWriteTool(name), false, name);
  for (const name of WRITE_TOOL_NAMES) assert.equal(isWriteTool(name), true, name);
});

test("every tool declares an object schema that rejects unknown properties", () => {
  for (const tool of getAllToolDefinitions()) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(Array.isArray(tool.inputSchema.required), tool.name);
    for (const required of tool.inputSchema.required) {
      assert.ok(required in tool.inputSchema.properties, `${tool.name}.${required} must be declared`);
    }
    for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(property.description.length > 0, `${tool.name}.${name} needs a description`);
      assert.ok(["string", "integer", "boolean", "array"].includes(property.type), `${tool.name}.${name}`);
      if (property.type === "array") assert.equal(property.items?.type, "string", `${tool.name}.${name}`);
    }
  }
});

test("a tree-scoped tool always offers treePath and documentId", () => {
  for (const tool of getAllToolDefinitions()) {
    if (tool.name === "list_trees" || tool.name === "create_tree") continue;
    assert.ok("treePath" in tool.inputSchema.properties, tool.name);
    assert.ok("documentId" in tool.inputSchema.properties, tool.name);
  }
});

test("getToolDefinition only resolves catalog names", () => {
  assert.equal(getToolDefinition("add_node")?.access, "write");
  assert.equal(getToolDefinition("nope"), undefined);
});

test("the argument validator reports missing, unknown and mistyped properties", () => {
  const definition = getToolDefinition("get_children");
  assert.ok(definition);
  if (!definition) return;

  assert.deepEqual(collectArgumentProblems(definition, { nodeId: "n1" }), []);
  assert.deepEqual(collectArgumentProblems(definition, { treePath: TREE_PATH, nodeId: "n1", recursive: true }), []);
  assert.deepEqual(collectArgumentProblems(definition, undefined), ['missing required property "nodeId"']);
  assert.deepEqual(collectArgumentProblems(definition, []), ["arguments must be an object"]);
  assert.deepEqual(collectArgumentProblems(definition, { nodeId: "n1", extra: 1 }), ['unknown property "extra"']);
  assert.deepEqual(collectArgumentProblems(definition, { nodeId: 1 }), ['"nodeId" must be a string']);
  assert.deepEqual(collectArgumentProblems(definition, { nodeId: "n1", recursive: "yes" }), ['"recursive" must be a boolean']);
  assert.deepEqual(collectArgumentProblems(definition, { nodeId: "n1", recursive: null }), ['"recursive" must be a boolean']);
});

test("numeric arguments are range-checked", () => {
  const definition = getToolDefinition("read_tree");
  assert.ok(definition);
  if (!definition) return;
  assert.deepEqual(collectArgumentProblems(definition, { maxNodes: 0 }), ['"maxNodes" must be at least 1']);
  assert.deepEqual(collectArgumentProblems(definition, { maxNodes: 5000 }), ['"maxNodes" must be at most 2000']);
  assert.deepEqual(collectArgumentProblems(definition, { maxNodes: 1.5 }), ['"maxNodes" must be an integer']);
  assert.deepEqual(collectArgumentProblems(definition, { offset: -1 }), ['"offset" must be at least 0']);
  assert.deepEqual(collectArgumentProblems(definition, { maxNodes: 2000, offset: 0 }), []);
});

test("string arrays reject non-string entries by index", () => {
  const definition = getToolDefinition("create_tree");
  assert.ok(definition);
  if (!definition) return;
  assert.deepEqual(collectArgumentProblems(definition, { title: "T", children: ["a", "b"] }), []);
  assert.deepEqual(collectArgumentProblems(definition, { title: "T", children: ["a", 2] }), ['"children[1]" must be a string']);
  assert.deepEqual(collectArgumentProblems(definition, { title: "T", children: "a" }), ['"children" must be an array of strings']);
});

// ─── tools/list ──────────────────────────────────────────────────────────────

test("tools/list returns every tool without internal catalog fields", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), host);
  const result = rpcResultOf(response) as { tools: Record<string, unknown>[] };
  assert.deepEqual(result.tools.map((tool) => tool["name"]), [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
  for (const tool of result.tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"]);
  }
});

test("write tools stay advertised while writes are disabled", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), host);
  const result = rpcResultOf(response) as { tools: { name: string }[] };
  assert.deepEqual(result.tools.map((tool) => tool.name), [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
});

// ─── the write gate ──────────────────────────────────────────────────────────

test("a write tool with writes disabled fails without touching any host port", async () => {
  const { host, recorder } = createHost({ allowsWrites: false });
  const response = await handleMcpMessage(callBody("add_node", { treePath: TREE_PATH, parentId: "root", title: "New" }), host);

  const result = toolResultOf(response);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
    error: { code: "writes-disabled", message: t("mcp.error.writesDisabled") }
  });
  assert.deepEqual(recorder.calls, []);
});

test("every write tool is gated while writes are disabled", async () => {
  const { host, recorder } = createHost({ allowsWrites: false });
  const bodies: [string, Record<string, unknown>][] = [
    ["create_tree", { title: "New" }],
    ["move_node", { nodeId: "a", targetId: "b" }],
    ["add_node", { parentId: "a", title: "T" }],
    ["rename_node", { nodeId: "a", title: "T" }],
    ["delete_node", { nodeId: "a" }],
    ["link_file", { nodeId: "a", filePath: "Notes/a.md" }],
    ["unlink_file", { nodeId: "a" }],
    ["link_node", { sourceId: "a", targetId: "b" }],
    ["unlink_node", { sourceId: "a" }]
  ];
  for (const [name, args] of bodies) {
    const response = await handleMcpMessage(callBody(name, args), host);
    assert.equal(errorCodeOf(response), "writes-disabled", name);
  }
  assert.deepEqual(recorder.calls, []);
});

test("the same write tool runs normally once writes are allowed", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  const response = await handleMcpMessage(callBody("add_node", { parentId: "root", title: "New", index: 2 }), host);
  const payload = payloadOf(response);
  assert.equal(toolResultOf(response).isError, undefined);
  assert.equal(payload["treePath"], TREE_PATH);
  assert.deepEqual(payload["node"], nodeView("new", { title: "New", parentId: "root" }));
  assert.deepEqual(recorder.calls, ["resolve:{}", `addNode:${TREE_PATH}:root:New:2`]);
});

test("read tools are never blocked by the write switch", async () => {
  const { host } = createHost({ allowsWrites: false });
  const response = await handleMcpMessage(callBody("list_trees"), host);
  assert.equal(toolResultOf(response).isError, undefined);
});

// ─── argument faults are tool results ────────────────────────────────────────

test("an unknown tool is an error result, not a protocol error", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  const response = await handleMcpMessage(callBody("destroy_everything", {}), host);
  const result = toolResultOf(response);
  assert.equal(result.isError, true);
  assert.equal(
    (JSON.parse(result.content[0]?.text ?? "") as { error: { message: string } }).error.message,
    t("mcp.error.invalidArguments", { detail: 'unknown tool "destroy_everything"' })
  );
  assert.deepEqual(recorder.calls, []);
});

test("invalid arguments are error results that never reach a port", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  const cases: [string, unknown][] = [
    ["get_node", {}],
    ["get_node", { nodeId: "a", extra: true }],
    ["get_node", { nodeId: 7 }],
    ["read_tree", { maxNodes: 0 }],
    ["find_nodes", { query: "x", limit: 5000 }],
    ["create_tree", { title: "T", children: ["ok", 3] }],
    ["get_children", [1, 2]]
  ];
  for (const [name, args] of cases) {
    const response = await handleMcpMessage(callBody(name, args), host);
    assert.equal(errorCodeOf(response), "invalid-arguments", `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(recorder.calls, []);
});

test("a missing or non-string tool name is a protocol-level invalid params", async () => {
  const { host } = createHost({ allowsWrites: true });
  for (const body of [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } })
  ]) {
    const response = await handleMcpMessage(body, host);
    assert.equal(protocolErrorOf(response).error.code, -32602);
  }
});

test("omitting arguments is the same as passing none", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_trees" } }),
    host
  );
  const payload = payloadOf(response);
  assert.equal(Array.isArray(payload["trees"]), true);
});

// ─── payload shapes ─────────────────────────────────────────────────────────

test("read_tree forwards the page bounds and embeds the resolved tree path", async () => {
  const { host, recorder } = createHost();
  const defaults = payloadOf(await handleMcpMessage(callBody("read_tree", { treePath: TREE_PATH }), host));
  assert.equal(defaults["treePath"], TREE_PATH);
  assert.deepEqual(defaults["nodes"], [{ id: "root", title: "Root", parentId: null, depth: 0 }]);
  assert.equal(recorder.calls[1], `readTree:${TREE_PATH}:500:0`);

  const explicit = payloadOf(
    await handleMcpMessage(callBody("read_tree", { treePath: TREE_PATH, maxNodes: 10, offset: 20 }), host)
  );
  assert.equal(explicit["treePath"], TREE_PATH);
  assert.ok(recorder.calls.includes(`readTree:${TREE_PATH}:10:20`));
});

test("documentId and treePath are both handed to the locator", async () => {
  const { host, recorder } = createHost();
  await handleMcpMessage(callBody("get_tree_stats", { documentId: "doc-1", treePath: TREE_PATH }), host);
  assert.equal(recorder.calls[0], `resolve:${JSON.stringify({ treePath: TREE_PATH, documentId: "doc-1" })}`);

  const { host: activeHost, recorder: activeRecorder } = createHost();
  await handleMcpMessage(callBody("get_tree_stats", {}), activeHost);
  assert.equal(activeRecorder.calls[0], "resolve:{}");
});

test("find_nodes applies the documented default limit", async () => {
  const { host, recorder } = createHost();
  const payload = payloadOf(await handleMcpMessage(callBody("find_nodes", { query: "ma" }), host));
  assert.equal(payload["treePath"], TREE_PATH);
  assert.equal(payload["query"], "ma");
  assert.equal(payload["limit"], 50);
  assert.deepEqual(recorder.calls[1], `findNodes:${TREE_PATH}:ma:50`);
});

test("get_children defaults to direct children only", async () => {
  const { host } = createHost();
  const payload = payloadOf(await handleMcpMessage(callBody("get_children", { nodeId: "root" }), host));
  assert.equal(payload["recursive"], false);
  assert.deepEqual(payload["nodes"], [nodeView("c1", { parentId: "root", depth: 1 })]);
});

test("get_parent reports a null parent for the root", async () => {
  const { host } = createHost();
  const payload = payloadOf(await handleMcpMessage(callBody("get_parent", { nodeId: "root" }), host));
  assert.equal(payload["parent"], null);
  assert.equal(payload["nodeId"], "root");
});

test("get_node, get_node_path and get_linked_files return the documented payloads", async () => {
  const { host } = createHost();

  const node = payloadOf(await handleMcpMessage(callBody("get_node", { nodeId: "n1" }), host));
  assert.equal(node["treePath"], TREE_PATH);
  assert.deepEqual(node["node"], nodeView("n1", { parentId: "root", depth: 1 }));

  const path = payloadOf(await handleMcpMessage(callBody("get_node_path", { nodeId: "n1" }), host));
  assert.deepEqual(path["path"], [{ id: "root", title: "Root" }, { id: "n1", title: "Match" }]);

  const linked = payloadOf(await handleMcpMessage(callBody("get_linked_files", { nodeId: "n1" }), host));
  assert.deepEqual(linked["resource"], { type: "file", resourceId: "ab12c", pathHint: "Notes/a.md", fileKind: "note" });
  assert.equal(linked["nodeLink"], "other");
});

test("get_tree_stats and list_trees embed the identity a client needs", async () => {
  const { host } = createHost();
  const stats = payloadOf(await handleMcpMessage(callBody("get_tree_stats", {}), host));
  assert.deepEqual(stats, { treePath: TREE_PATH, path: TREE_PATH, title: "Plan", nodeCount: 3, fileCount: 1, depth: 2 });

  const trees = payloadOf(await handleMcpMessage(callBody("list_trees"), host));
  assert.deepEqual(trees["trees"], [{ path: TREE_PATH, title: "Plan", nodeCount: 2 }]);
});

test("create_tree never consults the locator", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  const payload = payloadOf(
    await handleMcpMessage(callBody("create_tree", { title: "New tree", folder: "trees", children: ["A", "B"] }), host)
  );
  assert.deepEqual(recorder.calls, [`createTree:${JSON.stringify({ title: "New tree", folder: "trees", children: ["A", "B"] })}`]);
  assert.deepEqual(payload, { path: "trees/new.mtn.md", rootId: "root", childIds: ["a"] });
});

test("create_tree omits absent optional arguments instead of sending undefined", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  await handleMcpMessage(callBody("create_tree", { title: "Solo" }), host);
  assert.deepEqual(recorder.calls, [`createTree:${JSON.stringify({ title: "Solo" })}`]);
});

test("the write tools return the affected node under the resolved path", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });

  const moved = payloadOf(await handleMcpMessage(callBody("move_node", { nodeId: "a", targetId: "b" }), host));
  assert.deepEqual(moved["node"], nodeView("a", { parentId: "b" }));

  const renamed = payloadOf(await handleMcpMessage(callBody("rename_node", { nodeId: "a", title: "Renamed" }), host));
  assert.deepEqual(renamed["node"], nodeView("a", { title: "Renamed" }));

  const linkedFile = payloadOf(await handleMcpMessage(callBody("link_file", { nodeId: "a", filePath: "Notes/a.md" }), host));
  assert.deepEqual(linkedFile["node"], nodeView("a", {
    resource: { type: "file", resourceId: "ab12c", pathHint: "Notes/a.md", fileKind: "note" }
  }));

  const unlinkedFile = payloadOf(await handleMcpMessage(callBody("unlink_file", { nodeId: "a" }), host));
  assert.deepEqual(unlinkedFile["node"], nodeView("a"));

  const linkedNode = payloadOf(await handleMcpMessage(callBody("link_node", { sourceId: "a", targetId: "b" }), host));
  assert.deepEqual(linkedNode["node"], nodeView("a", { nodeLink: "b" }));

  const unlinkedNode = payloadOf(await handleMcpMessage(callBody("unlink_node", { sourceId: "a" }), host));
  assert.deepEqual(unlinkedNode["node"], nodeView("a"));

  assert.ok(recorder.calls.includes(`moveNode:${TREE_PATH}:a:b`));
  assert.ok(recorder.calls.includes(`renameNode:${TREE_PATH}:a:Renamed`));
  assert.ok(recorder.calls.includes(`linkNode:${TREE_PATH}:a:b`));
});

test("add_node only forwards an index when the caller supplied one", async () => {
  const { host, recorder } = createHost({ allowsWrites: true });
  await handleMcpMessage(callBody("add_node", { parentId: "root", title: "A" }), host);
  await handleMcpMessage(callBody("add_node", { parentId: "root", title: "B", index: 0 }), host);
  assert.ok(recorder.calls.includes(`addNode:${TREE_PATH}:root:A:-`));
  assert.ok(recorder.calls.includes(`addNode:${TREE_PATH}:root:B:0`));
});

test("delete_node reports the removed node and the promoted children", async () => {
  const { host } = createHost({ allowsWrites: true });
  const payload = payloadOf(await handleMcpMessage(callBody("delete_node", { nodeId: "a" }), host));
  assert.deepEqual(payload, { treePath: TREE_PATH, removedId: "a", promotedChildIds: ["c1", "c2"] });
});

// ─── failure mapping ────────────────────────────────────────────────────────

test("a structured domain failure is forwarded verbatim, code and message", async () => {
  const { McpToolError } = await import("../src/services/mcp/tool-error");
  const { host } = createHost({ failure: new McpToolError("node-not-found", 'Node "n1" is missing') });
  const response = await handleMcpMessage(callBody("get_node", { nodeId: "n1" }), host);
  const result = toolResultOf(response);
  assert.equal(result.isError, true);
  // The service layer already localized this sentence; re-translating it here
  // would double-localize and lose the detail the domain added.
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
    error: { code: "node-not-found", message: 'Node "n1" is missing' }
  });
});

test("a plain thrown error is reported as unexpected with its message", async () => {
  const { host } = createHost({ failure: new Error("vault exploded") });
  const response = await handleMcpMessage(callBody("get_node", { nodeId: "n1" }), host);
  const result = toolResultOf(response);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
    error: { code: "unexpected", message: "vault exploded" }
  });
});

test("a limit failure keeps its code and the domain's wording", async () => {
  const { McpToolError } = await import("../src/services/mcp/tool-error");
  const { host } = createHost({ failure: new McpToolError("depth-limit", "Maximum depth 6 exceeded") });
  const response = await handleMcpMessage(callBody("get_node", { nodeId: "n1" }), host);
  const payload = payloadOf(response);
  assert.deepEqual(payload["error"], {
    code: "depth-limit",
    message: "Maximum depth 6 exceeded"
  });
});

test("a failing locator keeps its own tree-not-found sentence", async () => {
  const { McpToolError } = await import("../src/services/mcp/tool-error");
  const { host } = createHost();
  host.locator.resolve = async () => {
    throw new McpToolError("tree-not-found", 'No mind tree matches documentId "doc-9".');
  };
  const response = await handleMcpMessage(callBody("get_tree_stats", { documentId: "doc-9" }), host);
  const payload = payloadOf(response);
  assert.deepEqual(payload["error"], {
    code: "tree-not-found",
    message: 'No mind tree matches documentId "doc-9".'
  });
});

// ─── method level behaviour ─────────────────────────────────────────────────

test("initialize negotiates the revision and advertises the tool capability", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    host
  );
  const result = rpcResultOf(response) as {
    protocolVersion: string;
    capabilities: { tools: { listChanged: boolean } };
    serverInfo: { name: string; version: string };
  };
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.serverInfo.name, "mind-tree-nature");
  assert.ok(result.serverInfo.version.length > 0);
});

test("initialize reports the release version the host supplies", async () => {
  const { host } = createHost({ version: () => "9.8.7" });
  const response = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    host
  );
  const result = rpcResultOf(response) as { serverInfo: { name: string; version: string } };
  assert.deepEqual(result.serverInfo, { name: "mind-tree-nature", version: "9.8.7" });
});

test("initialize reports a visible development marker when no version is provided", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    host
  );
  const result = rpcResultOf(response) as { serverInfo: { name: string; version: string } };
  assert.equal(result.serverInfo.version, "0.0.0-dev");
  assert.equal(result.serverInfo.name, "mind-tree-nature");
});

test("initialize falls back to the preferred revision for an unknown client", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2000-01-01" } }),
    host
  );
  const result = rpcResultOf(response) as { protocolVersion: string };
  assert.equal(result.protocolVersion, "2025-06-18");
});

test("ping answers with an empty result", async () => {
  const { host } = createHost();
  const response = await handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }), host);
  assert.deepEqual(rpcResultOf(response), {});
});

test("notifications and client replies produce no reply at all", async () => {
  const { host, recorder } = createHost();
  const notification = await handleMcpMessage(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    host
  );
  assert.equal(notification, undefined);

  const reply = await handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), host);
  assert.equal(reply, undefined);
  assert.deepEqual(recorder.calls, []);
});

test("an unknown method and malformed JSON stay protocol errors", async () => {
  const { host } = createHost();
  const unknown = await handleMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/rename" }), host);
  assert.equal(protocolErrorOf(unknown).error.code, -32601);

  const malformed = await handleMcpMessage("{", host);
  assert.equal(protocolErrorOf(malformed).error.code, -32700);

  const batch = await handleMcpMessage("[]", host);
  assert.equal(protocolErrorOf(batch).error.code, -32600);
});

test("callTool can be driven directly, without the transport", async () => {
  const { host } = createHost();
  const result = await callTool(host, "list_trees", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), {
    trees: [{ path: TREE_PATH, title: "Plan", nodeCount: 2 }]
  });
});

// ─── purity ─────────────────────────────────────────────────────────────────

test("the pure protocol modules never import Obsidian", () => {
  const files = [
    "../src/services/mcp/tool-schemas.ts",
    "../src/services/mcp/json-rpc-core.ts",
    "../src/services/mcp/mcp-core.ts",
    "../src/services/mcp/client-config.ts"
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']obsidian["']/, `${file} must stay Obsidian-free`);
    assert.doesNotMatch(source, /import\(\s*["']obsidian["']\s*\)/, `${file} must stay Obsidian-free`);
  }
});
