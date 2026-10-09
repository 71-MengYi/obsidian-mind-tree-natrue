import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { isCompleteThemeRowMapping, isMenuLabelRow, matchThemeRows, type MenuRowLike } from "../src/ui/menus/theme-menu-hover";
import type { MindTreeTheme } from "../src/types";

/** Row double: the mapping logic must stay testable without a DOM. */
interface FakeRowLike extends MenuRowLike {
  readonly id: string;
}

function fakeRow(id: string, tokens: readonly string[] = []): FakeRowLike {
  const classes = new Set(tokens);
  return {
    id,
    matches: (selector: string) => selector.startsWith(".") && classes.has(selector.slice(1)),
    classList: { contains: (token: string) => classes.has(token) }
  };
}

const THEMES: readonly MindTreeTheme[] = ["vibrant", "classic", "fresh"];

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** Drop comments so source assertions describe code, not prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("matchThemeRows maps rows to themes in DOM order and skips the label row", () => {
  const rows = [fakeRow("theme-label", ["is-label"]), fakeRow("vibrant"), fakeRow("classic"), fakeRow("fresh")];
  const matched = matchThemeRows(rows, THEMES);
  assert.deepEqual(matched.map((entry) => [entry.theme, entry.row.id]), [
    ["vibrant", "vibrant"],
    ["classic", "classic"],
    ["fresh", "fresh"]
  ]);
});

test("matchThemeRows keeps the matched prefix when there are fewer rows than themes", () => {
  const matched = matchThemeRows([fakeRow("theme-label", ["is-label"]), fakeRow("first")], THEMES);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.theme, "vibrant");
  assert.equal(matched[0]?.row.id, "first");
});

test("matchThemeRows ignores rows beyond the theme count and keeps order", () => {
  const rows = [fakeRow("theme-label", ["is-label"]), fakeRow("a"), fakeRow("b"), fakeRow("c"), fakeRow("extra")];
  const matched = matchThemeRows(rows, THEMES);
  assert.deepEqual(matched.map((entry) => entry.theme), ["vibrant", "classic", "fresh"]);
  assert.deepEqual(matched.map((entry) => entry.row.id), ["a", "b", "c"]);
});

test("matchThemeRows returns nothing for empty rows or empty themes", () => {
  assert.deepEqual(matchThemeRows([], THEMES), []);
  assert.deepEqual(matchThemeRows([fakeRow("theme-label", ["is-label"]), fakeRow("a")], []), []);
});

test("matchThemeRows accepts a custom skipLabel predicate", () => {
  const rows = [
    fakeRow("theme-label", ["is-label"]),
    fakeRow("hidden", ["mtn-skip"]),
    fakeRow("first"),
    fakeRow("second")
  ];
  const matched = matchThemeRows(rows, THEMES, (row) => row.classList.contains("mtn-skip") || isMenuLabelRow(row));
  assert.deepEqual(matched.map((entry) => [entry.theme, entry.row.id]), [
    ["vibrant", "first"],
    ["classic", "second"]
  ]);
});

test("isMenuLabelRow recognises labels through classList and matches", () => {
  assert.equal(isMenuLabelRow(fakeRow("label", ["is-label"])), true);
  const matchesOnly: MenuRowLike = {
    matches: (selector: string) => selector === ".is-label",
    classList: { contains: () => false }
  };
  assert.equal(isMenuLabelRow(matchesOnly), true);
  assert.equal(isMenuLabelRow(fakeRow("choice", ["menu-item"])), false);
});

test("isCompleteThemeRowMapping gates hover on an exact row-to-theme match", () => {
  const label = fakeRow("theme-label", ["is-label"]);
  assert.equal(isCompleteThemeRowMapping([label, fakeRow("a"), fakeRow("b"), fakeRow("c")], THEMES), true);
  assert.equal(isCompleteThemeRowMapping([label, fakeRow("a"), fakeRow("b")], THEMES), false);
  assert.equal(isCompleteThemeRowMapping([label, fakeRow("a"), fakeRow("b"), fakeRow("c"), fakeRow("extra")], THEMES), false);
  assert.equal(isCompleteThemeRowMapping([], THEMES), false);
  assert.equal(isCompleteThemeRowMapping([label], []), false);
});

// ---------------------------------------------------------------------------
// Delegated hover: run the real module against a fake menu container so that
// "rows appear after binding" and "rows are rebuilt" can be reproduced.
// ---------------------------------------------------------------------------

