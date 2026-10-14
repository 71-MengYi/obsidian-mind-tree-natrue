import { Menu } from "obsidian";
import { t } from "../../i18n";
import {
  copyAsGroup,
  copyBranchRow,
  exportRows,
  type CopyMenuActions,
  type ExportMenuActions
} from "./copy-export-menu";
import { addMenuGroup, addMenuRow, supportsSubmenus } from "./menu-groups";

export class CollapseLevelMenu {
  constructor(private readonly collapseToLevel: (level: number) => void) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    for (let level = 1; level <= 9; level += 1) menu.addItem((item) => item
      .setTitle(t("toolbar.collapseToLevel", { level })).onClick(() => this.collapseToLevel(level)));
    menu.showAtMouseEvent(event);
  }
}

/**
 * Toolbar copy dropdown: the plain branch copy plus the same "复制为…" group the
 * node context menu renders, so both surfaces offer identical commands.
 */
export class CopyMenu {
  constructor(private readonly actions: CopyMenuActions) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    addMenuRow(menu, copyBranchRow(this.actions));
    addMenuGroup(menu, copyAsGroup(this.actions), supportsSubmenus(() => new Menu()));
    menu.showAtMouseEvent(event);
  }
}

/** Toolbar export dropdown: the same two commands the node menu exports. */
export class ExportMenu {
  constructor(private readonly actions: ExportMenuActions) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    for (const row of exportRows(this.actions)) addMenuRow(menu, row);
    menu.showAtMouseEvent(event);
  }
}
