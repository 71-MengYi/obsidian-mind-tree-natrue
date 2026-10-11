import { clamp } from "../numeric";
import type { FileResourceRef, MindTreeNode } from "../types";

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

/** Shared by the geometry helpers above and the browser image loader. */
export function validNaturalSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}
