import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  MAX_MCP_REQUEST_BYTES,
  MCP_ENDPOINT_PATH,
  mcpServerRecordKey,
  mcpUrl,
  normalizeMcpServerRecord,
  type McpServerRecord
} from "../src/services/mcp/connection";
import { McpHttpTransport, type McpHttpRequest, type McpListenerFactory }
  from "../src/services/mcp/http-transport";
import { McpServerController } from "../src/services/mcp/mcp-server";
import { DEFAULT_MCP_READ_PORT, DEFAULT_MCP_WRITE_PORT } from "../src/settings-model";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SESSION = "session-0001";

/**
 * A real listener on a real loopback socket, mirroring what the production
 * factory does: buffer the body up to the limit and hand the decision to the
 * transport. Injecting it is what keeps this a transport test rather than an
 * exercise of node's HTTP module, which the production factory already owns.
 */
function realListenerFactory(state: { closed: boolean }): McpListenerFactory {
  return {
    listen: (port, onRequest) => new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        let oversized = false;
        request.on("data", (chunk: Uint8Array) => {
          if (oversized) return;
          size += chunk.byteLength;
          if (size > MAX_MCP_REQUEST_BYTES) { oversized = true; chunks.length = 0; return; }
          chunks.push(chunk);
        });
        request.on("end", () => {
          void (async () => {
            const result = await onRequest({
              method: request.method ?? "GET",
              url: request.url ?? "/",
              headers: request.headers,
              body: oversized ? "" : Buffer.concat(chunks).toString("utf8"),
              oversized
            });
            response.writeHead(result.status, {
              ...(result.contentType ? { "content-type": result.contentType } : {}),
              ...(result.headers ?? {})
            });
            response.end(result.body ?? "");
          })();
        });
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        resolve({
          port: typeof address === "object" && address ? address.port : port,
          close: () => new Promise<void>((done, failed) => {
            state.closed = true;
            server.closeIdleConnections();
            server.close((error) => { if (error) failed(error); else done(); });
          })
        });
      });
    })
  };
}

interface CallResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: options.method ?? "POST",
      path: options.path ?? MCP_ENDPOINT_PATH,
      // No keep-alive: an idle pooled socket would keep the server from closing.
      agent: false,
      headers: options.headers ?? {}
    }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** The headers a valid call carries; named fields so `noUncheckedIndexedAccess`
 *  does not turn every lookup into `string | undefined`. */
interface BaseHeaders {
  host: string;
  authorization: string;
  accept: string;
  "content-type": string;
  [name: string]: string;
}

/**
 * Every server is closed even when an assertion throws: a leaked listener would
 * keep the whole test process alive, which is what made the first attempt hang.
 */
async function withServer(
  handle: (raw: string) => unknown | Promise<unknown>,
  run: (context: {
    transport: McpHttpTransport;
    port: number;
    base: BaseHeaders;
    seen: string[];
    state: { closed: boolean };
    call: (options?: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) => Promise<CallResult>;
  }) => Promise<void>
): Promise<void> {
  const state = { closed: false };
  const seen: string[] = [];
  const transport = new McpHttpTransport({
    token: TOKEN,
    handleMessage: (raw) => { seen.push(raw); return handle(raw); },
    createListener: realListenerFactory(state),
    createSessionId: () => SESSION
  });
  const port = await transport.listen(0);
  const base: BaseHeaders = {
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${TOKEN}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json"
  };
  try {
    await run({
      transport, port, base, seen, state,
      call: (options) => call(port, { headers: base, ...options })
    });
  } finally {
    await transport.close();
  }
}

const echo = (raw: string) => ({ jsonrpc: "2.0", id: JSON.parse(raw).id, result: "ok" });
const initializeBody = (id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18" } });

/** A request-level decision, driven without a socket, for header-only rules. */
function directRequest(overrides: {
  method?: string; url?: string; body?: string;
  headers?: Record<string, string | string[] | undefined>;
}): McpHttpRequest {
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? MCP_ENDPOINT_PATH,
    headers: overrides.headers ?? {},
    body: overrides.body ?? "",
    oversized: false
  };
}

