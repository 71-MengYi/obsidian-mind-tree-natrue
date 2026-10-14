import { t } from "../../i18n";
import { COPY_AS_MENU_ORDER, EXPORT_MENU_ORDER } from "../ui-contracts";
import type { MenuGroup, MenuRow } from "./menu-groups";

/** The branch-reference / outline / Mermaid copy commands. */
export interface CopyAsActions {
  readonly copyBranchReference: () => void;
  readonly copyOutline: () => void;
  readonly copyMermaid: () => void;
}

/** The plain branch copy plus every "copy as…" command. */
export interface CopyMenuActions extends CopyAsActions {
  readonly copyBranch: () => void;
}

/** The two branch export commands. */
export interface ExportMenuActions {
  readonly exportPng: () => void;
  readonly exportMarkdown: () => void;
}

/**
 * The single "复制为…" description behind the toolbar copy menu and the node
 * context menu: both surfaces must offer the same rows in the same order.
 */
export function copyAsGroup(actions: CopyAsActions): MenuGroup {
  return {
    title: t("menu.copyAs"),
    icon: "copy-plus",
    rows: COPY_AS_MENU_ORDER.map((id): MenuRow => {
      switch (id) {
        case "copy-as-reference": return { title: t("menu.copyBranchReference"), icon: "file-symlink", run: actions.copyBranchReference };
        case "copy-as-outline": return { title: t("menu.copyAsOutline"), icon: "list-tree", run: actions.copyOutline };
        case "copy-as-mermaid": return { title: t("menu.copyAsMermaid"), icon: "workflow", run: actions.copyMermaid };
      }
    })
  };
}

/** The branch copy that stays a direct row next to the nested copy group. */
export function copyBranchRow(actions: Pick<CopyMenuActions, "copyBranch">): MenuRow {
  return { title: t("menu.copyBranch"), icon: "copy", run: actions.copyBranch };
}

/**
 * The "导出" description behind the toolbar export menu and the node context
 * menu, as a nested group or as flat rows (see `addMenuGroup`).
 */
export function exportGroup(actions: ExportMenuActions): MenuGroup {
  return { title: t("menu.export"), icon: "download", rows: exportRows(actions) };
}

/** The export commands in their shared order. */
export function exportRows(actions: ExportMenuActions): MenuRow[] {
  return EXPORT_MENU_ORDER.map((id): MenuRow => {
    switch (id) {
      case "export-png": return { title: t("menu.exportPng"), icon: "image-down", run: actions.exportPng };
      case "export-markdown": return { title: t("menu.exportMarkdown"), icon: "file-down", run: actions.exportMarkdown };
    }
  });
}
