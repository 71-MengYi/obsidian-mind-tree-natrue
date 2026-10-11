import { parseNodeTitle } from "../../format/node-title";
import { classifyFile, linkedFileTitle } from "../../format/resource-id";
import type { FileResourceRef, MindTreeDocument } from "../../types";
import type { FileCandidate, SearchCandidate } from "./search-core";

/**
 * Search payload assembly without any Obsidian or DOM dependency.
 *
 * The search window must not read the vault on every keystroke, so this module
 * owns the two decisions that bound the work: which nodes are searchable, and
 * which of their files may be read as Markdown. Both are pure so the rules stay
 * testable, and so a document edit can rebuild the payload from scratch.
 */

/** Vault paths are `/` separated and the plugin never stores `./` prefixes. */
export function normalizeSearchPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Node order is stable, so the read budget always covers the same first files
 * and results do not shuffle between keystrokes. Nodes without a file still
 * match by title; they simply carry no content. A resource claimed by two nodes
 * is listed once, matching the document's stable resource identity.
 */
export function buildSearchCandidates(
  document: MindTreeDocument,
  ownPath: string | undefined
): readonly SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  const seenResourceIds = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.resource?.type !== "file") continue;
    const { resourceId, pathHint } = node.resource;
    if (seenResourceIds.has(resourceId)) continue;
    seenResourceIds.add(resourceId);
    const path = pathHint ? normalizeSearchPath(pathHint) : undefined;
    if (path && path === ownPath) continue;
    candidates.push({
      nodeId: node.id,
      title: node.title,
      plainTitle: parseNodeTitle(node.title).plainText,
      resourceId,
      ...(path ? { path, fileName: linkedFileTitle(path) } : {})
    });
  }
  for (const node of Object.values(document.nodes)) {
    // File nodes were added above; a URL node still matches by title and only
    // lacks content, so it must not fall through both loops.
    if (node.resource?.type === "file") continue;
    candidates.push({ nodeId: node.id, title: node.title, plainTitle: parseNodeTitle(node.title).plainText });
  }
  return candidates;
}

/**
 * Only `.md` files are searched. The current mind-tree file is excluded so its
 * compressed payload can never reach the results, and another `.mtn.md` is
 * excluded because reading one would parse a second tree instead of a note.
 * Identity verification is per candidate: one unverifiable reference only drops
 * that candidate.
 */
export function resolveSearchMarkdownFiles<T extends { path: string }>(
  resources: {
    resolveVerified: (reference: FileResourceRef) => Promise<T | undefined>;
  },
  candidates: readonly SearchCandidate[],
  ownPath: string | undefined
): Promise<readonly FileCandidate<T>[]> {
  const seen = new Set<string>();
  const resolved: Array<Promise<FileCandidate<T> | undefined>> = [];
  for (const candidate of candidates) {
    const hint = candidate.path;
    if (!hint || !candidate.resourceId) continue;
    const reference: FileResourceRef = {
      type: "file", resourceId: candidate.resourceId, pathHint: hint, fileKind: classifyFile(hint)
    };
    resolved.push(resources.resolveVerified(reference).then((file) => {
      if (!file || !file.path.toLowerCase().endsWith(".md")) return undefined;
      const path = normalizeSearchPath(file.path);
      if (path === ownPath || path.endsWith(".mtn.md") || seen.has(path)) return undefined;
      seen.add(path);
      return { path, file };
    }).catch(() => undefined));
  }
  return Promise.all(resolved).then((entries) => entries.filter((entry): entry is FileCandidate<T> => entry !== undefined));
}
