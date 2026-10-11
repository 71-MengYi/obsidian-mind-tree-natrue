import type { TranslationKey } from "../i18n";
import type {
  MindTreeCollectionMode,
  MindTreeConnectionStyle,
  MindTreeDocument,
  MindTreeLayoutMode,
  MindTreeNodeShape,
  MindTreeTheme,
  NodeId
} from "../types";

/** Match the twelve-accent palettes supplied by the Light Mindmap themes. */
export const BRANCH_COLOR_COUNT = 12;

/**
 * Assign the twelve palette slots in current first-level document order. The
 * first twelve branches are therefore visually distinct; later branches cycle
 * through the palette. Every descendant inherits its first-level slot.
 */
export function getBranchColorSlots(
  document: MindTreeDocument,
  rootId = document.rootId
): Map<NodeId, number> {
  const result = new Map<NodeId, number>([[rootId, 0]]);
  const root = document.nodes[rootId];
  if (!root) return result;
  const visit = (nodeId: NodeId, slot: number): void => {
    if (result.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) return;
    result.set(nodeId, slot);
    for (const childId of node.childIds) visit(childId, slot);
  };
  root.childIds.forEach((childId, index) => visit(childId, index % BRANCH_COLOR_COUNT + 1));
  return result;
}

/** Convert a stable slot to the CSS variable supplied by the active theme. */
export function branchColorCss(slot: number | undefined): string {
  return slot && slot > 0
    ? `var(--mtn-branch-${Math.min(BRANCH_COLOR_COUNT, slot)})`
    : "var(--mtn-theme-root-accent)";
}

/**
 * Shared option catalogs keep the relevant settings and command surfaces in a
 * stable order and prevent a surface from silently omitting a new style.
 */
export const LAYOUT_OPTIONS: ReadonlyArray<{ value: MindTreeLayoutMode; label: TranslationKey; command: TranslationKey }> = [
  { value: "balanced", label: "layout.balanced", command: "command.layout.balanced" },
  { value: "right", label: "layout.right", command: "command.layout.right" },
  { value: "left", label: "layout.left", command: "command.layout.left" },
  { value: "tree", label: "layout.tree", command: "command.layout.tree" },
  { value: "radial", label: "layout.radial", command: "command.layout.radial" }
];

/** Shared order and labels for global defaults and the current-tree menu. */
export const COLLECTION_MODE_OPTIONS: ReadonlyArray<{ value: MindTreeCollectionMode; label: TranslationKey }> = [
  { value: "off", label: "settings.scan.off" },
  { value: "ask", label: "settings.scan.ask" },
  { value: "root", label: "settings.scan.root" },
  { value: "collect", label: "settings.scan.collect" }
];

export const THEME_OPTIONS: ReadonlyArray<{ value: MindTreeTheme; label: TranslationKey }> = [
  { value: "vibrant", label: "theme.vibrant" },
  { value: "classic", label: "theme.classic" },
  { value: "fresh", label: "theme.fresh" },
  { value: "ocean", label: "theme.ocean" },
  { value: "sunset", label: "theme.sunset" },
  { value: "midnight", label: "theme.midnight" },
  { value: "slate", label: "theme.slate" },
  { value: "flat", label: "theme.flat" },
  { value: "minimal", label: "theme.minimal" },
  { value: "floating", label: "theme.floating" }
];

export const CONNECTION_OPTIONS: ReadonlyArray<{ value: MindTreeConnectionStyle; label: TranslationKey }> = [
  { value: "theme", label: "connection.theme" },
  { value: "smooth", label: "connection.smooth" },
  { value: "smooth-dashed", label: "connection.smoothDashed" },
  { value: "straight", label: "connection.straight" },
  { value: "orthogonal", label: "connection.orthogonal" },
  { value: "orthogonal-dashed", label: "connection.orthogonalDashed" }
];

export const NODE_SHAPE_OPTIONS: ReadonlyArray<{ value: MindTreeNodeShape; label: TranslationKey }> = [
  { value: "rounded", label: "shape.rounded" },
  { value: "square", label: "shape.square" },
  { value: "borderless", label: "shape.borderless" }
];
