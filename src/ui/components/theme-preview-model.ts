import { DEFAULT_DOCUMENT_SETTINGS } from "../../document-settings";
import type { MindTreeDocument, MindTreeNode, MindTreeTheme, NodeId } from "../../types";

/** Localized sample titles keep one preview readable in both interface languages. */
export interface ThemePreviewTitles {
  readonly root: string;
  readonly branchA: string;
  readonly branchB: string;
  readonly leaf: string;
}

export interface ThemePreviewRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Distance between the hovered anchor and the preview panel. */
export const THEME_PREVIEW_GAP = 8;
/** Minimum free space kept between the panel and the viewport edges. */
export const THEME_PREVIEW_MARGIN = 8;

/**
 * Fixed timestamps and stable node ids make repeated calls deeply equal. A
 * hover preview is rebuilt on every theme change, so it must never look like a
 * document edit or depend on the current clock.
 */
export const THEME_PREVIEW_TIMESTAMP = "2000-01-01T00:00:00.000Z";

const PREVIEW_ROOT_ID = "mtn-theme-preview-root";
const PREVIEW_BRANCH_A_ID = "mtn-theme-preview-branch-a";
const PREVIEW_LEAF_ID = "mtn-theme-preview-leaf";
const PREVIEW_BRANCH_B_ID = "mtn-theme-preview-branch-b";

/**
 * One representative sample tree: a root, two first-level branches and one
 * child under the first branch. Four nodes are enough to show the root accent,
 * two different branch colors, a connection and a descendant without making the
 * small hover panel unreadable. Sample titles stay short because the panel fits
 * the whole layout (roughly 0.8x for the localized titles), and longer titles
 * would shrink the rendered text below a readable size.
 */
export function themePreviewDocument(theme: MindTreeTheme, titles: ThemePreviewTitles): MindTreeDocument {
  const node = (id: NodeId, title: string, childIds: readonly NodeId[]): MindTreeNode => ({
    id,
    title,
    childIds: [...childIds],
    createdAt: THEME_PREVIEW_TIMESTAMP,
    updatedAt: THEME_PREVIEW_TIMESTAMP
  });
  const nodes: Record<NodeId, MindTreeNode> = {
    [PREVIEW_ROOT_ID]: node(PREVIEW_ROOT_ID, titles.root, [PREVIEW_BRANCH_A_ID, PREVIEW_BRANCH_B_ID]),
    [PREVIEW_BRANCH_A_ID]: node(PREVIEW_BRANCH_A_ID, titles.branchA, [PREVIEW_LEAF_ID]),
    [PREVIEW_LEAF_ID]: node(PREVIEW_LEAF_ID, titles.leaf, []),
    [PREVIEW_BRANCH_B_ID]: node(PREVIEW_BRANCH_B_ID, titles.branchB, [])
  };
  return {
    // Only the theme varies; every other option stays on the code defaults.
    // A horizontal layout keeps the sample readable inside a small panel.
    settings: { ...DEFAULT_DOCUMENT_SETTINGS, theme, layoutMode: "right" },
    title: titles.root,
    rootId: PREVIEW_ROOT_ID,
    nodes,
    createdAt: THEME_PREVIEW_TIMESTAMP,
    updatedAt: THEME_PREVIEW_TIMESTAMP
  };
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

/**
 * Place the preview beside its anchor without ever covering it: prefer the
 * right side, flip to the left when the panel does not fit there, and finally
 * clamp both axes into the viewport margin. Coordinates are viewport-relative,
 * matching `getBoundingClientRect` and a `position: fixed` panel.
 */
export function placeThemePreview(anchor: ThemePreviewRect, size: { width: number; height: number },
  viewport: ThemePreviewRect, gap = THEME_PREVIEW_GAP): { left: number; top: number; side: "left" | "right" } {
  const bounds = {
    left: viewport.left + THEME_PREVIEW_MARGIN,
    top: viewport.top + THEME_PREVIEW_MARGIN,
    right: viewport.right - THEME_PREVIEW_MARGIN,
    bottom: viewport.bottom - THEME_PREVIEW_MARGIN
  };
  // A panel larger than the free area shrinks to it instead of overflowing.
  const width = Math.max(0, Math.min(size.width, bounds.right - bounds.left));
  const height = Math.max(0, Math.min(size.height, bounds.bottom - bounds.top));
  const side: "left" | "right" = anchor.right + gap + width <= bounds.right ? "right" : "left";
  const left = side === "right" ? anchor.right + gap : anchor.left - gap - width;
  const top = (anchor.top + anchor.bottom - height) / 2;
  return {
    left: clamp(left, bounds.left, Math.max(bounds.left, bounds.right - width)),
    top: clamp(top, bounds.top, Math.max(bounds.top, bounds.bottom - height)),
    side
  };
}
