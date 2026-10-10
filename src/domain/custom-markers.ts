/**
 * User-defined marker definitions ("manage markers" settings tab).
 *
 * These definitions are *global* display metadata: they describe which custom
 * emoji and text tags appear in the marker palette and in what order. They are
 * never written into `.mtn.md` files; a node only stores the plain value it
 * references. Resolution therefore happens in the runtime presentation layer,
 * which keeps this module free of Obsidian dependencies and unit-testable.
 */

/** Custom markers form two independent groups that never share a category. */
export type CustomMarkerKind = "emoji" | "tag";

export interface CustomMarkerDefinition {
  /** Stable identity used for reordering and duplicate rejection. */
  readonly id: string;
  readonly kind: CustomMarkerKind;
  /** The exact emoji glyph or text tag shown in the palette and on nodes. */
  readonly value: string;
}

/**
 * A custom marker value is stored verbatim in the compressed payload, so these
 * caps follow the existing file-badge rule limits rather than node text limits.
 */
/**
 * The cap is per group, not per table: the settings page presents Emoji and
 * text tags as two independent lists, so "64 emoji + 64 tags" must be a valid
 * combination. Enforcing one global cap would silently drop the second group on
 * the next `data.json` load.
 */
export const MAX_CUSTOM_MARKER_ENTRIES = 64;
export const MAX_CUSTOM_EMOJI_LENGTH = 16;
export const MAX_CUSTOM_TAG_LENGTH = 24;
export const MAX_CUSTOM_MARKER_ID_LENGTH = 64;

/**
 * These code points are invisible or reverse the visual order of the tag. They
 * would make a saved marker indistinguishable from an empty one, so both the
 * settings page and `data.json` normalization reject them. Surrogate code
 * points are deliberately allowed: emoji outside the BMP require them.
 */
const DANGEROUS_MARKER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
/** Any pictographic character makes the value a candidate emoji group value. */
const PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;

export type CustomMarkerValidationErrorCode =
  | "empty"
  | "too-long"
  | "unsafe"
  | "duplicate"
  | "limit";

export interface CustomMarkerValidation {
  readonly ok: boolean;
  /** Field text the settings page shows; the caller supplies the localized copy. */
  readonly code: CustomMarkerValidationErrorCode | "ok";
}

/**
 * Strip invisible characters and collapse whitespace. Called before saving and
 * before comparing, so `"  绘图  "` and `"绘图"` can never both be stored.
 */
