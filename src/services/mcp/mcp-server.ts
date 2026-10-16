import {
  DEFAULT_MCP_READ_PORT,
  DEFAULT_MCP_WRITE_PORT,
  MAX_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  normalizeMcpPort
} from "../../settings-model";
import { isMcpSupported } from "./availability";
import { mcpServerRecordKey, mcpUrl, normalizeMcpServerRecord, type McpServerGroup, type McpServerRecord } from "./connection";
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
  /** Which of the two servers this controller owns. */
  group: McpServerGroup;
  /** `!Platform.isMobile`, read at call time so a reload cannot stale it. */
  isDesktop(): boolean;
  storage: McpServerStorage;
  handleMessage: (raw: string) => unknown | Promise<unknown>;
  createListener?: McpListenerFactory;
  createToken?: () => string;
  logger?: (message: string) => void;
}

/**
 * Owns the lifetime of one local MCP endpoint.
 *
 * One instance per group, because the two servers are independent: separate
 * ports for separate client approval policies, and separate tokens so a read
 * configuration can never unlock writes.
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
  private preferredPort: number;
  private memory?: McpServerRecord;

  constructor(private readonly options: McpServerControllerOptions) {
    this.preferredPort = DEFAULT_PORT_BY_GROUP[options.group];
  }

  /** A getter, not a field: `useDefineForClassFields` initializes fields before
   * the constructor assigns the parameter property, so a field copy would read
   * `undefined`. */
  get group(): McpServerGroup {
    return this.options.group;
  }

  /** The record key; per group and device-local, so never part of `data.json`. */
  get storageKey(): string {
    return mcpServerRecordKey(this.options.pluginId, this.options.group);
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

  /** The live bound port, or `undefined` while nothing is listening. */
  get boundPort(): number | undefined {
    return this.transport?.boundPort;
  }

  status(): McpSettingsStatus {
    if (!this.options.isDesktop()) return { kind: "unsupported" };
    return this.live;
  }

  /** Binds, falling back to nearby ports, and reports what happened. */
  async start(preferredPort: number): Promise<McpSettingsStatus> {
    this.preferredPort = normalizeMcpPort(preferredPort) ?? DEFAULT_PORT_BY_GROUP[this.options.group];
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
      this.options.logger?.(`MCP record could not be stored: ${describeThrown(error)}`);
    }
  }
}

/** The port each group prefers when settings supply none. */
const DEFAULT_PORT_BY_GROUP: Record<McpServerGroup, number> = {
  read: DEFAULT_MCP_READ_PORT,
  write: DEFAULT_MCP_WRITE_PORT
};

function describeThrown(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
