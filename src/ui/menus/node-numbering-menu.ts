import type { Menu } from "obsidian";
import { NODE_NUMBERING_FORMATS } from "../../domain/node-numbering";
import { t, type TranslationKey } from "../../i18n";
import type { NodeNumberingFormat, NodeNumberingScope, NodeNumberingStart } from "../../types";
import { addMenuRow, attachSubmenu, type MenuRow } from "./menu-groups";

export interface NodeNumberingMenuActions {
  readonly numberChildren: (
    format: NodeNumberingFormat,
    scope: NodeNumberingScope,
    start: NodeNumberingStart
  ) => void;
  readonly clearNumbering: (scope: "level" | "all") => void;
}

interface NumberingAction {
  readonly titleKey: TranslationKey;
  readonly scope: NodeNumberingScope;
  readonly start: NodeNumberingStart;
}

/**
 * Order fixed by the product spec: one level first, then the complete subtree.
 * Each pair reads "(restart at 1)" then "(continue from parent)".
 */
const NUMBERING_ACTIONS: readonly NumberingAction[] = [
  { titleKey: "menu.numberingLevelRestart", scope: "level", start: "restart" },
  { titleKey: "menu.numberingLevelContinue", scope: "level", start: "continue" },
  { titleKey: "menu.numberingAllRestart", scope: "descendants", start: "restart" },
  { titleKey: "menu.numberingAllContinue", scope: "descendants", start: "continue" }
];

const FORMAT_TITLE_KEYS: Record<NodeNumberingFormat, TranslationKey> = {
  decimal: "menu.numberingFormat.decimal",
  chinese: "menu.numberingFormat.chinese",
  lowerRoman: "menu.numberingFormat.lowerRoman",
  upperRoman: "menu.numberingFormat.upperRoman",
  upperAlpha: "menu.numberingFormat.upperAlpha",
  lowerAlpha: "menu.numberingFormat.lowerAlpha"
};

function formatRow(
  format: NodeNumberingFormat,
  action: NumberingAction,
  actions: NodeNumberingMenuActions
): MenuRow {
  return {
    title: t(FORMAT_TITLE_KEYS[format]),
    run: () => actions.numberChildren(format, action.scope, action.start)
  };
}

/**
 * Second nesting level: the action row opens the six style options. Without
 * submenu support the styles stay reachable by flattening them into the parent
 * menu, exactly like `addMenuGroup` does for its single level.
 */
function addActionPicker(
  menu: Menu,
  action: NumberingAction,
  actions: NodeNumberingMenuActions,
  hasChildren: boolean
): void {
  if (!hasChildren) {
    // A childless node has nothing to number; keep the row visible but inert so
    // the menu group does not change shape between nodes.
    menu.addItem((item) => item.setTitle(t(action.titleKey)).setIcon("list-ordered").setDisabled(true));
    return;
  }
  menu.addItem((item) => {
    item.setTitle(t(action.titleKey)).setIcon("list-ordered");
    const submenu = attachSubmenu(item);
    if (!submenu) {
      for (const format of NODE_NUMBERING_FORMATS) addMenuRow(menu, formatRow(format, action, actions));
      return;
    }
    for (const format of NODE_NUMBERING_FORMATS) addMenuRow(submenu, formatRow(format, action, actions));
  });
}

function addRemovalRows(menu: Menu, actions: NodeNumberingMenuActions): void {
  addMenuRow(menu, {
    title: t("menu.numberingClearLevel"),
    icon: "list-x",
    run: () => actions.clearNumbering("level")
  });
  addMenuRow(menu, {
    title: t("menu.numberingClearAll"),
    icon: "list-x",
    run: () => actions.clearNumbering("all")
  });
}

/**
 * The "节点编号" entry of the node context menu. It sits directly below the
 * node-marker row and owns one nested level for the four numbering actions plus
 * a second nested level for the six styles.
 */
export function addNodeNumberingMenu(
  menu: Menu,
  nested: boolean,
  actions: NodeNumberingMenuActions,
  hasChildren: boolean
): void {
  if (!nested) {
    for (const action of NUMBERING_ACTIONS) {
      for (const format of NODE_NUMBERING_FORMATS) {
        addMenuRow(menu, {
          title: `${t(action.titleKey)} · ${t(FORMAT_TITLE_KEYS[format])}`,
          run: () => actions.numberChildren(format, action.scope, action.start)
        });
      }
    }
    addRemovalRows(menu, actions);
    return;
  }
  menu.addItem((item) => {
    item.setTitle(t("menu.numbering")).setIcon("list-ordered");
    const submenu = attachSubmenu(item);
    if (!submenu) {
      for (const action of NUMBERING_ACTIONS) addActionPicker(menu, action, actions, hasChildren);
      addRemovalRows(menu, actions);
      return;
    }
    for (const action of NUMBERING_ACTIONS) addActionPicker(submenu, action, actions, hasChildren);
    submenu.addSeparator();
    addRemovalRows(submenu, actions);
  });
}
