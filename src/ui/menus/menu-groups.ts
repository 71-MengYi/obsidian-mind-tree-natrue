import type { Menu, MenuItem } from "obsidian";

/** One clickable row inside a menu or inside one of its nested menus. */
export interface MenuRow {
  readonly title: string;
  readonly icon?: string;
  readonly run: () => void;
}

/** A parent row that owns a nested menu of its own. */
export interface MenuGroup {
  readonly title: string;
  readonly icon: string;
  readonly rows: readonly MenuRow[];
}

/**
 * Obsidian grows a real nested menu for an item that owns a submenu: the desktop
 * fly-out keeps the parent menu open, mobile slides the child in, and native
 * desktop menus build a native submenu. `MenuItem.setSubmenu()` is not part of
 * the published `obsidian` typings, so it is reached through a narrow structural
 * view; `docs/memory.md` records the probe and the flat fallback below.
 */
export function attachSubmenu(item: MenuItem): Menu | undefined {
  const candidate = item as unknown as { setSubmenu?: () => Menu };
  return typeof candidate.setSubmenu === "function" ? candidate.setSubmenu() : undefined;
}

/**
 * Whether this app build can render nested menus. `createMenu` allocates the
 * throwaway menu the probe item is created in, so callers that already own a
 * `Menu` import pass their own constructor.
 */
export function supportsSubmenus(createMenu: () => Menu): boolean {
  let supported = false;
  createMenu().addItem((item) => {
    supported = typeof (item as unknown as { setSubmenu?: unknown }).setSubmenu === "function";
  });
  return supported;
}

/** Add one directly clickable row. */
export function addMenuRow(menu: Menu, row: MenuRow): void {
  menu.addItem((item) => {
    item.setTitle(row.title);
    if (row.icon) item.setIcon(row.icon);
    item.onClick(row.run);
  });
}

/**
 * Add one nested group. Without submenu support every row stays a direct entry
 * of the parent menu instead of living under a parent row that would do nothing
 * when clicked, so all commands remain reachable on older app builds.
 */
export function addMenuGroup(menu: Menu, group: MenuGroup, nested: boolean): void {
  if (!nested) {
    for (const row of group.rows) addMenuRow(menu, row);
    return;
  }
  menu.addItem((item) => {
    item.setTitle(group.title).setIcon(group.icon);
    const submenu = attachSubmenu(item);
    if (!submenu) {
      for (const row of group.rows) addMenuRow(menu, row);
      return;
    }
    for (const row of group.rows) addMenuRow(submenu, row);
  });
}