test("a request without a valid bearer token is refused before anything else", async () => {
  await withServer(echo, async ({ port, base, call: request }) => {
    assert.equal((await request({ headers: { host: base.host, accept: base.accept } })).status, 401);
    assert.equal((await request({
      headers: { host: base.host, accept: base.accept, authorization: "Bearer wrong-token-wrong-token" }
    })).status, 401);
    assert.equal((await request({
      headers: { host: base.host, accept: base.accept, authorization: TOKEN }
    })).status, 401);
  });
});

test("a non-loopback host or origin is refused", async () => {
  await withServer(echo, async ({ port, base, call: request }) => {
    // Driven directly for the header checks that node's own client would rewrite.
    const transport = new McpHttpTransport({
      token: TOKEN,
      handleMessage: echo,
      createListener: realListenerFactory({ closed: false })
    });
    const authorized = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized, host: "evil.example", origin: `http://127.0.0.1:${port}` }, body: initializeBody()
    }))).status, 403);
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized, origin: "https://evil.example" }, body: initializeBody()
    }))).status, 403);
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized, origin: "null" }, body: initializeBody()
    }))).status, 403);
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized }, body: initializeBody()
    }))).status, 403, "a missing Host header is not loopback");
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized, host: "127.0.0.1", origin: "http://localhost:1234" }, body: initializeBody()
    }))).status, 200);
    assert.equal((await transport.handle(directRequest({
      headers: { ...authorized, host: "[::1]" }, body: initializeBody()
    }))).status, 200);
    // And over a real socket, with only the Origin header differing.
    assert.equal((await request({
      headers: { ...base, origin: "http://localhost:1234" }, body: initializeBody()
    })).status, 200);
    assert.equal((await request({
      headers: { ...base, origin: "https://evil.example" }, body: initializeBody()
    })).status, 403);
  });
});

test("the endpoint path is the only one and POST is the only method", async () => {
  await withServer(echo, async ({ call: request }) => {
    assert.equal((await request({ path: "/other", body: initializeBody() })).status, 404);
    assert.equal((await request({ path: "/mcp/extra", body: initializeBody() })).status, 404);
    assert.equal((await request({ method: "GET", path: "/mcp" })).status, 405);
    assert.equal((await request({ method: "DELETE", path: "/mcp" })).status, 405);
    assert.equal((await request({ path: "/other", body: initializeBody() })).body, "");
  });
});

test("both response media types must be acceptable", async () => {
  await withServer(echo, async ({ base, call: request }) => {
    const { accept: _accept, ...withoutAccept } = base;
    assert.equal((await request({ headers: { ...base, accept: "application/json" }, body: initializeBody() })).status, 406);
    assert.equal((await request({ headers: { ...base, accept: "text/event-stream" }, body: initializeBody() })).status, 406);
    assert.equal((await request({ headers: withoutAccept, body: initializeBody() })).status, 406);
    assert.equal((await request({
      headers: { ...base, accept: "application/json;q=1, text/event-stream;q=0.5" }, body: initializeBody()
    })).status, 200);
  });
});

test("an oversized body is refused with 413 and never reaches the handler", async () => {
  await withServer(echo, async ({ base, seen, call: request }) => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(MAX_MCP_REQUEST_BYTES) });
    assert.equal(huge.length > MAX_MCP_REQUEST_BYTES, true);
    assert.equal((await request({ headers: base, body: huge })).status, 413);
    assert.deepEqual(seen, []);
    const atLimit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", pad: "" });
    assert.equal(atLimit.length < MAX_MCP_REQUEST_BYTES, true);
    assert.equal((await request({ headers: base, body: atLimit })).status, 200);
  });
});

test("initialize answers with a session id, and later calls must present it", async () => {
  await withServer(echo, async ({ base, seen, call: request }) => {
    const initialized = await request({ headers: base, body: initializeBody() });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers["content-type"], "application/json");
    assert.equal(initialized.headers["mcp-session-id"], SESSION);
    assert.deepEqual(JSON.parse(initialized.body), { jsonrpc: "2.0", id: 1, result: "ok" });

    const followUp = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal((await request({ headers: base, body: followUp })).status, 404);
    assert.equal((await request({
      headers: { ...base, "mcp-session-id": "someone-elses" }, body: followUp
    })).status, 404);
    const accepted = await request({ headers: { ...base, "mcp-session-id": SESSION }, body: followUp });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["mcp-session-id"], undefined);
    assert.equal(seen.length, 2);
  });
});

