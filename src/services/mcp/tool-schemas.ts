/**
 * The MCP tool catalog as pure data, plus the one validator that reads it.
 *
 * The catalog lives here instead of next to the tool bodies for two reasons:
 * `tools/list` must be able to describe every tool without constructing a host
 * (so the list is testable and cannot drift from the schemas), and the
 * write/read split is what the capability gate keys on, so it belongs with the
 * declaration rather than with each implementation.
 *
 * Descriptions and property docs are protocol surface: they are handed to the
 * calling model verbatim, exactly like JSON Schema keywords, so they are not
 * translated UI copy.
 */
import {
  DEFAULT_MCP_FIND_LIMIT,
  DEFAULT_MCP_READ_MAX_NODES,
  MAX_MCP_FIND_LIMIT,
  MAX_MCP_READ_MAX_NODES
} from "./connection";

/**
 * What a tool is allowed to do, and therefore which switch gates it.
 *
 * `create-tree` is deliberately its own tier rather than another `write` tool:
 * creating a whole new file is a different kind of risk from editing one the
 * user is already looking at, so the user can hand out one without the other.
 * (Adding a node *inside* an existing tree is editing, not creating.)
 */
export type McpToolAccess = "read" | "write" | "create-tree";

export type McpJsonPropertySchema = {
  type: "string" | "integer" | "boolean" | "array";
  /** Only meaningful for `array`; every current array argument is a list of strings. */
  items?: { type: "string" };
  minimum?: number;
  maximum?: number;
  description: string;
};

export type McpToolInputSchema = {
  type: "object";
  properties: Record<string, McpJsonPropertySchema>;
  required: string[];
  additionalProperties: false;
};

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: McpToolInputSchema;
  /** `write` tools need the edit switch; `create-tree` needs its own. */
  access: McpToolAccess;
};

/**
 * Every tool name, in the order clients see them.
 *
 * The list is the single source of the `McpToolName` union, so a body that
 * forgets a name - or a name that loses its body - fails type checking instead
 * of failing at runtime.
 */
