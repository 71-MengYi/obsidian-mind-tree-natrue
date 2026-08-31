import { Menu } from "obsidian";
import { t } from "../../i18n";

export class CollapseLevelMenu {
  constructor(private readonly collapseToLevel: (level: number) => void) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    for (let level = 1; level <= 9; level += 1) menu.addItem((item) => item
      .setTitle(t("toolbar.collapseToLevel", { level })).onClick(() => this.collapseToLevel(level)));
    menu.showAtMouseEvent(event);
  }
}

export class CopyMenu {
  constructor(private readonly copyBranch: () => void, private readonly copyMarkdown: () => void) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("menu.copyBranch")).setIcon("copy").onClick(this.copyBranch));
    menu.addItem((item) => item.setTitle(t("menu.copyMarkdown")).setIcon("list-tree").onClick(this.copyMarkdown));
    menu.showAtMouseEvent(event);
  }
}

export class ExportMenu {
  constructor(private readonly exportPng: () => void, private readonly exportMarkdown: () => void) {}
  show(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("menu.exportPng")).setIcon("image-down").onClick(this.exportPng));
    menu.addItem((item) => item.setTitle(t("menu.exportMarkdown")).setIcon("file-down").onClick(this.exportMarkdown));
    menu.showAtMouseEvent(event);
  }
}