test("a notification is accepted with an empty 202 body", async () => {
  await withServer(
    (raw) => (JSON.parse(raw) as { method?: string }).method === "initialize" ? echo(raw) : undefined,
    async ({ base, call: request }) => {
      assert.equal((await request({ headers: base, body: initializeBody() })).status, 200);
      const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = await request({ headers: { ...base, "mcp-session-id": SESSION }, body: notification });
      assert.equal(result.status, 202);
      assert.equal(result.body, "");
      assert.equal(result.headers["mcp-session-id"], undefined);
      assert.equal(result.headers["content-type"], undefined);
    }
  );
});

test("a handler failure is reported as a server error instead of a crash", async () => {
  await withServer(() => { throw new Error("boom"); }, async ({ base, call: request }) => {
    assert.equal((await request({ headers: base, body: initializeBody() })).status, 500);
  });
});

test("closing releases the socket and forgets the session", async () => {
  const state = { closed: false };
  const transport = new McpHttpTransport({
    token: TOKEN,
    handleMessage: echo,
    createListener: realListenerFactory(state),
    createSessionId: () => SESSION
  });
  const port = await transport.listen(0);
  const base = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
  assert.equal((await call(port, { headers: base, body: initializeBody() })).status, 200);
  assert.equal(transport.boundPort, port);
  await transport.close();
  assert.equal(state.closed, true);
  assert.equal(transport.boundPort, undefined);
  await assert.rejects(() => call(port, { headers: base, body: initializeBody() }));
});

/** A listener whose first `failures` bind attempts refuse the port as busy. */
function flakyListenerFactory(failures: number, bound: number[] = []) {
  // Deliberately not a socket: these cases exercise the controller's port
  // selection, recording and token reuse. Binding the preferred port for real
  // would make the suite depend on machine state — the default port is exactly
  // the one a running plugin (or any other service) may already hold, which made
  // this file flaky. Real loopback sockets are covered by `withServer` above,
  // which always asks the OS for a free port.
  const factory: McpListenerFactory = {
    listen: (port) => {
      if (failures > 0 && bound.length === 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
      }
      bound.push(port);
      return Promise.resolve({ port, close: () => Promise.resolve() });
    }
  };
  return { factory, bound };
}

test("the controller reuses one device token and records the bound port", async () => {
  const stored = new Map<string, unknown>();
  const { factory, bound } = flakyListenerFactory(0);
  const recordKey = mcpServerRecordKey("mind-tree-nature", "read");
  const controller = new McpServerController({
    pluginId: "mind-tree-nature",
    group: "read",
    isDesktop: () => true,
    storage: {
      load: (key) => stored.get(key) ?? null,
      save: (key, value) => { stored.set(key, value); }
    },
    handleMessage: echo,
    createListener: factory,
    createToken: () => "token-abcdefghijklmnop"
  });

  assert.equal(controller.group, "read");
  assert.equal(controller.storageKey, recordKey);
  const tokenBeforeStart = controller.token();
  assert.equal(tokenBeforeStart, "token-abcdefghijklmnop");
  // The record exists before the server runs, so the configuration the settings
  // page shows is already the one the server will accept.
  assert.deepEqual(stored.get(recordKey), {
    port: DEFAULT_MCP_READ_PORT, token: "token-abcdefghijklmnop"
  });

  const status = await controller.start(DEFAULT_MCP_READ_PORT);
  assert.equal(status.kind, "running");
  assert.deepEqual(status, { kind: "running", url: mcpUrl(DEFAULT_MCP_READ_PORT) });
  assert.deepEqual(bound, [DEFAULT_MCP_READ_PORT]);
  assert.deepEqual(stored.get(recordKey), {
    port: DEFAULT_MCP_READ_PORT, token: "token-abcdefghijklmnop"
  });
  assert.equal(controller.token(), tokenBeforeStart);

  await controller.stop();
  assert.deepEqual(controller.status(), { kind: "stopped" });
  // The record survives a stop: copying the client configuration must keep working.
  assert.deepEqual(normalizeMcpServerRecord(stored.get(recordKey)), {
    port: DEFAULT_MCP_READ_PORT, token: "token-abcdefghijklmnop"
  } as McpServerRecord);
});