export const MCP_TOOL_NAMES = [
  "list_trees",
  "read_tree",
  "find_nodes",
  "get_node",
  "get_parent",
  "get_children",
  "get_node_path",
  "get_linked_files",
  "get_tree_stats",
  "create_tree",
  "move_node",
  "add_node",
  "rename_node",
  "delete_node",
  "link_file",
  "unlink_file",
  "link_node",
  "unlink_node"
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

const SELECTION_PROPERTIES: Record<string, McpJsonPropertySchema> = {
  treePath: {
    type: "string",
    description: "Vault-relative path of the .mtn.md file. Omit to use the mind tree that is open or last active."
  },
  documentId: {
    type: "string",
    description: "Stable document id of the mind tree. Wins over treePath when both are given."
  }
};

const NODE_ID_PROPERTY: McpJsonPropertySchema = {
  type: "string",
  description: "Id of a node inside the mind tree."
};

const TARGET_ID_PROPERTY: McpJsonPropertySchema = {
  type: "string",
  description: "Id of the node that becomes the target."
};

const SOURCE_ID_PROPERTY: McpJsonPropertySchema = {
  type: "string",
  description: "Id of the node the operation starts from."
};

function schemaOf(
  properties: Record<string, McpJsonPropertySchema>,
  required: string[]
): McpToolInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function selectionSchema(
  extra: Record<string, McpJsonPropertySchema> = {},
  required: string[] = []
): McpToolInputSchema {
  return schemaOf({ ...SELECTION_PROPERTIES, ...extra }, required);
}

/**
 * A tool that addresses a node as `nodeId`.
 *
 * Tools that name their nodes differently (`parentId`, `sourceId`) build their
 * schema with `selectionSchema` directly: a required `nodeId` they never read
 * would reject every well-formed call.
 */
function nodeSchema(
  extra: Record<string, McpJsonPropertySchema> = {},
  required: string[] = []
): McpToolInputSchema {
  return selectionSchema({ nodeId: NODE_ID_PROPERTY, ...extra }, ["nodeId", ...required]);
}

const TITLE_PROPERTY: McpJsonPropertySchema = {
  type: "string",
  description: "Title of the node. Plain text; use \"\\\\n\" for an intentional line break."
};

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "list_trees",
    description:
      "List every mind tree in the vault with its path, document id and node count. Start here when you do not know which mind tree the user means.",
    inputSchema: schemaOf({}, []),
    access: "read"
  },
  {
    name: "read_tree",
    description:
      "Read a mind tree as a flat page of nodes in document order (root first). Use offset to page through a large tree.",
    inputSchema: selectionSchema({
      maxNodes: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MCP_READ_MAX_NODES,
        description: `Maximum rows in this page. Defaults to ${DEFAULT_MCP_READ_MAX_NODES}.`
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Row offset for pagination. The response reports nextOffset while more rows remain."
      }
    }),
    access: "read"
  },
  {
    name: "find_nodes",
    description: "Search node titles inside one mind tree by case-insensitive substring match.",
    inputSchema: selectionSchema({
      query: {
        type: "string",
        description: "Text to look for in node titles."
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MCP_FIND_LIMIT,
        description: `Maximum matches to return. Defaults to ${DEFAULT_MCP_FIND_LIMIT}.`
      }
    }, ["query"]),
    access: "read"
  },
  {
    name: "get_node",
    description: "Read one node with its parent id, child ids, markers, file resource and node link.",
    inputSchema: nodeSchema(),
    access: "read"
  },
  {
    name: "get_parent",
    description: "Read the parent of one node. Returns null when the node is the tree root.",
    inputSchema: nodeSchema(),
    access: "read"
  },
  {
    name: "get_children",
    description: "Read the child nodes of one node, either the direct children or the whole subtree.",
    inputSchema: nodeSchema({
      recursive: {
        type: "boolean",
        description: "When true, return every descendant in document order instead of the direct children."
      }
    }),
    access: "read"
  },
  {
    name: "get_node_path",
    description: "Read the ancestor chain of one node, from the root down to and including the node.",
    inputSchema: nodeSchema(),
    access: "read"
  },
  {
    name: "get_linked_files",
    description: "Read the file resource and the node link attached to one node.",
    inputSchema: nodeSchema(),
    access: "read"
  },
  {
    name: "get_tree_stats",
    description: "Read node count, linked file count and maximum depth for one mind tree.",
    inputSchema: selectionSchema(),
    access: "read"
  },
  {
    name: "create_tree",
    description:
      "Create a new mind tree file. The new tree is never opened or focused; it appears in the vault for the user to open.",
    inputSchema: schemaOf({
      title: {
        type: "string",
        description: "Title of the new mind tree, also used for its file name."
      },
      folder: {
        type: "string",
        description: "Vault-relative folder for the new file. Defaults to the vault root."
      },
      children: {
        type: "array",
        items: { type: "string" },
        description: "Titles of the top-level nodes to create under the new root."
      }
    }, ["title"]),
    access: "create-tree"
  },
  {
    name: "move_node",
    description: "Move one node, together with its subtree, under another node of the same mind tree.",
    inputSchema: selectionSchema({
      nodeId: NODE_ID_PROPERTY,
      targetId: TARGET_ID_PROPERTY
    }, ["nodeId", "targetId"]),
    access: "write"
  },
  {
    name: "add_node",
    description: "Add a child node under an existing node.",
    inputSchema: selectionSchema({
      parentId: {
        type: "string",
        description: "Id of the node that receives the new child."
      },
      title: TITLE_PROPERTY,
      index: {
        type: "integer",
        minimum: 0,
        description: "Zero-based position among the parent's children. Appends when omitted."
      }
    }, ["parentId", "title"]),
    access: "write"
  },
  {
    name: "rename_node",
    description: "Change the title of one node.",
    inputSchema: nodeSchema({ title: TITLE_PROPERTY }, ["title"]),
    access: "write"
  },
  {
    name: "delete_node",
    description:
      "Remove one node and promote its children to the node's parent. Never deletes a branch and never deletes a file.",
    inputSchema: nodeSchema(),
    access: "write"
  },
  {
    name: "link_file",
    description:
      "Associate an existing vault file with a node. The file is never created, copied or moved.",
    inputSchema: nodeSchema({
      filePath: {
        type: "string",
        description: "Vault-relative path of the file to associate."
      }
    }, ["filePath"]),
    access: "write"
  },
  {
    name: "unlink_file",
    description: "Remove the file association from a node. The file itself is left untouched.",
    inputSchema: nodeSchema(),
    access: "write"
  },
  {
    name: "link_node",
    description:
      "Create a one-way node link from a source node to another node in the same mind tree. Each node has at most one outgoing link.",
    inputSchema: selectionSchema({
      sourceId: SOURCE_ID_PROPERTY,
      targetId: TARGET_ID_PROPERTY
    }, ["sourceId", "targetId"]),
    access: "write"
  },
  {
    name: "unlink_node",
    description: "Remove the outgoing node link of one node.",
    inputSchema: selectionSchema({
      sourceId: SOURCE_ID_PROPERTY
    }, ["sourceId"]),
    access: "write"
  }
]);

