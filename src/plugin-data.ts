import { normalizeConnectionStyle, normalizeNodeShape } from "./document-settings";
import { assertSafeRecordKey, createSafeRecord } from "./input-limits";
import type { IndexedResource } from "./services/resource-index";
import { normalizeNewNoteDefaultContent } from "./services/note-content";
import {
  DEFAULT_SETTINGS,
  type MindTreeSettings
} from "./settings-model";
import { normalizeNodeWrapWidth } from "./ui/layout";
import {
  COLLECTION_MODE_OPTIONS,
  LAYOUT_OPTIONS,
  THEME_OPTIONS
} from "./ui/presentation";

export interface PluginData {
  settings: Partial<MindTreeSettings>;
  resourceIndex: Record<string, IndexedResource>;
}

export interface NormalizedPluginData {
  settings: MindTreeSettings;
  resourceIndex: Record<string, IndexedResource>;
}

/** Treat data.json as untrusted input so one malformed value cannot block load. */
export function normalizePluginData(value: unknown): NormalizedPluginData {
  const root = asRecord(value);
  const settings = asRecord(root?.["settings"]);
  const legacyCollectionMode = settings?.["defaultCollectionMode"] ?? settings?.["scanSameFolder"];
  return {
    settings: {
      templateFolder: safeVaultDirectory(settings?.["templateFolder"], DEFAULT_SETTINGS.templateFolder),
      newNoteFolder: safeVaultDirectory(settings?.["newNoteFolder"], DEFAULT_SETTINGS.newNoteFolder),
      newNoteDefaultContent: normalizeNewNoteDefaultContent(settings?.["newNoteDefaultContent"]),
      ignoredPathPrefixes: normalizeStringArray(
        settings?.["ignoredPathPrefixes"],
        DEFAULT_SETTINGS.ignoredPathPrefixes
      ),
      titleSync: safeBoolean(settings?.["titleSync"], DEFAULT_SETTINGS.titleSync),
      nonMarkdownIdSeparator: settings?.["nonMarkdownIdSeparator"] === "%" ? "%" : "@",
      resourceOpenMode: settings?.["resourceOpenMode"] === "split-right" ? "split-right" : "tab",
      newNoteOpenMode: normalizeNewNoteOpenMode(settings?.["newNoteOpenMode"]),
      autosaveDelayMs: normalizeInteger(settings?.["autosaveDelayMs"], 250, 2_000, DEFAULT_SETTINGS.autosaveDelayMs),
      pngScale: settings?.["pngScale"] === 1 || settings?.["pngScale"] === 2 || settings?.["pngScale"] === 3
        ? settings["pngScale"]
        : DEFAULT_SETTINGS.pngScale,
      nodeWrapWidth: normalizeNodeWrapWidth(numberValue(settings?.["nodeWrapWidth"]) ?? DEFAULT_SETTINGS.nodeWrapWidth),
      nodeAlignment: settings?.["nodeAlignment"] === "compact" ? "compact" : "level",
      defaultLayoutMode: optionValue(
        settings?.["defaultLayoutMode"],
        LAYOUT_OPTIONS.map((option) => option.value),
        DEFAULT_SETTINGS.defaultLayoutMode
      ),
      defaultCollectionMode: optionValue(
        legacyCollectionMode,
        COLLECTION_MODE_OPTIONS.map((option) => option.value),
        DEFAULT_SETTINGS.defaultCollectionMode
      ),
      theme: optionValue(
        settings?.["theme"],
        THEME_OPTIONS.map((option) => option.value),
        DEFAULT_SETTINGS.theme
      ),
      connectionStyle: normalizeConnectionStyle(settings?.["connectionStyle"], DEFAULT_SETTINGS.connectionStyle),
      nodeShape: normalizeNodeShape(settings?.["nodeShape"], DEFAULT_SETTINGS.nodeShape)
    },
    resourceIndex: normalizeResourceIndex(root?.["resourceIndex"])
  };
}

function normalizeResourceIndex(value: unknown): Record<string, IndexedResource> {
  const result = createSafeRecord<IndexedResource>();
  const record = asRecord(value);
  if (!record) return result;
  for (const [storedId, rawEntry] of Object.entries(record)) {
    const entry = asRecord(rawEntry);
    const resourceId = nonEmptyString(entry?.["resourceId"]);
    const path = safeVaultPath(entry?.["path"]);
    const fileKind = entry?.["fileKind"];
    try {
      if (!resourceId || resourceId.length > 512 || storedId !== resourceId) throw new Error();
      assertSafeRecordKey(resourceId);
      if (!path || (fileKind !== "note" && fileKind !== "image" && fileKind !== "attachment")) throw new Error();
    } catch {
      // Ownership history affects duplicate-ID repair. A partially trusted,
      // corrupted index is less safe than rebuilding every entry from Vault.
      return createSafeRecord<IndexedResource>();
    }
    result[resourceId] = {
      resourceId,
      path,
      fileKind,
      ...(entry?.["fileSubtype"] === "excalidraw" ? { fileSubtype: "excalidraw" as const } : {})
    };
  }
  return result;
}

function normalizeNewNoteOpenMode(value: unknown): MindTreeSettings["newNoteOpenMode"] {
  return value === "split-right" || value === "tab" || value === "current" || value === "window"
    ? value
    : DEFAULT_SETTINGS.newNoteOpenMode;
}

function normalizeStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value
    .map((item) => safeVaultPath(item, true))
    .filter((item): item is string => item !== undefined);
  return [...new Set(normalized)];
}

function normalizeInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = numberValue(value);
  return number === undefined ? fallback : Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeVaultDirectory(value: unknown, fallback: string): string {
  return safeVaultPath(value, true) ?? fallback;
}

/** Accept only vault-relative paths; settings must never escape the vault. */
function safeVaultPath(value: unknown, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > 4_096 || /^[A-Za-z]:[\\/]/.test(value)) return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return allowEmpty ? "" : undefined;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return normalized;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionValue<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && options.includes(value as T) ? value as T : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
