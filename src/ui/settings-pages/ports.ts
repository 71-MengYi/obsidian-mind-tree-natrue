import type { MindTreeSettings } from "../../settings-model";
import type { ResourceIndexProgress, ResourceIndexReport } from "../../services/resource-catalog";
import type { UpdateState } from "../../services/updates/update-coordinator";
import type { McpPageState, McpSettingsStatus } from "../../services/mcp/settings-page-model";

/** Settings pages mutate only the supplied model and named persistence ports. */
export interface SettingsPagePort {
  readonly settings: MindTreeSettings;
  readonly save: () => Promise<void>;
  readonly refreshOpenLayouts: () => void;
  readonly rebuildResourceIndex: (progress?: (value: ResourceIndexProgress) => void) => Promise<ResourceIndexReport>;
  readonly updates: {
    check(): Promise<void>;
    showAvailable(): void;
    subscribe(listener: (state: UpdateState) => void): () => void;
  };
  readonly mcp: McpSettingsPagePort;
}

/**
 * Everything the AI settings page needs from the MCP subsystem.
 *
 * The page never touches the transport or node's HTTP module directly; it reads
 * one resolved snapshot and asks for named transitions, so a platform without
 * MCP support simply reports `supported: false` and the page renders a notice.
 */
export interface McpSettingsPagePort {
  state(): McpPageState;
  setEnabled(enabled: boolean): Promise<void>;
  setAllowWrites(allowWrites: boolean): Promise<void>;
  setPort(port: number): Promise<void>;
  /** Applies the port text as typed; returns false when it is not a valid port. */
  applyPortInput(raw: string): Promise<boolean>;
  start(): Promise<McpSettingsStatus>;
  stop(): Promise<void>;
  /** Writes to the system clipboard; false means the caller must show the text. */
  copyText(text: string): Promise<boolean>;
}

/**
 * The MCP port as seen on a platform that cannot serve it.
 *
 * Tests and non-MCP pages need a value for the slot without owning any MCP
 * behaviour, and a shared default keeps them from drifting apart when the
 * interface grows.
 */
export function unsupportedMcpSettingsPort(): McpSettingsPagePort {
  return {
    state: () => ({
      supported: false,
      enabled: false,
      allowWrites: false,
      port: 0,
      status: { kind: "unsupported" },
      configuredPort: 0,
      token: ""
    }),
    setEnabled: async () => undefined,
    setAllowWrites: async () => undefined,
    setPort: async () => undefined,
    applyPortInput: async () => false,
    start: async () => ({ kind: "unsupported" }),
    stop: async () => undefined,
    copyText: async () => false
  };
}

export interface SettingsPageObject {
  readonly element: HTMLElement;
  destroy?(): void;
}
