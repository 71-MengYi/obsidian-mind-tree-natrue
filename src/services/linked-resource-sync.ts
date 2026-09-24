import type { FileResourceRef, MindTreeDocument } from "../types";
import { renameNode } from "../domain/tree";
import { linkedFileTitle } from "../format/resource-id";

/**
 * Minimal file shape needed to refresh a node's cached resource information.
 * Keeping this independent from Obsidian makes the rename race easy to test.
 */
export interface ResolvedLinkedFile {
  path: string;
  /** Derived from the currently resolved file, not trusted from compressed data. */
  fileSubtype?: FileResourceRef["fileSubtype"];
}

/**
 * Replace stale path hints and synchronized titles with canonical file state.
 *
 * Obsidian can rewrite wiki links after a file rename and then reload the open
 * mind-tree source. Its compressed node data may still contain the pre-rename
 * path and title, so both loading and saving must reconcile by stable resource
 * ID before rendering or generating the readable outline.
 */
export function reconcileLinkedFileReferences(
  document: MindTreeDocument,
  resolve: (reference: FileResourceRef) => ResolvedLinkedFile | undefined,
  pendingTitleRenames: ReadonlySet<string> = new Set()
): boolean {
  let changed = false;
  for (const node of Object.values(document.nodes)) {
    if (node.resource?.type !== "file") continue;
    const file = resolve(node.resource);
    if (!file) continue;
    if (node.resource.pathHint !== file.path) {
      node.resource.pathHint = file.path;
      changed = true;
    }
    if (node.resource.fileSubtype !== file.fileSubtype) {
      if (file.fileSubtype) node.resource.fileSubtype = file.fileSubtype;
      else delete node.resource.fileSubtype;
      changed = true;
    }
    // A host link rewrite can reload stale compressed node data after the rename
    // event already rendered the new title. Re-derive bidirectional titles here
    // so that every load/save boundary closes that race before old data is shown.
    if (node.titleSync === "bidirectional" && !pendingTitleRenames.has(node.id)) {
      const canonicalTitle = linkedFileTitle(file.path);
      if (node.title !== canonicalTitle) {
        renameNode(document, node.id, canonicalTitle);
        changed = true;
      }
    }
  }
  return changed;
}
