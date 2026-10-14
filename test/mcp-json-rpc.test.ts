import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolErrorResult,
  buildToolResult,
  buildToolsListResult,
  dispatchJsonRpcMessage,
  JSON_RPC_ERROR_CODES,
  JsonRpcFault,
  negotiateProtocolVersion,
  parseJsonRpcText,
  parseJsonRpcValue,
  type JsonRpcFailureResponse,
  type JsonRpcMethodTable,
  type JsonRpcResponse
} from "../src/services/mcp/json-rpc-core";
import { PREFERRED_PROTOCOL_VERSION } from "../src/services/mcp/connection";

function failureOf(response: JsonRpcResponse | undefined): JsonRpcFailureResponse {
  assert.ok(response, "expected a reply");
  if (!("error" in response)) {
    throw new Error(`expected a failure reply, got ${JSON.stringify(response)}`);
  }
  return response;
}

function resultOf(response: JsonRpcResponse | undefined): unknown {
  assert.ok(response, "expected a reply");
  if (!("result" in response)) {
    throw new Error(`expected a success reply, got ${JSON.stringify(response)}`);
  }
  return response.result;
}

const ECHO_METHODS: JsonRpcMethodTable = {
  echo: (params) => ({ params })
};

// ─── envelope parsing ─────────────────────────────────────────────────────────

test("malformed JSON becomes a parse error with a null id", () => {
  const message = parseJsonRpcText("{not json");
  assert.equal(message.kind, "invalid");
  if (message.kind !== "invalid") return;
  assert.equal(message.response.error.code, JSON_RPC_ERROR_CODES.parseError);
  assert.equal(message.response.id, null);
});

test("a batch array is refused as an invalid request", () => {
  const message = parseJsonRpcText('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  assert.equal(message.kind, "invalid");
  if (message.kind !== "invalid") return;
  assert.equal(message.response.error.code, JSON_RPC_ERROR_CODES.invalidRequest);
});

test("non-object payloads are invalid requests", () => {
  for (const value of [null, 5, "text", true]) {
    const message = parseJsonRpcValue(value);
    assert.equal(message.kind, "invalid", `expected ${JSON.stringify(value)} to be invalid`);
  }
});

test("a non-2.0 jsonrpc field is an invalid request", () => {
  const message = parseJsonRpcValue({ jsonrpc: "1.0", id: 1, method: "ping" });
  assert.equal(message.kind, "invalid");
});

test("a request keeps its string or numeric id and its params", () => {
  const stringId = parseJsonRpcValue({ jsonrpc: "2.0", id: "abc", method: "ping", params: { a: 1 } });
  assert.deepEqual(stringId, { kind: "request", id: "abc", method: "ping", params: { a: 1 } });

  const numericId = parseJsonRpcValue({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(numericId, { kind: "request", id: 7, method: "ping", params: undefined });
});

test("a message without an id member is a notification", () => {
  const message = parseJsonRpcValue({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(message.kind, "notification");
});

test("an explicit null id is malformed for a request", () => {
  const message = parseJsonRpcValue({ jsonrpc: "2.0", id: null, method: "ping" });
  assert.equal(message.kind, "invalid");
});

test("a request carrying result or error is invalid", () => {
  assert.equal(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, method: "ping", result: {} }).kind, "invalid");
  assert.equal(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, method: "ping", error: {} }).kind, "invalid");
});

test("a non-string method is an invalid request", () => {
  assert.equal(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, method: 42 }).kind, "invalid");
});

test("client replies are recognised and never answered", () => {
  assert.deepEqual(parseJsonRpcValue({ jsonrpc: "2.0", id: 3, result: { ok: true } }), { kind: "response", id: 3 });
  assert.deepEqual(parseJsonRpcValue({ jsonrpc: "2.0", id: "s", error: { code: -1 } }), { kind: "response", id: "s" });
});

test("a reply with both result and error, or without an id, is invalid", () => {
  assert.equal(parseJsonRpcValue({ jsonrpc: "2.0", id: 1, result: {}, error: {} }).kind, "invalid");
  assert.equal(parseJsonRpcValue({ jsonrpc: "2.0", result: {} }).kind, "invalid");
});

// ─── dispatch ─────────────────────────────────────────────────────────────────

