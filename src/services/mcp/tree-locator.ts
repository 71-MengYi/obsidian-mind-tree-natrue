import { isMindTreePath } from "../../format/resource-id";
import { t } from "../../i18n";
import { readResourceIdentity } from "../resource-catalog";
import { canonicalTreePath } from "../pending-conflict-store";
import type { McpTreeLocator } from "./contracts";
import { McpToolError } from "./tool-error";

export interface MindTreeLocatorPorts {
  /** Vault-relative `.mtn.md` paths the resource index knows for one identity. */
  indexedTreePaths(documentId: string): readonly string[];
  /** Every vault file path; only used as a fallback sweep when the index is silent. */
  filePaths(): readonly string[];
  fileExists(path: string): boolean;
  read(path: string): Promise<string>;
  /** The tree the user is looking at right now, if any. */
  activeTreePath(): string | undefined;
}

/**
 * Turns "which tree did the client mean" into exactly one vault path.
 *
 * A client can name a tree by path, by stable `documentId`, or not at all (the
 * tree the user has open). The rules mirror the note-embed reference resolver:
 * only a candidate whose *current* on-disk identity equals the requested one may
 * be accepted, so a path that was reused by another tree fails closed instead of
 * operating on the wrong file. When two selectors disagree, or when the identity
 * cannot be verified at all, the call fails with a named error rather than
 * guessing — writing to the wrong tree is unrecoverable, a retry is not.
 */
export class MindTreePathLocator implements McpTreeLocator {
  constructor(private readonly ports: MindTreeLocatorPorts) {}

  async resolve(selection: { treePath?: string; documentId?: string }): Promise<string> {
    const requestedPath = selection.treePath === undefined || selection.treePath === ""
      ? undefined
      : canonicalTreePath(selection.treePath);
    const documentId = selection.documentId === undefined || selection.documentId === ""
      ? undefined
      : selection.documentId;
    if (documentId !== undefined) return this.resolveByIdentity(documentId, requestedPath);
    if (requestedPath !== undefined) return this.resolveByPath(requestedPath);
    const activePath = this.ports.activeTreePath();
    if (activePath === undefined || !isMindTreePath(canonicalTreePath(activePath))) {
      // Neither selector was given and no tree is open: the client has to supply
      // one, so the failure names the missing input instead of an empty target.
      throw new McpToolError("invalid-arguments", t("mcp.error.invalidArguments", {
        detail: "treePath or documentId"
      }));
    }
    return canonicalTreePath(activePath);
  }

  /** An explicitly named file is returned as-is; there is nothing to guess. */
  private resolveByPath(path: string): string {
    if (!isMindTreePath(path) || !this.ports.fileExists(path)) this.throwNotFound(path);
    return path;
  }

  private async resolveByIdentity(documentId: string, requestedPath?: string): Promise<string> {
    // A path that is simply gone is not an occupant: the caller may be holding a
    // stale hint, and the document id is the stronger selector, so resolution
    // continues with the index and the vault sweep.
    if (requestedPath !== undefined && this.ports.fileExists(requestedPath)) {
      const identity = await this.identityAt(requestedPath);
      if (identity.unreadable || (identity.documentId !== undefined && identity.documentId !== documentId)) {
        // The path exists but is not this tree (or cannot be verified): the two
        // selectors contradict each other, so neither may be trusted.
        this.throwAmbiguous(requestedPath);
      }
    }
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (rawPath: string): void => {
      const path = canonicalTreePath(rawPath);
      if (!isMindTreePath(path) || seen.has(path) || !this.ports.fileExists(path)) return;
      seen.add(path);
      candidates.push(path);
    };
    add(requestedPath ?? "");
    for (const path of this.ports.indexedTreePaths(documentId)) add(path);

    let matches = await this.match(candidates, documentId);
    if (matches.length === 0) {
      // A tree the index never saw (created outside the plugin, or after a
      // rebuild) must still be findable, so the whole vault is swept once.
      for (const path of this.ports.filePaths()) add(path);
      matches = await this.match(candidates, documentId);
    }
    if (matches.length > 1) this.throwAmbiguous(documentId);
    if (matches.length === 1) return matches[0]!;
    this.throwNotFound(documentId);
  }

  private async match(candidates: readonly string[], documentId: string): Promise<string[]> {
    const matches: string[] = [];
    let unreadable = false;
    for (const path of candidates) {
      const identity = await this.identityAt(path);
      if (identity.unreadable) unreadable = true;
      if (identity.documentId === documentId) matches.push(path);
    }
    // Unverifiable data could be hiding the requested tree; reporting "not
    // found" would invite a create that silently duplicates its identity.
    if (matches.length === 0 && unreadable) this.throwAmbiguous(documentId);
    return matches;
  }

  private async identityAt(path: string): Promise<{ documentId?: string; unreadable: boolean }> {
    try {
      const source = await this.ports.read(path);
      const resourceId = readResourceIdentity(path, source)?.resourceId;
      return { ...(resourceId ? { documentId: resourceId } : {}), unreadable: false };
    } catch {
      return { unreadable: true };
    }
  }

  private throwNotFound(target: string): never {
    throw new McpToolError("tree-not-found", t("mcp.error.treeNotFound", { target }));
  }

  private throwAmbiguous(target: string): never {
    throw new McpToolError("tree-ambiguous", t("mcp.error.treeAmbiguous", { target }));
  }
}
