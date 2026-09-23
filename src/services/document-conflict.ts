import { DOCUMENT_SETTING_YAML_KEYS } from "../document-settings";
import { cloneDocument } from "../domain/tree";
import {
  mindTreeMachineDataFingerprint,
  parseMindTreeFile,
  type ParseMindTreeOptions
} from "../format/document";
import { CURRENT_MIND_TREE_SCHEMA_VERSION } from "../format/migrations";
import type { MindTreeDocument, MindTreeDocumentSettings } from "../types";

export type MindTreeConflictReason =
  | { kind: "machine-data" }
  | { kind: "document-id" }
  | { kind: "document-setting"; property: keyof MindTreeDocumentSettings }
  | { kind: "invalid-baseline"; message: string }
  | { kind: "invalid-external"; message: string };

/** The only logical file regions managed by conflict detection. */
export interface ManagedMindTreeSnapshot {
  readonly document: MindTreeDocument;
  readonly machineFingerprint: string;
  /** Parsing validates the source version; comparisons use its normalized form. */
  readonly schemaVersion: number;
  readonly documentId?: string;
  readonly settings: Readonly<MindTreeDocumentSettings>;
}

/** External state that must also be applied to undo and redo snapshots. */
export interface MindTreeExternalRebase {
  readonly machineDocument?: MindTreeDocument;
  readonly settings: Partial<MindTreeDocumentSettings>;
  readonly documentId?: { readonly value?: string };
}

export type MindTreeMergeResult =
  | {
    readonly kind: "merged";
    readonly document: MindTreeDocument;
    readonly externalSnapshot: ManagedMindTreeSnapshot;
    readonly rebase: MindTreeExternalRebase;
  }
  | {
    readonly kind: "conflict";
    readonly reasons: readonly MindTreeConflictReason[];
    readonly externalSnapshot?: ManagedMindTreeSnapshot;
  };

const DOCUMENT_SETTING_PROPERTIES = Object.keys(DOCUMENT_SETTING_YAML_KEYS) as Array<keyof MindTreeDocumentSettings>;

/** Parse and normalize a disk source before any overwrite decision is made. */
export function createManagedMindTreeSnapshot(
  source: string,
  options: Readonly<ParseMindTreeOptions> = {}
): ManagedMindTreeSnapshot {
  const document = parseMindTreeFile(source, options).document;
  return snapshotFromDocument(document);
}

/** Compare managed logical data while ignoring prose, outline and unknown YAML. */
export function sameManagedMindTreeSnapshot(
  left: Readonly<ManagedMindTreeSnapshot>,
  right: Readonly<ManagedMindTreeSnapshot>
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.machineFingerprint === right.machineFingerprint
    && left.documentId === right.documentId
    && DOCUMENT_SETTING_PROPERTIES.every((property) => left.settings[property] === right.settings[property]);
}

/**
 * Merge the in-memory document with the latest disk source against the source
 * that was originally loaded. Markdown prose, generated text and unknown YAML
 * never enter this decision; serializeMindTreeFile later preserves them from
 * the latest disk source.
 */
export function mergeMindTreeExternalChange(
  baselineSource: string,
  localDocument: Readonly<MindTreeDocument>,
  externalSource: string,
  options: Readonly<ParseMindTreeOptions> = {}
): MindTreeMergeResult {
  let baseline: ManagedMindTreeSnapshot;
  try {
    baseline = createManagedMindTreeSnapshot(baselineSource, options);
  } catch (error) {
    return {
      kind: "conflict",
      reasons: [{ kind: "invalid-baseline", message: errorMessage(error) }]
    };
  }

  let external: ManagedMindTreeSnapshot;
  try {
    external = createManagedMindTreeSnapshot(externalSource, options);
  } catch (error) {
    return {
      kind: "conflict",
      reasons: [{ kind: "invalid-external", message: errorMessage(error) }]
    };
  }

  const local = snapshotFromDocument(localDocument);
  const reasons: MindTreeConflictReason[] = [];
  const rebaseSettings: Partial<MindTreeDocumentSettings> = {};

  const localMachineChanged = local.machineFingerprint !== baseline.machineFingerprint;
  const externalMachineChanged = external.machineFingerprint !== baseline.machineFingerprint;
  if (localMachineChanged
    && externalMachineChanged
    && local.machineFingerprint !== external.machineFingerprint) {
    reasons.push({ kind: "machine-data" });
  }

  const localIdentityChanged = local.documentId !== baseline.documentId;
  const externalIdentityChanged = external.documentId !== baseline.documentId;
  const externalReplacedEstablishedIdentity = baseline.documentId !== undefined
    && externalIdentityChanged
    && !localIdentityChanged;
  if (externalReplacedEstablishedIdentity
    || (localIdentityChanged && externalIdentityChanged && local.documentId !== external.documentId)) {
    reasons.push({ kind: "document-id" });
  }

  const mergedSettings = { ...local.settings };
  for (const property of DOCUMENT_SETTING_PROPERTIES) {
    const baselineValue = baseline.settings[property];
    const localValue = local.settings[property];
    const externalValue = external.settings[property];
    const localChanged = localValue !== baselineValue;
    const externalChanged = externalValue !== baselineValue;
    if (localChanged && externalChanged && localValue !== externalValue) {
      reasons.push({ kind: "document-setting", property });
      continue;
    }
    if (externalChanged) {
      // Assignment through the complete interface is difficult for a union of
      // property types; every value comes from the same normalized property.
      Object.assign(mergedSettings, { [property]: externalValue });
      Object.assign(rebaseSettings, { [property]: externalValue });
    }
  }

  if (reasons.length > 0) {
    return { kind: "conflict", reasons, externalSnapshot: external };
  }

  const externalOwnsMachine = externalMachineChanged;
  const merged = cloneDocument(externalOwnsMachine ? external.document : local.document);
  merged.settings = mergedSettings;

  let rebaseDocumentId: MindTreeExternalRebase["documentId"];
  if (externalIdentityChanged) {
    rebaseDocumentId = { value: external.documentId };
    if (external.documentId) merged.documentId = external.documentId;
    else delete merged.documentId;
  } else if (local.documentId) {
    merged.documentId = local.documentId;
  } else {
    delete merged.documentId;
  }

  return {
    kind: "merged",
    document: merged,
    externalSnapshot: external,
    rebase: {
      ...(externalOwnsMachine ? { machineDocument: external.document } : {}),
      settings: rebaseSettings,
      ...(rebaseDocumentId ? { documentId: rebaseDocumentId } : {})
    }
  };
}

