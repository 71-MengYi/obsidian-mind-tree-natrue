import { Menu, Platform } from "obsidian";
import { t } from "../../i18n";
export { KEYBOARD_HELP_ACTIONS } from "../ui-contracts";

/** Read-only shortcut reference opened from the upper-left help button. */
export class KeyboardHelpMenu {
  constructor(private readonly ownerDocument: Document) {}

  show(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("shortcut.help")).setIsLabel(true));
    const commandKey = Platform.isMacOS ? "Cmd" : "Ctrl";
    const shortcuts: Array<[string, string]> = [
      ["Enter", t("shortcut.addSiblingBelow")], ["Shift + Enter", t("shortcut.addSiblingAbove")],
      ["Tab", t("shortcut.addChild")], ["Shift + Tab", t("shortcut.addParent")],
      [`${commandKey} + ↑`, t("shortcut.moveSiblingUp")], [`${commandKey} + ↓`, t("shortcut.moveSiblingDown")],
      [`${commandKey} + E`, t("shortcut.createNote")], [`${commandKey} + S`, t("shortcut.save")],
      ["↑ / ↓", t("shortcut.navigateSiblings")], ["← / →", t("shortcut.navigateHierarchy")],
      [t("shortcut.spaceKey"), t("shortcut.editNode")], ["Delete / Backspace", t("shortcut.deleteBranch")],
      [`${commandKey} + A`, t("shortcut.selectAll")], [`${commandKey} + C`, t("shortcut.copyBranch")],
      [`${commandKey} + X`, t("shortcut.cutBranch")], [`${commandKey} + V`, t("shortcut.pasteBranch")],
      [`${commandKey} + Z`, t("shortcut.undo")], [`${commandKey} + Shift + Z`, t("shortcut.redo")],
      ["Escape", t("shortcut.cancel")]
    ];
    for (const [keys, action] of shortcuts) {
      const fragment = this.ownerDocument.createDocumentFragment();
      const row = this.ownerDocument.createElement("span");
      row.className = "mtn-shortcut-row";
      const key = this.ownerDocument.createElement("kbd");
      key.setText(keys);
      const description = this.ownerDocument.createElement("span");
      description.setText(action);
      row.append(key, description);
      fragment.append(row);
      menu.addItem((item) => item.setTitle(fragment).setIsLabel(true));
    }
    menu.showAtMouseEvent(event);
  }
}
