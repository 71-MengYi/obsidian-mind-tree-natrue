import type { MindTreeNode } from "../types";

/** Match the existing static resource button and the gap before each control. */
export const RESOURCE_CONTROL_SIZE = 20;
export const RESOURCE_CONTROL_GAP = 2;

export interface NodeResourceControls {
  readonly hasOpenButton: boolean;
  readonly titleSyncDisabled: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * Shared by the renderer and the node box model. Every linked resource can be
 * opened, but only a vault file has a filename whose title sync can be disabled.
 * In particular, a URL's titleSync: "off" must not reserve a second icon slot.
 */
export function getNodeResourceControls(node?: Readonly<MindTreeNode>): NodeResourceControls {
  const hasOpenButton = node?.resource !== undefined;
  const titleSyncDisabled = node?.resource?.type === "file" && node.titleSync !== "bidirectional";
  const count = hasOpenButton ? (titleSyncDisabled ? 2 : 1) : 0;
  return {
    hasOpenButton,
    titleSyncDisabled,
    width: count * (RESOURCE_CONTROL_SIZE + RESOURCE_CONTROL_GAP),
    height: hasOpenButton ? RESOURCE_CONTROL_SIZE : 0
  };
}
