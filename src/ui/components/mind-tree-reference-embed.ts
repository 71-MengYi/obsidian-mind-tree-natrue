import { MarkdownRenderChild, setIcon, type TFile } from "obsidian";
import type { BranchReference } from "../../domain/branch-reference";
import type { BranchReferenceResolution } from "../../services/mind-tree-reference";
import { t } from "../../i18n";
import type { MindTreeDocument, MindTreeNode, NodeId } from "../../types";
import { DEFAULT_NODE_WRAP_WIDTH } from "../../render/layout";
import { DisposableUiObject } from "./ui-object";
import { ReadOnlyTreePreview, type TreePreviewOptions } from "./read-only-tree-preview";

/**
 * Everything the embed needs from the plugin. The component never imports the
 * view or the plugin class, so a stale reference can only degrade to text.
 */
export interface MindTreeReferenceEmbedPorts {
  readonly resolve: (reference: BranchReference) => Promise<BranchReferenceResolution>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly openTree: (path: string) => void;
  readonly openResource: (node: Readonly<MindTreeNode>) => void;
  readonly resolveImageFile: (node: Readonly<MindTreeNode>) => TFile | undefined;
  readonly resourcePath: (file: TFile) => string;
}

/** Vault events arrive in bursts; one refresh per burst is enough. */
const REFRESH_DEBOUNCE_MS = 120;
/** The embed grows with the branch but never collapses below a usable box. */
const MIN_EMBED_HEIGHT = 120;
const EMBED_HEIGHT_PADDING = 32;

type UnreadyKind = Exclude<BranchReferenceResolution["kind"], "ready">;

/**
 * One `mind-tree-ref` code block: a read-only view of a branch that lives in
 * another tree file. Resolution is asynchronous and may change (the tree is
 * renamed, the node is cut), so the element is rebuilt only when the target
 * actually changes; a same-file refresh keeps the reader's viewport and folds.
 */
export class MindTreeReferenceEmbed extends DisposableUiObject {
  readonly element: HTMLElement;
  private preview?: ReadOnlyTreePreview;
  private unsubscribe?: () => void;
  private refreshTimer?: number;
  private renderedKey?: string;
  private readyPath?: string;
  private embedHeight?: number;

  constructor(
    parent: HTMLElement,
    private readonly reference: BranchReference | undefined,
    private readonly ports: MindTreeReferenceEmbedPorts
  ) {
    super();
    this.element = parent.createDiv("mtn-embed");
    if (!reference) {
      // A malformed block has nothing to resolve and nothing to open.
      this.element.createDiv({ cls: "mtn-embed-invalid", text: t("embed.invalidSyntax") });
      return;
    }
    this.unsubscribe = ports.subscribe(() => this.scheduleRefresh());
    this.own(() => this.release());
    void this.refresh();
  }

  private get view(): Window | null {
    return this.element.ownerDocument.defaultView;
  }

  /** Idempotent: also runs when the owning note is unloaded. */
  private release(): void {
    this.clearRefreshTimer();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.preview?.destroy();
    this.preview = undefined;
  }

  private scheduleRefresh(): void {
    if (this.cleanup.isDisposed) return;
    this.clearRefreshTimer();
    const owner = this.view;
    if (!owner) {
      void this.refresh();
      return;
    }
    this.refreshTimer = owner.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === undefined) return;
    this.view?.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async refresh(): Promise<void> {
    const reference = this.reference;
    if (!reference || this.cleanup.isDisposed) return;
    let resolution: BranchReferenceResolution;
    try {
      resolution = await this.ports.resolve(reference);
    } catch {
      // Resolution reports failures as data; a throwing port must still not
      // surface an unhandled rejection inside Obsidian's renderer.
      if (this.cleanup.isDisposed) return;
      this.apply({ kind: "unreadable" });
      return;
    }
    // The note may have been closed while the lookup was in flight.
    if (this.cleanup.isDisposed) return;
    this.apply(resolution);
  }

  private apply(resolution: BranchReferenceResolution): void {
    if (resolution.kind === "ready") {
      if (this.preview && this.readyPath === resolution.path) {
        // Same branch in the same file: swap the document only, so the viewport
        // and any temporary folds survive an ordinary save. The accessible name
        // follows too — a retitled node must not keep announcing the old title.
        this.preview.setLabel(this.viewLabel(resolution.document));
        this.preview.update(resolution.document);
        return;
      }
      this.renderReady(resolution.path, resolution.document);
      return;
    }
    const pathHint = this.reference?.pathHint;
    // Only `missing-tree` has no file to open. A resolved missing node still
    // reports its (possibly renamed) path, and the remaining states fall back
    // to the recorded hint so the reader can open the tree and fix it.
    const executablePath = resolution.kind === "missing-tree" ? undefined
      : resolution.kind === "missing-node" ? resolution.path
      : pathHint;
    const key = `${resolution.kind}:${executablePath ?? ""}`;
    if (this.renderedKey === key) return;
    this.renderPlaceholder(resolution.kind, executablePath);
  }