export function cleanCustomMarkerValue(value: string): string {
  return value
    .replace(new RegExp(DANGEROUS_MARKER_PATTERN.source, "gu"), "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function customMarkerMaxLength(kind: CustomMarkerKind): number {
  return kind === "emoji" ? MAX_CUSTOM_EMOJI_LENGTH : MAX_CUSTOM_TAG_LENGTH;
}

export function isEmojiMarkerValue(value: string): boolean {
  return PICTOGRAPHIC_PATTERN.test(value);
}

export function hasDangerousMarkerCharacter(value: string): boolean {
  return DANGEROUS_MARKER_PATTERN.test(value);
}

/**
 * Validate one candidate value for a group. `existing` is compared after
 * cleaning so visually identical values cannot be added twice; the caller
 * excludes the entry being edited from that list.
 */
export function validateCustomMarkerValue(
  kind: CustomMarkerKind,
  value: string,
  existing: readonly string[]
): CustomMarkerValidation {
  const cleaned = cleanCustomMarkerValue(value);
  if (cleaned.length === 0) return { ok: false, code: "empty" };
  // Measure the typed value: invisible characters must not buy extra room.
  if (Array.from(value.trim()).length > customMarkerMaxLength(kind)) {
    return { ok: false, code: "too-long" };
  }
  if (hasDangerousMarkerCharacter(value)) return { ok: false, code: "unsafe" };
  if (existing.some((candidate) => cleanCustomMarkerValue(candidate) === cleaned)) {
    return { ok: false, code: "duplicate" };
  }
  return { ok: true, code: "ok" };
}

/** Deterministic, collision-free id for a new definition. */
export function createCustomMarkerId(
  kind: CustomMarkerKind,
  value: string,
  existing: readonly CustomMarkerDefinition[]
): string {
  const base = `mtn-${kind}-${hashMarkerValue(value)}`;
  const used = new Set(existing.map((definition) => definition.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function findCustomMarkerDefinition(
  definitions: readonly CustomMarkerDefinition[],
  id: string
): CustomMarkerDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
}

/** Append one definition; rejects duplicates, unsafe ids and the entry cap. */
export function addCustomMarkerDefinition(
  definitions: readonly CustomMarkerDefinition[],
  definition: CustomMarkerDefinition
): CustomMarkerDefinition[] {
  const id = definition.id.trim();
  const value = cleanCustomMarkerValue(definition.value);
  if (!isSafeCustomMarkerId(id) || value.length === 0) return [...definitions];
  // Enforce the same cap as `data.json` loading: a value that normalization
  // would drop on the next start must never be accepted into a live session,
  // otherwise "adding" it would silently disappear after a reload.
  if (Array.from(value).length > customMarkerMaxLength(definition.kind)) return [...definitions];
  // Count only this group: Emoji and text tags are independent lists of up to
  // MAX_CUSTOM_MARKER_ENTRIES each, matching what the settings page promises.
  if (definitions.filter((candidate) => candidate.kind === definition.kind).length
    >= MAX_CUSTOM_MARKER_ENTRIES) return [...definitions];
  if (definitions.some((candidate) => candidate.id === id)) return [...definitions];
  if (definitions.some((candidate) =>
    candidate.kind === definition.kind && cleanCustomMarkerValue(candidate.value) === value)) {
    return [...definitions];
  }
  return [...definitions, { id, kind: definition.kind, value }];
}

export function removeCustomMarkerDefinition(
  definitions: readonly CustomMarkerDefinition[],
  id: string
): CustomMarkerDefinition[] {
  return definitions.filter((definition) => definition.id !== id);
}

/**
 * Move one definition so that it lands before `beforeIndex` in the list
 * *without* the dragged entry. The caller computes `beforeIndex` on the list
 * with the dragged entry removed, which is what "the target and everything
 * after it shifts back" means for a drop.
 */
export function moveCustomMarkerDefinition(
  definitions: readonly CustomMarkerDefinition[],
  id: string,
  beforeIndex: number
): CustomMarkerDefinition[] {
  const index = definitions.findIndex((definition) => definition.id === id);
  if (index < 0) return [...definitions];
  const moved = definitions[index]!;
  const rest = [...definitions.slice(0, index), ...definitions.slice(index + 1)];
  // `NaN` must not silently become index 0 through `splice` coercion.
  const requested = Number.isFinite(beforeIndex) ? Math.trunc(beforeIndex) : 0;
  const target = Math.max(0, Math.min(requested, rest.length));
  rest.splice(target, 0, moved);
  return rest;
}

/** Resolve one persisted value to its current display form, or `undefined`. */
export function getCustomMarkerValue(
  definitions: readonly CustomMarkerDefinition[],
  kind: CustomMarkerKind,
  id: string
): string | undefined {
  const definition = definitions.find((candidate) => candidate.kind === kind && candidate.id === id);
  return definition?.value;
}

/** Emoji first, then text tags; each group keeps its own user order. */
export function customMarkerDefinitionsByKind(
  definitions: readonly CustomMarkerDefinition[],
  kind: CustomMarkerKind
): CustomMarkerDefinition[] {
  return definitions.filter((definition) => definition.kind === kind);
}

/** Shared by `data.json` loading and by the settings page before saving. */
export function isSafeCustomMarkerId(id: string): boolean {
  return id.length > 0
    && id.length <= MAX_CUSTOM_MARKER_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id);
}

/**
 * Normalize the untrusted `settings.customMarkers` value from `data.json`.
 * Malformed entries are dropped instead of failing the whole settings load, and
 * the surviving order is preserved so a user's arrangement is never shuffled.
 */
export function normalizeCustomMarkerDefinitions(value: unknown): CustomMarkerDefinition[] {
  if (!Array.isArray(value)) return [];
  // The cap is per group, so a full Emoji list must not consume the text tag
  // budget. Reading a little past the per-group ceiling still bounds the work.
  const result: CustomMarkerDefinition[] = [];
  const usedIds = new Set<string>();
  const usedValues = new Set<string>();
  const countByKind: Record<CustomMarkerKind, number> = { emoji: 0, tag: 0 };
  for (const candidate of value.slice(0, MAX_CUSTOM_MARKER_ENTRIES * 2)) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const rawKind = record["kind"];
    if (rawKind !== "emoji" && rawKind !== "tag") continue;
    const rawValue = record["value"];
    if (typeof rawValue !== "string") continue;
    const kind: CustomMarkerKind = rawKind;
    if (countByKind[kind] >= MAX_CUSTOM_MARKER_ENTRIES) continue;
    const cleaned = cleanCustomMarkerValue(rawValue);
    if (cleaned.length === 0) continue;
    if (Array.from(cleaned).length > customMarkerMaxLength(kind)) continue;
    const valueKey = `${kind}\u0000${cleaned}`;
    if (usedValues.has(valueKey)) continue;
    const rawId = record["id"];
    const id = typeof rawId === "string" && isSafeCustomMarkerId(rawId) && !usedIds.has(rawId)
      ? rawId
      : createCustomMarkerId(kind, cleaned, result);
    usedValues.add(valueKey);
    usedIds.add(id);
    countByKind[kind] += 1;
    result.push({ id, kind, value: cleaned });
  }
  return result;
}

/** FNV-1a keeps generated ids short, deterministic and dependency-free. */
function hashMarkerValue(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
