/** Stable semantic order used by the command-style top toolbar renderer. */
export const TOP_TOOLBAR_ORDER = [
  "expand-all", "collapse-all", "collapse-level", "markers",
  "fit", "zoom-out", "zoom", "zoom-in", "search",
  "copy", "import", "export"
] as const;

/** Semantic rows shown by the keyboard help menu. */
export const KEYBOARD_HELP_ACTIONS = [
  "add-sibling-below", "add-sibling-above", "add-child", "add-parent",
  "move-up", "move-down", "create-note", "save", "navigate-siblings",
  "navigate-hierarchy", "edit", "delete", "select-all", "copy", "cut",
  "paste", "undo", "redo", "cancel"
] as const;

export type NodeResourceMenuItemId =
  | "title-sync" | "add-note" | "add-file-template" | "link-file" | "link-web"
  | "open-resource" | "open-default-app" | "unlink-resource";

export type NodeMenuItemId = NodeResourceMenuItemId
  | "markers" | "add-child" | "add-sibling"
  | "toggle-collapse" | "expand-all" | "collapse-all" | "delete-branch" | "delete-node-only"
  | "move-files" | "copy-branch" | "copy-markdown" | "export-png";

export interface NodeMenuContractState {
  readonly hasFileResource: boolean;
  readonly hasResource: boolean;
  readonly isDesktopApp: boolean;
  readonly isRoot: boolean;
  readonly hasChildren: boolean;
}

/** One resource section description for both the real menu and contract tests. */
export function nodeResourceMenuItemOrder(state: Pick<NodeMenuContractState, "hasFileResource" | "hasResource" | "isDesktopApp">): NodeResourceMenuItemId[] {
  const items: NodeResourceMenuItemId[] = [];
  if (state.hasFileResource) items.push("title-sync");
  if (!state.hasResource) items.push("add-note", "add-file-template", "link-file", "link-web");
  if (state.hasResource) {
    items.push("open-resource");
    if (state.isDesktopApp) items.push("open-default-app");
    items.push("unlink-resource");
  }
  return items;
}

/** Stale menus cannot act on a new document or a replaced node association. */
export function guardNodeMenuAction(isCurrent: () => boolean, action: () => void): () => void {
  return () => { if (isCurrent()) action(); };
}

/** Pure menu description used by tests and the visual menu composer. */
export function nodeMenuItemOrder(state: NodeMenuContractState): NodeMenuItemId[] {
  const items: NodeMenuItemId[] = [...nodeResourceMenuItemOrder(state)];
  items.push("markers", "add-child");
  if (!state.isRoot) items.push("add-sibling");
  if (state.hasChildren) items.push("toggle-collapse", "expand-all", "collapse-all");
  if (!state.isRoot) items.push("delete-branch", "delete-node-only");
  items.push("move-files", "copy-branch", "copy-markdown", "export-png");
  return items;
}