test("an invalid envelope is answered with its prepared failure", async () => {
  const response = await dispatchJsonRpcMessage(parseJsonRpcText("nope"), ECHO_METHODS);
  assert.equal(failureOf(response).error.code, JSON_RPC_ERROR_CODES.parseError);
});

test("an unknown method is reported as method-not-found with the request id", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 12, method: "tools/does-not-exist" }),
    ECHO_METHODS
  );
  const failure = failureOf(response);
  assert.equal(failure.error.code, JSON_RPC_ERROR_CODES.methodNotFound);
  assert.equal(failure.id, 12);
});

test("a handler result is wrapped in a success reply", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: "a", method: "echo", params: { value: 2 } }),
    ECHO_METHODS
  );
  assert.deepEqual(resultOf(response), { params: { value: 2 } });
  assert.equal(response?.id, "a");
  assert.equal(response?.jsonrpc, "2.0");
});

test("a missing params member reaches the handler as an empty object", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 1, method: "echo" }),
    ECHO_METHODS
  );
  assert.deepEqual(resultOf(response), { params: {} });
});

test("non-object params are refused as invalid params", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 1, method: "echo", params: [1, 2] }),
    ECHO_METHODS
  );
  assert.equal(failureOf(response).error.code, JSON_RPC_ERROR_CODES.invalidParams);
});

test("a handler fault keeps its code and message", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 4, method: "boom" }),
    {
      boom: () => {
        throw new JsonRpcFault(JSON_RPC_ERROR_CODES.invalidParams, "Invalid params", { field: "name" });
      }
    }
  );
  const failure = failureOf(response);
  assert.equal(failure.error.code, JSON_RPC_ERROR_CODES.invalidParams);
  assert.deepEqual(failure.error.data, { field: "name" });
});

test("an unexpected handler error becomes an internal error without leaking the cause", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 4, method: "boom" }),
    {
      boom: () => {
        throw new Error("secret vault detail");
      }
    }
  );
  const failure = failureOf(response);
  assert.equal(failure.error.code, JSON_RPC_ERROR_CODES.internalError);
  assert.doesNotMatch(failure.error.message, /secret vault detail/);
});

test("notifications produce no reply, known or not", async () => {
  let called = 0;
  const notifications: JsonRpcMethodTable = { "notifications/initialized": () => { called += 1; } };
  const known = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ECHO_METHODS,
    notifications
  );
  assert.equal(known, undefined);
  assert.equal(called, 1);

  const unknown = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", method: "notifications/whatever" }),
    ECHO_METHODS,
    notifications
  );
  assert.equal(unknown, undefined);
  assert.equal(called, 1);
});

test("a throwing notification handler is swallowed", async () => {
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ECHO_METHODS,
    { "notifications/initialized": () => { throw new Error("no channel to report on"); } }
  );
  assert.equal(response, undefined);
});

test("a client reply is consumed without running any method", async () => {
  let called = 0;
  const response = await dispatchJsonRpcMessage(
    parseJsonRpcValue({ jsonrpc: "2.0", id: 9, result: {} }),
    { ping: () => { called += 1; } }
  );
  assert.equal(response, undefined);
  assert.equal(called, 0);
});

// ─── protocol version negotiation ────────────────────────────────────────────

test("a supported protocol version is echoed back", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
});

test("an unknown or missing protocol version falls back to the preferred one", () => {
  assert.equal(negotiateProtocolVersion("1999-01-01"), PREFERRED_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), PREFERRED_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(7), PREFERRED_PROTOCOL_VERSION);
});

// ─── tools/list and tool results ─────────────────────────────────────────────

test("tools/list descriptors drop every internal field", () => {
  const result = buildToolsListResult([
    { name: "read_tree", description: "Read", inputSchema: { type: "object" } }
  ]);
  assert.deepEqual(result, {
    tools: [{ name: "read_tree", description: "Read", inputSchema: { type: "object" } }]
  });
  assert.deepEqual(Object.keys(result.tools[0] ?? {}), ["name", "description", "inputSchema"]);
});

test("a tool result carries compact JSON in one text block", () => {
  const result = buildToolResult({ a: 1, b: [1, 2] });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, '{"a":1,"b":[1,2]}');
  assert.equal(result.isError, undefined);
});

test("a failed tool call is flagged as an error result", () => {
  const result = buildToolErrorResult({ error: { code: "unexpected", message: "x" } });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), { error: { code: "unexpected", message: "x" } });
});
