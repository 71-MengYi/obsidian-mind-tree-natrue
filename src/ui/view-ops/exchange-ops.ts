import { Notice, type TFile } from "obsidian";
import { t } from "../../i18n";
import { sanitizeFileTitle } from "../../format/resource-id";
import type { BranchReference } from "../../domain/branch-reference";
import { getTopLevelSelectedNodeIds } from "../../domain/tree";
import type {
  FileResourceRef,
  MindTreeDocument,
  MindTreeNodeAlignment,
  MindTreeTheme,
  NodeId
} from "../../types";
import { fallbackNodeTextMeasurer, type NodeTextMeasurer } from "../../render/text-measurer";
import {
  createResourceBadgePresentation,
  fallbackResourceBadgeMeasurer,
  type CustomMarkerRules,
  type FileBadgeRules,
  type ResourceBadgeMeasurer,
  type ResourceBadgePresentation
} from "../../render/resource-badges";
import {
  copyBranchReference as copyBranchReferenceToClipboard,
  copyBranches,
  copyPlainText
} from "../../services/clipboard";
import { buildCanvasFile, createCanvasPathCandidates } from "../../services/canvas-export";
import {
  downloadMarkdown,
  exportBranchPng,
  prepareImageExportSource,
  resolveExportNodeId,
  type ExportThemeColors
} from "../../services/export";
import { renderBranchMarkdown } from "../../format/outline";
import { renderBranchMermaid } from "../../format/mermaid";

/**
 * Export settings the exchange commands read. Kept as a value snapshot from the
 * host so this module never imports the plugin class or its settings object.
 */
export interface ExchangeExportSettings {
  readonly pngScale: 1 | 2 | 3;
  readonly nodeWrapWidth: number;
  readonly nodeAlignment: MindTreeNodeAlignment;
}

/** Badge measurer plus the style refresh the render and export paths share. */
export interface ExchangeResourceBadgeMeasurer extends ResourceBadgeMeasurer {
  refreshStyles(): void;
}

/**
 * Everything the exchange commands need from the view. Getters return live
 * view state so session switches and node deletions observed after an `await`
 * still invalidate the command, exactly like the original inline methods.
 */
export interface ExchangeOpsHost {
  getDocument(): MindTreeDocument | undefined;
  getFile(): TFile | null;
  getPrimarySelectedId(): NodeId | undefined;
  getSelectedIds(): ReadonlySet<NodeId>;
  getDocumentSessionToken(): string;
  /** False while the session refuses edits, mirroring the view's commit guard. */
  mutationLocked(): boolean;
  getExportSettings(): ExchangeExportSettings;
  getTextMeasurer(): NodeTextMeasurer | undefined;
  getRootEl(): HTMLElement;
  getResourceBadgePresentation(): ResourceBadgePresentation;
  buildBranchReference(file: TFile, nodeId: NodeId, document: MindTreeDocument): Promise<BranchReference>;
  resolveVerifiedResource(resource: FileResourceRef): Promise<TFile | undefined>;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  fileExists(path: string): boolean;
  createTextFile(path: string, source: string): Promise<{ readonly path: string }>;
  /**
   * The node command layer's single delete step. Cut reaches it only after the
   * clipboard write succeeded, so a failed copy never deletes anything.
   */
  deleteTopics(targetNodeIds: NodeId[], structureMode: "branch" | "node-only"): void;
}

/**
 * Assemble one immutable trailing-item profile for a render/export pass. This
 * is a mechanical extraction of the view's former private helper: the measurer
 * still refreshes its cached styles against the live DOM before every profile.
 */
export function createViewResourceBadgePresentation(
  settings: FileBadgeRules & Partial<CustomMarkerRules>,
  measurer: ExchangeResourceBadgeMeasurer | undefined
): ResourceBadgePresentation {
  measurer?.refreshStyles();
  return createResourceBadgePresentation(
    settings,
    { mindTree: t("node.mindTreeMarker"), drawing: t("node.drawingMarker") },
    measurer ?? fallbackResourceBadgeMeasurer,
    { emoji: t("marker.category.emoji"), tag: t("marker.category.tag") }
  );
}

/**
 * Resolve Obsidian CSS variables before handing colors to SVG. Custom
 * properties retain `var(...)` tokens when read directly, so a hidden probe
 * asks the browser for the final computed color in the current light/dark mode.
 */
