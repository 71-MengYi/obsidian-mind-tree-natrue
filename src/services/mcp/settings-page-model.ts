/**
 * Pure decision layer for the AI settings page.
 *
 * The page itself is only DOM plumbing: it asks these functions what to render
 * and what a control change means. Keeping the rules here means the desktop-only
 * gate, the port validation and the configuration text are covered by ordinary
 * unit tests instead of a browser-shaped harness.
 *
 * The product shape is one local MCP server carrying every tool. An MCP client
 * attaches its approval policy to a *server*, so reading and editing share the
 * same client-side policy; the plugin does not gate individual tools.
 */
import { t } from "../../i18n";
import {
  MAX_MCP_PORT,
  MIN_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  normalizeMcpPort
} from "../../settings-model";
import { DEFAULT_MCP_HOST } from "./connection";
import type { McpClientServerConnection } from "./client-config";
import { buildMcpClientConfigText } from "./client-config";

export type McpSettingsStatus =
  | { kind: "unsupported" }
  | { kind: "stopped" }
  | { kind: "running"; url: string }
  | { kind: "failed"; message: string };

/** The server's rendered facts: what the user asked for, and what is live. */
export interface McpEndpointState {
  /** The preferred port from settings. */
  port: number;
  /** The port actually bound, which differs after a fallback. */
  boundPort?: number;
  status: McpSettingsStatus;
  token: string;
}

/** What the page receives; every field is already resolved by the host. */
export interface McpPageState {
  supported: boolean;
  /** The master switch; it is also the only switch. */
  enabled: boolean;
  server: McpEndpointState;
}

/** One rendered control, so the page never decides behaviour on its own. */
export interface McpPageModel {
  supported: boolean;
  heading: string;
  description: string;
  enable: { value: boolean; disabled: boolean };
  server: McpServerModel;
  config: { text: string; visible: boolean };
}

export interface McpServerModel {
  /** Name shown as the row's own sub-heading. */
  heading: string;
  port: { value: number; disabled: boolean };
  status: { kind: McpSettingsStatus["kind"]; text: string };
  /** Scrollable, wrapped explanation of what the server holds. */
  scope: string;
  /**
   * Whether the server's own controls are inert because the master switch is
   * off or the platform cannot serve it.
   *
   * Exposed so the page never has to reconstruct "the server is off" from
   * `enable.value` plus `enable.disabled`: that composition is a policy decision
   * and belongs beside the rule that produced it.
   */
  disabled: boolean;
}

/** `port` is valid when it is a whole number inside the bindable range. */
export function parseMcpPortInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return undefined;
  return normalizeMcpPort(Number(trimmed));
}

export function describeMcpStatus(status: McpSettingsStatus): string {
  switch (status.kind) {
    case "unsupported": return t("settings.ai.mcp.status.desktopOnly");
    case "stopped": return t("settings.ai.mcp.status.stopped");
    case "failed": return t("settings.ai.mcp.status.failed", { message: status.message });
    case "running": return t("settings.ai.mcp.status.running", { url: status.url });
  }
}

/** The connections the copied configuration should advertise. */
export function enabledConnections(state: McpPageState): McpClientServerConnection[] {
  if (!state.supported || !state.enabled) return [];
  return [{
    port: state.server.boundPort ?? state.server.port,
    token: state.server.token
  }];
}

export function buildMcpPageModel(state: McpPageState): McpPageModel {
  // The server is meaningless while the master switch is off, so its controls
  // stay visible but inert instead of hidden, which would hide the capability.
  const serverDisabled = !state.supported || !state.enabled;
  return {
    supported: state.supported,
    heading: t("settings.ai.mcp.heading"),
    description: t("settings.ai.mcp.desc"),
    enable: { value: state.enabled, disabled: !state.supported },
    server: {
      heading: t("settings.ai.mcp.server.heading"),
      scope: t("settings.ai.mcp.server.scope"),
      port: { value: state.server.port, disabled: serverDisabled },
      status: { kind: state.server.status.kind, text: describeMcpStatus(state.server.status) },
      disabled: serverDisabled
    },
    config: {
      text: buildMcpClientConfigText(enabledConnections(state)),
      // A token is only handed out on a platform that can actually serve one.
      visible: state.supported
    }
  };
}

/** Rendered only as a hint; the host enforces the real fallback range. */
export function describePortFallbacks(): number {
  return MCP_PORT_FALLBACK_ATTEMPTS;
}

export { MAX_MCP_PORT, MIN_MCP_PORT, DEFAULT_MCP_HOST };
