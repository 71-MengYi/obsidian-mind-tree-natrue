import { normalizeConnectionStyle, normalizeNodeShape } from "./document-settings";
import { assertSafeRecordKey, createSafeRecord } from "./input-limits";
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
import {
  MAX_FILE_BADGE_RULE_ENTRIES,
  normalizeFileBadgeAlias,
  normalizeFileBadgeExtension
} from "./ui/resource-badges";

export interface PluginData {
  settings: Partial<MindTreeSettings>;
}

export interface NormalizedPluginData {
  settings: MindTreeSettings;
}

/** Treat data.json as untrusted input so one malformed value cannot block load. */
export function normalizePluginData(value: unknown): NormalizedPluginData {
  const root = asRecord(value);
  const settings = asRecord(root?.["settings"]);
  const legacyCollectionMode = settings?.["defaultCollectionMode"] ?? settings?.["scanSameFolder"];
  return {
    settings: {
      autoCheckUpdates: safeBoolean(settings?.["autoCheckUpdates"], DEFAULT_SETTINGS.autoCheckUpdates),
      templateFolder: safeVaultDirectory(settings?.["templateFolder"], DEFAULT_SETTINGS.templateFolder),
      newNoteFolder: safeVaultDirectory(settings?.["newNoteFolder"], DEFAULT_SETTINGS.newNoteFolder),
      newNoteDefaultContent: normalizeNewNoteDefaultContent(settings?.["newNoteDefaultContent"]),
      ignoredPathPrefixes: normalizeStringArray(
        settings?.["ignoredPathPrefixes"],
        DEFAULT_SETTINGS.ignoredPathPrefixes
      ),
      ignoredFileBadgeExtensions: normalizeFileBadgeExtensionList(
        settings?.["ignoredFileBadgeExtensions"]
      ),
      fileExtensionBadgeAliases: normalizeFileBadgeAliases(
        settings?.["fileExtensionBadgeAliases"]
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
    }
  };
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

function normalizeFileBadgeExtensionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.ignoredFileBadgeExtensions];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_FILE_BADGE_RULE_ENTRIES)) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeFileBadgeExtension(candidate);
    if (!normalized || seen.has(normalized)) continue;
    try { assertSafeRecordKey(normalized); } catch { continue; }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeFileBadgeAliases(value: unknown): Record<string, string> {
  const result = createSafeRecord<string>();
  const record = asRecord(value);
  if (!record) return result;
  for (const [rawKey, rawAlias] of Object.entries(record).slice(0, MAX_FILE_BADGE_RULE_ENTRIES)) {
    if (typeof rawAlias !== "string") continue;
    const key = normalizeFileBadgeExtension(rawKey);
    const alias = normalizeFileBadgeAlias(rawAlias);
    if (!key || !alias) continue;
    try { assertSafeRecordKey(key); } catch { continue; }
    result[key] = alias;
  }
  return result;
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