function resolveExportThemeColors(rootEl: HTMLElement, theme: MindTreeTheme | undefined): ExportThemeColors | undefined {
  if (theme !== "flat" && theme !== "minimal" && theme !== "floating") return undefined;

  const ownerDocument = rootEl.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return undefined;
  const probe = ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  rootEl.appendChild(probe);
  const resolve = (property: string, fallback: string): string => {
    probe.style.color = `var(${property}, ${fallback})`;
    return ownerWindow.getComputedStyle(probe).color.trim() || fallback;
  };
  try {
    return {
      canvas: resolve("--mtn-canvas-base", "#F7F3E8"),
      root: resolve("--mtn-theme-root-accent", "#7C3AED"),
      rootText: resolve("--mtn-theme-root-text", "#FFFFFF"),
      levelOne: resolve("--mtn-theme-level-one", "#4A4A4A"),
      levelOneText: resolve("--mtn-theme-level-one-text", "#FFFFFF"),
      descendant: resolve("--mtn-theme-descendant", "#E2E0DB"),
      descendantText: resolve("--mtn-theme-descendant-text", "#2F2F2F")
    };
  } finally {
    probe.remove();
  }
}

/**
 * Copy, branch-reference, Mermaid and export commands, extracted verbatim from
 * the view. The host supplies the current document/selection/session
 * state through getters and the vault/plugin work through callbacks; keeping
 * those reads live preserves the cancellation checks that follow each `await`.
 */
export class ExchangeOps {
  constructor(private readonly host: ExchangeOpsHost) {}

  /** Single-flight guard: a second cut while the clipboard write is pending is a no-op. */
  private cutInProgress = false;

  private getResourceBadgePresentation(): ResourceBadgePresentation {
    return this.host.getResourceBadgePresentation();
  }

