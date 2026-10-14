/**
 * JSON-RPC 2.0 envelope handling for the MCP endpoint.
 *
 * Kept apart from `mcp-core.ts` because the two answer different questions:
 * this module decides whether bytes are even a well-formed message and how a
 * reply is shaped, while `mcp-core.ts` decides what the MCP methods mean. The
 * JSON-RPC level is where protocol faults live, and a fault must never be
 * reported to the model as a tool result - the transport has to see it.
 *
 * Only single objects are supported: MCP does not use JSON-RPC batches, and
 * silently flattening one would let a client believe it may pipeline.
 */
import { PREFERRED_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./connection";

export const JSON_RPC_VERSION = "2.0";

/** The five codes RFC 8259 / JSON-RPC 2.0 define; nothing else is emitted. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

export type JsonRpcId = string | number;

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId | null;
  result: unknown;
};

export type JsonRpcFailureResponse = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcFailureResponse;

export type JsonRpcRequest = {
  kind: "request";
  id: JsonRpcId;
  method: string;
  params: unknown;
};

export type JsonRpcNotification = {
  kind: "notification";
  method: string;
  params: unknown;
};

/** A reply to something the server sent; consumed and never answered. */
export type JsonRpcResponseEnvelope = {
  kind: "response";
  id: JsonRpcId | null;
};

export type JsonRpcInvalid = {
  kind: "invalid";
  response: JsonRpcFailureResponse;
};

export type McpIncomingMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponseEnvelope
  | JsonRpcInvalid;

export type McpToolContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpToolContent[];
  isError?: true;
};

/** The part of a tool definition a client is allowed to see. */
export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolsListResult = {
  tools: McpToolDescriptor[];
};

/**
 * Raised by a method handler to ask for a specific protocol error.
 *
 * Handler authors throw this instead of returning a synthetic error object, so
 * the dispatcher stays the only place that can build a failure reply.
 */
export class JsonRpcFault extends Error {
  constructor(readonly code: JsonRpcErrorCode, message: string, readonly data?: unknown) {
    super(message);
    this.name = "JsonRpcFault";
  }
}

/** Handlers always receive the normalized params object, never raw JSON. */
export type JsonRpcMethodHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

/** Methods the server answers; a missing entry is reported as `-32601`. */
export type JsonRpcMethodTable = {
  readonly [method: string]: JsonRpcMethodHandler | undefined;
};

/** Notifications never produce a reply, so their handlers return nothing. */
export type JsonRpcNotificationTable = {
  readonly [method: string]: JsonRpcMethodHandler | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: JsonRpcErrorCode,
  message: string,
  id: JsonRpcId | null,
  data?: unknown
): JsonRpcFailureResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  };
}

export function jsonRpcSuccessResponse(id: JsonRpcId | null, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

/**
 * The envelope could not be trusted, so no id may be echoed: answering with an
 * id the caller never sent would let a client match a reply to the wrong call.
 */
function invalidEnvelope(message: string, id: JsonRpcId | null = null): JsonRpcInvalid {
  return { kind: "invalid", response: failure(JSON_RPC_ERROR_CODES.invalidRequest, message, id) };
}

/** Parse raw request text; unusable bytes become a `-32700` reply. */
export function parseJsonRpcText(text: string): McpIncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      kind: "invalid",
      response: failure(JSON_RPC_ERROR_CODES.parseError, "Parse error", null)
    };
  }
  return parseJsonRpcValue(value);
}

/** Classify an already-decoded JSON value. */
export function parseJsonRpcValue(value: unknown): McpIncomingMessage {
  // A batch array is a valid JSON-RPC 2.0 construct that this server does not
  // implement, so it is refused as an invalid request rather than half-handled.
  if (Array.isArray(value)) return invalidEnvelope("Invalid Request");
  if (!isRecord(value)) return invalidEnvelope("Invalid Request");

  if (value["jsonrpc"] !== JSON_RPC_VERSION) return invalidEnvelope("Invalid Request");

  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  const rawId = value["id"];
  const usableId: JsonRpcId | null = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  const method = value["method"];
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");

  if (method === undefined) {
    // No method: the only other legal shape is a response to a server request.
    const isResponse = hasResult !== hasError && hasId && (usableId !== null || rawId === null);
    if (!isResponse) return invalidEnvelope("Invalid Request");
    return { kind: "response", id: usableId };
  }

  if (typeof method !== "string") return invalidEnvelope("Invalid Request");
  if (hasResult || hasError) return invalidEnvelope("Invalid Request");
  if (!hasId) return { kind: "notification", method, params: value["params"] };
  // `id: null` is reserved for replies, so a request carrying it is malformed.
  if (usableId === null) return invalidEnvelope("Invalid Request");
  return { kind: "request", id: usableId, method, params: value["params"] };
}

function paramsOf(message: JsonRpcRequest | JsonRpcNotification): Record<string, unknown> {
  const params = message.params;
  if (params === undefined || params === null) return {};
  if (!isRecord(params)) {
    throw new JsonRpcFault(JSON_RPC_ERROR_CODES.invalidParams, "Invalid params");
  }
  return params;
}

/**
 * Answer one incoming message, or return `undefined` when no reply is owed.
 *
 * Notifications - including unknown ones - and client replies are consumed
 * silently, which is what JSON-RPC requires and what keeps a heartbeat from
 * producing traffic the client did not ask for.
 */
export async function dispatchJsonRpcMessage(
  message: McpIncomingMessage,
  methods: JsonRpcMethodTable,
  notifications: JsonRpcNotificationTable = {}
): Promise<JsonRpcResponse | undefined> {
  if (message.kind === "invalid") return message.response;
  if (message.kind === "response") return undefined;

  if (message.kind === "notification") {
    const handler = notifications[message.method];
    if (handler === undefined) return undefined;
    try {
      await handler(paramsOf(message));
    } catch {
      // A notification has no channel for failure; swallowing it is the only
      // spec-conformant behaviour and keeps a bad heartbeat from killing the
      // connection.
    }
    return undefined;
  }

  const handler = methods[message.method];
  if (handler === undefined) {
    return failure(JSON_RPC_ERROR_CODES.methodNotFound, "Method not found", message.id);
  }

  let params: Record<string, unknown>;
  try {
    params = paramsOf(message);
  } catch (error) {
    if (error instanceof JsonRpcFault) {
      return failure(error.code, error.message, message.id, error.data);
    }
    return failure(JSON_RPC_ERROR_CODES.internalError, "Internal error", message.id);
  }

  try {
    return jsonRpcSuccessResponse(message.id, await handler(params));
  } catch (error) {
    if (error instanceof JsonRpcFault) {
      return failure(error.code, error.message, message.id, error.data);
    }
    return failure(JSON_RPC_ERROR_CODES.internalError, "Internal error", message.id);
  }
}

/**
 * Negotiate the protocol revision.
 *
 * MCP requires the server to answer with a revision it supports; echoing an
 * unknown one would make the client speak a dialect this server never
 * implemented, so the preferred revision wins instead.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return PREFERRED_PROTOCOL_VERSION;
}

/** `tools/list` strips every internal field, so `access` can never leak out. */
export function buildToolsListResult(tools: readonly McpToolDescriptor[]): McpToolsListResult {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
}

/** A successful tool result: one text block holding compact JSON. */
export function buildToolResult(payload: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** A failed tool call is still a result - the model must be able to read why. */
export function buildToolErrorResult(payload: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}
