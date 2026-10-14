/** Stable semantic order used by the command-style top toolbar renderer. */
export const TOP_TOOLBAR_ORDER = [
  "expand-all", "collapse-all", "collapse-level", "markers", "link-node",
  "fit", "zoom-out", "zoom", "zoom-in", "search",
  "copy", "import", "export"
] as const;

/** Semantic rows shown by the keyboard help menu. */
export const KEYBOARD_HELP_ACTIONS = [
  "add-sibling-below", "add-sibling-above", "add-child", "add-parent",
  "move-up", "move-down", "create-note", "save", "search", "navigate-siblings",
  "navigate-hierarchy", "edit", "delete", "select-all", "copy", "cut",
  "paste", "undo", "redo", "cancel"
] as const;

export type NodeResourceMenuItemId =
  | "title-sync" | "add-note" | "add-file-template" | "link-file" | "link-web"
  | "open-resource" | "open-default-app" | "unlink-resource";

/** Rows of the nested "copy as…" group shared by the node menu and the toolbar. */
export type CopyAsMenuItemId = "copy-as-reference" | "copy-as-outline" | "copy-as-mermaid";

/** Rows of the "export" group shared by the node menu and the toolbar. */
export type ExportMenuItemId = "export-png" | "export-markdown";

export type NodeMenuItemId = NodeResourceMenuItemId
  | "markers" | "node-link" | "add-child" | "add-sibling"
  | "toggle-collapse" | "expand-all" | "collapse-all" | "delete-branch" | "delete-node-only"
  | "move-files" | "copy-branch";

/** Parent rows whose commands live in a nested menu on both surfaces. */
export type NodeMenuGroupId = "copy-as" | "export";

export type NodeMenuEntryId = NodeMenuItemId | NodeMenuGroupId;

/** The one order both the node menu and the toolbar copy menu render. */
export const COPY_AS_MENU_ORDER: readonly CopyAsMenuItemId[] =
  ["copy-as-reference", "copy-as-outline", "copy-as-mermaid"];

/** The one order both the node menu and the toolbar export menu render. */
export const EXPORT_MENU_ORDER: readonly ExportMenuItemId[] = ["export-png", "export-markdown"];

export interface NodeMenuContractState {
  readonly hasFileResource: boolean;
  readonly hasResource: boolean;
  readonly isDesktopApp: boolean;
  readonly isRoot: boolean;
  readonly hasChildren: boolean;
  /** The node takes part in a node link on either side. */
  readonly nodeLinked: boolean;
}

/** One resource section description for both the real menu and contract tests. */
export function nodeResourceMenuItemOrder(
  state: Pick<NodeMenuContractState, "hasFileResource" | "hasResource" | "isDesktopApp"> & {
    /** A node link already counts as this node's association. */
    readonly nodeLinked?: boolean;
  }
): NodeResourceMenuItemId[] {
  const items: NodeResourceMenuItemId[] = [];
  if (state.hasFileResource) items.push("title-sync");
  // Creating or linking a resource is not offered once the node links another
  // node: the node link occupies that association slot.
  if (!state.hasResource && !state.nodeLinked) items.push("add-note", "add-file-template", "link-file", "link-web");
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
export function nodeMenuItemOrder(state: NodeMenuContractState): NodeMenuEntryId[] {
  const items: NodeMenuEntryId[] = [...nodeResourceMenuItemOrder(state)];
  // The node link sits directly under the marker entry in every menu surface.
  items.push("markers", "node-link", "add-child");
  if (!state.isRoot) items.push("add-sibling");
  if (state.hasChildren) items.push("toggle-collapse", "expand-all", "collapse-all");
  if (!state.isRoot) items.push("delete-branch", "delete-node-only");
  // The plain branch copy stays a direct row; every "copy as…" command and both
  // export commands live in the nested groups the toolbar reuses, so the copy
  // surface is one row plus one group above the export group.
  items.push("move-files", "copy-branch", "copy-as", "export");
  return items;
}