/** The whole catalog; the array itself is frozen so callers cannot add a tool. */
export function getAllToolDefinitions(): readonly McpToolDefinition[] {
  return MCP_TOOL_DEFINITIONS;
}

export function getToolDefinition(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((definition) => definition.name === name);
}

/**
 * The declared access of a tool, or `undefined` when the name is unknown.
 *
 * Replaces the old `isWriteTool` boolean: with two independent capability tiers
 * a yes/no answer can no longer say *which* switch gates a tool.
 */
export function accessOfTool(name: string): McpToolAccess | undefined {
  return getToolDefinition(name)?.access;
}

function describePropertyType(property: McpJsonPropertySchema): string {
  switch (property.type) {
    case "string": return "a string";
    case "integer": return "an integer";
    case "boolean": return "a boolean";
    case "array": return "an array of strings";
  }
}

function checkProperty(name: string, property: McpJsonPropertySchema, value: unknown): string[] {
  if (property.type === "array") {
    if (!Array.isArray(value)) return [`"${name}" must be ${describePropertyType(property)}`];
    const problems: string[] = [];
    value.forEach((item, index) => {
      if (typeof item !== "string") problems.push(`"${name}[${index}]" must be a string`);
    });
    return problems;
  }
  if (property.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return [`"${name}" must be ${describePropertyType(property)}`];
    }
    if (property.minimum !== undefined && value < property.minimum) {
      return [`"${name}" must be at least ${property.minimum}`];
    }
    if (property.maximum !== undefined && value > property.maximum) {
      return [`"${name}" must be at most ${property.maximum}`];
    }
    return [];
  }
  if (typeof value !== property.type) return [`"${name}" must be ${describePropertyType(property)}`];
  return [];
}

/**
 * Check `value` against one tool's schema and return every violation.
 *
 * The schemas are deliberately a small, closed subset of JSON Schema, so this
 * stays a short explicit function instead of pulling a validator dependency
 * into the plugin bundle. Returning every problem lets the model fix the whole
 * call in one retry.
 */
export function collectArgumentProblems(
  definition: McpToolDefinition,
  value: unknown
): string[] {
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return ["arguments must be an object"];
  }
  const record = value as Record<string, unknown>;
  const schema = definition.inputSchema;
  const problems: string[] = [];
  for (const name of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      problems.push(`missing required property "${name}"`);
    }
  }
  for (const name of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) {
      problems.push(`unknown property "${name}"`);
    }
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const provided = record[name];
    if (provided === undefined) continue;
    problems.push(...checkProperty(name, property, provided));
  }
  return problems;
}
