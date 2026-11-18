import type { BacklinkTarget } from "../../domain/backlink";

/** Circles shown before the `+N` overflow marker takes over. */
export const MAX_BACKLINK_DOTS = 5;
/** Note rows shown in the expanded list; the index itself keeps every entry. */
export const MAX_BACKLINK_PILLS = 20;

export interface BacklinkRenderModel {
  /** One circle per reference, capped at `MAX_BACKLINK_DOTS`. */
  readonly dots: number;
  /** References that only the `+N` marker represents. */
  readonly overflow: number;
  /** Note rows to render, already in the index's path-then-line order. */
  readonly pills: readonly BacklinkTarget[];
  /** Total reference count; the expanded list may show fewer rows. */
  readonly total: number;
}

/**
 * Pure projection of one node's backlinks into the collapsed indicator and the
 * expanded list. Rendering layers only draw this model, so the caps can be
 * tested without a DOM.
 */
export function createBacklinkRenderModel(
  entries: readonly BacklinkTarget[] | undefined
): BacklinkRenderModel | undefined {
  if (!entries || entries.length === 0) return undefined;
  const dots = Math.min(entries.length, MAX_BACKLINK_DOTS);
  return {
    dots,
    overflow: entries.length - dots,
    pills: entries.slice(0, MAX_BACKLINK_PILLS),
    total: entries.length
  };
}
