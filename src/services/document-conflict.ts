import { mergeTreeSettings, type TreeSettingKey } from "../document-settings-state";
import { cloneDocument } from "../domain/tree";
import { mindTreeMachineDataFingerprint, parseMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import { CURRENT_MIND_TREE_SCHEMA_VERSION } from "../format/migrations";
import type { MindTreeDocument, MindTreeDocumentSettings } from "../types";

/** Logical regions only: gzip representation, generated text and prose are irrelevant. */
export interface ManagedMindTreeSnapshot {
  readonly document: MindTreeDocument;
  readonly machineFingerprint: string;
  readonly schemaVersion: number;
  readonly documentId?: string;
  readonly settings: Readonly<MindTreeDocumentSettings>;
}

export function createManagedMindTreeSnapshot(source: string, options: Readonly<ParseMindTreeOptions> = {}): ManagedMindTreeSnapshot {
  return snapshotFromDocument(parseMindTreeFile(source, options).document);
}

export function snapshotFromDocument(document: Readonly<MindTreeDocument>): ManagedMindTreeSnapshot {
  const copy = cloneDocument(document as MindTreeDocument);
  return {
    document: copy, machineFingerprint: mindTreeMachineDataFingerprint(copy),
    schemaVersion: CURRENT_MIND_TREE_SCHEMA_VERSION,
    ...(copy.documentId ? { documentId: copy.documentId } : {}), settings: { ...copy.settings }
  };
}

function sameContent(left: ManagedMindTreeSnapshot, right: ManagedMindTreeSnapshot): boolean {
  return left.machineFingerprint === right.machineFingerprint;
}

export function sameManagedMindTreeSnapshot(left: ManagedMindTreeSnapshot, right: ManagedMindTreeSnapshot): boolean {
  return left.schemaVersion === right.schemaVersion && left.documentId === right.documentId && sameContent(left, right);
}

export type ExternalVersionAssessment =
  | { kind: "unchanged"; external: ManagedMindTreeSnapshot; document: MindTreeDocument; changedSettings: TreeSettingKey[] }
  | { kind: "choose"; external: ManagedMindTreeSnapshot }
  | { kind: "blocked"; message: "identity" | "invalid-source"; external?: ManagedMindTreeSnapshot; details?: string };

/**
 * Baseline detects outside changes, not permission to auto-merge them. Even a
 * clean session requires explicit choice before adopting external tree data.
 * Identity/format safety is independent and cannot be overridden by a choice.
 */
export function assessExternalVersion(baselineSource: string, localDocument: MindTreeDocument,
  externalSource: string, options: Readonly<ParseMindTreeOptions> = {}): ExternalVersionAssessment {
  let baseline: ManagedMindTreeSnapshot;
  let external: ManagedMindTreeSnapshot;
  try {
    baseline = createManagedMindTreeSnapshot(baselineSource, options);
    external = createManagedMindTreeSnapshot(externalSource, options);
  } catch (error) { return { kind: "blocked", message: "invalid-source", details: error instanceof Error ? error.message : String(error) }; }
  const local = snapshotFromDocument(localDocument);
  // Established identities must never disappear or change. A first assignment
  // is harmless only if the two live sides do not assign different identities.
  if ((baseline.documentId && (local.documentId !== baseline.documentId || external.documentId !== baseline.documentId))
    || (local.documentId && external.documentId && local.documentId !== external.documentId)) {
    return { kind: "blocked", message: "identity", external };
  }
  if (!sameContent(external, baseline) && !sameContent(external, local)) return { kind: "choose", external };
  const { document, changedSettings } = mergeTreeSettings(localDocument, baseline.document, external.document);
  if (!document.documentId && external.documentId) document.documentId = external.documentId;
  return { kind: "unchanged", external, document, changedSettings };
}

/**
 * What an open view does with one settled external read.
 *
 * `adopt` is the normal sync path: a session without local work follows the
 * file, so an open tree refreshes in place instead of asking the user to compare
 * two versions. `conflict` covers both local work (an unsaved document, an
 * unconfirmed title draft, an editor still in use) and unsafe identity/format
 * changes, which must keep the explicit choice. Settings-only changes merge.
 */
export type ExternalChangeDecision =
  | { readonly kind: "merge"; readonly assessment: Extract<ExternalVersionAssessment, { kind: "unchanged" }> }
  | { readonly kind: "adopt"; readonly assessment: Extract<ExternalVersionAssessment, { kind: "choose" }> }
  | { readonly kind: "conflict" };

export function decideExternalChange(
  assessment: ExternalVersionAssessment,
  hasLocalWork: boolean
): ExternalChangeDecision {
  if (assessment.kind === "unchanged") return { kind: "merge", assessment };
  if (assessment.kind === "choose" && !hasLocalWork) return { kind: "adopt", assessment };
  return { kind: "conflict" };
}