const bundle = buildSync({
  entryPoints: ["src/ui/menus/theme-menu-hover.ts"], bundle: true, write: false, format: "cjs", platform: "browser"
}).outputFiles[0]!.text;

class Surface extends EventTarget {
  listenerCount = 0;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, listener, options);
    this.listenerCount += 1;
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    super.removeEventListener(type, listener, options);
    this.listenerCount -= 1;
  }
  emit(type: string, properties: Record<string, unknown> = {}): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
    this.dispatchEvent(event);
    return event;
  }
}

/** Mirrors a `.menu-item` row: it matches itself and owns its child nodes. */
class FakeRow extends Surface {
  readonly nodeType = 1;
  readonly id: string;
  readonly classes: Set<string>;
  readonly classList: { contains: (token: string) => boolean };
  constructor(id: string, tokens: readonly string[] = []) {
    super();
    this.id = id;
    this.classes = new Set(tokens);
    this.classList = { contains: (token: string) => this.classes.has(token) };
  }
  matches(selector: string): boolean {
    return selector.startsWith(".") && this.classes.has(selector.slice(1));
  }
  closest(selector: string): FakeRow | undefined {
    return this.matches(selector) ? this : undefined;
  }
}

/** A child node inside a row (icon, text span): `closest` must walk up to the row. */
class FakeChild extends Surface {
  readonly nodeType = 1;
  readonly parent: FakeRow;
  constructor(parent: FakeRow) {
    super();
    this.parent = parent;
  }
  closest(selector: string): FakeRow | undefined {
    return this.parent.matches(selector) ? this.parent : undefined;
  }
}

/** An element that belongs to no menu row. */
class FakeOutside extends Surface {
  readonly nodeType = 1;
  closest(_selector: string): undefined {
    return undefined;
  }
}

type FakeMediaQuery = { matches: boolean };
type FakeDefaultView = { matchMedia: (query: string) => FakeMediaQuery };

/** Mirrors the `.menu` container: the element survives while its rows may not. */
class FakeMenu extends Surface {
  readonly nodeType = 1;
  rows: FakeRow[] = [];
  readonly ownerDocument: { defaultView?: FakeDefaultView };
  constructor(defaultView?: FakeDefaultView) {
    super();
    this.ownerDocument = defaultView ? { defaultView } : {};
  }
  querySelectorAll(selector: string): FakeRow[] {
    return this.rows.filter((row) => row.matches(selector));
  }
}

interface HoverBindings {
  bindThemeMenuHover(
    menu: FakeMenu,
    themes: readonly string[],
    handlers: { onEnter: (theme: string, row: FakeRow) => void; onLeave: () => void }
  ): void;
}
const module = { exports: {} as HoverBindings };
runInNewContext(bundle, { module, exports: module.exports, console });
const { bindThemeMenuHover } = module.exports;

function themeRows(ids: readonly string[]): FakeRow[] {
  return [new FakeRow("theme-label", ["menu-item", "is-label"]), ...ids.map((id) => new FakeRow(id, ["menu-item"]))];
}

function rowById(menu: FakeMenu, id: string): FakeRow {
  const row = menu.rows.find((candidate) => candidate.id === id);
  assert.ok(row, `expected a row with id ${id}`);
  return row;
}

function hoverMenu(options: { readonly hover?: boolean; readonly view?: boolean } = {}) {
  const defaultView = options.view === false
    ? undefined
    : { matchMedia: (_query: string) => ({ matches: options.hover !== false }) };
  const menu = new FakeMenu(defaultView);
  const entries: string[] = [];
  const enteredRows: FakeRow[] = [];
  bindThemeMenuHover(menu, THEMES, {
    onEnter: (theme, row) => { entries.push(`enter:${theme}:${row.id}`); enteredRows.push(row); },
    onLeave: () => entries.push("leave")
  });
  return { menu, entries, enteredRows };
}

test("delegated hover resolves rows that only appear after binding", () => {
  const f = hoverMenu();
  assert.equal(f.menu.rows.length, 0); // Obsidian defers Menu.load() to a timer.
  f.menu.rows = themeRows(THEMES);
  const classic = rowById(f.menu, "classic");
  f.menu.emit("pointerover", { target: classic, pointerType: "mouse" });
  assert.deepEqual(f.entries, ["enter:classic:classic"]);
  assert.equal(f.enteredRows[0], classic); // callers anchor on the live row element.
});

