import {
  DEFAULT_NON_MARKDOWN_RESOURCE_ID_SEPARATOR,
  type NonMarkdownResourceIdSeparator
} from "./format/resource-id";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme
} from "./types";
import { DEFAULT_NODE_WRAP_WIDTH } from "./ui/layout";

/** Persisted cross-tree preferences, kept free of Obsidian UI dependencies. */
export interface MindTreeSettings {
  templateFolder: string;
  newNoteFolder: string;
  newNoteDefaultContent: string;
  ignoredPathPrefixes: string[];
  /** Non-Markdown extensions whose derived node badge stays hidden. */
  ignoredFileBadgeExtensions: string[];
  /** Case-insensitive extension keys mapped to user-facing badge labels. */
  fileExtensionBadgeAliases: Record<string, string>;
  titleSync: boolean;
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
}

export const DEFAULT_SETTINGS: MindTreeSettings = {
  templateFolder: "",
  newNoteFolder: "",
  newNoteDefaultContent: "",
  ignoredPathPrefixes: [".obsidian/", ".trash/"],
  ignoredFileBadgeExtensions: [],
  fileExtensionBadgeAliases: {},
  titleSync: true,
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
  nodeShape: "rounded"
};
