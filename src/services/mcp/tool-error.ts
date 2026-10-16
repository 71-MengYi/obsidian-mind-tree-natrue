/**
 * One structured failure shape for every MCP tool call.
 *
 * The MCP layer never throws raw errors across the transport boundary: a tool
 * result is always a JSON document the calling model can read, so each failure
 * carries a stable machine-readable code plus a short human sentence. Keeping
 * the code separate from the sentence lets callers branch without parsing
 * prose, and lets the wording change without breaking a client.
 *
 * There is deliberately no code for "the plugin refused this on permission
 * grounds": the two-server split is the boundary, so a tool that does not belong
 * to the server being called is reported as `invalid-arguments` (an unknown tool
 * there) rather than as a denied-but-known tool.
 */
export type McpToolErrorCode =
  | "service-unavailable"
  | "invalid-arguments"
  | "tree-not-found"
  | "tree-ambiguous"
  | "node-not-found"
  | "file-not-found"
  | "duplicate-title"
  | "depth-limit"
  | "node-limit"
  | "invalid-operation"
  | "conflict-locked"
  | "save-conflict"
  | "file-changed"
  | "unexpected";

export class McpToolError extends Error {
  constructor(readonly code: McpToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Wrap anything a tool body can throw into one `McpToolError`.
 *
 * Domain commands (`addNode`, `moveNodes`, `createNodeLink`, …) deliberately
 * throw plain `Error`s with English wording; mapping them here keeps the tool
 * bodies free of try/catch boilerplate while still giving the client a code.
 */
export function normalizeToolError(error: unknown, fallbackCode: McpToolErrorCode = "unexpected"): McpToolError {
  if (error instanceof McpToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpToolError(fallbackCode, message);
}
