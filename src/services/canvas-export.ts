import type {
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNodeAlignment,
  NodeId
} from "../types";
import { DEFAULT_NODE_WRAP_WIDTH, layoutTree } from "../render/layout";
import { computeNodeNumbering, numberedNodeTitle } from "../domain/node-numbering";
import {
  fallbackResourceBadgePresentation,
  type ResourceBadgePresentation
} from "../render/resource-badges";
import { fallbackNodeTextMeasurer, type NodeTextMeasurer } from "../render/text-measurer";

/**
 * Room kept between the layout's bounding box and the canvas origin. Obsidian
 * Canvas has no page padding of its own, so the exported file reserves it here.
 */
export const CANVAS_EXPORT_MARGIN = 48;

/** Upper bound for the numbered name-collision sequence, mirroring tree creation. */
export const MAX_CANVAS_PATH_CANDIDATES = 1000;

/** Attachment side of a JSON Canvas edge. */
export type CanvasEdgeSide = "top" | "right" | "bottom" | "left";

/** One JSON Canvas `text` node; the only node type this export renders. */
export interface CanvasTextNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One parent → child relation between two exported text nodes. */
export interface CanvasFileEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide: CanvasEdgeSide;
  toSide: CanvasEdgeSide;
}

/**
 * A JSON Canvas 1.0 document. It is plain JSON data (no Obsidian API objects),
 * so `JSON.stringify` writes a file Obsidian can open as a canvas.
 */
export interface CanvasFile {
  nodes: CanvasTextNode[];
  edges: CanvasFileEdge[];
}

/** Candidate paths in creation order: `<name>.canvas`, `<name>-2.canvas`, … */
export function createCanvasPathCandidates(
  directory: string,
  name: string,
  limit: number = MAX_CANVAS_PATH_CANDIDATES
): string[] {
  const cleanDirectory = directory
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  const prefix = cleanDirectory ? `${cleanDirectory}/` : "";
  const attempts = Math.max(1, Math.min(Math.floor(limit), MAX_CANVAS_PATH_CANDIDATES));
  const candidates: string[] = [];
  for (let counter = 1; counter <= attempts; counter += 1) {
    candidates.push(`${prefix}${counter === 1 ? name : `${name}-${counter}`}.canvas`);
  }
  return candidates;
}

/**
 * Convert one branch (or the whole tree when started from the root) into a
 * JSON Canvas document. Geometry comes from the same `layoutTree` call the
 * PNG/SVG exporter uses, so the canvas keeps the arrangement users see: the
 * exported node rectangle is exactly the laid-out rectangle plus the fixed
 * margin, and `text` is the node title (never an image or a vault path).
 *
 * `fallbackTitle` is supplied by the caller because interface text must stay in
 * the i18n catalog; this module stays free of Obsidian and translation imports
 * so it can be unit-tested as pure data.
 */
export function buildCanvasFile(
  document: MindTreeDocument,
  nodeId: NodeId,
  fallbackTitle: string,
  nodeWrapWidth = DEFAULT_NODE_WRAP_WIDTH,
  layoutMode: MindTreeLayoutMode = "right",
  nodeAlignment: MindTreeNodeAlignment = "level",
  textMeasurer: NodeTextMeasurer = fallbackNodeTextMeasurer,
  resourceBadges: ResourceBadgePresentation = fallbackResourceBadgePresentation
): CanvasFile {
  if (!document.nodes[nodeId]) return { nodes: [], edges: [] };
  // Exporting expands collapsed branches on purpose: the file must contain every
  // node, not only the ones the current view happens to reveal.
  const layout = layoutTree(
    document,
    nodeId,
    false,
    nodeWrapWidth,
    layoutMode,
    nodeAlignment,
    textMeasurer,
    resourceBadges
  );
  const usedIds = new Set<string>();
  const canvasIdByNodeId = new Map<NodeId, string>();
  const numberingLabels = computeNodeNumbering(document);
  const nodes = layout.nodes.map((position): CanvasTextNode => {
    const id = uniqueId(`n-${position.id}`, usedIds);
    if (!canvasIdByNodeId.has(position.id)) canvasIdByNodeId.set(position.id, id);
    return {
      id,
      type: "text",
      // An untitled node must still be visible and selectable in the canvas, so
      // the caller's localized placeholder replaces the empty string.
      text: document.nodes[position.id]
        ? (numberedNodeTitle(document.nodes[position.id]!, numberingLabels) || fallbackTitle)
        : fallbackTitle,
      x: position.x + CANVAS_EXPORT_MARGIN,
      y: position.y + CANVAS_EXPORT_MARGIN,
      width: position.width,
      height: position.height
    };
  });
  const [fromSide, toSide] = canvasEdgeSides(layoutMode);
  const seenConnections = new Set<string>();
  const edges: CanvasFileEdge[] = [];
  for (const connection of layout.connections) {
    const fromNode = canvasIdByNodeId.get(connection.from);
    const toNode = canvasIdByNodeId.get(connection.to);
    if (!fromNode || !toNode) continue;
    // A hand-edited document may repeat a child id; one relation is one edge.
    const relation = `${fromNode}\u0000${toNode}`;
    if (seenConnections.has(relation)) continue;
    seenConnections.add(relation);
    edges.push({ id: uniqueId(`e-${fromNode}-${toNode}`, usedIds), fromNode, toNode, fromSide, toSide });
  }
  return { nodes, edges };
}

/**
 * Edges leave the parent on the side its branch grows toward. The top-down
 * `tree` layout and `radial` keep the horizontal pair as well: side hints only
 * decide where Obsidian attaches the line, and one stable pair per layout keeps
 * the file identical across exports.
 */
function canvasEdgeSides(layoutMode: MindTreeLayoutMode): readonly [CanvasEdgeSide, CanvasEdgeSide] {
  return layoutMode === "left" ? ["left", "right"] : ["right", "left"];
}

/**
 * Obsidian rejects a canvas whose node or edge ids repeat. Derived ids are
 * stable for the same tree; the counter only matters after a hand-edited
 * document produced a duplicate node id or an ambiguous `e-<from>-<to>`.
 */
function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}
