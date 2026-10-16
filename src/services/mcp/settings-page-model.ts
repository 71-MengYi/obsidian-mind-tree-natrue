/**
 * Pure decision layer for the AI settings page.
 *
 * The page itself is only DOM plumbing: it asks these functions what to render
 * and what a control change means. Keeping the rules here means the
 * desktop-only gate, the two capability switches (editing an existing tree and
 * creating a whole new one) and the port validation are covered by ordinary unit
 * tests instead of a browser-shaped harness.
 */
import { t } from "../../i18n";
import {
  MAX_MCP_PORT,
  MIN_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  normalizeMcpPort
} from "../../settings-model";
import { DEFAULT_MCP_HOST } from "./connection";

export type McpSettingsStatus =
  | { kind: "unsupported" }
  | { kind: "stopped" }
  | { kind: "running"; url: string }
  | { kind: "failed"; message: string };

/** What the page receives; every field is already resolved by the host. */
export interface McpPageState {
  supported: boolean;
  enabled: boolean;
  allowWrites: boolean;
  allowTreeCreation: boolean;
  port: number;
  status: McpSettingsStatus;
  configuredPort: number;
  token: string;
}

/** One rendered control, so the page never decides behaviour on its own. */
export interface McpPageModel {
  supported: boolean;
  heading: string;
  description: string;
  enable: { value: boolean; disabled: boolean };
  writes: { value: boolean; disabled: boolean };
  treeCreation: { value: boolean; disabled: boolean };
  port: { value: number; disabled: boolean };
  status: { kind: McpSettingsStatus["kind"]; text: string };
  config: { text: string; visible: boolean };
}

/** `port` is valid when it is a whole number inside the bindable range. */
export function parseMcpPortInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return undefined;
  return normalizeMcpPort(Number(trimmed));
}

/** The port a running service actually bound, falling back to the preference. */
export function resolveConfiguredPort(port: number): number {
  return normalizeMcpPort(port) ?? MIN_MCP_PORT;
}

export function buildMcpConfigText(port: number, token: string): string {
  return JSON.stringify({
    mcpServers: {
      "mind-tree-nature": {
        url: `http://${DEFAULT_MCP_HOST}:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }, null, 2);
}

export function describeMcpStatus(status: McpSettingsStatus): string {
  switch (status.kind) {
    case "unsupported": return t("settings.ai.mcp.status.desktopOnly");
    case "stopped": return t("settings.ai.mcp.status.stopped");
    case "failed": return t("settings.ai.mcp.status.failed", { message: status.message });
    case "running": return t("settings.ai.mcp.status.running", { url: status.url });
  }
}

export function buildMcpPageModel(state: McpPageState): McpPageModel {
  const writesDisabled = !state.supported || !state.enabled;
  return {
    supported: state.supported,
    heading: t("settings.ai.mcp.heading"),
    description: t("settings.ai.mcp.desc"),
    enable: { value: state.enabled, disabled: !state.supported },
    // Editing and creating are meaningless while the server is off, so both
    // switches stay visible but inert instead of hidden, which would hide the
    // capability. They are also independent of each other: a user may want one
    // without the other, so neither disables its sibling.
    writes: { value: state.allowWrites, disabled: writesDisabled },
    treeCreation: { value: state.allowTreeCreation, disabled: writesDisabled },
    port: { value: state.port, disabled: !state.supported },
    status: { kind: state.status.kind, text: describeMcpStatus(state.status) },
    config: {
      text: buildMcpConfigText(state.configuredPort, state.token),
      // A token is only handed out on a platform that can actually serve it.
      visible: state.supported
    }
  };
}

/** Rendered only as a hint; the host enforces the real fallback range. */
export function describePortFallbacks(): number {
  return MCP_PORT_FALLBACK_ATTEMPTS;
}

export { MAX_MCP_PORT, MIN_MCP_PORT };
