import { cloneDocument } from "../../domain/tree";
import type { MindTreeDocument, MindTreeDocumentSettings } from "../../types";

/** Preview-only folds never enter session history or the chosen document. */
export function previewDocument(document: MindTreeDocument, folds: ReadonlyMap<string, boolean>): MindTreeDocument {
  const presentation = cloneDocument(document);
  for (const [id, collapsed] of folds) if (presentation.nodes[id]) presentation.nodes[id]!.collapsed = collapsed;
  return presentation;
}

/** Nonvisual settings also need explicit comparison labels. */
export function changedVersionSettings(left: MindTreeDocumentSettings, right: MindTreeDocumentSettings): Array<keyof MindTreeDocumentSettings> {
  return (Object.keys(left) as Array<keyof MindTreeDocumentSettings>).filter((key) => left[key] !== right[key]);
}
