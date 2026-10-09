import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocumentSettings,
  MindTreeLayoutMode,
  MindTreeNodeShape,
  MindTreeTheme
} from "./types";

/** Each per-tree setting is a top-level YAML property beside the optional documentId. */
export const DOCUMENT_LAYOUT_YAML_KEY = "layoutMode";
export const DOCUMENT_RECURSIVE_SCAN_YAML_KEY = "recursiveScan";
export const DOCUMENT_COLLECTION_MODE_YAML_KEY = "collectionMode";
export const DOCUMENT_THEME_YAML_KEY = "theme";
export const DOCUMENT_CONNECTION_STYLE_YAML_KEY = "connectionStyle";
export const DOCUMENT_NODE_SHAPE_YAML_KEY = "nodeShape";

/**
 * The complete YAML contract is typed against the domain interface. Adding a
 * future per-tree property therefore causes a compile error until its top-level
 * key, default, normalizer and serializer path have all been considered.
 */
export const DOCUMENT_SETTING_YAML_KEYS = {
  layoutMode: DOCUMENT_LAYOUT_YAML_KEY,
  recursiveScan: DOCUMENT_RECURSIVE_SCAN_YAML_KEY,
  collectionMode: DOCUMENT_COLLECTION_MODE_YAML_KEY,
  theme: DOCUMENT_THEME_YAML_KEY,
  connectionStyle: DOCUMENT_CONNECTION_STYLE_YAML_KEY,
  nodeShape: DOCUMENT_NODE_SHAPE_YAML_KEY
} as const satisfies Record<keyof MindTreeDocumentSettings, string>;

const LAYOUT_MODES = new Set<MindTreeLayoutMode>(["balanced", "right", "left", "tree", "radial"]);
const COLLECTION_MODES = new Set<MindTreeCollectionMode>(["off", "ask", "root", "collect"]);
const THEMES = new Set<MindTreeTheme>([
  "vibrant", "classic", "fresh", "ocean", "sunset", "midnight", "slate",
  "flat", "minimal", "floating"
]);
const CONNECTION_STYLES = new Set<MindTreeConnectionStyle>([
  "theme", "smooth", "smooth-dashed", "straight", "orthogonal", "orthogonal-dashed"
]);
const NODE_SHAPES = new Set<MindTreeNodeShape>(["rounded", "square", "borderless"]);

/**
 * Only options that genuinely vary by tree belong here. A global layout/theme
 * preference is merely the runtime default for a tree that never chose its own
 * value; operation defaults stay global.
 */
export const DEFAULT_DOCUMENT_SETTINGS: Readonly<MindTreeDocumentSettings> = {
  layoutMode: "balanced",
  recursiveScan: false,
  collectionMode: "ask",
  theme: "vibrant",
  connectionStyle: "theme",
  nodeShape: "rounded"
};

export function createDefaultDocumentSettings(
  theme = DEFAULT_DOCUMENT_SETTINGS.theme,
  layoutMode = DEFAULT_DOCUMENT_SETTINGS.layoutMode,
  nodeShape = DEFAULT_DOCUMENT_SETTINGS.nodeShape,
  collectionMode = DEFAULT_DOCUMENT_SETTINGS.collectionMode,
  connectionStyle = DEFAULT_DOCUMENT_SETTINGS.connectionStyle
): MindTreeDocumentSettings {
  return { ...DEFAULT_DOCUMENT_SETTINGS, layoutMode, theme, nodeShape, collectionMode, connectionStyle };
}

/** Validate YAML and persisted plugin defaults through the shared line catalog. */
export function normalizeConnectionStyle(
  value: unknown,
  fallback: unknown = "theme"
): MindTreeConnectionStyle {
  return enumValue(value, CONNECTION_STYLES) ?? enumValue(fallback, CONNECTION_STYLES) ?? "theme";
}

/**
 * Normalize both YAML and persisted plugin defaults through one shape catalog.
 * Removed capsule/sketch values are ordinary invalid settings and fall back to
 * rounded without introducing a document-format migration.
 */
export function normalizeNodeShape(value: unknown, fallback: unknown = "rounded"): MindTreeNodeShape {
  return enumValue(value, NODE_SHAPES) ?? enumValue(fallback, NODE_SHAPES) ?? "rounded";
}

/**
 * Validate the top-level, hand-editable YAML values. `defaults` is deliberately
 * supplied by the caller: every property a file does not carry resolves to the
 * user's current global default at runtime, without writing it back.
 */
export function normalizeDocumentSettings(
  value: unknown,
  defaults: Readonly<MindTreeDocumentSettings> = DEFAULT_DOCUMENT_SETTINGS
): MindTreeDocumentSettings {
  const record = asRecord(value);
  return {
    layoutMode: enumValue(record?.[DOCUMENT_LAYOUT_YAML_KEY], LAYOUT_MODES) ?? defaults.layoutMode,
    recursiveScan: typeof record?.[DOCUMENT_RECURSIVE_SCAN_YAML_KEY] === "boolean"
      ? record[DOCUMENT_RECURSIVE_SCAN_YAML_KEY]
      : defaults.recursiveScan,
    collectionMode: enumValue(record?.[DOCUMENT_COLLECTION_MODE_YAML_KEY], COLLECTION_MODES)
      ?? defaults.collectionMode,
    theme: enumValue(record?.[DOCUMENT_THEME_YAML_KEY], THEMES) ?? defaults.theme,
    connectionStyle: normalizeConnectionStyle(
      record?.[DOCUMENT_CONNECTION_STYLE_YAML_KEY],
      defaults.connectionStyle
    ),
    nodeShape: normalizeNodeShape(record?.[DOCUMENT_NODE_SHAPE_YAML_KEY], defaults.nodeShape)
  };
}

/** Detect missing or invalid YAML values that the normalizer had to replace. */
export function documentSettingsUsedDefaults(
  value: unknown,
  normalized: Readonly<MindTreeDocumentSettings>
): boolean {
  const record = asRecord(value);
  return (Object.keys(DOCUMENT_SETTING_YAML_KEYS) as Array<keyof MindTreeDocumentSettings>)
    .some((property) => record?.[DOCUMENT_SETTING_YAML_KEYS[property]] !== normalized[property]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === "string" && allowed.has(value as T) ? value as T : undefined;
}
