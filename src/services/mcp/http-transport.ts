import { DEFAULT_MCP_HOST, LOOPBACK_HOSTS, MAX_MCP_REQUEST_BYTES, MCP_ENDPOINT_PATH } from "./connection";

/**
 * The loopback HTTP transport for the MCP endpoint.
 *
 * This is the only module in the plugin that may touch `node:http`, and it does
 * so from inside a function (see `loadNodeHttp`), never at module evaluation, so
 * the mobile bundle keeps loading this file untouched. Everything observable
 * lives in `McpHttpTransport.handle`, which maps one fully buffered request to
 * one response without any stream, socket or server object — that is what the
 * tests drive, and the real listener is a thin adapter around it.
 */

/** One fully buffered request. */
export interface McpHttpRequest {
  method: string;
  /** Request target as sent, e.g. `/mcp` or `/mcp?session=1`. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  /** The client sent more than `MAX_MCP_REQUEST_BYTES`. */
  oversized: boolean;
}

export interface McpHttpResponse {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface McpListenerHandle {
  /** The port that was actually bound, which may differ from the request. */
  readonly port: number;
  close(): Promise<void>;
}

/** Injectable so a test can bind a real `node:http` server of its own. */
export interface McpListenerFactory {
  listen(port: number, onRequest: (request: McpHttpRequest) => Promise<McpHttpResponse>): Promise<McpListenerHandle>;
}

export interface McpHttpTransportOptions {
  token: string;
  /** One JSON-RPC message in, one response out; `undefined` means "no reply". */
  handleMessage: (raw: string) => unknown | Promise<unknown>;
  createListener?: McpListenerFactory;
  createSessionId?: () => string;
  logger?: (message: string) => void;
}

export class McpHttpTransport {
  private readonly sessions = new Set<string>();
  private listener?: McpListenerHandle;
  private readonly createListener: McpListenerFactory;
  private readonly createSessionId: () => string;

  constructor(private readonly options: McpHttpTransportOptions) {
    this.createListener = options.createListener ?? createNodeHttpListenerFactory();
    this.createSessionId = options.createSessionId ?? (() => crypto.randomUUID());
  }

  get boundPort(): number | undefined {
    return this.listener?.port;
  }

  /** Binds loopback only; returns the port that was actually bound. */
  async listen(port: number): Promise<number> {
    if (this.listener) return this.listener.port;
    const listener = await this.createListener.listen(port, (request) => this.handle(request));
    this.listener = listener;
    this.options.logger?.(`MCP endpoint listening on ${DEFAULT_MCP_HOST}:${listener.port}`);
    return listener.port;
  }

  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = undefined;
    this.sessions.clear();
    if (listener) await listener.close();
  }

  /**
   * The single request → response mapping.
   *
   * Order matters: the caller's identity and origin are checked before anything
   * about the request is interpreted, a session is only issued for `initialize`,
   * and every other request must present a session this transport issued.
   */
  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    if (!this.isLoopback(request)) return { status: 403 };
    if (!this.isAuthorized(request)) return { status: 401 };
    const path = request.url.split("?")[0] ?? "";
    if (path !== MCP_ENDPOINT_PATH) return { status: 404 };
    if (request.method.toUpperCase() !== "POST") return { status: 405 };
    if (!this.acceptsBoth(request)) return { status: 406 };
    if (request.oversized) return { status: 413 };

    const initializing = isInitializeRequest(request.body);
    const sessionId = headerValue(request.headers, "mcp-session-id");
    if (!initializing && (!sessionId || !this.sessions.has(sessionId))) {
      // An unknown session is not a new one: a client that lost its id must
      // re-initialize rather than continue against a guessed conversation.
      return { status: 404 };
    }

