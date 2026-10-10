import type {
  MindTreeNode,
  NodeHighlightColor,
  NodeMarker,
  NodePriority,
  NodeProgress
} from "../types";
import { cleanCustomMarkerValue } from "./custom-markers";

export const NODE_PROGRESS_VALUES = ["todo", "inprogress", "done", "cancelled"] as const satisfies readonly NodeProgress[];
export const NODE_PRIORITY_VALUES = ["red", "yellow", "blue"] as const satisfies readonly NodePriority[];
export const NODE_HIGHLIGHT_COLORS = [
  "#75ACA6",
  "#85A695",
  "#C39E96",
  "#F37B6A",
  "#6B565D",
  "#403721",
  "#BF4830",
  "#BF6730",
  "#99723C",
  "#E0CA9D"
] as const satisfies readonly NodeHighlightColor[];

export type NodeMarkerCategory = NodeMarker["type"];
export type VisibleNodeMarker = Exclude<NodeMarker, { type: "highlight" }>;
export type CustomNodeMarkerCategory = Extract<NodeMarkerCategory, "emoji" | "tag">;

/**
 * Fixed palette order. User-managed custom markers come last, whether or not
 * they currently exist in settings, so enabling one can never reorder a
 * built-in marker category in the payload or in the Markdown outline.
 */
const CATEGORY_ORDER: readonly NodeMarkerCategory[] = ["progress", "priority", "highlight", "emoji", "tag"];
const CATEGORY_ORDER_INDEX = new Map<NodeMarkerCategory, number>(
  CATEGORY_ORDER.map((type, index) => [type, index])
);

/** Longest accepted custom value; mirrors the domain marker registration cap. */
export const MAX_CUSTOM_NODE_MARKER_VALUE_LENGTH = 32;

export function isCustomMarkerCategory(type: NodeMarkerCategory): type is CustomNodeMarkerCategory {
  return type === "emoji" || type === "tag";
}

/** Map only the official Excalidraw Frontmatter values to the persisted cache. */
export function classifyFileSubtype(frontmatter: unknown): "excalidraw" | undefined {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return undefined;
  const value = (frontmatter as Record<string, unknown>)["excalidraw-plugin"];
  return value === "raw" || value === "parsed" ? "excalidraw" : undefined;
}

export function getNodeMarker<T extends NodeMarkerCategory>(
  node: MindTreeNode,
  type: T
): Extract<NodeMarker, { type: T }> | undefined {
  return node.markers?.find((marker): marker is Extract<NodeMarker, { type: T }> => marker.type === type);
}

/**
 * Replace only one category so progress, priority, highlight and the two custom
 * groups can coexist. Known categories keep the fixed palette order and the
 * first unknown category keeps its relative position, so an unrelated edit can
 * never silently reshuffle the other badges or the Markdown outline.
 */
export function setNodeMarker(node: MindTreeNode, marker: NodeMarker): void {
  const markers = node.markers ?? [];
  const index = markers.findIndex((existing) => existing.type === marker.type);
  const next = index < 0
    ? [...markers, marker]
    : markers.map((existing, position) => position === index ? marker : existing);
  node.markers = [...next].sort((left, right) =>
    (CATEGORY_ORDER_INDEX.get(left.type) ?? CATEGORY_ORDER.length)
    - (CATEGORY_ORDER_INDEX.get(right.type) ?? CATEGORY_ORDER.length));
}

/** Remove one category without disturbing markers belonging to other categories. */
export function removeNodeMarker(node: MindTreeNode, type: NodeMarkerCategory): void {
  const remaining = (node.markers ?? []).filter((marker) => marker.type !== type);
  if (remaining.length > 0) node.markers = remaining;
  else delete node.markers;
}

export function getNodeHighlightColor(node: MindTreeNode): NodeHighlightColor | undefined {
  return getNodeMarker(node, "highlight")?.value;
}

