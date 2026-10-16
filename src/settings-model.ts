import {
  DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
  type NonMarkdownResourceIdSeparator
} from "./format/resource-id";
import type { ParseMindTreeOptions } from "./format/document";
import type { CustomMarkerDefinition } from "./domain/custom-markers";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme
} from "./types";
import { DEFAULT_NODE_WRAP_WIDTH } from "./render/layout";

/** Persisted cross-tree preferences, kept free of Obsidian UI dependencies. */
export interface MindTreeSettings {
  /** Explicit opt-in; checks never install code without a user click. */
  autoCheckUpdates: boolean;
  templateFolder: string;
  newNoteFolder: string;
  newNoteDefaultContent: string;
  ignoredPathPrefixes: string[];
  /** Non-Markdown extensions whose derived node badge stays hidden. */
  ignoredFileBadgeExtensions: string[];
  /** Case-insensitive extension keys mapped to user-facing badge labels. */
  fileExtensionBadgeAliases: Record<string, string>;
  titleSync: boolean;
  /**
   * User-managed marker palette entries, in display order. The node payload
   * only stores a marker's value, so this list is the single source of truth
   * for which custom markers are currently available.
   */
  customMarkers: CustomMarkerDefinition[];
  nonMarkdownIdSeparator: NonMarkdownResourceIdSeparator;
  resourceOpenMode: "tab" | "split-right";
  newNoteOpenMode: "split-right" | "tab" | "current" | "window";
  autosaveDelayMs: number;
  pngScale: 1 | 2 | 3;
  nodeWrapWidth: number;
  nodeAlignment: MindTreeNodeAlignment;
  defaultLayoutMode: MindTreeLayoutMode;
  defaultCollectionMode: MindTreeCollectionMode;
  theme: MindTreeTheme;
  connectionStyle: MindTreeConnectionStyle;
  nodeShape: MindTreeNodeShape;
  /**
   * Master switch for the two local MCP servers. Off by default because they
   * accept inbound connections; desktop-only, and the access tokens never live
   * here (they are device-local, see `services/mcp/connection.ts`).
   */
  mcpEnabled: boolean;
  /** Preferred port of the read-only server; a busy port falls back to nearby ones. */
  mcpReadPort: number;
  /**
   * Whether the second server (node edits plus whole-tree creation) listens.
   *
   * The two servers are separate so an MCP client can attach different approval
   * policies to them: the read server holds nothing that changes a file, while
   * this one holds every tool that does. There is deliberately no per-tool
   * switch — approval lives in the client, keyed on the server.
   */
  mcpWriteEnabled: boolean;
  /** Preferred port of the write server; a busy port falls back to nearby ones. */
  mcpWritePort: number;
}

/** Above 1024 the port needs no privileges; the upper bound is the TCP limit. */
export const MIN_MCP_PORT = 1024;
export const MAX_MCP_PORT = 65535;
/** The read server keeps the original single-endpoint port. */
export const DEFAULT_MCP_READ_PORT = 27321;
/** The write server sits on the next port so clients key on distinct host:port. */
export const DEFAULT_MCP_WRITE_PORT = 27322;
/** Busy ports are retried upward from the preferred one, with one bound. */
export const MCP_PORT_FALLBACK_ATTEMPTS = 10;

export const DEFAULT_SETTINGS: MindTreeSettings = {
  autoCheckUpdates: false,
  templateFolder: "",
  newNoteFolder: "",
  newNoteDefaultContent: "",
  ignoredPathPrefixes: [".obsidian/", ".trash/"],
  ignoredFileBadgeExtensions: [],
  fileExtensionBadgeAliases: {},
  titleSync: true,
  customMarkers: [],
  nonMarkdownIdSeparator: DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
  resourceOpenMode: "tab",
  newNoteOpenMode: "split-right",
  autosaveDelayMs: 500,
  pngScale: 2,
  nodeWrapWidth: DEFAULT_NODE_WRAP_WIDTH,
  nodeAlignment: "level",
  defaultLayoutMode: "balanced",
  defaultCollectionMode: "ask",
  theme: "vibrant",
  connectionStyle: "theme",
  nodeShape: "rounded",
  mcpEnabled: false,
  mcpReadPort: DEFAULT_MCP_READ_PORT,
  // Off on upgrade as well as on a fresh install: turning a whole new inbound
  // server on because an older version had granted write tools would silently
  // widen what is exposed. The user re-opts in explicitly.
  mcpWriteEnabled: false,
  mcpWritePort: DEFAULT_MCP_WRITE_PORT
};

/** Clamp a user-supplied port into the usable range; `undefined` means "not a port". */
export function normalizeMcpPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_MCP_PORT || rounded > MAX_MCP_PORT) return undefined;
  return rounded;
}

/**
 * Global preferences only fill YAML properties absent from a file. Kept here as
 * the single mapping so parsing, identity writes and conflict snapshots cannot
 * drift apart.
 */
export function createParseOptions(settings: MindTreeSettings): Readonly<ParseMindTreeOptions> {
  return {
    defaultLayoutMode: settings.defaultLayoutMode,
    defaultTheme: settings.theme,
    defaultNodeShape: settings.nodeShape,
    defaultCollectionMode: settings.defaultCollectionMode,
    defaultConnectionStyle: settings.connectionStyle
  };
}
