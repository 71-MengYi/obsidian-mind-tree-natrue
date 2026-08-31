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

export type NodeMenuItemId =
  | "title-sync" | "add-note" | "add-note-template" | "link-note" | "link-web"
  | "open-resource" | "unlink-resource" | "markers" | "add-child" | "add-sibling"
  | "toggle-collapse" | "expand-all" | "collapse-all" | "delete-branch" | "delete-node-only"
  | "move-notes" | "copy-branch" | "copy-markdown" | "export-png";

export interface NodeMenuContractState {
  readonly hasFileResource: boolean;
  readonly hasResource: boolean;
  readonly isRoot: boolean;
  readonly hasChildren: boolean;
}

/** Pure menu description used by tests and the visual menu composer. */
export function nodeMenuItemOrder(state: NodeMenuContractState): NodeMenuItemId[] {
  const items: NodeMenuItemId[] = [];
  if (state.hasFileResource) items.push("title-sync");
  else if (!state.hasResource) items.push("add-note", "add-note-template", "link-note");
  items.push("link-web");
  if (state.hasResource) items.push("open-resource", "unlink-resource");
  items.push("markers", "add-child");
  if (!state.isRoot) items.push("add-sibling");
  if (state.hasChildren) items.push("toggle-collapse", "expand-all", "collapse-all");
  if (!state.isRoot) items.push("delete-branch", "delete-node-only");
  items.push("move-notes", "copy-branch", "copy-markdown", "export-png");
  return items;
}