  private renderReady(path: string, document: MindTreeDocument): void {
    const reference = this.reference;
    if (!reference) return;
    this.clearBody();
    this.renderedKey = `ready:${path}`;
    this.readyPath = path;
    const tree = this.element.createDiv("mtn-embed-tree");
    const preview = new ReadOnlyTreePreview(tree, this.viewLabel(document), this.previewOptions(reference.nodeId));
    this.preview = preview;
    preview.update(document);
    this.renderOpenButton(tree, path);
  }

  /** Accessible name of the branch, read from the document of this pass. */
  private viewLabel(document: MindTreeDocument): string {
    const reference = this.reference;
    const title = reference ? document.nodes[reference.nodeId]?.title ?? reference.nodeId : "";
    return t("embed.viewLabel", { title });
  }

  private renderPlaceholder(kind: UnreadyKind, path: string | undefined): void {
    this.clearBody();
    this.renderedKey = `${kind}:${path ?? ""}`;
    this.element.createDiv({ cls: "mtn-embed-message", text: placeholderText(kind) });
    if (path) this.renderOpenButton(this.element, path);
  }

  private renderOpenButton(parent: HTMLElement, path: string): void {
    const button = parent.createEl("button", {
      cls: "mtn-embed-open",
      attr: { type: "button", "aria-label": t("embed.openTree") }
    });
    setIcon(button, "git-fork");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.ports.openTree(path);
    });
  }

  private clearBody(): void {
    this.preview?.destroy();
    this.preview = undefined;
    this.readyPath = undefined;
    this.renderedKey = undefined;
    this.embedHeight = undefined;
    this.element.empty();
    this.element.style.removeProperty("--mtn-embed-height");
  }

  /** The visible box follows the laid-out branch height, in whole pixels. */
  private applyEmbedHeight(height: number, zoom: number): void {
    const value = Math.max(MIN_EMBED_HEIGHT, Math.round(height * zoom) + EMBED_HEIGHT_PADDING);
    if (this.embedHeight === value) return;
    this.embedHeight = value;
    this.element.style.setProperty("--mtn-embed-height", `${value}px`);
  }

  private previewOptions(nodeId: NodeId): TreePreviewOptions {
    return {
      // An embed does not read plugin settings: sharing the built-in defaults
      // keeps the same reference identical in every note.
      ignoredFileBadgeExtensions: [],
      fileExtensionBadgeAliases: {},
      nodeWrapWidth: DEFAULT_NODE_WRAP_WIDTH,
      nodeAlignment: "level",
      className: "mtn-view mtn-embed-tree",
      startId: nodeId,
      fit: "width",
      // The box height comes from this very layout, so the first fit measures a
      // placeholder height; re-fit until the reader takes over the viewport.
      refitOnResize: true,
      allowResourceOpen: true,
      wheelPassThrough: true,
      // The preview resolves the node from the document it is rendering right
      // now, so an in-place refresh can never open a stale resource.
      openResource: (node) => { this.ports.openResource(node); },
      resolveImageFile: (node) => this.ports.resolveImageFile(node),
      resourcePath: (file) => this.ports.resourcePath(file),
      onLayout: ({ height, zoom }) => { this.applyEmbedHeight(height, zoom); }
    };
  }
}

/** Obsidian render child: one embed per fenced block, destroyed with the block. */
export class MindTreeReferenceRenderChild extends MarkdownRenderChild {
  private embed?: MindTreeReferenceEmbed;

  constructor(
    containerEl: HTMLElement,
    private readonly reference: BranchReference | undefined,
    private readonly ports: MindTreeReferenceEmbedPorts
  ) {
    super(containerEl);
  }

  onload(): void {
    if (!this.embed) this.embed = new MindTreeReferenceEmbed(this.containerEl, this.reference, this.ports);
  }

  onunload(): void {
    this.embed?.destroy();
    this.embed = undefined;
  }
}

function placeholderText(kind: UnreadyKind): string {
  if (kind === "missing-tree") return t("embed.missingTree");
  if (kind === "missing-node") return t("embed.missingNode");
  if (kind === "ambiguous") return t("embed.ambiguousTree");
  return t("embed.unreadableTree");
}
