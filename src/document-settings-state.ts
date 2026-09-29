import { DOCUMENT_SETTING_YAML_KEYS, documentSettingsToYaml } from "./document-settings";
import type { MindTreeDocument, MindTreeDocumentSettings } from "./types";

export type TreeSettingKey = keyof MindTreeDocumentSettings;
export type RawTreeSettings = Partial<Record<TreeSettingKey, unknown>>;
export const TREE_SETTING_KEYS = Object.keys(DOCUMENT_SETTING_YAML_KEYS) as TreeSettingKey[];
type PropertyValue = { present: boolean; value?: unknown };
interface SettingsState {
  raw: RawTreeSettings;
  normalized: MindTreeDocumentSettings;
  pending: Partial<Record<TreeSettingKey, PropertyValue>>;
}

/** Runtime-only YAML ownership. Never enters a document, clipboard or machine JSON. */
const states = new WeakMap<MindTreeDocument, SettingsState>();
const copy = <T>(value: T): T => structuredClone(value);
const property = (raw: RawTreeSettings, key: TreeSettingKey): PropertyValue =>
  Object.hasOwn(raw, key) ? { present: true, value: raw[key] } : { present: false };
const equal = (a: PropertyValue, b: PropertyValue): boolean => a.present === b.present
  && (!a.present || JSON.stringify(a.value) === JSON.stringify(b.value));
function put(raw: RawTreeSettings, key: TreeSettingKey, value: PropertyValue): void {
  if (value.present) raw[key] = copy(value.value);
  else delete raw[key];
}

export function extractTreeSettings(header: Record<string, unknown>): RawTreeSettings {
  return Object.fromEntries(TREE_SETTING_KEYS.filter((key) => Object.hasOwn(header, key))
    .map((key) => [key, header[key]]));
}

export function initializeSettingsState(document: MindTreeDocument, raw: RawTreeSettings): void {
  states.set(document, { raw: copy(raw), normalized: { ...document.settings }, pending: {} });
}

export function copySettingsState(from: MindTreeDocument, to: MindTreeDocument): void {
  const state = states.get(from);
  if (state) states.set(to, copy(state));
}

function stateOf(document: MindTreeDocument): SettingsState {
  return states.get(document) ?? {
    raw: documentSettingsToYaml(document.settings), normalized: { ...document.settings }, pending: {}
  };
}

function pendingOf(document: MindTreeDocument): SettingsState["pending"] {
  const state = stateOf(document);
  const pending = copy(state.pending);
  for (const key of TREE_SETTING_KEYS) {
    if (!pending[key] && document.settings[key] !== state.normalized[key]) pending[key] = { present: true, value: document.settings[key] };
  }
  return pending;
}

export function desiredTreeSettings(document: MindTreeDocument): RawTreeSettings {
  const raw = copy(stateOf(document).raw);
  const pending = pendingOf(document);
  for (const key of TREE_SETTING_KEYS) if (pending[key]) put(raw, key, pending[key]);
  return raw;
}

/** An explicit menu selection can write a missing property even at its default value. */
export function markSettingsEdited(document: MindTreeDocument, keys: readonly TreeSettingKey[]): void {
  const state = copy(stateOf(document));
  for (const key of keys) state.pending[key] = { present: true, value: document.settings[key] };
  states.set(document, state);
}

/** Latest disk wins a same-field race; unrelated user edits remain writable. */
export function settingsForSerialization(document: MindTreeDocument, latest: RawTreeSettings): RawTreeSettings {
  if (!states.has(document)) return documentSettingsToYaml(document.settings); // Brand-new document.
  const state = stateOf(document);
  const result = copy(latest);
  const pending = pendingOf(document);
  for (const key of TREE_SETTING_KEYS) {
    if (pending[key] && equal(property(latest, key), property(state.raw, key))) put(result, key, pending[key]);
  }
  return result;
}

