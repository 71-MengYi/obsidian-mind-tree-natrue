import { Menu } from "obsidian";
import { t } from "../../i18n";
import { CHAIN_BROKEN_ICON } from "../icons";

export interface NodeContextMenuState {
  readonly hasFileResource: boolean;
  readonly hasResource: boolean;
  readonly titleSyncEnabled: boolean;
  readonly isRoot: boolean;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly deleteCount: number;
  readonly branchHasNotes: boolean;
}

export interface NodeContextMenuActions {
  readonly toggleTitleSync: () => void;
  readonly addNote: () => void;
  readonly addNoteFromTemplate: () => void;
  readonly linkNote: () => void;
  readonly linkWeb: () => void;
  readonly openResource: () => void;
  readonly unlinkResource: () => void;
  readonly showMarkers: () => void;
  readonly addChild: () => void;
  readonly addSibling: () => void;
  readonly toggleCollapsed: () => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly deleteBranch: () => void;
  readonly deleteNodeOnly: () => void;
  readonly moveNotes: () => void;
  readonly copyBranch: () => void;
  readonly copyMarkdown: () => void;
  readonly exportBranchPng: () => void;
}

/** Declarative node-menu composition; all domain work is delegated by name. */
export class NodeContextMenu {
  constructor(private readonly state: NodeContextMenuState, private readonly actions: NodeContextMenuActions) {}

  show(event: MouseEvent): void {
    const menu = new Menu();
    const { state, actions } = this;
    if (state.hasFileResource) menu.addItem((item) => item
      .setTitle(state.titleSyncEnabled ? t("menu.disableTitleSync") : t("menu.enableTitleSync"))
      .setIcon(state.titleSyncEnabled ? "unlink" : "refresh-cw").onClick(actions.toggleTitleSync));
    else if (!state.hasResource) {
      menu.addItem((item) => item.setTitle(t("menu.addNote")).setIcon("file-plus-2").onClick(actions.addNote));
      menu.addItem((item) => item.setTitle(t("menu.addNoteFromTemplate")).setIcon("copy-plus").onClick(actions.addNoteFromTemplate));
      menu.addItem((item) => item.setTitle(t("menu.linkNote")).setIcon("file-search").onClick(actions.linkNote));
    }
    menu.addItem((item) => item.setTitle(t("menu.linkWeb")).setIcon("link").onClick(actions.linkWeb));
    if (state.hasResource) {
      menu.addItem((item) => item.setTitle(t("menu.openResource")).setIcon("external-link").onClick(actions.openResource));
      menu.addItem((item) => item.setTitle(t("menu.unlinkResource")).setIcon(CHAIN_BROKEN_ICON).onClick(actions.unlinkResource));
    }
    menu.addItem((item) => item.setTitle(t("menu.markers")).setIcon("tags").onClick(actions.showMarkers));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.addChild")).setIcon("corner-down-right").onClick(actions.addChild));
    if (!state.isRoot) menu.addItem((item) => item.setTitle(t("menu.addSibling")).setIcon("list-plus").onClick(actions.addSibling));
    if (state.hasChildren) {
      menu.addItem((item) => item.setTitle(state.collapsed ? t("menu.expand") : t("menu.collapse"))
        .setIcon(state.collapsed ? "unfold-vertical" : "fold-vertical").onClick(actions.toggleCollapsed));
      menu.addItem((item) => item.setTitle(t("menu.expandAll")).setIcon("chevrons-down").onClick(actions.expandAll));
      menu.addItem((item) => item.setTitle(t("menu.collapseAll")).setIcon("chevrons-up").onClick(actions.collapseAll));
    }
    if (!state.isRoot) {
      menu.addItem((item) => item.setTitle(t("menu.deleteBranch", { count: state.deleteCount }))
        .setIcon("trash-2").setWarning(true).onClick(actions.deleteBranch));
      menu.addItem((item) => item.setTitle(t("menu.deleteNodeOnly")).setIcon("git-pull-request-arrow").onClick(actions.deleteNodeOnly));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.moveNotes")).setIcon("folder-input")
      .setDisabled(!state.branchHasNotes).onClick(actions.moveNotes));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("menu.copyBranch")).setIcon("copy").onClick(actions.copyBranch));
    menu.addItem((item) => item.setTitle(t("menu.copyMarkdown")).setIcon("list-tree").onClick(actions.copyMarkdown));
    menu.addItem((item) => item.setTitle(t("menu.exportBranchPng")).setIcon("image-down").onClick(actions.exportBranchPng));
    menu.showAtMouseEvent(event);
  }
}