test("delegated hover survives rows rebuilt by Menu.sort", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  f.menu.emit("pointerover", { target: rowById(f.menu, "vibrant"), pointerType: "mouse" });
  f.menu.rows = themeRows(THEMES); // sort() empties the scroll element and re-attaches rows.
  f.menu.emit("pointerover", { target: rowById(f.menu, "fresh"), pointerType: "mouse" });
  assert.deepEqual(f.entries, ["enter:vibrant:vibrant", "enter:fresh:fresh"]);
});

test("moving between theme rows never reports a leave", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  const vibrant = rowById(f.menu, "vibrant");
  const classic = rowById(f.menu, "classic");
  f.menu.emit("pointerover", { target: vibrant, pointerType: "mouse" });
  f.menu.emit("pointerout", { target: vibrant, relatedTarget: classic, pointerType: "mouse" });
  f.menu.emit("pointerover", { target: classic, pointerType: "mouse" });
  assert.deepEqual(f.entries, ["enter:vibrant:vibrant", "enter:classic:classic"]);
});

test("child nodes of one row enter once and never report a leave", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  const vibrant = rowById(f.menu, "vibrant");
  f.menu.emit("pointerover", { target: vibrant, pointerType: "mouse" });
  f.menu.emit("pointerover", { target: new FakeChild(vibrant), pointerType: "mouse" });
  f.menu.emit("pointerout", {
    target: new FakeChild(vibrant), relatedTarget: new FakeChild(vibrant), pointerType: "mouse"
  });
  assert.deepEqual(f.entries, ["enter:vibrant:vibrant"]);
});

test("leaving a theme row for the label row or for outside ends the preview", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  const vibrant = rowById(f.menu, "vibrant");
  f.menu.emit("pointerover", { target: vibrant, pointerType: "mouse" });
  f.menu.emit("pointerout", { target: vibrant, relatedTarget: rowById(f.menu, "theme-label"), pointerType: "mouse" });
  f.menu.emit("pointerover", { target: vibrant, pointerType: "mouse" });
  f.menu.emit("pointerout", { target: vibrant, relatedTarget: new FakeOutside(), pointerType: "mouse" });
  f.menu.emit("pointerover", { target: vibrant, pointerType: "mouse" });
  f.menu.emit("pointerout", { target: vibrant, relatedTarget: null, pointerType: "mouse" });
  // A pointerout from the label row itself is not a theme row: nothing to end.
  f.menu.emit("pointerout", { target: rowById(f.menu, "theme-label"), relatedTarget: null, pointerType: "mouse" });
  assert.deepEqual(f.entries, [
    "enter:vibrant:vibrant", "leave",
    "enter:vibrant:vibrant", "leave",
    "enter:vibrant:vibrant", "leave"
  ]);
});

test("a row count that does not mirror the theme list never maps to a theme", () => {
  const f = hoverMenu();
  f.menu.rows = [new FakeRow("theme-label", ["menu-item", "is-label"]), new FakeRow("vibrant", ["menu-item"])];
  f.menu.emit("pointerover", { target: rowById(f.menu, "vibrant"), pointerType: "mouse" });
  f.menu.emit("pointerout", { target: rowById(f.menu, "vibrant"), relatedTarget: null, pointerType: "mouse" });
  assert.deepEqual(f.entries, []);
  f.menu.rows = [...themeRows(THEMES), new FakeRow("unexpected", ["menu-item"])];
  f.menu.emit("pointerover", { target: rowById(f.menu, "unexpected"), pointerType: "mouse" });
  assert.deepEqual(f.entries, []);
  // The same binding becomes active as soon as the count matches again.
  f.menu.rows = themeRows(THEMES);
  f.menu.emit("pointerover", { target: rowById(f.menu, "classic"), pointerType: "mouse" });
  assert.deepEqual(f.entries, ["enter:classic:classic"]);
});

test("touch pointers never start or end a preview", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  const vibrant = rowById(f.menu, "vibrant");
  f.menu.emit("pointerover", { target: vibrant, pointerType: "touch" });
  f.menu.emit("pointerout", { target: vibrant, relatedTarget: null, pointerType: "touch" });
  assert.deepEqual(f.entries, []);
  f.menu.emit("pointerover", { target: vibrant }); // no pointerType means a hovering pointer.
  assert.deepEqual(f.entries, ["enter:vibrant:vibrant"]);
});

