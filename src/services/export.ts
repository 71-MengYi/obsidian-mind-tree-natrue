import type {
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  MindTreeNodeShape,
  MindTreeTheme,
  NodeId,
  PositionedNode
} from "../types";
import {
  EXCALIDRAW_MARKER_WIDTH,
  getNodeHighlightColor,
  getNodeMarkerDisplayWidth,
  getVisibleNodeMarkers,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker,
  MIND_TREE_MARKER_WIDTH
} from "../domain/markers";
import {
  connectionPath,
  DEFAULT_NODE_WRAP_WIDTH,
  getNodeFontSize,
  getNodeLineHeight,
  getNodeSizeClass,
  layoutTree,
  wrapNodeTitle
} from "../ui/layout";
import { getBranchColorSlots } from "../ui/presentation";
import { getThemePreset, resolveThemeConnection } from "../ui/theme-presets";

const PADDING = 36;

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

export function renderBranchSvg(
  document: MindTreeDocument,
  nodeId: NodeId,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  layoutMode: MindTreeLayoutMode = "right",
  connectionStyle: MindTreeConnectionStyle = "theme",
  theme: MindTreeTheme = "vibrant",
  nodeShape: MindTreeNodeShape = "rounded",
  nodeAlignment: MindTreeNodeAlignment = "level",
  runtimeColors?: Readonly<ExportThemeColors>
): string {
  // Export deliberately reuses the canvas layout rules, including dynamic width
  // and wrapping, so PNG output does not drift from what the user arranged.
  const layout = layoutTree(document, nodeId, false, nodeWrapWidth, layoutMode, nodeAlignment);
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
    const fontSize = getNodeFontSize(position.depth);
    const lineHeight = getNodeLineHeight(position.depth);
    // Use the same title-only track as the DOM renderer. Trailing markers and
    // file controls change the outer rectangle, never wrapping or shifting text.
    const textWidth = Math.max(1, shifted.contentWidth - 4);
    const lines = wrapNodeTitle(node.title || "未命名节点", position.depth, textWidth);
    const firstBaseline = shifted.y + (shifted.height - lines.length * lineHeight) / 2 + fontSize;
    // Every wrapped line starts at the title area's left edge, matching the
    // browser node instead of centering the complete multiline text block.
    const textX = shifted.x + 2;
    const tspans = lines.map((line, index) =>
      `<tspan x="${textX}" y="${firstBaseline + index * lineHeight}">${escapeXml(line)}</tspan>`).join("");
    const visibleMarkers = getVisibleNodeMarkers(node);
    const hasMindTreeMarker = hasMindTreeResourceMarker(node);
    const hasExcalidrawMarker = hasExcalidrawResourceMarker(node);
    const resourceControlWidth = node.resource?.type === "file"
      ? (node.titleSync === "bidirectional" ? 22 : 44)
      : 0;
    const markerAreaWidth = getNodeMarkerDisplayWidth(node);
    const markerStartX = shifted.x + shifted.contentWidth;
    const markerY = shifted.y + shifted.height / 2 + 5;
    const markerSvg = visibleMarkers.map((marker, index) => {
      const symbol = marker.type === "priority"
        ? "⚑"
        : marker.value === "todo" ? "○" : marker.value === "inprogress" ? "◐" : marker.value === "done" ? "✓" : "×";
      const color = marker.type === "priority"
        ? marker.value === "red" ? "#dc2626" : marker.value === "yellow" ? "#d6a700" : "#2563eb"
        : marker.value === "done" ? "#15803d" : marker.value === "cancelled" ? "#dc2626" : marker.value === "inprogress" ? "#2563eb" : palette.text;
      return `<text x="${markerStartX + index * 20}" y="${markerY}" font-family="system-ui,sans-serif" font-size="15" fill="${color}">${symbol}</text>`;
    }).join("");
    const resourceMarkerX = markerStartX + visibleMarkers.length * 20;
    const resourceMarkerSvg = hasMindTreeMarker
      ? `<g class="mtn-mind-tree-marker"><rect x="${resourceMarkerX}" y="${shifted.y + shifted.height / 2 - 9}" width="${MIND_TREE_MARKER_WIDTH}" height="18" rx="5" fill="#dff4e7" stroke="#a8d5b8"/><text x="${resourceMarkerX + MIND_TREE_MARKER_WIDTH / 2}" y="${shifted.y + shifted.height / 2 + 3.5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="#2f6b49">思维树</text></g>`
      : hasExcalidrawMarker
        ? `<g class="mtn-excalidraw-marker"><rect x="${resourceMarkerX}" y="${shifted.y + shifted.height / 2 - 9}" width="${EXCALIDRAW_MARKER_WIDTH}" height="18" rx="5" fill="#7d4fbe" stroke="none"/><text x="${resourceMarkerX + EXCALIDRAW_MARKER_WIDTH / 2}" y="${shifted.y + shifted.height / 2 + 3.5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="#ffffff">绘图</text></g>`
        : "";
    const leafWithoutBorder = nodeShape === "borderless" && node.childIds.length === 0;
    const radius = nodeShape === "square" ? 0 : 2;
    const textColor = highlight
      ? readableSvgTextColor(highlight)
      : position.depth === 0
        ? rootTextColor
        : tierPalette
          ? position.depth === 1 ? levelOneTextColor : descendantTextColor
          : position.depth === 1 ? "#ffffff" : palette.text;
    const nodeShadow = leafWithoutBorder
      ? "none"
      : position.depth === 0 ? tierPalette?.rootShadow : tierPalette?.shadow;
    const shadowStyle = nodeShadow && nodeShadow !== "none" ? ` style="filter:${nodeShadow}"` : "";
    return `<g class="${className}"${shadowStyle}><rect x="${shifted.x}" y="${shifted.y}" width="${shifted.width}" height="${shifted.height}" rx="${radius}" fill="${leafWithoutBorder && !highlight ? "none" : fill}" stroke="none"/><text text-anchor="start" font-family="system-ui,sans-serif" font-size="${fontSize}" font-weight="${position.depth === 0 ? 700 : position.depth === 1 ? 400 : 500}" fill="${textColor}">${tspans}</text>${markerSvg}${resourceMarkerSvg}</g>`;
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
  runtimeColors?: Readonly<ExportThemeColors>
): Promise<void> {
  const svg = renderBranchSvg(
    document,
    nodeId,
    nodeWrapWidth,
    layoutMode,
    connectionStyle,
    theme,
    nodeShape,
    nodeAlignment,
    runtimeColors
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
