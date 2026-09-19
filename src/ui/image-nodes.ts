import type { TFile } from "obsidian";
import type { FileResourceRef, MindTreeNode, NodeId } from "../types";

export interface ImageDisplaySize {
  readonly width: number;
  readonly height: number;
}

export interface ImageNodeVisual extends ImageDisplaySize {
  readonly source: string;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly loading: boolean;
}

/** Synchronous facade consumed by layout and rendering; loading stays internal. */
export interface ImageNodePresentation {
  resolve(node: Readonly<MindTreeNode>): ImageNodeVisual | undefined;
}

export const DEFAULT_IMAGE_MAX_WIDTH = 180;
export const DEFAULT_IMAGE_MAX_HEIGHT = 135;
export const MIN_IMAGE_RESIZE_WIDTH = 60;
export const MAX_IMAGE_RESIZE_WIDTH = 600;
export const MAX_IMAGE_DISPLAY_HEIGHT = 4_096;
export const MAX_IMAGE_PREVIEW_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_PREVIEW_PIXELS = 40_000_000;
export const IMAGE_CAPTION_GAP = 2;

interface CachedImage {
  readonly key: string;
  readonly source: string;
  readonly loader?: HTMLImageElement;
  state: "loading" | "ready" | "error";
  naturalWidth?: number;
  naturalHeight?: number;
}

export function isImageNode(
  node: Readonly<MindTreeNode> | undefined
): node is Readonly<MindTreeNode> & { resource: FileResourceRef & { fileKind: "image" } } {
  return node?.resource?.type === "file" && node.resource.fileKind === "image";
}

export function persistedImageSize(node: Readonly<MindTreeNode>): ImageDisplaySize | undefined {
  const width = node.style?.imageWidth;
  const height = node.style?.imageHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width === undefined || height === undefined
    || width <= 0 || width > MAX_IMAGE_RESIZE_WIDTH
    || height <= 0 || height > MAX_IMAGE_DISPLAY_HEIGHT) return undefined;
  return { width, height };
}

/** Fit an image into the compact initial box without enlarging small sources. */
export function fitImageToDefault(naturalWidth: number, naturalHeight: number): ImageDisplaySize {
  if (!validNaturalSize(naturalWidth, naturalHeight)) {
    return { width: DEFAULT_IMAGE_MAX_WIDTH, height: DEFAULT_IMAGE_MAX_HEIGHT };
  }
  const scale = Math.min(
    1,
    DEFAULT_IMAGE_MAX_WIDTH / naturalWidth,
    DEFAULT_IMAGE_MAX_HEIGHT / naturalHeight
  );
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  };
}

/** Resize from a horizontal drag while preserving the source aspect ratio. */
export function resizeImageFromWidth(width: number, aspectRatio: number): ImageDisplaySize {
  const safeRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 4 / 3;
  let nextWidth = clamp(width, MIN_IMAGE_RESIZE_WIDTH, MAX_IMAGE_RESIZE_WIDTH);
  let nextHeight = nextWidth / safeRatio;
  if (nextHeight > MAX_IMAGE_DISPLAY_HEIGHT) {
    nextHeight = MAX_IMAGE_DISPLAY_HEIGHT;
    nextWidth = nextHeight * safeRatio;
  }
  return {
    width: Math.max(1, Math.round(nextWidth)),
    height: Math.max(1, Math.round(nextHeight))
  };
}

/** Deterministic headless geometry used by layout tests and safe fallbacks. */
export const fallbackImageNodePresentation: ImageNodePresentation = {
  resolve(node) {
    if (!isImageNode(node)) return undefined;
    const size = persistedImageSize(node)
      ?? { width: DEFAULT_IMAGE_MAX_WIDTH, height: DEFAULT_IMAGE_MAX_HEIGHT };
    return { ...size, source: "", loading: true };
  }
};

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

function validNaturalSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
