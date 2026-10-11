import { evictOldest } from "../../lru-cache";
import type { MindTreeDocument, NodeId } from "../../types";
import { MindTreeSearchPanel } from "../search/search-panel";
import {
  buildSearchCandidates,
  buildSearchParentIndex,
  nodeAncestorIds,
  normalizeSearchPath,
  resolveSearchMarkdownFiles
} from "../search/search-payload";
import {
  readSearchFiles,
  searchMindTree,
  type FileCandidate,
  type SearchCandidate,
  type SearchContext,
  type SearchResult
} from "../search/search-core";

/** Bounded Markdown cache; a long session still covers every realistic query. */
export const SEARCH_CONTENT_CACHE_LIMIT = 300;

/** The five readable attributes of a vault file the content cache keys on. */
export interface SearchVaultFile {
  readonly path: string;
  readonly stat: { readonly mtime: number };
}

/** Labels and node-title text stay localized by the host, never by this module. */
export interface SearchControllerLabels {
  readonly title: string;
  readonly placeholder: string;
  readonly close: string;
  readonly count: string;
  readonly empty: string;
  readonly loading: string;
  readonly truncated: string;
  readonly clear: string;
}

/**
 * Everything the search surface needs from the view. The controller owns the
 * panel and the three caches; it never touches the document model, the canvas
 * or the vault itself, and it may not import `MindTreeView` or the plugin.
 */
export interface SearchControllerPorts<TFile extends SearchVaultFile> {
  /** Labels are read once, at construction, exactly like the panel's own. */
  readonly labels: SearchControllerLabels;
  /** Where the right-hand panel is appended; also supplies the owner document. */
  readonly parent: HTMLElement;

  readonly readDocument: () => MindTreeDocument | undefined;
  /** A parse failure disables search for the whole file. */
  readonly hasParseError: () => boolean;
  /** Bumped whenever the host replaces the loaded document snapshot. */
  readonly readSessionToken: () => string;
  /** A closing view must never answer an in-flight query. */
  readonly isViewClosed: () => boolean;
  /** Path of this view's own mind-tree file, already normalized, if any. */
  readonly readOwnPath: () => string | undefined;

  readonly resolveSearchMarkdownFiles: (
    candidates: readonly SearchCandidate[],
    ownPath: string | undefined
  ) => Promise<readonly FileCandidate<TFile>[]>;
  readonly readFileText: (file: TFile) => Promise<string>;

  readonly jumpToNode: (nodeId: NodeId) => void;
  readonly openFileAtLine: (path: string, line: number) => void;
  /** Display name for a path row; the node id stays the fallback. */
  readonly readNodeTitle: (nodeId: NodeId) => string | undefined;
}

export interface SearchController {
  /** Append the panel to the host element. Called once, from view wiring. */
  mount(): void;
  open(): void;
  /** Every reflow invalidates the derived payload; the revision only grows. */
  invalidate(): void;
  /** Drop cached answers when the host document object changed. */
  setContext(): void;
  destroy(): void;
}

/** One cached payload per revision, invalidated by the host's monotonic counter. */
interface CandidateCache<TFile extends SearchVaultFile> {
  revision: number;
  candidates: readonly SearchCandidate[];
  nodeAncestors: (nodeId: NodeId) => readonly NodeId[] | undefined;
  files: Promise<readonly FileCandidate<TFile>[]>;
}

export function createSearchController<TFile extends SearchVaultFile>(
  ports: SearchControllerPorts<TFile>
): SearchController {
  let panel: MindTreeSearchPanel | undefined;
  let candidateCache: CandidateCache<TFile> | undefined;
  /** Markdown text keyed by `path\0mtime` so repeated keystrokes stop re-reading. */
  const contentCache = new Map<string, string>();
  /** Bumped by every host reflow so a document change invalidates candidates. */
  let revision = 0;
  /** Document object whose answer the panel currently displays. */
  let searchedDocument: MindTreeDocument | undefined;
  let destroyed = false;

  /**
   * Build the searchable payload: node titles always, file names always, and
   * Markdown content only for files whose path is worth reading.
   *
   * Both the candidate list and the identity verification are cached per
   * document revision. Verification re-reads every linked file, so repeating it
   * on each keystroke would make a large tree feel unresponsive; the content
   * cache below then keeps the first payload build the only expensive one.
   */
  const buildContext = async (): Promise<SearchContext | undefined> => {
    const document = ports.readDocument();
    if (!document || ports.hasParseError()) return undefined;
    const candidateRevision = revision;
    const token = ports.readSessionToken();
    const ownPath = ports.readOwnPath();
    if (candidateCache?.revision !== candidateRevision) {
      // Ancestry stays lazy: only the cards that survive the result limit ask
      // for their root-to-node chain, so a deep tree does not pay for every node.
      const nodeAncestors = nodeAncestorIds(buildSearchParentIndex(document), new Set(Object.keys(document.nodes)));
      const candidates = buildSearchCandidates(document, ownPath);
      candidateCache = {
        revision: candidateRevision,
        candidates,
        nodeAncestors,
        files: ports.resolveSearchMarkdownFiles(candidates, ownPath)
      };
    }
    const cache = candidateCache;
    // The read budget bounds the read burst; the caches make later keystrokes almost free.
    const contents = await readSearchFiles<TFile>({
      resolve: () => cache.files,
      read: (file) => readFileText(file)
    }, () => true);
    // Triple comparison, unchanged from the view: a closed view, a replaced
    // document snapshot, or a different document object all invalidate it.
    if (ports.isViewClosed() || token !== ports.readSessionToken() || ports.readDocument() !== document) {
      return undefined;
    }
    return { candidates: cache.candidates, fileContents: contents.contents, nodeAncestorIds: cache.nodeAncestors };
  };

  /** Bounded, path+mtime keyed cache; every read is a plain vault read. */
  const readFileText = async (file: TFile): Promise<string> => {
    const key = `${file.path}\u0000${file.stat.mtime}`;
    const cached = contentCache.get(key);
    if (cached !== undefined) return cached;
    const text = await ports.readFileText(file);
    evictOldest(contentCache, SEARCH_CONTENT_CACHE_LIMIT);
    contentCache.set(key, text);
    return text;
  };

  /** Resolve the current payload for one query; stale reads are simply dropped. */
  const runSearch = async (query: string): Promise<SearchResult | undefined> => {
    const context = await buildContext();
    if (!context || ports.isViewClosed()) return undefined;
    searchedDocument = ports.readDocument();
    return searchMindTree(context, query);
  };

  return {
    mount(): void {
      if (destroyed || panel) return;
      panel = new MindTreeSearchPanel(ports.parent, ports.labels, {
        search: (query) => runSearch(query),
        jumpToNode: (nodeId) => ports.jumpToNode(nodeId),
        openFileAtLine: (path, line) => ports.openFileAtLine(path, line),
        // Path rows show node names; the id stays the fallback for a pruned node.
        nodeTitle: (nodeId) => ports.readNodeTitle(nodeId)
      });
    },

    open(): void {
      panel?.open();
    },

    invalidate(): void {
      revision += 1;
    },

    setContext(): void {
      // An open window shows rows from the previous document object until it is
      // asked again; the comparison keeps an untouched document from refreshing.
      if (panel?.isOpen && searchedDocument !== ports.readDocument()) panel.setContext();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel?.destroy();
      panel = undefined;
      candidateCache = undefined;
      contentCache.clear();
      searchedDocument = undefined;
    }
  };
}
