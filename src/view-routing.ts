import type { ViewState } from "obsidian";
import { isMindTreePath } from "./format/resource-id";

export const MIND_TREE_VIEW_TYPE = "mind-tree-nature-view";

/** Re-exported so existing `view-routing` importers keep working. */
export { isMindTreePath };

export function routeMindTreeViewState(viewState: ViewState): ViewState {
  const filePath = viewState.state?.["file"];
  if (viewState.type !== "markdown" || typeof filePath !== "string" || !isMindTreePath(filePath)) {
    return viewState;
  }
  return { ...viewState, type: MIND_TREE_VIEW_TYPE };
}
