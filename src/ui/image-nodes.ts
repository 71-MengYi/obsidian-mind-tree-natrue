import type { TFile } from "obsidian";
import {
  DEFAULT_IMAGE_MAX_HEIGHT,
  DEFAULT_IMAGE_MAX_WIDTH,
  fitImageToDefault,
  isImageNode,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_PIXELS,
  persistedImageSize,
  validNaturalSize,
  type ImageDisplaySize,
  type ImageNodePresentation,
  type ImageNodeVisual
} from "../render/image-nodes";
import type { MindTreeNode, NodeId } from "../types";

interface CachedImage {
  readonly key: string;
  readonly source: string;
  readonly loader?: HTMLImageElement;
  state: "loading" | "ready" | "error";
  naturalWidth?: number;
  naturalHeight?: number;
}

/**
 * Resolves vault image URLs and natural dimensions without persisting either.
 * Cache keys include path and mtime, so replacing or renaming a source cannot
 * leave a stale preview attached to a stable resource ID.
 */
export class BrowserImageNodePresentation implements ImageNodePresentation {
  private readonly cache = new Map<string, CachedImage>();
  private readonly transientSizes = new Map<NodeId, ImageDisplaySize>();
  private destroyed = false;

  constructor(
    private readonly ownerWindow: Window,
    private readonly resolveFile: (node: Readonly<MindTreeNode>) => TFile | undefined,
    private readonly resourcePath: (file: TFile) => string,
    private readonly onChanged: (resourceId: string) => void
  ) {}

  resolve(node: Readonly<MindTreeNode>): ImageNodeVisual | undefined {
    if (!isImageNode(node)) return undefined;
    const file = this.resolveFile(node);
    if (!file || file.stat.size > MAX_IMAGE_PREVIEW_BYTES) return undefined;
    const key = `${file.path}\u0000${file.stat.mtime}`;
    let cached = this.cache.get(node.resource!.resourceId);
    if (!cached || cached.key !== key) {
      cached?.loader && (cached.loader.src = "");
      cached = this.beginLoad(node.resource!.resourceId, file, key);
      this.cache.set(node.resource!.resourceId, cached);
    }
    if (cached.state === "error") return undefined;
    const size = this.transientSizes.get(node.id)
      ?? persistedImageSize(node)
      ?? (cached.state === "ready" && cached.naturalWidth && cached.naturalHeight
        ? fitImageToDefault(cached.naturalWidth, cached.naturalHeight)
        : { width: DEFAULT_IMAGE_MAX_WIDTH, height: DEFAULT_IMAGE_MAX_HEIGHT });
    return {
      ...size,
      source: cached.source,
      naturalWidth: cached.naturalWidth,
      naturalHeight: cached.naturalHeight,
      loading: cached.state === "loading"
    };
  }

  setTransientSize(nodeId: NodeId, size: ImageDisplaySize): void {
    this.transientSizes.set(nodeId, size);
  }

  clearTransientSize(nodeId: NodeId): void {
    this.transientSizes.delete(nodeId);
  }

  invalidate(resourceId?: string): void {
    if (resourceId) {
      const entry = this.cache.get(resourceId);
      if (entry?.loader) entry.loader.src = "";
      this.cache.delete(resourceId);
      return;
    }
    for (const entry of this.cache.values()) if (entry.loader) entry.loader.src = "";
    this.cache.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidate();
    this.transientSizes.clear();
  }

  private beginLoad(resourceId: string, file: TFile, key: string): CachedImage {
    const source = this.resourcePath(file);
    const loader = this.ownerWindow.document.createElement("img");
    const entry: CachedImage = { key, source, loader, state: "loading" };
    loader.decoding = "async";
    loader.onload = () => {
      if (this.destroyed || this.cache.get(resourceId) !== entry) return;
      const naturalWidth = loader.naturalWidth;
      const naturalHeight = loader.naturalHeight;
      if (!validNaturalSize(naturalWidth, naturalHeight)
        || naturalWidth * naturalHeight > MAX_IMAGE_PREVIEW_PIXELS) {
        entry.state = "error";
      } else {
        entry.state = "ready";
        entry.naturalWidth = naturalWidth;
        entry.naturalHeight = naturalHeight;
      }
      this.onChanged(resourceId);
    };
    loader.onerror = () => {
      if (this.destroyed || this.cache.get(resourceId) !== entry) return;
      entry.state = "error";
      this.onChanged(resourceId);
    };
    loader.src = source;
    return entry;
  }
}
