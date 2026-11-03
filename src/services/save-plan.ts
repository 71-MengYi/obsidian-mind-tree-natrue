import type { TreeSettingKey } from "../document-settings-state";
import type { MindTreeDocument } from "../types";
import { serializeMindTreeFile, type ParseMindTreeOptions } from "../format/document";
import { assessExternalVersion } from "./document-conflict";

/**
 * What one compare-and-set save pass should hand back to `Vault.process`.
 *
 * `identical` deliberately carries the bytes the callback received: Obsidian's
 * `Vault.process` skips the write when the callback returns its own input, so a
 * save of an unchanged tree leaves the file's mtime — and every sync client —
 * alone. `deferred` means this pass must not decide anything: the disk already
 * holds another version, or its identity/format blocks an automatic write, and
 * the external-change path owns that decision.
 */
export type MindTreeSavePlan =
  | { readonly kind: "deferred"; readonly source: string }
  | { readonly kind: "identical"; readonly source: string; readonly changedSettings: readonly TreeSettingKey[] }
  | { readonly kind: "write"; readonly source: string; readonly changedSettings: readonly TreeSettingKey[] };

/**
 * Decide whether a queued save has bytes worth writing.
 *
 * The assessment is the save-time safety check the view used inline before: an
 * external machine-data change is never overwritten by this pass. Only a pass
 * without conflicts reaches serialization, and comparing that serialization
 * with the disk bytes is what prevents a redundant write — Obsidian Sync and
 * similar clients treat every write as a change, even when the bytes match.
 */
export function planMindTreeSave(
  baselineSource: string,
  document: MindTreeDocument,
  diskSource: string,
  options: Readonly<ParseMindTreeOptions> = {}
): MindTreeSavePlan {
  const assessment = assessExternalVersion(baselineSource, document, diskSource, options);
  if (assessment.kind !== "unchanged") return { kind: "deferred", source: diskSource };
  const source = serializeMindTreeFile(assessment.document, diskSource);
  const changedSettings = assessment.changedSettings;
  return source === diskSource
    ? { kind: "identical", source, changedSettings }
    : { kind: "write", source, changedSettings };
}
