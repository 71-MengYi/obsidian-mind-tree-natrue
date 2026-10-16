import { Menu } from "obsidian";
import { t } from "../../i18n";
import { CHAIN_BROKEN_ICON } from "../icons";
import { guardNodeMenuAction, nodeResourceMenuItemOrder } from "../ui-contracts";
import { copyAsGroup, copyBranchRow, exportGroup } from "./copy-export-menu";
import { addMenuGroup, addMenuRow, supportsSubmenus } from "./menu-groups";

export interface NodeContextMenuState {
  readonly hasFileResource: boolean;
  readonly hasResource: boolean;
  readonly isDesktopApp: boolean;
  readonly titleSyncEnabled: boolean;
  readonly isRoot: boolean;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly deleteCount: number;
  readonly branchHasFiles: boolean;
  /** True when this node points at another node or is pointed at by one. */
  readonly nodeLinked: boolean;
}

export interface NodeContextMenuActions {
  readonly isCurrent: () => boolean;
  readonly toggleTitleSync: () => void;
  readonly addNote: () => void;
  readonly addFileFromTemplate: () => void;
  readonly linkFile: () => void;
  readonly linkWeb: () => void;
  readonly openResource: () => void;
  readonly openDefaultApp: () => void;
  readonly unlinkResource: () => void;
  readonly showMarkers: () => void;
  /** Remove every link this node takes part in. */
  readonly unlinkNode: () => void;
  readonly addChild: () => void;
  readonly addSibling: () => void;
  readonly toggleCollapsed: () => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly deleteBranch: () => void;
  readonly deleteNodeOnly: () => void;
  readonly moveFiles: () => void;
  readonly copyBranch: () => void;
  /** Copy a pointer to this branch instead of a copy of its content. */
  readonly copyBranchReference: () => void;
  /** Copy this branch as a Markdown unordered list. */
  readonly copyOutline: () => void;
  /** Copy this branch as Mermaid mindmap code. */
  readonly copyMermaid: () => void;
  readonly exportPng: () => void;
  readonly exportMarkdown: () => void;
}

/** Declarative node-menu composition; all domain work is delegated by name. */
export class NodeContextMenu {
  constructor(private readonly state: NodeContextMenuState, private readonly actions: NodeContextMenuActions) {}

  show(event: Pick<MouseEvent, "clientX" | "clientY">, ownerDocument?: Document): void {
    const menu = new Menu();
    const { state, actions } = this;
    const guarded = (action: () => void): (() => void) => guardNodeMenuAction(actions.isCurrent, action);
    for (const id of nodeResourceMenuItemOrder(state)) {
      menu.addItem((item) => {
        switch (id) {
          case "title-sync": return item.setTitle(state.titleSyncEnabled ? t("menu.disableTitleSync") : t("menu.enableTitleSync"))
            .setIcon(state.titleSyncEnabled ? "unlink" : "refresh-cw").onClick(guarded(actions.toggleTitleSync));
          case "add-note": return item.setTitle(t("menu.addNote")).setIcon("file-plus-2").onClick(guarded(actions.addNote));
          case "add-file-template": return item.setTitle(t("menu.addFileFromTemplate")).setIcon("copy-plus").onClick(guarded(actions.addFileFromTemplate));
          case "link-file": return item.setTitle(t("menu.linkFile")).setIcon("file-search").onClick(guarded(actions.linkFile));
          case "link-web": return item.setTitle(t("menu.linkWeb")).setIcon("link").onClick(guarded(actions.linkWeb));
          case "open-resource": return item.setTitle(t("menu.openResource")).setIcon("external-link").onClick(guarded(actions.openResource));
          case "open-default-app": return item.setTitle(t("menu.openDefaultApp")).setIcon("app-window").onClick(guarded(actions.openDefaultApp));
          case "unlink-resource": return item.setTitle(t("menu.unlinkResource")).setIcon(CHAIN_BROKEN_ICON).onClick(guarded(actions.unlinkResource));
        }
      });
    }
    menu.addItem((item) => item.setTitle(t("toolbar.markers")).setIcon("tags").onClick(guarded(actions.showMarkers)));
    if (state.nodeLinked) {
      // The creation entry is gone: a node link is made by pasting a copied
      // branch reference, so the menu only ever offers the removal row.
      menu.addItem((item) => item.setTitle(t("menu.unlinkNode"))
        .setIcon(CHAIN_BROKEN_ICON).onClick(guarded(actions.unlinkNode)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.addChild")).setIcon("corner-down-right").onClick(guarded(actions.addChild)));
    if (!state.isRoot) menu.addItem((item) => item.setTitle(t("menu.addSibling")).setIcon("list-plus").onClick(guarded(actions.addSibling)));
    if (state.hasChildren) {
      menu.addItem((item) => item.setTitle(state.collapsed ? t("menu.expand") : t("menu.collapse"))
        .setIcon(state.collapsed ? "unfold-vertical" : "fold-vertical").onClick(guarded(actions.toggleCollapsed)));
      menu.addItem((item) => item.setTitle(t("menu.expandAll")).setIcon("chevrons-down").onClick(guarded(actions.expandAll)));
      menu.addItem((item) => item.setTitle(t("menu.collapseAll")).setIcon("chevrons-up").onClick(guarded(actions.collapseAll)));
    }
    if (!state.isRoot) {
      menu.addItem((item) => item.setTitle(t("menu.deleteBranch", { count: state.deleteCount }))
        .setIcon("trash-2").setWarning(true).onClick(guarded(actions.deleteBranch)));
      menu.addItem((item) => item.setTitle(t("menu.deleteNodeOnly")).setIcon("git-pull-request-arrow").onClick(guarded(actions.deleteNodeOnly)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.moveFiles")).setIcon("folder-input")
      .setDisabled(!state.branchHasFiles).onClick(guarded(actions.moveFiles)));
    menu.addSeparator();
    addMenuRow(menu, copyBranchRow({ copyBranch: guarded(actions.copyBranch) }));
    // Both groups are the same descriptions the toolbar menus render, so the two
    // surfaces cannot drift apart; stale menus are revalidated on every row.
    const nested = supportsSubmenus(() => new Menu());
    addMenuGroup(menu, copyAsGroup({
      copyBranchReference: guarded(actions.copyBranchReference),
      copyOutline: guarded(actions.copyOutline),
      copyMermaid: guarded(actions.copyMermaid)
    }), nested);
    addMenuGroup(menu, exportGroup({
      exportPng: guarded(actions.exportPng),
      exportMarkdown: guarded(actions.exportMarkdown)
    }), nested);
    menu.showAtPosition({ x: event.clientX, y: event.clientY }, ownerDocument);
  }
}
