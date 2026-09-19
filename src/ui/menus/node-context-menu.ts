import { Menu } from "obsidian";
import { t } from "../../i18n";
import { CHAIN_BROKEN_ICON } from "../icons";
import { guardNodeMenuAction, nodeResourceMenuItemOrder } from "../ui-contracts";

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
  readonly addChild: () => void;
  readonly addSibling: () => void;
  readonly toggleCollapsed: () => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly deleteBranch: () => void;
  readonly deleteNodeOnly: () => void;
  readonly moveFiles: () => void;
  readonly copyBranch: () => void;
  readonly copyMarkdown: () => void;
  readonly exportBranchPng: () => void;
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
    menu.addItem((item) => item.setTitle(t("menu.markers")).setIcon("tags").onClick(guarded(actions.showMarkers)));
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
    menu.addItem((item) => item.setTitle(t("menu.copyBranch")).setIcon("copy").onClick(guarded(actions.copyBranch)));
    menu.addItem((item) => item.setTitle(t("menu.copyMarkdown")).setIcon("list-tree").onClick(guarded(actions.copyMarkdown)));
    menu.addItem((item) => item.setTitle(t("menu.exportBranchPng")).setIcon("image-down").onClick(guarded(actions.exportBranchPng)));
    menu.showAtPosition({ x: event.clientX, y: event.clientY }, ownerDocument);
  }
}
