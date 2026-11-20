import test from "node:test";
import assert from "node:assert/strict";
import type { Menu } from "obsidian";
import { loadModule } from "./helpers/module-loader";

interface NumberingActions {
  readonly numberChildren: (format: string, scope: string, start: string) => void;
  readonly clearNumbering: (scope: "level" | "all") => void;
}

interface NumberingMenuApi {
  addNodeNumberingMenu(menu: Menu, nested: boolean, actions: NumberingActions, hasChildren: boolean): void;
}

// Load before registering tests: Node's runner can swallow top-level errors
// after test() registrations, which would silently skip every case below.
const { addNodeNumberingMenu } = loadModule<NumberingMenuApi>("src/ui/menus/node-numbering-menu.ts", {
  obsidian: { getLanguage: () => "zh" },
  globals: { console }
});

/** Records what a real MenuItem would display and run. */
class FakeItem {
  title?: string;
  icon?: string;
  disabled = false;
  clicked?: () => void;
  submenu?: FakeMenu;
  /** Present only on runtimes that can render a nested menu. */
  setSubmenu?: () => FakeMenu;

  setTitle(title: string): this { this.title = title; return this; }
  setIcon(icon: string): this { this.icon = icon; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
  onClick(run: () => void): this { this.clicked = run; return this; }
}

/** Minimal stand-in for Obsidian's Menu; `submenus` mimics the app capability. */
class FakeMenu {
  readonly items: FakeItem[] = [];
  separators = 0;
  constructor(private readonly submenus = false) {}
  addItem(callback: (item: FakeItem) => unknown): this {
    const item = new FakeItem();
    if (this.submenus) item.setSubmenu = () => (item.submenu = new FakeMenu(true));
    this.items.push(item);
    callback(item);
    return this;
  }
  addSeparator(): this { this.separators += 1; return this; }
  asMenu(): Menu { return this as unknown as Menu; }
}

const calls: string[] = [];

function actions(): NumberingActions {
  return {
    numberChildren: (format, scope, start) => calls.push(`${format}|${scope}|${start}`),
    clearNumbering: (scope) => calls.push(`clear|${scope}`)
  };
}

test("the group sits below the marker row and opens an action submenu", () => {
  calls.length = 0;
  const menu = new FakeMenu(true);
  addNodeNumberingMenu(menu.asMenu(), true, actions(), true);
  assert.equal(menu.items.length, 1);
  const group = menu.items[0]!;
  assert.equal(group.title, "节点编号");
  assert.equal(group.clicked, undefined);

  const submenu = group.submenu!;
  assert.deepEqual(submenu.items.map((item) => item.title), [
    "编号一层子节点（从第一层开始）",
    "编号一层子节点（从上层继续）",
    "编号所有子节点（从第一层开始）",
    "编号所有子节点（从上层继续）",
    "移除一层子节点编号",
    "移除所有子节点编号"
  ]);
  assert.equal(submenu.separators, 1);
});

test("each action opens the six style options", () => {
  calls.length = 0;
  const menu = new FakeMenu(true);
  addNodeNumberingMenu(menu.asMenu(), true, actions(), true);
  const firstAction = menu.items[0]!.submenu!.items[0]!;
  assert.equal(firstAction.clicked, undefined);
  const styles = firstAction.submenu!;
  assert.deepEqual(styles.items.map((item) => item.title), [
    "1.; 1.1; 1.1.1; 1.1.1.1",
    "一、;（一）;（1）;1;1.1;1.1.1",
    "i.; ii.; iii.; iv.; v.; vi.",
    "I.; II.; III.; IV.; V.; VI.",
    "A.; B.; C.; D.; E.; F.",
    "a.; b.; c.; d.; e.; f."
  ]);
  styles.items[0]!.clicked!();
  styles.items[2]!.clicked!();
  assert.deepEqual(calls, ["decimal|level|restart", "lowerRoman|level|restart"]);
});

test("the continued and descendant rows keep their own scope and start", () => {
  calls.length = 0;
  const menu = new FakeMenu(true);
  addNodeNumberingMenu(menu.asMenu(), true, actions(), true);
  const submenu = menu.items[0]!.submenu!;
  submenu.items[1]!.submenu!.items[0]!.clicked!();
  submenu.items[3]!.submenu!.items[1]!.clicked!();
  submenu.items[4]!.clicked!();
  submenu.items[5]!.clicked!();
  assert.deepEqual(calls, [
    "decimal|level|continue",
    "chinese|descendants|continue",
    "clear|level",
    "clear|all"
  ]);
});

test("a childless node keeps the group but disables its numbering rows", () => {
  const menu = new FakeMenu(true);
  addNodeNumberingMenu(menu.asMenu(), true, actions(), false);
  const submenu = menu.items[0]!.submenu!;
  assert.deepEqual(submenu.items.map((item) => item.disabled), [true, true, true, true, false, false]);
  assert.deepEqual(submenu.items.map((item) => item.clicked !== undefined), [false, false, false, false, true, true]);
});

test("runtimes without nested menus flatten every command into direct rows", () => {
  calls.length = 0;
  const menu = new FakeMenu();
  addNodeNumberingMenu(menu.asMenu(), false, actions(), true);
  assert.equal(menu.items.length, 26);
  assert.equal(menu.items[0]!.title, "编号一层子节点（从第一层开始） · 1.; 1.1; 1.1.1; 1.1.1.1");
  assert.equal(menu.items[24]!.title, "移除一层子节点编号");
  assert.equal(menu.items[25]!.title, "移除所有子节点编号");
  menu.items[0]!.clicked!();
  assert.deepEqual(calls, ["decimal|level|restart"]);
});