test("the two servers keep separate record keys, ports and tokens", async () => {
  const stored = new Map<string, unknown>();
  const storage = {
    load: (key: string) => stored.get(key) ?? null,
    save: (key: string, value: unknown) => { stored.set(key, value); }
  };
  const controllerOf = (group: "read" | "write", token: string) => new McpServerController({
    pluginId: "mind-tree-nature",
    group,
    isDesktop: () => true,
    storage,
    handleMessage: echo,
    createListener: flakyListenerFactory(0).factory,
    createToken: () => token
  });
  const read = controllerOf("read", "read-token-abcdefghij");
  const write = controllerOf("write", "write-token-abcdefghij");

  assert.equal(read.group, "read");
  assert.equal(write.group, "write");
  // Distinct keys are what let the two devices-local records coexist: one
  // record cannot overwrite the other's port or token.
  assert.equal(read.storageKey, mcpServerRecordKey("mind-tree-nature", "read"));
  assert.equal(write.storageKey, mcpServerRecordKey("mind-tree-nature", "write"));
  assert.notEqual(read.storageKey, write.storageKey);
  assert.equal(read.storageKey, "mind-tree-nature:mcp-server:read");
  assert.equal(write.storageKey, "mind-tree-nature:mcp-server:write");

  // Minting happens before start, so the settings page can show a usable token.
  const readToken = read.token();
  const writeToken = write.token();
  assert.equal(readToken, "read-token-abcdefghij");
  assert.equal(writeToken, "write-token-abcdefghij");
  // The security boundary in one assertion: a token that unlocked writes must
  // never be the token the read-only configuration carries.
  assert.notEqual(readToken, writeToken);

  assert.deepEqual(normalizeMcpServerRecord(stored.get(read.storageKey)), {
    port: DEFAULT_MCP_READ_PORT, token: readToken
  } as McpServerRecord);
  assert.deepEqual(normalizeMcpServerRecord(stored.get(write.storageKey)), {
    port: DEFAULT_MCP_WRITE_PORT, token: writeToken
  } as McpServerRecord);

  assert.deepEqual(await read.start(DEFAULT_MCP_READ_PORT), {
    kind: "running", url: mcpUrl(DEFAULT_MCP_READ_PORT)
  });
  assert.deepEqual(await write.start(DEFAULT_MCP_WRITE_PORT), {
    kind: "running", url: mcpUrl(DEFAULT_MCP_WRITE_PORT)
  });
  assert.equal(read.boundPort, DEFAULT_MCP_READ_PORT);
  assert.equal(write.boundPort, DEFAULT_MCP_WRITE_PORT);
  await read.stop();
  await write.stop();
});

test("the controller falls back to nearby ports and reports a total failure", async () => {
  const stored = new Map<string, unknown>();
  const { factory, bound } = flakyListenerFactory(3);
  const controller = new McpServerController({
    pluginId: "mind-tree-nature",
    group: "read",
    isDesktop: () => true,
    storage: { load: (key) => stored.get(key) ?? null, save: (key, value) => { stored.set(key, value); } },
    handleMessage: echo,
    createListener: factory,
    createToken: () => "token-abcdefghijklmnop"
  });
  const status = await controller.start(27321);
  assert.deepEqual(status, { kind: "running", url: mcpUrl(27324) });
  assert.deepEqual(bound, [27324]);
  await controller.stop();

  const alwaysBusy = new McpServerController({
    pluginId: "mind-tree-nature",
    group: "write",
    isDesktop: () => true,
    storage: { load: () => null, save: () => undefined },
    handleMessage: echo,
    createListener: {
      listen: () => Promise.reject(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }))
    },
    createToken: () => "token-abcdefghijklmnop"
  });
  const failed = await alwaysBusy.start(30000);
  assert.equal(failed.kind, "failed");
  assert.equal(alwaysBusy.status().kind, "failed");
  // Nothing bound, so the reported port stays the one the user asked for.
  assert.equal(alwaysBusy.port, 30000);
});

test("an unsupported platform never binds, even when start is called directly", async () => {
  let listened = 0;
  const controller = new McpServerController({
    pluginId: "mind-tree-nature",
    group: "read",
    isDesktop: () => false,
    storage: { load: () => null, save: () => undefined },
    handleMessage: echo,
    createListener: {
      listen: () => { listened += 1; return Promise.reject(new Error("must not bind")); }
    },
    createToken: () => "token-abcdefghijklmnop"
  });
  assert.deepEqual(controller.status(), { kind: "unsupported" });
  assert.deepEqual(await controller.start(27321), { kind: "unsupported" });
  assert.equal(listened, 0);
});
