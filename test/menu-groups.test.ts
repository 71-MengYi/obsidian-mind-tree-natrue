import test from "node:test";
import assert from "node:assert/strict";
import type { Menu } from "obsidian";
import {
  addMenuGroup,
  addMenuRow,
  supportsSubmenus,
  type MenuGroup
} from "../src/ui/menus/menu-groups";

/** Records what a real MenuItem would display and run. */
class FakeItem {
  title?: string;
  icon?: string;
  clicked?: () => void;
  submenu?: FakeMenu;
  /** Present only on runtimes that can render a nested menu. */
  setSubmenu?: () => FakeMenu;

  setTitle(title: string): this { this.title = title; return this; }
  setIcon(icon: string): this { this.icon = icon; return this; }
  onClick(run: () => void): this { this.clicked = run; return this; }
}

/** Minimal stand-in for Obsidian's Menu; `submenus` mimics the app capability. */
class FakeMenu {
  readonly items: FakeItem[] = [];
  constructor(private readonly submenus = false) {}
  addItem(callback: (item: FakeItem) => unknown): this {
    const item = new FakeItem();
    if (this.submenus) item.setSubmenu = () => (item.submenu = new FakeMenu(true));
    this.items.push(item);
    callback(item);
    return this;
  }
  asMenu(): Menu { return this as unknown as Menu; }
}

const calls: string[] = [];
const group: MenuGroup = {
  title: "Copy as…",
  icon: "copy-plus",
  rows: [
    { title: "Reference", icon: "file-symlink", run: () => calls.push("reference") },
    { title: "Outline", icon: "list-tree", run: () => calls.push("outline") }
  ]
};

test("nested-capable runtimes get one parent row with the group rows inside its submenu", () => {
  calls.length = 0;
  assert.equal(supportsSubmenus(() => new FakeMenu(true).asMenu()), true);

  const menu = new FakeMenu(true);
  addMenuGroup(menu.asMenu(), group, true);
  assert.equal(menu.items.length, 1);
  const parent = menu.items[0]!;
  assert.equal(parent.title, group.title);
  assert.equal(parent.icon, group.icon);
  // A row that owns a submenu must not also run an action of its own.
  assert.equal(parent.clicked, undefined);
  assert.deepEqual(parent.submenu?.items.map((item) => item.title), ["Reference", "Outline"]);
  parent.submenu?.items[0]?.clicked?.();
  assert.deepEqual(calls, ["reference"]);
});

test("runtimes without nested menus keep every command as a direct row", () => {
  calls.length = 0;
  const flat = new FakeMenu();
  // The probe owns a throwaway menu: probing must not add rows to `flat`.
  assert.equal(supportsSubmenus(() => new FakeMenu().asMenu()), false);

  addMenuGroup(flat.asMenu(), group, false);
  assert.deepEqual(flat.items.map((item) => item.title), ["Reference", "Outline"]);
  assert.equal(flat.items.some((item) => item.title === group.title), false);
  flat.items[1]?.clicked?.();
  assert.deepEqual(calls, ["outline"]);
});

test("a plain row carries its icon, title and action", () => {
  calls.length = 0;
  const menu = new FakeMenu();
  addMenuRow(menu.asMenu(), { title: "Copy branch", icon: "copy", run: () => calls.push("copy") });
  assert.equal(menu.items[0]?.title, "Copy branch");
  assert.equal(menu.items[0]?.icon, "copy");
  menu.items[0]?.clicked?.();
  assert.deepEqual(calls, ["copy"]);
});
