import { nodeTitleMode } from "../format/node-title";
import { renderRichTitleSvg } from "../ui/rich-title";
import type {
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme,
  NodeId,
  PositionedNode
} from "../types";
import { collectBranchIds } from "../domain/tree";
import {
  getIconNodeMarkers,
  getNodeHighlightColor
} from "../domain/markers";
import {
  connectionPath,
  DEFAULT_NODE_WRAP_WIDTH,
  getNodeFontSize,
  getNodeLineHeight,
  getNodeSizeClass,
  layoutTree,
  NODE_HORIZONTAL_INSETS,
  NODE_HORIZONTAL_PADDING,
  NODE_VERTICAL_INSETS,
  NODE_VERTICAL_PADDING,
  wrapNodeTitle
} from "../ui/layout";
import { getBranchColorSlots } from "../ui/presentation";
import { fallbackNodeTextMeasurer, type NodeTextMeasurer } from "../ui/text-measurer";
import {
  fallbackResourceBadgePresentation,
  getNodeMarkerGeometry,
  MANUAL_MARKER_SIZE,
  NODE_MARKER_GAP,
  type ResourceBadge,
  type ResourceBadgePresentation,
  type ResourceBadgeSize
} from "../ui/resource-badges";
import { getThemePreset, resolveThemeConnection } from "../ui/theme-presets";
import {
  fitImageToDefault,
  IMAGE_CAPTION_GAP,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_PIXELS,
  persistedImageSize,
  type ImageNodePresentation,
  type ImageNodeVisual
} from "../ui/image-nodes";

const PADDING = 36;

/**
 * Mirrors `.mtn-node-marker.is-emoji` in `styles.css`. An exported SVG is
 * rendered outside the Obsidian document, so the emoji font stack has to travel
 * with the markup or rasterized PNGs lose their color glyphs.
 */
const EMOJI_FONT_FAMILY = escapeXml("'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',system-ui,sans-serif");

/**
 * Colors resolved by the live Obsidian view. This is intentionally a runtime
 * argument rather than persisted data: accent colors and light/dark mode belong
 * to the active workspace, not to the mind-tree file.
 */
export interface ExportThemeColors {
  canvas: string;
  root: string;
  rootText: string;
  levelOne: string;
  levelOneText: string;
  descendant: string;
  descendantText: string;
}

