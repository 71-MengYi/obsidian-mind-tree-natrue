import { createMindTreeFile } from "../format/document";
import { sanitizeFileTitle } from "../format/resource-id";
import { t } from "../i18n";
import type { MindTreeDocument, NodeId } from "../types";

/**
 * The one path that types a `.mtn.md` file into existence.
 *
 * The Ribbon, the "create mind tree" command and the MCP `create_tree` tool all
 * have to produce the same file with the same name-collision sequence, so the
 * rule lives here behind injected storage ports. Two behaviours are deliberately
 * caller-controlled: the destination folder (the command infers it, the Ribbon
 * and MCP state it) and whether the new tree may take focus, because an MCP call
 * must never pull the canvas away from whatever the user is doing.
 */

/** How many numbered suffixes are tried before creation is refused. */
export const MAX_MIND_TREE_PATH_CANDIDATES = 1000;

/**
 * A vault-safe file name for a new tree, derived from one shared sanitiser so a
 * resource rename and a tree creation can never disagree about illegal
 * characters or consecutive whitespace.
 */
export function sanitizeMindTreeTitle(title: string): string {
  return sanitizeFileTitle(title);
}

/** Vault-relative `/` style, trimmed, with no empty or `.`/`..` segments kept. */
function normalizeDirectory(directory: string): string {
  return directory
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

/**
 * Candidate paths in creation order: `<title>.mtn.md`, then ` 2`, ` 3`, and so
 * on. Pure, so the collision sequence is unit-testable without a vault; the
 * caller picks the first path that is still free.
 */
export function createMindTreePathCandidates(
  directory: string,
  title: string,
  limit: number = MAX_MIND_TREE_PATH_CANDIDATES
): string[] {
  const cleanDirectory = normalizeDirectory(directory);
  const prefix = cleanDirectory ? `${cleanDirectory}/` : "";
  const attempts = Math.max(1, Math.min(Math.floor(limit), MAX_MIND_TREE_PATH_CANDIDATES));
  const candidates: string[] = [];
  for (let counter = 1; counter <= attempts; counter += 1) {
    const name = counter === 1 ? title : `${title} ${counter}`;
    candidates.push(`${prefix}${name}.mtn.md`);
  }
  return candidates;
}

export interface MindTreeCreatedFile<TFile> {
  file: TFile;
  /** The parsed document of what was just written, so no second disk read is needed. */
  document: MindTreeDocument;
}

export interface MindTreeCreationPorts<TFile> {
  fileExists(path: string): boolean;
  createFile(path: string, source: string): Promise<MindTreeCreatedFile<TFile>>;
  /** Adds the initial child nodes to the tree just created, in order. */
  appendChildren(file: TFile, titles: readonly string[]): Promise<NodeId[]>;
  /** `focus: false` means "make it exist", never "bring it to the front". */
  activate(file: TFile, focus: boolean): Promise<void>;
}

export interface MindTreeCreationInput {
  title: string;
  /** Already-normalized vault directory; empty means the vault root. */
  folderPath?: string;
  children?: readonly string[];
  /** Interactive callers keep the default; MCP passes `false`. */
  focus?: boolean;
}

export interface CreatedMindTree<TFile> {
  file: TFile;
  path: string;
  rootId: NodeId;
  documentId?: string;
  childIds: NodeId[];
}

export class MindTreeCreationService<TFile> {
  constructor(private readonly ports: MindTreeCreationPorts<TFile>) {}

  async create(input: MindTreeCreationInput): Promise<CreatedMindTree<TFile>> {
    const safeTitle = sanitizeMindTreeTitle(input.title);
    // The command prompt already reports this failure; a blank or fully illegal
    // name must keep the same wording instead of creating a nameless file.
    if (!safeTitle) throw new Error(t("tree.invalidName"));
    const path = createMindTreePathCandidates(input.folderPath ?? "", safeTitle)
      .find((candidate) => !this.ports.fileExists(candidate));
    // Only reachable if a thousand same-named trees exist; refusing is safer
    // than looping forever or silently reusing one of them.
    if (!path) throw new Error(t("mcp.error.duplicateTitle", { title: safeTitle }));
    const created = await this.ports.createFile(path, createMindTreeFile(safeTitle));
    const childTitles = (input.children ?? [])
      .map((child) => child.trim())
      .filter((child) => child.length > 0);
    const childIds = childTitles.length > 0
      ? await this.ports.appendChildren(created.file, childTitles)
      : [];
    await this.ports.activate(created.file, input.focus ?? true);
    return {
      file: created.file,
      path,
      rootId: created.document.rootId,
      ...(created.document.documentId ? { documentId: created.document.documentId } : {}),
      childIds
    };
  }
}