test("the (any-hover: hover) gate disables binding on touch-only devices", () => {
  const gated = hoverMenu({ hover: false });
  gated.menu.rows = themeRows(THEMES);
  gated.menu.emit("pointerover", { target: rowById(gated.menu, "vibrant"), pointerType: "mouse" });
  assert.deepEqual(gated.entries, []);
  assert.equal(gated.menu.listenerCount, 0);
  const unknown = hoverMenu({ view: false }); // no matchMedia: assume hover support.
  assert.equal(unknown.menu.listenerCount, 3);
  unknown.menu.rows = themeRows(THEMES);
  unknown.menu.emit("pointerover", { target: rowById(unknown.menu, "vibrant"), pointerType: "mouse" });
  assert.deepEqual(unknown.entries, ["enter:vibrant:vibrant"]);
});

test("scrolling the menu drops the preview and a later hover re-enters", () => {
  const f = hoverMenu();
  f.menu.rows = themeRows(THEMES);
  const classic = rowById(f.menu, "classic");
  f.menu.emit("pointerover", { target: classic, pointerType: "mouse" });
  f.menu.emit("scroll");
  f.menu.emit("pointerover", { target: classic, pointerType: "mouse" });
  assert.deepEqual(f.entries, ["enter:classic:classic", "leave", "enter:classic:classic"]);
});

test("theme hover delegates pointers to the menu container and re-reads rows live", () => {
  const hover = readSource("../src/ui/menus/theme-menu-hover.ts");
  assert.match(hover, /export function bindThemeMenuHover\(\s*menu: HTMLElement,/);
  assert.match(hover, /menu\.addEventListener\("pointerover"/);
  assert.match(hover, /menu\.addEventListener\("pointerout"/);
  // Scroll events do not bubble, so the capture phase is required.
  assert.match(hover, /menu\.addEventListener\("scroll",[\s\S]*?\{ capture: true \}/);
  assert.match(hover, /closest\("\.menu-item"\)/);
  assert.match(hover, /const rows = queryMenuRows\(menu\);/);
  assert.match(hover, /if \(!isCompleteThemeRowMapping\(rows, themes\)\) return undefined;/);
  assert.match(hover, /event\.pointerType === "touch"/);
  // Leaving is reported only after the relatedTarget guard declined to stay.
  assert.match(hover, /event\.relatedTarget\)\) return;[\s\S]*?handlers\.onLeave\(\)/);
  assert.match(hover, /any-hover: hover/);
  // Realm independent and free of resident document listeners.
  assert.doesNotMatch(codeOnly(hover), /instanceof (?:Element|Node|HTMLElement)/);
  assert.doesNotMatch(hover, /document\.body/);
  assert.doesNotMatch(hover, /from "obsidian"/);
  assert.doesNotMatch(hover, /as any|@ts-ignore|@ts-expect-error/);
  const addCalls = hover.match(/\.addEventListener\(/g) ?? [];
  assert.equal(addCalls.length, 3);
  assert.equal((hover.match(/menu\.addEventListener\(/g) ?? []).length, 3);
});

test("tree settings menu wires live preview only for the theme list and keeps the plain path", () => {
  const source = readSource("../src/ui/menus/tree-settings-menu.ts");
  assert.match(source, /readonly previewTheme\?: \(theme: MindTreeTheme, anchor: HTMLElement\) => void;/);
  assert.match(source, /readonly endThemePreview\?: \(\) => void;/);
  assert.match(source, /this\.settings\.theme, this\.actions\.setTheme, THEME_OPTIONS\.map\(\(option\) => option\.value\)\)/);
  assert.equal(source.match(/THEME_OPTIONS\.map\(\(option\) => option\.value\)/g)?.length, 1);
  assert.match(source, /menu\.setUseNativeMenu\(false\)/);
  // One registration drops the preview when the list closes, one when the parent closes.
  assert.equal(source.match(/menu\.onHide\(\(\) => endThemePreview\(\)\)/g)?.length, 2);
  assert.match(source, /captureShownMenuElement\(this\.anchor\.ownerDocument/);
  assert.match(source, /bindThemeMenuHover\(element, previewThemes/);
  assert.match(source, /if \(!previewThemes \|\| !previewTheme \|\| !endThemePreview\) \{\r?\n\s+menu\.showAtPosition\(position\);/);
});