export interface ExportImageSource {
  readonly dataUrl: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface ExportImageAsset extends ExportImageSource {
  readonly width: number;
  readonly height: number;
}

export type ExportImageResolver = (node: Readonly<MindTreeNode>) => Promise<ExportImageSource | undefined>;

const EMPTY_IMAGE_ASSETS: ReadonlyMap<NodeId, ExportImageAsset> = new Map();

export function renderBranchSvg(
  document: MindTreeDocument,
  nodeId: NodeId,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  layoutMode: MindTreeLayoutMode = "right",
  connectionStyle: MindTreeConnectionStyle = "theme",
  theme: MindTreeTheme = "vibrant",
  nodeShape: MindTreeNodeShape = "rounded",
  nodeAlignment: MindTreeNodeAlignment = "level",
  runtimeColors?: Readonly<ExportThemeColors>,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  resourceBadgePresentation: ResourceBadgePresentation = fallbackResourceBadgePresentation,
  imageAssets: ReadonlyMap<NodeId, ExportImageAsset> = EMPTY_IMAGE_ASSETS
): string {
  const imagePresentation = exportImagePresentation(imageAssets);
  // Export deliberately reuses the canvas layout rules, including dynamic width
  // and wrapping, so PNG output does not drift from what the user arranged.
  const layout = layoutTree(
    document,
    nodeId,
    false,
    nodeWrapWidth,
    layoutMode,
    nodeAlignment,
    textMeasurer,
    resourceBadgePresentation,
    imagePresentation
  );
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const branchColorSlots = getBranchColorSlots(document);
  const palette = getThemePreset(theme);
  const tierPalette = palette.nodes;
  const canvasColor = safeSvgColor(runtimeColors?.canvas, palette.canvas);
  const rootColor = safeSvgColor(runtimeColors?.root, palette.root || "#7C3AED");
  const rootTextColor = safeSvgColor(runtimeColors?.rootText, palette.rootText || "#FFFFFF");
  const levelOneColor = safeSvgColor(runtimeColors?.levelOne, tierPalette?.levelOne ?? palette.surface);
  const levelOneTextColor = safeSvgColor(runtimeColors?.levelOneText, tierPalette?.levelOneText ?? "#FFFFFF");
  const descendantColor = safeSvgColor(runtimeColors?.descendant, tierPalette?.descendant ?? palette.surface);
  const descendantTextColor = safeSvgColor(runtimeColors?.descendantText, tierPalette?.descendantText ?? palette.text);
  const width = layout.width + PADDING * 2;
  const height = layout.height + PADDING * 2;
  const paths = layout.connections.map((connection) => {
    const from = positions.get(connection.from);
    const to = positions.get(connection.to);
    if (!from || !to) return "";
    const visual = resolveThemeConnection(theme, connectionStyle, to.depth);
    const dash = visual.dash ? ` stroke-dasharray="${visual.dash}"` : "";
    const slot = branchColorSlots.get(connection.to) ?? 0;
    const connectionColor = slot > 0 ? palette.branches[(slot - 1) % palette.branches.length]! : rootColor;
    const filter = visual.shadow === "none" ? "" : ` style="filter:${visual.shadow}"`;
    return `<path d="${connectionPath(offsetNode(from), offsetNode(to), layoutMode, visual.style)}" fill="none" stroke="${connectionColor}" stroke-width="${visual.width}" stroke-linecap="${visual.lineCap}" stroke-linejoin="${visual.lineJoin}" opacity="${visual.opacity}"${dash}${filter}/>`;
  }).join("");
  const nodes = layout.nodes.map((position) => {
    const node = document.nodes[position.id];
    if (!node) return "";
    const shifted = offsetNode(position);
    const className = getNodeSizeClass(position.depth);
    const highlight = getNodeHighlightColor(node);
    const slot = branchColorSlots.get(node.id) ?? 0;
    const accent = slot > 0 ? palette.branches[(slot - 1) % palette.branches.length]! : rootColor;
    const customBackground = highlight ?? node.style?.background;
    const fill = customBackground
      ? safeSvgColor(customBackground, palette.surface)
      : position.depth === 0
        ? rootColor
        : tierPalette
          ? position.depth === 1 ? levelOneColor : descendantColor
          : position.depth === 1
            ? accent
            : position.depth === 2 ? mixHexColors(accent, palette.surface, 0.16) : palette.surface;
    const textStyle = textMeasurer.getStyle(position.depth);
    const fontSize = getNodeFontSize(position.depth, textMeasurer);
    const lineHeight = getNodeLineHeight(position.depth, textMeasurer);
    const imageAsset = imageAssets.get(node.id);
    // Use the same title-only track as the DOM renderer. Trailing markers and
    // file controls change the outer rectangle, never wrapping or shifting text.
    const textWidth = Math.max(1, shifted.contentWidth - NODE_HORIZONTAL_INSETS);
    const measurement = textMeasurer.measure(node.title || "未命名节点", position.depth, nodeWrapWidth, nodeTitleMode(node, position.depth));
    const lines = measurement.lines;
    const captionTop = imageAsset
      ? shifted.y + NODE_VERTICAL_PADDING + imageAsset.height + IMAGE_CAPTION_GAP
      : shifted.y;
    const captionHeight = imageAsset
      ? shifted.height - imageAsset.height - IMAGE_CAPTION_GAP - NODE_VERTICAL_INSETS
      : shifted.height;
    const firstBaseline = captionTop + (captionHeight - lines.length * lineHeight) / 2 + fontSize;
    // Every wrapped line starts at the title area's left edge, matching the
    // browser node instead of centering the complete multiline text block.
    const textX = shifted.x + NODE_HORIZONTAL_PADDING;
    const tspans = lines.map((line, index) =>
      `<tspan x="${textX}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`).join("");
    // Title text and custom emoji share one body color, so the exported marker
    // inherits exactly what the canvas span gets from `--mtn-node-text`.
    const textColor = highlight
      ? readableSvgTextColor(highlight)
      : position.depth === 0
        ? rootTextColor
        : tierPalette
          ? position.depth === 1 ? levelOneTextColor : descendantTextColor
          : position.depth === 1 ? "#ffffff" : palette.text;
    // Custom emoji and text tags live in the global settings registry, so only
    // the presentation can decide whether they still exist; built-in icons are
    // still read from the domain. `geometry.markers` repeats the canvas DOM's
    // trailing order: custom items first, then derived resource badges.
    const iconMarkers = getIconNodeMarkers(node);
    const markerGeometry = getNodeMarkerGeometry(node, resourceBadgePresentation);
    // The marker column (canvas `.mtn-node-markers`) starts at `nodeX +
    // NODE_HORIZONTAL_PADDING + titleWidth`; its first box starts one
    // NODE_MARKER_GAP later (that rule's `padding-left`), and its last box ends
    // exactly at `markerColumnLeft + markerGeometry.width`. Never add another
    // gap here: the leading 2px is already this one.
    const markerColumnLeft = shifted.x + NODE_HORIZONTAL_PADDING + textWidth;
    const markerStartX = markerColumnLeft + (markerGeometry.width > 0 ? NODE_MARKER_GAP : 0);
    const markerCenterY = captionTop + captionHeight / 2;
    const markerY = markerCenterY + 5;
    const extensionFill = mixHexColors(palette.text, palette.surface, 0.1);
    // One cursor walks the complete trailing list - built-in icons, custom
    // emoji/tags, then derived badges. It mirrors the canvas CSS exactly (a 2px
    // padded flex column with `gap: 2px`), so every box keeps one
    // NODE_MARKER_GAP and the rendered extent equals the reserved width.
    let cursor = markerStartX;
    let placedMarkers = 0;
    const gapBeforeMarker = (): void => {
      if (placedMarkers > 0) cursor += NODE_MARKER_GAP;
    };
    const iconMarkerSvg = iconMarkers.map((marker) => {
      gapBeforeMarker();
      const centerX = cursor + MANUAL_MARKER_SIZE / 2;
      cursor += MANUAL_MARKER_SIZE;
      placedMarkers += 1;
      const symbol = marker.type === "priority"
        ? "⚑"
        : marker.value === "todo" ? "○" : marker.value === "inprogress" ? "◐" : marker.value === "done" ? "✓" : "×";
      const color = marker.type === "priority"
        ? marker.value === "red" ? "#dc2626" : marker.value === "yellow" ? "#d6a700" : "#2563eb"
        : marker.value === "done" ? "#15803d" : marker.value === "cancelled" ? "#dc2626" : marker.value === "inprogress" ? "#2563eb" : palette.text;
      return `<text x="${centerX}" y="${markerY}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" fill="${color}">${symbol}</text>`;
    }).join("");
    const trailingMarkerSvg = markerGeometry.markers.map((item) => {
      gapBeforeMarker();
      const startX = cursor;
      if (item.kind === "emoji") {
        // Emoji keep the fixed 18px icon box and inherit the node's body color,
        // exactly like the canvas span they replace.
        cursor += MANUAL_MARKER_SIZE;
        placedMarkers += 1;
        return `<text x="${startX + MANUAL_MARKER_SIZE / 2}" y="${markerY}" font-size="15" text-anchor="middle" font-family="${EMOJI_FONT_FAMILY}" fill="${textColor}">${escapeXml(item.label)}</text>`;
      }
      // Tags and file badges share one measured box, so layout and export can
      // never disagree about where the marker column ends.
      const size = resourceBadgePresentation.measure(item);
      cursor += size.width;
      placedMarkers += 1;
      return renderResourceBadgeSvg(
        item,
        size,
        startX,
        markerCenterY,
        extensionFill,
        palette.text
      );
    }).join("");
    const leafWithoutBorder = nodeShape === "borderless" && node.childIds.length === 0;
    const radius = nodeShape === "square" ? 0 : 2;
    const nodeShadow = leafWithoutBorder
      ? "none"
      : position.depth === 0 ? tierPalette?.rootShadow : tierPalette?.shadow;
    const shadowStyle = nodeShadow && nodeShadow !== "none" ? ` style="filter:${nodeShadow}"` : "";
    const imageSvg = imageAsset
      ? `<image class="mtn-node-image" x="${shifted.x + NODE_HORIZONTAL_PADDING}" y="${shifted.y + NODE_VERTICAL_PADDING}" width="${imageAsset.width}" height="${imageAsset.height}" href="${escapeXml(imageAsset.dataUrl)}" preserveAspectRatio="xMidYMid meet"/>`
      : "";
    const richTitle = measurement.richLines
      ? `<g transform="translate(${textX} ${captionTop + (captionHeight - measurement.height!) / 2})" color="${textColor}">${renderRichTitleSvg(measurement)}</g>`
      : undefined;
    const titleSvg = richTitle ?? `<text text-anchor="start" font-family="${escapeXml(textStyle.fontFamily)}" font-size="${fontSize}" font-style="${escapeXml(textStyle.fontStyle)}" font-weight="${escapeXml(textStyle.fontWeight)}" letter-spacing="${textStyle.letterSpacing}" word-spacing="${textStyle.wordSpacing}" font-kerning="${textStyle.fontKerning}" font-stretch="${textStyle.fontStretch}" font-variant-caps="${textStyle.fontVariantCaps}" text-rendering="${textStyle.textRendering}" fill="${textColor}">${tspans}</text>`;
    return `<g class="${className}"${shadowStyle}><rect x="${shifted.x}" y="${shifted.y}" width="${shifted.width}" height="${shifted.height}" rx="${radius}" fill="${leafWithoutBorder && !highlight ? "none" : fill}" stroke="none"/>${imageSvg}${titleSvg}${iconMarkerSvg}${trailingMarkerSvg}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${canvasColor}"/>${paths}${nodes}</svg>`;
}

export async function exportBranchPng(
  document: MindTreeDocument,
  nodeId: NodeId,
  scale: 1 | 2 | 3,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  layoutMode: MindTreeLayoutMode = "right",
  connectionStyle: MindTreeConnectionStyle = "theme",
  theme: MindTreeTheme = "vibrant",
  nodeShape: MindTreeNodeShape = "rounded",
  nodeAlignment: MindTreeNodeAlignment = "level",
  runtimeColors?: Readonly<ExportThemeColors>,
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  resourceBadgePresentation: ResourceBadgePresentation = fallbackResourceBadgePresentation,
  resolveImage?: ExportImageResolver
): Promise<void> {
  const imageAssets = await resolveExportImageAssets(document, nodeId, resolveImage);
  const svg = renderBranchSvg(
    document,
    nodeId,
    nodeWrapWidth,
    layoutMode,
    connectionStyle,
    theme,
    nodeShape,
    nodeAlignment,
    runtimeColors,
    textMeasurer,
    resourceBadgePresentation,
    imageAssets
  );
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await loadImage(url);
    const canvas = documentCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable.");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encoding failed.")), "image/png"));
    downloadBlob(blob, `${safeFileName(document.nodes[nodeId]?.title || document.title)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Build a safe standalone data URL and intrinsic dimensions for SVG/PNG export. */
export async function prepareImageExportSource(
  bytes: ArrayBuffer,
  path: string
): Promise<ExportImageSource | undefined> {
  if (bytes.byteLength > MAX_IMAGE_PREVIEW_BYTES) return undefined;
  const mimeType = imageMimeType(path);
  if (!mimeType) return undefined;
  const blob = new Blob([bytes], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (!naturalWidth || !naturalHeight || naturalWidth * naturalHeight > MAX_IMAGE_PREVIEW_PIXELS) return undefined;
    // Standalone SVG must never contain an active nested SVG payload. Rasterize
    // that one format; ordinary raster files can retain their compact encoding.
    const dataUrl = mimeType === "image/svg+xml"
      ? rasterizeImage(image, naturalWidth, naturalHeight)
      : arrayBufferDataUrl(bytes, mimeType);
    return { dataUrl, naturalWidth, naturalHeight };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function resolveExportImageAssets(
  document: MindTreeDocument,
  nodeId: NodeId,
  resolver?: ExportImageResolver
): Promise<ReadonlyMap<NodeId, ExportImageAsset>> {
  const assets = new Map<NodeId, ExportImageAsset>();
  if (!resolver) return assets;
  for (const candidateId of collectBranchIds(document, nodeId)) {
    const node = document.nodes[candidateId];
    if (node?.resource?.type !== "file" || node.resource.fileKind !== "image") continue;
    try {
      const source = await resolver(node);
      if (!source) continue;
      const size = persistedImageSize(node)
        ?? fitImageToDefault(source.naturalWidth, source.naturalHeight);
      assets.set(candidateId, { ...source, ...size });
    } catch {
      // One unreadable image falls back to the ordinary attachment node while
      // the rest of the requested branch still exports successfully.
    }
  }
  return assets;
}

function exportImagePresentation(
  assets: ReadonlyMap<NodeId, ExportImageAsset>
): ImageNodePresentation {
  return {
    resolve(node): ImageNodeVisual | undefined {
      const asset = assets.get(node.id);
      return asset ? {
        width: asset.width,
        height: asset.height,
        naturalWidth: asset.naturalWidth,
        naturalHeight: asset.naturalHeight,
        source: asset.dataUrl,
        loading: false
      } : undefined;
    }
  };
}

function renderResourceBadgeSvg(
  badge: Readonly<ResourceBadge>,
  size: Readonly<ResourceBadgeSize>,
  x: number,
  centerY: number,
  extensionFill: string,
  extensionText: string
): string {
  const y = centerY - size.height / 2;
  // Text tags reuse the quiet file-badge treatment: `styles.css` gives
  // `.mtn-node-marker.is-tag` the same hover surface and muted text as an
  // extension badge, only with its own class name inside the standalone SVG.
  const appearance = badge.kind === "mind-tree"
    ? { className: "mtn-mind-tree-marker", fill: "#dff4e7", stroke: "#a8d5b8", text: "#2f6b49" }
    : badge.kind === "excalidraw"
      ? { className: "mtn-excalidraw-marker", fill: "#7d4fbe", stroke: "none", text: "#ffffff" }
      : badge.kind === "tag"
        ? { className: "mtn-tag-marker", fill: extensionFill, stroke: "none", text: extensionText }
        : { className: "mtn-extension-marker", fill: extensionFill, stroke: "none", text: extensionText };
  return `<g class="${appearance.className}"><rect x="${x}" y="${y}" width="${size.width}" height="${size.height}" rx="5" fill="${appearance.fill}" stroke="${appearance.stroke}"/><text x="${x + size.width / 2}" y="${centerY}" dominant-baseline="middle" text-anchor="middle" font-family="${escapeXml(size.fontFamily ?? "system-ui,sans-serif")}" font-size="${size.fontSize ?? 10}" font-weight="${escapeXml(size.fontWeight ?? "600")}" fill="${appearance.text}">${escapeXml(badge.label)}</text></g>`;
}

export function downloadMarkdown(markdown: string, title: string): void {
  downloadBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), `${safeFileName(title)}.md`);
}

function offsetNode(node: PositionedNode): PositionedNode {
  return { ...node, x: node.x + PADDING, y: node.y + PADDING };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to render the exported SVG."));
    image.src = source;
  });
}

function documentCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.min(16_384, Math.max(1, Math.ceil(width)));
  canvas.height = Math.min(16_384, Math.max(1, Math.ceil(height)));
  return canvas;
}

function rasterizeImage(image: HTMLImageElement, width: number, height: number): string {
  const scale = Math.min(1, 16_384 / width, 16_384 / height);
  const canvas = documentCanvas(width * scale, height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function arrayBufferDataUrl(bytes: ArrayBuffer, mimeType: string): string {
  const input = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    binary += String.fromCharCode(...input.subarray(offset, Math.min(input.length, offset + chunkSize)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function imageMimeType(path: string): string | undefined {
  const extension = /\.([^.]+)$/u.exec(path)?.[1]?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  if (["png", "gif", "webp", "avif", "bmp"].includes(extension ?? "")) return `image/${extension}`;
  return undefined;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[character] ?? character);
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "mind-tree";
}

function safeSvgColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)$/i.test(color)) return color;
  if (/^[a-z]{3,20}$/i.test(color)) return color;
  return fallback;
}

function readableSvgTextColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#1f2937" : "#ffffff";
}

/** Mix an accent into a surface using the same ratio as CSS color-mix. */
function mixHexColors(foreground: string, background: string, foregroundRatio: number): string {
  const parse = (value: string): [number, number, number] => [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ];
  const foregroundRgb = parse(foreground);
  const backgroundRgb = parse(background);
  const mixed = foregroundRgb.map((channel, index) =>
    Math.round(channel * foregroundRatio + backgroundRgb[index]! * (1 - foregroundRatio)));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