  async copySelected(mode: "branch" | "markdown"): Promise<void> {
    const document = this.host.getDocument();
    const primarySelectedId = this.host.getPrimarySelectedId();
    if (!document || !primarySelectedId) return;
    try {
      const selectedIds = this.host.getSelectedIds();
      const selected = selectedIds.size > 0 ? selectedIds : [primarySelectedId];
      await copyBranches(document, selected, mode);
      new Notice(mode === "branch" ? t("notice.branchCopied") : t("notice.markdownCopied"));
    } catch (error) {
      new Notice(t("notice.copyFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Cut every top-level selected branch, but never the protected root node.
   * The clipboard payload is written before anything is deleted, so a failed
   * write leaves the document (and its linked-file metadata) untouched.
   */
  async cutSelected(): Promise<void> {
    if (this.host.mutationLocked()) return;
    const document = this.host.getDocument();
    const primarySelectedId = this.host.getPrimarySelectedId();
    if (!document || !primarySelectedId || this.cutInProgress) return;
    const sourcePath = this.host.getFile()?.path;
    const documentSessionToken = this.host.getDocumentSessionToken();
    const selectedIds = this.host.getSelectedIds();
    const selected = selectedIds.size > 0 ? selectedIds : [primarySelectedId];
    const branchRootIds = getTopLevelSelectedNodeIds(document, selected);
    if (branchRootIds.length === 0) return;

    this.cutInProgress = true;
    try {
      // A failed clipboard write must leave the document untouched. This also
      // retains linked-file metadata so a later paste recreates full branches.
      await copyBranches(document, branchRootIds, "branch");
      // Switching files while an asynchronous clipboard write is pending must
      // never delete matching node IDs from the newly active document.
      if (this.host.getDocumentSessionToken() !== documentSessionToken || this.host.getFile()?.path !== sourcePath) return;
      const survivingIds = branchRootIds.filter((id) => Boolean(this.host.getDocument()?.nodes[id]));
      if (survivingIds.length > 0) this.host.deleteTopics(survivingIds, "branch");
      new Notice(t("notice.branchCut", { count: survivingIds.length }));
    } catch (error) {
      new Notice(t("notice.cutFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.cutInProgress = false;
    }
  }

  async copyBranchReference(nodeId: NodeId): Promise<void> {
    const document = this.host.getDocument();
    const file = this.host.getFile();
    const token = this.host.getDocumentSessionToken();
    if (!document || !file || !document.nodes[nodeId]) return;
    try {
      const reference = await this.host.buildBranchReference(file, nodeId, document);
      // The reference was resolved against the captured session: a switch or a
      // node deletion while identity allocation was pending must not report success.
      if (this.host.getDocumentSessionToken() !== token || !this.host.getDocument()?.nodes[nodeId]) return;
      await copyBranchReferenceToClipboard(reference);
      new Notice(t("notice.branchReferenceCopied"));
    } catch (error) {
      new Notice(t("notice.copyFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Copy this branch as Mermaid mindmap code. Only plain text is written: the
   * fenced block has no structured counterpart and must not inherit the branch
   * clipboard's custom MIME payload.
   */
  async copyMermaid(nodeId: NodeId): Promise<void> {
    const document = this.host.getDocument();
    const token = this.host.getDocumentSessionToken();
    if (!document?.nodes[nodeId]) return;
    try {
      const code = renderBranchMermaid(document, nodeId);
      // The branch may have changed while the menu gesture was pending.
      if (this.host.getDocumentSessionToken() !== token || !this.host.getDocument()?.nodes[nodeId] || !code) return;
      await copyPlainText(code);
      new Notice(t("notice.mermaidCopied"));
    } catch (error) {
      new Notice(t("notice.copyFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * Export a PNG. Without a selection this exports the whole tree: the export
   * target falls back to the root instead of silently doing nothing.
   */
  async exportSelectedPng(): Promise<void> {
    const document = this.host.getDocument();
    if (!document) return;
    const nodeId = resolveExportNodeId(document, this.host.getPrimarySelectedId());
    try {
      const settings = this.host.getExportSettings();
      await exportBranchPng(
        document,
        nodeId,
        settings.pngScale,
        settings.nodeWrapWidth,
        document.settings.layoutMode,
        document.settings.connectionStyle,
        document.settings.theme,
        document.settings.nodeShape,
        settings.nodeAlignment,
        resolveExportThemeColors(this.host.getRootEl(), document.settings.theme),
        this.host.getTextMeasurer() ?? fallbackNodeTextMeasurer,
        this.getResourceBadgePresentation(),
        async (node) => {
          if (node.resource?.type !== "file" || node.resource.fileKind !== "image") return undefined;
          const file = await this.host.resolveVerifiedResource(node.resource);
          if (!file) return undefined;
          return prepareImageExportSource(await this.host.readBinary(file), file.path);
        }
      );
    } catch (error) {
      new Notice(t("notice.pngFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** Markdown export of a branch, or of the whole tree when nothing is selected. */
  exportSelectedMarkdown(): void {
    const document = this.host.getDocument();
    if (!document) return;
    const nodeId = resolveExportNodeId(document, this.host.getPrimarySelectedId());
    downloadMarkdown(renderBranchMarkdown(document, nodeId), document.nodes[nodeId]?.title || document.title);
  }

  /**
   * Write an Obsidian Canvas file next to the source `.mtn.md`. A canvas is a
   * vault file, not a browser download: it goes through `vault.create`, keeps
   * the tree's folder, and reports the path that actually exists. Name
   * collisions use the same `-2`/`-3` sequence as other generated files.
   */
  async exportSelectedCanvas(): Promise<void> {
    const document = this.host.getDocument();
    if (!document) return;
    const nodeId = resolveExportNodeId(document, this.host.getPrimarySelectedId());
    try {
      const settings = this.host.getExportSettings();
      const canvas = buildCanvasFile(
        document,
        nodeId,
        t("node.untitled"),
        settings.nodeWrapWidth,
        document.settings.layoutMode,
        settings.nodeAlignment,
        this.host.getTextMeasurer() ?? fallbackNodeTextMeasurer,
        this.getResourceBadgePresentation()
      );
      // Obsidian saves canvases as pretty-printed JSON; matching that shape keeps
      // a hand-edited export diffable instead of one very long line.
      const source = `${JSON.stringify(canvas, null, "\t")}\n`;
      const file = this.host.getFile();
      const directory = file?.parent && !file.parent.isRoot() ? file.parent.path : "";
      const title = sanitizeFileTitle(document.nodes[nodeId]?.title || document.title) || t("node.untitled");
      const path = createCanvasPathCandidates(directory, title)
        .find((candidate) => !this.host.fileExists(candidate));
      if (!path) throw new Error(t("notice.canvasNameExhausted"));
      const created = await this.host.createTextFile(path, source);
      new Notice(t("notice.canvasExported", { path: created.path }));
    } catch (error) {
      new Notice(t("notice.canvasFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }
}
