import {
  DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
  type NonMarkdownResourceIdSeparator
} from "./format/resource-id";
import type { ParseMindTreeOptions } from "./format/document";
import type { CustomMarkerDefinition } from "./domain/custom-markers";
import type { AiChatModelConfig, AiEmbeddingModelConfig, AiProviderConfig } from "./services/ai/contracts";
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
  /**
   * Cross-tree preference for the view overlay; on by default. The viewport it
   * summarizes stays session state, so this flag is the only thing persisted.
   */
  minimapEnabled: boolean;
  pngScale: 1 | 2 | 3;
  nodeWrapWidth: number;
  nodeAlignment: MindTreeNodeAlignment;
  defaultLayoutMode: MindTreeLayoutMode;
  defaultCollectionMode: MindTreeCollectionMode;
  theme: MindTreeTheme;
  connectionStyle: MindTreeConnectionStyle;
  nodeShape: MindTreeNodeShape;
  /**
   * Master switch for the local MCP server. Off by default because it accepts
   * inbound connections; desktop-only, and the access token never lives here
   * (it is device-local, see `services/mcp/connection.ts`).
   */
  mcpEnabled: boolean;
  /**
   * Preferred port of the local server; a busy port falls back to nearby ones.
   *
   * The server carries both reading and editing tools, so this is the only port.
   */
  mcpPort: number;
  /**
   * Bearer token of the local MCP server.
   *
   * Deliberately part of `data.json` so every device that syncs the plugin data
   * uses the same credential. It used to live in device-local storage, which
   * meant each device minted its own token and a synced client configuration
   * stopped working on the other machine.
   */
  mcpToken: string;
  /** External model providers configured in the AI tab. */
  aiProviders: AiProviderConfig[];
  /** Chat models attached to those providers. */
  aiChatModels: AiChatModelConfig[];
  /** Embedding models attached to those providers. */
  aiEmbeddingModels: AiEmbeddingModelConfig[];
}

/** Above 1024 the port needs no privileges; the upper bound is the TCP limit. */
export const MIN_MCP_PORT = 1024;
export const MAX_MCP_PORT = 65535;
/** The original single-endpoint port, kept so installed client configs persist. */
export const DEFAULT_MCP_PORT = 27321;
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
  minimapEnabled: true,
  pngScale: 2,
  nodeWrapWidth: DEFAULT_NODE_WRAP_WIDTH,
  nodeAlignment: "level",
  defaultLayoutMode: "balanced",
  defaultCollectionMode: "ask",
  theme: "vibrant",
  connectionStyle: "theme",
  nodeShape: "rounded",
  mcpEnabled: false,
  mcpPort: DEFAULT_MCP_PORT,
  // Minted on first desktop start (or adopted from the old device-local
  // record) and then synced with the rest of the settings.
  mcpToken: "",
  aiProviders: [],
  aiChatModels: [],
  aiEmbeddingModels: []
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
