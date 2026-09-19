import type {
  MindTreeNode,
  NodeHighlightColor,
  NodeMarker,
  NodePriority,
  NodeProgress
} from "../types";

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

/** Map only the official Excalidraw Frontmatter values to the persisted cache. */
export function classifyFileSubtype(frontmatter: unknown): "excalidraw" | undefined {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return undefined;
  const value = (frontmatter as Record<string, unknown>)["excalidraw-plugin"];
  return value === "raw" || value === "parsed" ? "excalidraw" : undefined;
}

const CATEGORY_ORDER: readonly NodeMarkerCategory[] = ["progress", "priority", "highlight"];

export function getNodeMarker<T extends NodeMarkerCategory>(
  node: MindTreeNode,
  type: T
): Extract<NodeMarker, { type: T }> | undefined {
  return node.markers?.find((marker): marker is Extract<NodeMarker, { type: T }> => marker.type === type);
}

/** Replace only one category so progress, priority, and highlight can coexist. */
export function setNodeMarker(node: MindTreeNode, marker: NodeMarker): void {
  const byType = new Map<NodeMarkerCategory, NodeMarker>();
  for (const existing of node.markers ?? []) byType.set(existing.type, existing);
  byType.set(marker.type, marker);
  node.markers = CATEGORY_ORDER.flatMap((type) => {
    const value = byType.get(type);
    return value ? [value] : [];
  });
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

/** Highlight changes the node surface and therefore reserves no trailing icon. */
export function getVisibleNodeMarkers(node: MindTreeNode): VisibleNodeMarker[] {
  return (node.markers ?? []).filter((marker): marker is VisibleNodeMarker => marker.type !== "highlight");
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

/** Strictly normalize compressed JSON; malformed or duplicate categories are ignored. */
export function normalizeNodeMarkers(value: unknown): NodeMarker[] {
  if (!Array.isArray(value)) return [];
  const byType = new Map<NodeMarkerCategory, NodeMarker>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const type = record["type"];
    const markerValue = record["value"];
    if (type === "progress" && typeof markerValue === "string" && NODE_PROGRESS_VALUES.includes(markerValue as NodeProgress)) {
      byType.set(type, { type, value: markerValue as NodeProgress });
    } else if (type === "priority" && typeof markerValue === "string" && NODE_PRIORITY_VALUES.includes(markerValue as NodePriority)) {
      byType.set(type, { type, value: markerValue as NodePriority });
    } else if (type === "highlight" && typeof markerValue === "string") {
      const canonical = NODE_HIGHLIGHT_COLORS.find((color) => color.toLowerCase() === markerValue.toLowerCase());
      if (canonical) byType.set(type, { type, value: canonical });
    }
  }
  return CATEGORY_ORDER.flatMap((type) => {
    const marker = byType.get(type);
    return marker ? [marker] : [];
  });
}