/**
 * Highlight changes the node surface and therefore reserves no trailing icon.
 * Custom emoji and text tags are included: Settings decides whether their value
 * still exists, so only the presentation layer can drop them.
 */
export function getVisibleNodeMarkers(node: MindTreeNode): VisibleNodeMarker[] {
  return (node.markers ?? []).filter((marker): marker is VisibleNodeMarker => marker.type !== "highlight");
}

/** Built-in icon markers only; the fixed 18px palette entries. */
export function getIconNodeMarkers(node: MindTreeNode): Exclude<VisibleNodeMarker, { type: "emoji" | "tag" }>[] {
  return getVisibleNodeMarkers(node).filter(
    (marker): marker is Exclude<VisibleNodeMarker, { type: "emoji" | "tag" }> =>
      !isCustomMarkerCategory(marker.type)
  );
}

/** The badge is derived from the linked path and is never duplicated in JSON. */
export function hasMindTreeResourceMarker(node: MindTreeNode): boolean {
  return node.resource?.type === "file" && /\.mtn\.md$/i.test(node.resource.pathHint.replace(/\\/g, "/"));
}

/** Excalidraw identity is cached from the linked Markdown file's Frontmatter. */
export function hasExcalidrawResourceMarker(node: MindTreeNode): boolean {
  return node.resource?.type === "file"
    && node.resource.fileSubtype === "excalidraw";
}

/** Stable, language-neutral suffixes make every category readable in the outline. */
export function renderNodeMarkerSuffix(node: MindTreeNode): string {
  const suffixes = (node.markers ?? []).map((marker) => `〔${marker.type}:${marker.value}〕`);
  if (hasMindTreeResourceMarker(node)) suffixes.push("〔mind-tree〕");
  if (hasExcalidrawResourceMarker(node)) suffixes.push("〔excalidraw〕");
  return suffixes.join(" ");
}

/**
 * Strictly normalize compressed JSON; malformed or duplicate categories are
 * ignored. Custom values are bounded here but are *not* validated against the
 * live settings registry: the document keeps a flag the user can re-enable, and
 * rendering simply skips values that are currently undefined.
 */
export function normalizeNodeMarkers(value: unknown): NodeMarker[] {
  if (!Array.isArray(value)) return [];
  const accepted = new Map<NodeMarkerCategory, NodeMarker>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const type = record["type"];
    const markerValue = record["value"];
    if (typeof type !== "string" || !CATEGORY_ORDER_INDEX.has(type as NodeMarkerCategory)) continue;
    const category = type as NodeMarkerCategory;
    if (category === "highlight" && typeof markerValue === "string") {
      const canonical = NODE_HIGHLIGHT_COLORS.find((color) => color.toLowerCase() === markerValue.toLowerCase());
      if (canonical) accepted.set(category, { type: category, value: canonical });
      continue;
    }
    if (typeof markerValue !== "string") continue;
    if (category === "progress") {
      if (NODE_PROGRESS_VALUES.includes(markerValue as NodeProgress)) {
        accepted.set(category, { type: category, value: markerValue as NodeProgress });
      }
    } else if (category === "priority") {
      if (NODE_PRIORITY_VALUES.includes(markerValue as NodePriority)) {
        accepted.set(category, { type: category, value: markerValue as NodePriority });
      }
    } else if (category === "emoji" || category === "tag") {
      const cleaned = cleanCustomMarkerValue(markerValue);
      if (cleaned.length > 0 && Array.from(cleaned).length <= MAX_CUSTOM_NODE_MARKER_VALUE_LENGTH) {
        accepted.set(category, { type: category, value: cleaned });
      }
    }
  }
  // Sort by the fixed palette order only for the categories the document
  // actually uses, so an unknown addition can never reorder the stored array.
  const used = [...accepted.values()];
  const orderOf = (type: NodeMarkerCategory): number =>
    CATEGORY_ORDER_INDEX.get(type) ?? CATEGORY_ORDER.length;
  return used.sort((left, right) => orderOf(left.type) - orderOf(right.type));
}
