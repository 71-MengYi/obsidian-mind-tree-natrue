import type { NodeId } from "../types";

/**
 * One note location that points at a node. `line` is 1-based and points at the
 * reference payload inside its fenced block, so opening the note can place the
 * caret on the reference itself.
 */
export interface BacklinkTarget {
  readonly path: string;
  readonly line: number;
}

/**
 * Note locations grouped by the mind-tree node they point at. A node without
 * entries is simply absent; the renderer therefore needs no empty arrays.
 */
export type BacklinkEntries = ReadonlyMap<NodeId, readonly BacklinkTarget[]>;
