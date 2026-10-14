import { DEFAULT_MCP_PORT, MAX_MCP_PORT, MCP_PORT_FALLBACK_ATTEMPTS, normalizeMcpPort } from "../../settings-model";
import { isMcpSupported } from "./availability";
import { mcpUrl, normalizeMcpServerRecord, type McpServerRecord } from "./connection";
import { McpHttpTransport, type McpListenerFactory } from "./http-transport";
import type { McpSettingsStatus } from "./settings-page-model";

/** The device-local record store: Obsidian's `loadLocalStorage`/`saveLocalStorage`. */
export interface McpServerStorage {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

export interface McpServerControllerOptions {
  /** `manifest.id`; the record key is per plugin and never leaves the device. */
  pluginId: string;
  /** `!Platform.isMobile`, read at call time so a reload cannot stale it. */
  isDesktop(): boolean;
  storage: McpServerStorage;
  handleMessage: (raw: string) => unknown | Promise<unknown>;
  createListener?: McpListenerFactory;
  createToken?: () => string;
  logger?: (message: string) => void;
}

/**
 * Owns the lifetime of the local MCP endpoint.
 *
 * The controller keeps three things apart on purpose: the *preference* (the port
 * the user asked for, from plugin settings), the *record* (this device's bound
 * port and access token, in local storage, never synced) and the *live state*
 * (whether a socket is actually listening). Reusing the recorded token is what
 * keeps an AI client's configuration working across restarts; re-reading
 * `isDesktop` on every start is what makes a platform gate impossible to bypass
 * by constructing the controller early.
 */
export class McpServerController {
  private transport?: McpHttpTransport;
  private live: McpSettingsStatus = { kind: "stopped" };
  private preferredPort: number = DEFAULT_MCP_PORT;
  private memory?: McpServerRecord;

  constructor(private readonly options: McpServerControllerOptions) {}

  /** The record key; device-local, so it is never part of `data.json`. */
  get storageKey(): string {
    return `${this.options.pluginId}:mcp-server`;
  }

  /**
   * The access token, minted on first use and then persisted.
   *
   * Minting happens as soon as the settings page asks for its state, because the
   * configuration it displays must be exactly the one the server will accept:
   * a token that changed on start would invalidate what the user just copied.
   */
  token(): string {
    const record = this.readRecord();
    if (record) return record.token;
    const token = this.options.createToken?.() ?? crypto.randomUUID();
    this.writeRecord({ port: this.preferredPort, token });
    return token;
  }

  /** The port a client should use: the bound one, else the recorded/last asked one. */
  get port(): number {
    return this.transport?.boundPort ?? this.readRecord()?.port ?? this.preferredPort;
  }

  status(): McpSettingsStatus {
    if (!this.options.isDesktop()) return { kind: "unsupported" };
    return this.live;
  }

  /** Binds, falling back to nearby ports, and reports what happened. */
  async start(preferredPort: number): Promise<McpSettingsStatus> {
    this.preferredPort = normalizeMcpPort(preferredPort) ?? DEFAULT_MCP_PORT;
    // Defence in depth: construct-time support is not evidence that the runtime
    // can still serve, and a half-started service is worse than an absent one.
    if (!isMcpSupported({ isDesktop: this.options.isDesktop() })) {
      this.live = { kind: "unsupported" };
      return this.live;
    }
    if (this.transport) return this.live;

    const token = this.token();
    const transport = new McpHttpTransport({
      token,
      handleMessage: this.options.handleMessage,
      ...(this.options.createListener ? { createListener: this.options.createListener } : {}),
      ...(this.options.logger ? { logger: this.options.logger } : {})
    });
    this.transport = transport;
    let lastError: unknown;
    for (let attempt = 0; attempt < MCP_PORT_FALLBACK_ATTEMPTS; attempt += 1) {
      const port = this.preferredPort + attempt;
      if (port > MAX_MCP_PORT) break;
      try {
        const bound = await transport.listen(port);
        // The record follows reality: a fallback port is what the client must use.
        this.writeRecord({ port: bound, token });
        this.live = { kind: "running", url: mcpUrl(bound) };
        return this.live;
      } catch (error) {
        lastError = error;
      }
    }
    this.transport = undefined;
    this.live = {
      kind: "failed",
      message: lastError instanceof Error ? lastError.message : String(lastError ?? "no port available")
    };
    return this.live;
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    // The token and the bound port stay recorded: stopping the server must not
    // force the user to copy a new client configuration.
    this.live = { kind: "stopped" };
    if (transport) await transport.close();
  }

  private readRecord(): McpServerRecord | undefined {
    return normalizeMcpServerRecord(this.options.storage.load(this.storageKey)) ?? this.memory;
  }

  private writeRecord(record: McpServerRecord): void {
    // Kept in memory as well: local storage can be unavailable (full disk,
    // private mode) and that must not churn the token mid-conversation.
    this.memory = record;
    try {
      this.options.storage.save(this.storageKey, record);
    } catch (error) {
      this.options.logger?.(`MCP record could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