export function changedTreeSettings(before: MindTreeDocument, after: MindTreeDocument): TreeSettingKey[] {
  const left = stateOf(before).raw;
  const right = stateOf(after).raw;
  return TREE_SETTING_KEYS.filter((key) => !equal(property(left, key), property(right, key)));
}

/** Accept external properties without converting local node edits into external data. */
export function mergeTreeSettings(local: MindTreeDocument, baseline: MindTreeDocument,
  external: MindTreeDocument): { document: MindTreeDocument; changedSettings: TreeSettingKey[] } {
  const changedSettings = changedTreeSettings(baseline, external);
  const raw = copy(stateOf(external).raw);
  const pending = pendingOf(local);
  // Non-parsed callers may have changed a freshly constructed document.
  if (!states.has(local)) for (const key of TREE_SETTING_KEYS) {
    if (local.settings[key] !== baseline.settings[key]) pending[key] = { present: true, value: local.settings[key] };
  }
  const document = { ...local, settings: { ...external.settings } };
  for (const key of TREE_SETTING_KEYS) {
    if (changedSettings.includes(key)) delete pending[key];
    if (pending[key]) Object.assign(document.settings, { [key]: pending[key].present ? pending[key].value : local.settings[key] });
  }
  states.set(document, { raw, normalized: { ...external.settings }, pending });
  return { document, changedSettings };
}

/** Rebase only externally owned fields in each undo/redo snapshot. */
export function rebaseTreeSettings(document: MindTreeDocument, external: MindTreeDocument,
  keys: readonly TreeSettingKey[]): MindTreeDocument {
  const existing = stateOf(document);
  const incoming = stateOf(external);
  if (keys.every((key) => document.settings[key] === external.settings[key]
    && equal(property(existing.raw, key), property(incoming.raw, key)) && !pendingOf(document)[key])) return document;
  const result = { ...document, settings: { ...document.settings } };
  const state = copy(stateOf(document));
  const externalState = stateOf(external);
  for (const key of keys) {
    Object.assign(result.settings, { [key]: external.settings[key] });
    Object.assign(state.normalized, { [key]: external.settings[key] });
    put(state.raw, key, property(externalState.raw, key));
    delete state.pending[key];
  }
  states.set(result, state);
  return result;
}

/** Undo preserves property absence and creates an explicit intent against today's baseline. */
export function restoreTreeSettingsHistory(target: MindTreeDocument, current: MindTreeDocument): MindTreeDocument {
  const targetRaw = desiredTreeSettings(target);
  const currentRaw = desiredTreeSettings(current);
  if (TREE_SETTING_KEYS.every((key) => equal(property(targetRaw, key), property(currentRaw, key)))) return target;
  const state = copy(stateOf(current));
  const result = { ...target, settings: { ...target.settings } };
  state.pending = pendingOf(current);
  for (const key of TREE_SETTING_KEYS) {
    if (!equal(property(targetRaw, key), property(currentRaw, key))) state.pending[key] = property(targetRaw, key);
  }
  states.set(result, state);
  return result;
}

/** A verified save acknowledges only captured intents; edits made during I/O survive. */
export function acceptSettingsWrite(current: MindTreeDocument, attempted: MindTreeDocument,
  written: MindTreeDocument, actual: MindTreeDocument, racedKeys: readonly TreeSettingKey[] = []):
  { document: MindTreeDocument; changedSettings: TreeSettingKey[] } {
  const changedSettings = [...new Set([...racedKeys, ...changedTreeSettings(written, actual)])];
  const desired = desiredTreeSettings(current);
  const attemptedRaw = desiredTreeSettings(attempted);
  const pending: SettingsState["pending"] = {};
  const document = { ...current, settings: { ...actual.settings } };
  for (const key of TREE_SETTING_KEYS) {
    if (!changedSettings.includes(key) && !equal(property(desired, key), property(attemptedRaw, key))) {
      pending[key] = property(desired, key);
      Object.assign(document.settings, { [key]: current.settings[key] });
    }
  }
  states.set(document, { raw: copy(stateOf(actual).raw), normalized: { ...actual.settings }, pending });
  return { document, changedSettings };
}
