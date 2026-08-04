import type { ViewState } from "obsidian";

export const MIND_TREE_VIEW_TYPE = "mind-tree-nature-view";
export const MIND_TREE_FILE_SUFFIX = ".mtn.md";

export function isMindTreePath(path: string): boolean {
  return path.endsWith(MIND_TREE_FILE_SUFFIX);
}

export function routeMindTreeViewState(viewState: ViewState): ViewState {
  const filePath = viewState.state?.["file"];
  if (viewState.type !== "markdown" || typeof filePath !== "string" || !isMindTreePath(filePath)) {
    return viewState;
  }
  return { ...viewState, type: MIND_TREE_VIEW_TYPE };
}