/** Apply accepted external ownership without erasing local-only setting history. */
export function rebaseMindTreeDocument(
  document: Readonly<MindTreeDocument>,
  rebase: Readonly<MindTreeExternalRebase>
): MindTreeDocument {
  const originalSettings = { ...document.settings };
  const originalDocumentId = document.documentId;
  const result = cloneDocument(rebase.machineDocument ?? document);
  result.settings = { ...originalSettings, ...rebase.settings };

  if (rebase.documentId) {
    if (rebase.documentId.value) result.documentId = rebase.documentId.value;
    else delete result.documentId;
  } else if (originalDocumentId) {
    result.documentId = originalDocumentId;
  } else {
    delete result.documentId;
  }
  return result;
}

export function hasExternalMindTreeRebase(rebase: Readonly<MindTreeExternalRebase>): boolean {
  return rebase.machineDocument !== undefined
    || rebase.documentId !== undefined
    || Object.keys(rebase.settings).length > 0;
}

/** True only when accepting a merged external source would replace local managed state. */
export function externalMergeWouldReplaceLocal(
  result: Extract<MindTreeMergeResult, { kind: "merged" }>,
  localDocument: Readonly<MindTreeDocument>
): boolean {
  return !sameManagedMindTreeSnapshot(snapshotFromDocument(localDocument), result.externalSnapshot);
}

export function snapshotFromDocument(document: Readonly<MindTreeDocument>): ManagedMindTreeSnapshot {
  const copy = cloneDocument(document as MindTreeDocument);
  return {
    document: copy,
    machineFingerprint: mindTreeMachineDataFingerprint(copy),
    schemaVersion: CURRENT_MIND_TREE_SCHEMA_VERSION,
    ...(copy.documentId ? { documentId: copy.documentId } : {}),
    settings: { ...copy.settings }
  };
}

export type ExternalVersionAssessment =
  | { kind: "unchanged"; external: ManagedMindTreeSnapshot; document: MindTreeDocument }
  | { kind: "choose"; external: ManagedMindTreeSnapshot }
  | { kind: "blocked"; message: string; external?: ManagedMindTreeSnapshot };

/**
 * External ownership is now explicit, even for a clean local session. The old
 * three-way merge is used only for identity validation and harmless changes;
 * it must never silently adopt externally changed tree data or settings.
 */
export function assessExternalVersion(
  baselineSource: string,
  localDocument: MindTreeDocument,
  externalSource: string,
  options: Readonly<ParseMindTreeOptions> = {}
): ExternalVersionAssessment {
  const result = mergeMindTreeExternalChange(baselineSource, localDocument, externalSource, options);
  if (result.kind === "conflict") {
    const unsafe = result.reasons.find((reason) => reason.kind === "document-id"
      || reason.kind === "invalid-baseline" || reason.kind === "invalid-external");
    if (unsafe) return {
      kind: "blocked",
      message: unsafe.kind === "document-id" ? "identity" : "invalid-source",
      external: result.externalSnapshot
    };
  }
  const external = result.externalSnapshot!;
  const baseline = createManagedMindTreeSnapshot(baselineSource, options);
  const local = snapshotFromDocument(localDocument);
  const contentEquals = (a: ManagedMindTreeSnapshot, b: ManagedMindTreeSnapshot): boolean =>
    a.machineFingerprint === b.machineFingerprint
    && DOCUMENT_SETTING_PROPERTIES.every((property) => a.settings[property] === b.settings[property]);
  if (!contentEquals(external, baseline) && !contentEquals(external, local)) return { kind: "choose", external };
  const document = cloneDocument(localDocument);
  // A first identity assignment is safe, but replacement/removal of an
  // established identity was rejected above. Identity is not a tree version.
  if (!document.documentId && external.documentId) document.documentId = external.documentId;
  return { kind: "unchanged", external, document };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