    let response: unknown;
    try {
      response = await this.options.handleMessage(request.body);
    } catch (error) {
      this.options.logger?.(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 500 };
    }
    if (response === undefined) return { status: 202 };
    if (initializing) {
      const issued = this.createSessionId();
      this.sessions.add(issued);
      return {
        status: 200,
        contentType: "application/json",
        headers: { "mcp-session-id": issued },
        body: JSON.stringify(response)
      };
    }
    return { status: 200, contentType: "application/json", body: JSON.stringify(response) };
  }

  private isLoopback(request: McpHttpRequest): boolean {
    const host = headerValue(request.headers, "host");
    if (!host || !LOOPBACK_HOSTS.includes(hostnameOf(host) as (typeof LOOPBACK_HOSTS)[number])) return false;
    const origin = headerValue(request.headers, "origin");
    if (origin === undefined) return true;
    // A browser page on another site must not be able to reach this endpoint,
    // even though the request itself arrives over loopback.
    return LOOPBACK_HOSTS.includes(originHostnameOf(origin) as (typeof LOOPBACK_HOSTS)[number]);
  }

  private isAuthorized(request: McpHttpRequest): boolean {
    const header = headerValue(request.headers, "authorization");
    if (!header) return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1] === this.options.token;
  }

  private acceptsBoth(request: McpHttpRequest): boolean {
    const accept = headerValue(request.headers, "accept")?.toLowerCase() ?? "";
    return accept.includes("application/json") && accept.includes("text/event-stream");
  }
}

/** Strip the port from a `Host` header without breaking bracketed IPv6. */
function hostnameOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end < 0 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon <= 0 ? trimmed : trimmed.slice(0, colon);
}

function originHostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  // Header lookup is case-insensitive, and the buffered test requests use plain
  // objects, so a mixed-case key must still be found.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0];
  }
  return undefined;
}

/** A session is issued for an `initialize` request, and only for one. */
function isInitializeRequest(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record["method"] === "initialize" && record["id"] !== undefined && record["id"] !== null;
  } catch {
    return false;
  }
}

const NODE_HTTP_SPECIFIER = "node:http";

/**
 * Required lazily from inside a function.
 *
 * The specifier is deliberately a variable: the plugin is bundled for a browser
 * platform whose external list does not contain node built-ins, so a literal
 * `require("node:http")` would fail `npm run build`. Nothing here runs on a
 * platform that cannot serve MCP, and nothing runs at module evaluation.
 */
function loadNodeHttp(): typeof import("node:http") {
  const loader: unknown = typeof require === "function" ? require : undefined;
  if (typeof loader !== "function") throw new Error("node:http is unavailable in this runtime.");
  return (loader as (specifier: string) => typeof import("node:http"))(NODE_HTTP_SPECIFIER);
}

/**
 * The production listener: a `node:http` server bound to loopback only.
 *
 * The body is buffered up to the request limit and reported as `oversized`
 * beyond it, so the decision stays in `handle` where it is testable.
 */
export function createNodeHttpListenerFactory(): McpListenerFactory {
  return {
    listen: (port, onRequest) => {
      const http = loadNodeHttp();
      const server = http.createServer((request, response) => {
        void serve(request, response, onRequest);
      });
      return new Promise<McpListenerHandle>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          server.on("error", (error: Error) => console.error("Mind Tree Nature: MCP listener error", error));
          const address = server.address();
          const boundPort = address && typeof address === "object" ? address.port : port;
          resolve({
            port: boundPort,
            close: () => new Promise<void>((done, failed) => {
              // A client's idle keep-alive socket would otherwise keep
              // `server.close()` pending for as long as the client waits.
              server.closeIdleConnections();
              server.close((error) => { if (error) failed(error); else done(); });
            })
          });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, DEFAULT_MCP_HOST);
      });
    }
  };
}

async function serve(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  onRequest: (request: McpHttpRequest) => Promise<McpHttpResponse>
): Promise<void> {
  const body = await readBody(request);
  const result = await onRequest({
    method: request.method ?? "GET",
    url: request.url ?? "/",
    headers: request.headers,
    body: body.text,
    oversized: body.oversized
  });
  response.writeHead(result.status, {
    ...(result.contentType ? { "content-type": result.contentType } : {}),
    ...(result.headers ?? {})
  });
  response.end(result.body ?? "");
}

function readBody(request: import("node:http").IncomingMessage): Promise<{ text: string; oversized: boolean }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let oversized = false;
    request.on("data", (chunk: Uint8Array) => {
      if (oversized) return;
      size += chunk.byteLength;
      if (size > MAX_MCP_REQUEST_BYTES) {
        // Stop buffering immediately: the response is already decided, and an
        // unbounded client must not be able to grow this process.
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve({ text: oversized ? "" : Buffer.concat(chunks).toString("utf8"), oversized }));
    request.on("error", () => resolve({ text: "", oversized: true }));
  });
}
