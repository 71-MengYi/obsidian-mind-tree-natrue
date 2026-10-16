/**
 * Pure decision layer for the AI settings page.
 *
 * The page itself is only DOM plumbing: it asks these functions what to render
 * and what a control change means. Keeping the rules here means the
 * desktop-only gate, the two-server port validation and the configuration text
 * are covered by ordinary unit tests instead of a browser-shaped harness.
 *
 * The product shape is two MCP servers rather than one server with permission
 * switches, because an MCP client attaches its approval policy to a *server*.
 * `read` holds nothing that changes a file (so it can run unattended) and
 * `write` holds everything that does (so it can require approval).
 */
import { t } from "../../i18n";
import {
  MAX_MCP_PORT,
  MIN_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  normalizeMcpPort
} from "../../settings-model";
import { DEFAULT_MCP_HOST, type McpServerGroup } from "./connection";
import type { McpClientServerConnection } from "./client-config";
import { buildMcpClientConfigText } from "./client-config";

export type McpSettingsStatus =
  | { kind: "unsupported" }
  | { kind: "stopped" }
  | { kind: "running"; url: string }
  | { kind: "failed"; message: string };

/** One server's rendered facts: what the user asked for, and what is live. */
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
  /** The master switch. */
  enabled: boolean;
  read: McpEndpointState;
  /** Whether the write server is meant to listen; no per-tool switch exists. */
  writeEnabled: boolean;
  write: McpEndpointState;
}

/** One rendered control, so the page never decides behaviour on its own. */
export interface McpPageModel {
  supported: boolean;
  heading: string;
  description: string;
  enable: { value: boolean; disabled: boolean };
  read: McpServerModel;
  write: McpServerModel & { value: boolean };
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
   * Whether this server's own controls are inert because the master switch is
   * off or the platform cannot serve it.
   *
   * Exposed so the page never has to reconstruct "the servers are off" from
   * `enable.value` plus `enable.disabled`: that composition is a policy decision
   * and belongs beside the rule that produced it. Deliberately NOT true merely
   * because the write server is switched off — its toggle must stay usable so
   * the user can switch it on.
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

export function describeMcpServerStatus(group: McpServerGroup, status: McpSettingsStatus): string {
  return describeMcpStatus(status);
}

/** The connections the copied configuration should advertise. */
export function enabledConnections(state: McpPageState): McpClientServerConnection[] {
  if (!state.supported || !state.enabled) return [];
  const connections: McpClientServerConnection[] = [
    { group: "read", port: state.read.boundPort ?? state.read.port, token: state.read.token }
  ];
  // The write entry appears only once its server is actually meant to listen, so
  // a copied configuration never advertises an endpoint that is not served.
  if (state.writeEnabled) {
    connections.push({
      group: "write",
      port: state.write.boundPort ?? state.write.port,
      token: state.write.token
    });
  }
  return connections;
}

export function buildMcpPageModel(state: McpPageState): McpPageModel {
  // Both servers are meaningless while the master switch is off, so their
  // controls stay visible but inert instead of hidden, which would hide the
  // capability. The write switch never disables the read server and vice versa.
  const serversDisabled = !state.supported || !state.enabled;
  return {
    supported: state.supported,
    heading: t("settings.ai.mcp.heading"),
    description: t("settings.ai.mcp.desc"),
    enable: { value: state.enabled, disabled: !state.supported },
    read: {
      heading: t("settings.ai.mcp.read.heading"),
      scope: t("settings.ai.mcp.read.scope"),
      port: { value: state.read.port, disabled: serversDisabled },
      status: { kind: state.read.status.kind, text: describeMcpStatus(state.read.status) },
      disabled: serversDisabled
    },
    write: {
      heading: t("settings.ai.mcp.write.heading"),
      scope: t("settings.ai.mcp.write.scope"),
      value: state.writeEnabled,
      port: { value: state.write.port, disabled: serversDisabled || !state.writeEnabled },
      status: { kind: state.write.status.kind, text: describeMcpStatus(state.write.status) },
      disabled: serversDisabled
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
