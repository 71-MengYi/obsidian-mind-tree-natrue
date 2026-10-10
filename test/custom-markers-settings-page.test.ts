import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import {
  MAX_CUSTOM_EMOJI_LENGTH,
  MAX_CUSTOM_MARKER_ENTRIES,
  MAX_CUSTOM_TAG_LENGTH,
  type CustomMarkerDefinition,
  type CustomMarkerKind
} from "../src/domain/custom-markers";
import { translate } from "../src/i18n/catalog";
import { DEFAULT_SETTINGS, type MindTreeSettings } from "../src/settings-model";
import { EMOJI_CATALOG } from "../src/ui/emoji-data";
import type { SettingsPagePort } from "../src/ui/settings-pages/ports";

// Exercise the real settings page with only the Obsidian element helpers and
// the browser events it uses simulated, the same way the other DOM-level tests
// in this folder isolate the Obsidian boundary.
const bundle = buildSync({
  entryPoints: ["src/ui/settings-pages/custom-markers-settings-page.ts"],
  bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian"]
}).outputFiles[0]!.text;

interface ElementOptions {
  readonly cls?: string;
  readonly text?: string;
  readonly attr?: Readonly<Record<string, string>>;
  readonly type?: string;
}

interface EventInit {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly key?: string;
  readonly altKey?: boolean;
  readonly isComposing?: boolean;
  readonly relatedTarget?: TestElement | null;
  readonly dataTransfer?: TestDataTransfer | null;
}

class TestDataTransfer {
  readonly data = new Map<string, string>();
  effectAllowed = "none";
  dropEffect = "none";
  setData(format: string, value: string): void { this.data.set(format, value); }
  getData(format: string): string { return this.data.get(format) ?? ""; }
}

class TestEvent {
  defaultPrevented = false;
  propagationStopped = false;
  constructor(readonly type: string, private readonly init: EventInit = {}) {}
  get clientX(): number { return this.init.clientX ?? 0; }
  get clientY(): number { return this.init.clientY ?? 0; }
  get key(): string { return this.init.key ?? ""; }
  get altKey(): boolean { return this.init.altKey ?? false; }
  get isComposing(): boolean { return this.init.isComposing ?? false; }
  get relatedTarget(): TestElement | null { return this.init.relatedTarget ?? null; }
  get dataTransfer(): TestDataTransfer | null { return this.init.dataTransfer ?? null; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Obsidian's element extensions on top of a bubbling, non-rendering element. */
class TestElement {
  readonly children: TestElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly handlers = new Map<string, Array<(event: TestEvent) => void>>();
  parent?: TestElement;
  text = "";
  value = "";
  hidden = false;
  disabled = false;
  icon = "";
  rect: Rect = { left: 0, top: 0, right: 34, bottom: 34 };

  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") {}

  createEl(tag: string, options: ElementOptions | string = {}): TestElement {
    const child = new TestElement(this.ownerDocument, tag);
    const resolved = typeof options === "string" ? { cls: options } : options;    if (resolved.cls) child.addClass(resolved.cls);
    // Obsidian sets `text` after the tag is created, so `input.value` and
    // `element.text` share one slot here too.
    if (resolved.text !== undefined) { child.text = resolved.text; child.value = resolved.text; }
    if (resolved.type) child.setAttribute("type", resolved.type);
    for (const [name, value] of Object.entries(resolved.attr ?? {})) child.setAttribute(name, value);
    this.append(child);
    return child;
  }
  createDiv(options: ElementOptions | string = {}): TestElement { return this.createEl("div", options); }
  createSpan(options: ElementOptions | string = {}): TestElement { return this.createEl("span", options); }
  append(child: TestElement): void { child.parent = this; this.children.push(child); }
  empty(): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.text = "";
  }
  setText(text: string): void { this.empty(); this.text = text; }
  addClass(value: string): void { for (const name of value.split(" ")) if (name) this.classes.add(name); }
  removeClass(value: string): void { for (const name of value.split(" ")) this.classes.delete(name); }
  toggleClass(value: string, on: boolean): void { if (on) this.addClass(value); else this.removeClass(value); }
  hasClass(value: string): boolean { return this.classes.has(value); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, handler: (event: TestEvent) => void): void {
    const registered = this.handlers.get(type) ?? [];
    registered.push(handler);
    this.handlers.set(type, registered);
  }
  fire(type: string, init: EventInit = {}): TestEvent { return this.dispatchEvent(new TestEvent(type, init)); }
  dispatchEvent(event: TestEvent): TestEvent {
    let node: TestElement | undefined = this;
    while (node && !event.propagationStopped) {
      for (const handler of node.handlers.get(event.type) ?? []) handler(event);
      node = node.parent;
    }
    return event;
  }
  /** Only the selectors the page uses are supported; anything else is a bug. */
  matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    const attribute = /^\[data-marker-id="(.*)"\]$/.exec(selector);
    if (attribute) return this.dataset["markerId"] === (attribute[1] ?? "").replace(/\\(.)/g, "$1");
    // A bare tag name is how the harness reaches the search input.
    if (/^[a-z]+$/.test(selector)) return this.tag === selector;
    throw new Error(`unsupported selector: ${selector}`);
  }
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string): TestElement | undefined { return this.querySelectorAll(selector)[0]; }
  contains(other: TestElement | null): boolean {
    return other !== null && (other === this || this.children.some((child) => child.contains(other)));
  }
  getBoundingClientRect(): Rect & { width: number; height: number } {
    return { ...this.rect, width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top };
  }
  focus(): void { this.ownerDocument.activeElement = this; }
  all(): TestElement[] {
    // Iterative pre-order walk: the Emoji picker adds hundreds of buttons and a
    // recursive flatMap allocates an array per node on every scan.
    const result: TestElement[] = [];
    const pending: TestElement[] = [this];
    while (pending.length > 0) {
      const current = pending.pop()!;
      result.push(current);
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        pending.push(current.children[index]!);
      }
    }
    return result;
  }
}

class TestDocument {
  activeElement?: TestElement;
  createElement(tag: string): TestElement { return new TestElement(this, tag); }
}

type PageInstance = { readonly element: TestElement };
type PageConstructor = new (parent: TestElement, port: SettingsPagePort) => PageInstance;

const module = { exports: {} as Record<string, unknown> };
runInNewContext(bundle, {
  module,
  exports: module.exports,
  console,
  // `CSS.escape` is supplied the way the browser supplies it, so the page's
  // focus restoration runs unchanged.
  CSS: { escape: (value: string) => value.replace(/["\\]/g, (character) => `\\${character}`) },
  require: (id: string) => {
    assert.equal(id, "obsidian");
    return {
      getLanguage: () => "en",
      setIcon: (element: TestElement, name: string) => { element.icon = name; }
    };
  }
});
const Page = module.exports["CustomMarkersSettingsPage"] as PageConstructor;

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  assert.ok(item, `expected ${what} at index ${index}`);
  return item;
}

/**
 * Distinct ids and values so a seeded group never collides with a test value.
 * Emoji seeds use real catalogue glyphs, because an Emoji definition can only
 * ever hold one emoji; text tags stay free-form.
 */
function seed(kind: CustomMarkerKind, count: number): CustomMarkerDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `mtn-${kind}-seed-${index}`,
    kind,
    value: kind === "emoji" ? at(EMOJI_CATALOG, index, "catalogue entry").g : `${kind}-${index}`
  }));
}

interface Harness {
  readonly document: TestDocument;
  readonly root: TestElement;
  readonly settings: MindTreeSettings;
  readonly calls: string[];
  grid(kind: CustomMarkerKind): TestElement;
  input(kind: CustomMarkerKind): TestElement;
  addButton(kind: CustomMarkerKind): TestElement;
  error(kind: CustomMarkerKind): TestElement;
  emptyNote(kind: CustomMarkerKind): TestElement;
  tiles(kind: CustomMarkerKind): TestElement[];
  /** The Emoji group is a picker: a search field plus a filtered list. */
  pickerItems(): TestElement[];
  pickerEmpty(): TestElement;
  pickerStatus(): TestElement;
  search(query: string): void;
  /**
   * Add one catalogue entry the way a user does: narrow the list with a keyword
   * and click the resulting entry. The default list is only the head of the
   * catalogue, so a test must not assume a glyph is already on screen.
   */
  pick(query: string, emoji: string): void;
  layout(kind: CustomMarkerKind, perRow?: number): void;
  failSave(error?: Error): void;
  failRefresh(error?: Error): void;
}

function fixture(options: { readonly markers?: readonly CustomMarkerDefinition[] } = {}): Harness {
  const document = new TestDocument();
  const root = document.createElement("div");
  const settings: MindTreeSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    customMarkers: [...(options.markers ?? [])]
  };
  const calls: string[] = [];
  let saveFailure: Error | undefined;
  let refreshFailure: Error | undefined;
  const port: SettingsPagePort = {
    settings,
    save: async () => {
      calls.push("save");
      if (saveFailure) throw saveFailure;
    },
    refreshOpenLayouts: () => {
      calls.push("refresh");
      if (refreshFailure) throw refreshFailure;
    },
    rebuildResourceIndex: async () => assert.fail("the marker page never rebuilds the file index"),
    updates: {
      check: async () => assert.fail("the marker page never checks for updates"),
      showAvailable: () => assert.fail("the marker page never opens the update dialog"),
      subscribe: () => () => undefined
    }
  };
  const page = new Page(root, port);
  assert.equal(page.element, root, "the page must expose the panel it filled");

  const byClass = (name: string): TestElement[] => root.all().filter((element) => element.hasClass(name));
  /**
   * Locate one group's own element. The page renders the Emoji section before
   * the text tag section, and this file has always selected by that order; the
   * picker only adds nodes *inside* the Emoji section, so the indices hold.
   */
  const group = (kind: CustomMarkerKind, name: string): TestElement =>
    at(byClass(name), kind === "emoji" ? 0 : 1, `${kind} ${name}`);
  const tiles = (kind: CustomMarkerKind): TestElement[] =>
    group(kind, "mtn-custom-marker-grid").querySelectorAll(".mtn-custom-marker-tile");
  const pickerList = (): TestElement => at(byClass("mtn-emoji-picker-list"), 0, "emoji picker list");
  const searchField = (): TestElement => {
    const addRow = group("emoji", "mtn-custom-marker-add");
    return addRow.querySelectorAll(".mtn-emoji-search")[0]
      ?.querySelectorAll("input")[0] ?? assert.fail("emoji picker has no search field");
  };
  const tagRow = (): TestElement => group("tag", "mtn-custom-marker-add");

  return {
    document,
    root,
    settings,
    calls,
    grid: (kind) => group(kind, "mtn-custom-marker-grid"),
    input: (kind) => kind === "emoji"
      ? searchField()
      : at(tagRow().children, 0, `${kind} input`),
    addButton: (kind) => kind === "emoji"
      ? assert.fail("the Emoji picker has no Add button")
      : at(group(kind, "mtn-custom-marker-add").children, 1, `${kind} Add button`),
    error: (kind) => group(kind, "mtn-setting-inline-error"),
    emptyNote: (kind) => group(kind, "mtn-custom-marker-empty"),
    tiles,
    pickerItems: () => pickerList().querySelectorAll(".mtn-emoji-picker-item"),
    pickerEmpty: () => at(byClass("mtn-emoji-picker-empty"), 0, "emoji picker empty note"),
    pickerStatus: () => at(byClass("mtn-emoji-picker-status"), 0, "emoji picker status"),    search: (query) => {
      const field = searchField();
      field.value = query;
      field.fire("input");
    },
    pick: (query, emoji) => {
      const field = searchField();
      field.value = query;
      field.fire("input");
      const item = pickerList().children.find((child) =>
        child.hasClass("mtn-emoji-picker-item") && child.attributes.get("data-emoji") === emoji);
      assert.ok(item, `expected a picker entry for ${emoji} after searching ${query}`);
      assert.equal(item.disabled, false, `${emoji} must still be pickable`);
      item.fire("click");
    },
    layout: (kind, perRow = 3) => {
      tiles(kind).forEach((tile, index) => {
        const left = (index % perRow) * 42;
        const top = Math.floor(index / perRow) * 42;
        tile.rect = { left, top, right: left + 34, bottom: top + 34 };
      });
    },
    failSave: (error) => { saveFailure = error; },
    failRefresh: (error) => { refreshFailure = error; }
  };
}

// The page mutates `settings.customMarkers` with arrays created inside the VM
// realm, so both helpers rebuild their result with this realm's Array.
const idsOf = (harness: Harness, kind: CustomMarkerKind = "emoji"): string[] => {
  const ids: string[] = [];
  for (const definition of harness.settings.customMarkers) {
    if (definition.kind === kind) ids.push(definition.id);
  }
  return ids;
};
const valuesOf = (harness: Harness, kind: CustomMarkerKind = "emoji"): string[] => {
  const values: string[] = [];
  for (const definition of harness.settings.customMarkers) {
    if (definition.kind === kind) values.push(definition.value);
  }
  return values;
};
const tileOf = (harness: Harness, id: string, kind: CustomMarkerKind = "emoji"): TestElement =>
  at(harness.tiles(kind).filter((tile) => tile.dataset["markerId"] === id), 0, `tile for ${id}`);
const removeButton = (tile: TestElement): TestElement =>
  at(tile.querySelectorAll(".mtn-custom-marker-remove"), 0, "remove button");
const altArrow = (tile: TestElement, key: "ArrowLeft" | "ArrowRight"): TestEvent =>
  tile.fire("keydown", { key, altKey: true });
const pressEnter = (harness: Harness, kind: CustomMarkerKind, init: EventInit = {}): TestEvent =>
  harness.input(kind).fire("keydown", { key: "Enter", ...init });
const startDrag = (tile: TestElement): TestDataTransfer => {
  const dataTransfer = new TestDataTransfer();
  tile.fire("dragstart", { dataTransfer });
  return dataTransfer;
};
const hoverLeftHalf = (harness: Harness, tile: TestElement, kind: CustomMarkerKind = "emoji", dataTransfer?: TestDataTransfer): TestEvent =>
  harness.grid(kind).fire("dragover", { clientX: tile.rect.left + 1, clientY: tile.rect.top + 1, dataTransfer: dataTransfer ?? null });
const dropLeftHalf = (harness: Harness, tile: TestElement, kind: CustomMarkerKind = "emoji"): TestEvent =>
  harness.grid(kind).fire("drop", { clientX: tile.rect.left + 1, clientY: tile.rect.top + 1 });
const settle = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

test("renders both groups in order with headings, descriptions, grids, notes and add rows", () => {
  const h = fixture();
  assert.equal(at(h.root.children, 0, "page heading").text, translate("settings.tabs.customMarkers", "en"));

  const headings = h.root.all().filter((element) => element.tag === "h4").map((element) => element.text);
  assert.deepEqual(headings, [
    translate("settings.customMarkers.emoji.heading", "en"),
    translate("settings.customMarkers.tag.heading", "en")
  ]);

  const descriptions = h.root.all().filter((element) => element.hasClass("setting-item-description"));
  assert.deepEqual(descriptions.map((element) => element.text), [
    translate("settings.customMarkers.emoji.desc", "en", { count: MAX_CUSTOM_MARKER_ENTRIES }),
    translate("settings.customMarkers.tag.desc", "en", {
      count: MAX_CUSTOM_MARKER_ENTRIES, length: MAX_CUSTOM_TAG_LENGTH
    })
  ]);
  // Both descriptions state the shared entry cap; only the tag copy mentions a
  // per-entry character limit, because Emoji values come from the catalogue.
  for (const [index] of descriptions.entries()) {
    const description = at(descriptions, index, "group description");
    assert.match(description.text, new RegExp(String(MAX_CUSTOM_MARKER_ENTRIES)));
    assert.doesNotMatch(description.text, /\{\w+\}/);
  }
  assert.match(at(descriptions, 1, "tag description").text, new RegExp(String(MAX_CUSTOM_TAG_LENGTH)));

  for (const kind of ["emoji", "tag"] as const) {
    const grid = h.grid(kind);
    assert.equal(grid.getAttribute("role"), "list");
    assert.equal(grid.getAttribute("aria-label"), translate(`settings.customMarkers.${kind}.heading`, "en"));
    assert.equal(grid.children.length, 0, "a group without definitions must render an empty grid");
    assert.equal(grid.text, "");

    assert.equal(h.input(kind).tag, "input");
    if (kind === "tag") {
      assert.equal(h.addButton("tag").tag, "button");
      assert.equal(h.addButton("tag").text, translate("settings.customMarkers.add", "en"));
      assert.equal(h.addButton("tag").getAttribute("type"), "button");
    }
  }

  // The Emoji group is a picker: a search field with a magnifier and a
  // scrollable, filtered list. The text tag group keeps a plain text field.
  const search = h.input("emoji");
  assert.equal(search.getAttribute("type"), "search");
  assert.equal(search.getAttribute("placeholder"), translate("settings.customMarkers.emoji.search", "en"));
  assert.equal(search.getAttribute("aria-label"), translate("settings.customMarkers.emoji.search", "en"));
  const magnifier = at(
    h.root.all().filter((element) => element.hasClass("mtn-emoji-search-icon")), 0, "magnifier"
  );
  assert.equal(magnifier.icon, "search");
  assert.equal(magnifier.getAttribute("aria-hidden"), "true");
  assert.equal(h.pickerItems().length > 0, true, "the picker shows a default list before any search");
  assert.equal(h.pickerItems()[0]!.tag, "button");
  assert.equal(h.pickerItems()[0]!.getAttribute("type"), "button");
  assert.equal(h.pickerItems()[0]!.disabled, false);

  const tagInput = h.input("tag");
  assert.equal(tagInput.getAttribute("type"), "text");
  assert.equal(tagInput.getAttribute("placeholder"), translate("settings.customMarkers.tag.placeholder", "en"));
  assert.equal(tagInput.getAttribute("aria-label"), translate("settings.customMarkers.tag.placeholder", "en"));
});

test("tiles keep the draggable list contract and expose named remove buttons", () => {
  const h = fixture({
    markers: [
      { id: "mtn-emoji-a", kind: "emoji", value: "🔥" },
      { id: "mtn-tag-b", kind: "tag", value: "绘图" }
    ]
  });

  const emojiTile = at(h.tiles("emoji"), 0, "emoji tile");
  assert.equal(emojiTile.getAttribute("role"), "listitem");
  assert.equal(emojiTile.getAttribute("draggable"), "true");
  assert.equal(emojiTile.getAttribute("tabindex"), "0");
  assert.equal(emojiTile.dataset["markerId"], "mtn-emoji-a");
  assert.equal(emojiTile.text, "🔥");
  assert.equal(emojiTile.getAttribute("aria-keyshortcuts"), "Alt+ArrowLeft Alt+ArrowRight");
  assert.equal(emojiTile.getAttribute("aria-label"),
    translate("settings.customMarkers.dragEmoji", "en", { value: "🔥" }));

  const remove = removeButton(emojiTile);
  assert.equal(remove.tag, "button");
  assert.equal(remove.getAttribute("type"), "button");
  assert.equal(remove.icon, "x");
  assert.equal(remove.getAttribute("aria-label"),
    translate("settings.customMarkers.removeEmoji", "en", { value: "🔥" }));

  const tagTile = at(h.tiles("tag"), 0, "tag tile");
  assert.equal(at(tagTile.querySelectorAll(".mtn-custom-marker-tile-label"), 0, "tag label").text, "绘图");
  assert.equal(tagTile.getAttribute("aria-label"),
    translate("settings.customMarkers.dragTag", "en", { value: "绘图" }));
  assert.equal(removeButton(tagTile).getAttribute("aria-label"),
    translate("settings.customMarkers.removeTag", "en", { value: "绘图" }));
});

test("picking an emoji appends it and the tag Add button appends the cleaned value", () => {
  const h = fixture();
  h.pick("fire", "🔥");

  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  assert.equal(h.tiles("emoji").length, 1);
  assert.deepEqual(h.calls, ["refresh", "save"]);
  const added = at(h.settings.customMarkers, 0, "added marker");
  assert.equal(added.kind, "emoji");
  assert.match(added.id, /^mtn-emoji-[a-z0-9]+$/);

  h.input("tag").value = "绘图";
  h.addButton("tag").fire("click");
  assert.deepEqual(valuesOf(h, "tag"), ["绘图"]);
  assert.equal(h.input("tag").value, "");
  assert.deepEqual(h.calls, ["refresh", "save", "refresh", "save"]);
  // The two groups are separate namespaces and keep their own order.
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
});

test("the search field filters the emoji list live and reports the result count", () => {
  const h = fixture();
  // The whole catalogue is in the DOM, so browsing works without a query.
  const all = h.pickerItems();
  assert.equal(all.length, EMOJI_CATALOG.length);
  assert.equal(all.filter((item) => item.hidden).length, 0, "nothing is hidden before a search");
  assert.equal(h.pickerStatus().text,
    translate("settings.customMarkers.emoji.total", "en", { count: EMOJI_CATALOG.length }));
  assert.equal(h.pickerEmpty().hidden, true);
  // The last catalogue entry is reachable by scrolling, not only by searching.
  assert.equal(all.at(-1)!.attributes.get("data-emoji"), EMOJI_CATALOG.at(-1)!.g);

  h.search("中国");
  const visible = h.pickerItems().filter((item) => !item.hidden);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.attributes.get("data-emoji"), "🇨🇳");
  assert.equal(visible[0]!.getAttribute("aria-label"), "flag China");
  assert.equal(h.pickerStatus().text,
    translate("settings.customMarkers.emoji.showing", "en", { shown: 1, total: 1 }));
  assert.equal(h.pickerEmpty().hidden, true);

  h.search("zzzzzz");
  assert.equal(h.pickerItems().filter((item) => !item.hidden).length, 0);
  assert.equal(h.pickerEmpty().hidden, false);
  assert.equal(h.pickerEmpty().text,
    translate("settings.customMarkers.emoji.noResults", "en", { query: "zzzzzz" }));

  h.search("");
  assert.equal(h.pickerItems().filter((item) => !item.hidden).length, EMOJI_CATALOG.length,
    "clearing the query restores the full list");
  assert.equal(h.pickerEmpty().hidden, true);
});

test("an emoji already in the grid is shown as added and cannot be picked twice", () => {
  const h = fixture();
  h.pick("fire", "🔥");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  assert.deepEqual(h.calls, ["refresh", "save"]);

  const addedItem = at(
    h.pickerItems().filter((item) => item.attributes.get("data-emoji") === "🔥"),
    0, "picked emoji entry"
  );
  assert.equal(addedItem.hasClass("is-added"), true);
  assert.equal(addedItem.disabled, true);
  assert.match(addedItem.getAttribute("aria-label")!, /already added/i);
  assert.equal(addedItem.icon, "", "a picker entry is text-only, never an icon lookup");
  // A disabled entry cannot be activated again, so no duplicate write happens.
  assert.deepEqual(h.calls, ["refresh", "save"]);
  assert.equal(h.settings.customMarkers.length, 1);
});

test("the Emoji group never stores free text because only catalogue entries can be picked", () => {
  const h = fixture();
  assert.equal(h.settings.customMarkers.length, 0);
  // There is no free-text path in the Emoji group at all: typing only filters.
  h.search("绘图");
  assert.ok(h.pickerItems().every((item) => item.tag === "button"));
  assert.equal(h.settings.customMarkers.length, 0);
  assert.deepEqual(h.calls, []);

  h.search("smile");
  assert.ok(h.pickerItems().length > 3, "an English keyword reaches several entries");
  const first = at(h.pickerItems(), 0, "first search result");
  first.fire("click");
  assert.equal(h.settings.customMarkers.length, 1);
  assert.equal(at(h.settings.customMarkers, 0, "picked marker").kind, "emoji");
  assert.equal(at(h.settings.customMarkers, 0, "picked marker").value, first.text);
});

test("blank, whitespace and invisible-only tag input is rejected without writing", () => {
  // Empty and whitespace-only inputs have nothing to store; a value made only
  // of hidden characters is reported as unsafe, which is the exact problem.
  // The Emoji group has no free-text path at all, so this rule is the tag one.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "settings.customMarkers.error.empty"],
    ["   ", "settings.customMarkers.error.empty"],
    ["\u200B", "settings.customMarkers.error.unsafe"],
    ["\uFEFF", "settings.customMarkers.error.unsafe"],
    ["\u200B\u200D", "settings.customMarkers.error.unsafe"]
  ];
  for (const [value, errorKey] of cases) {
    const h = fixture();
    h.input("tag").value = value;
    pressEnter(h, "tag");
    assert.equal(h.settings.customMarkers.length, 0, JSON.stringify(value));
    assert.deepEqual(h.calls, [], JSON.stringify(value));
    assert.equal(h.error("tag").text, translate(errorKey as Parameters<typeof translate>[0], "en"), JSON.stringify(value));
    assert.equal(h.error("tag").hasClass("is-visible"), true);
    assert.doesNotMatch(h.error("tag").text, /\{\w+\}/);
  }
});

test("a duplicate value is rejected after cleaning while the typed text is kept", () => {
  const h = fixture({ markers: [{ id: "mtn-tag-1", kind: "tag", value: "绘图" }] });
  h.input("tag").value = " 绘图 ";
  pressEnter(h, "tag");

  assert.deepEqual(valuesOf(h, "tag"), ["绘图"]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.error("tag").text, translate("settings.customMarkers.error.duplicate", "en"));
  assert.doesNotMatch(h.error("tag").text, /\{\w+\}/);
  assert.equal(h.input("tag").value, " 绘图 ", "rejected text stays available for editing");

  // Unicode whitespace folds into the same canonical value, so it is a duplicate too.
  const folded = fixture({ markers: [{ id: "mtn-tag-1", kind: "tag", value: "绘 图" }] });
  folded.input("tag").value = "绘\u3000图";
  pressEnter(folded, "tag");
  assert.deepEqual(folded.calls, []);
  assert.equal(folded.error("tag").text, translate("settings.customMarkers.error.duplicate", "en"));
});

test("an over-long tag reports the group's own character limit with the count substituted", () => {
  const h = fixture();
  // The Emoji group cannot receive a long value: the picker only offers single
  // glyphs, so the length rule is exercised through the tag field.
  h.input("tag").value = "绘".repeat(MAX_CUSTOM_TAG_LENGTH + 1);
  pressEnter(h, "tag");
  assert.equal(h.error("tag").text,
    translate("settings.customMarkers.error.tooLong", "en", { length: MAX_CUSTOM_TAG_LENGTH }));
  assert.match(h.error("tag").text, new RegExp(String(MAX_CUSTOM_TAG_LENGTH)));
  assert.doesNotMatch(h.error("tag").text, /\{\w+\}/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.settings.customMarkers.length, 0);
});

test("invisible and bidirectional characters are rejected as unsafe", () => {
  for (const value of ["绘\u200B图", "a\u202Eb", "绘\u2066图", "\uFEFF绘图"]) {
    const h = fixture();
    h.input("tag").value = value;
    pressEnter(h, "tag");
    assert.equal(h.settings.customMarkers.length, 0, JSON.stringify(value));
    assert.deepEqual(h.calls, [], JSON.stringify(value));
    assert.equal(h.error("tag").text, translate("settings.customMarkers.error.unsafe", "en"));
    assert.doesNotMatch(h.error("tag").text, /\{\w+\}/);
  }
});

test("the entry cap applies per group and never grows that group", () => {
  // Seed with real catalogue glyphs: an Emoji definition can only ever hold a
  // single emoji, so seeding text would describe a state the page cannot reach.
  const seeded = EMOJI_CATALOG.slice(0, MAX_CUSTOM_MARKER_ENTRIES).map((entry, index) =>
    ({ id: `mtn-emoji-seed-${index}`, kind: "emoji" as const, value: entry.g }));
  const h = fixture({ markers: seeded });
  assert.equal(h.tiles("emoji").length, MAX_CUSTOM_MARKER_ENTRIES);

  // Every seeded entry is disabled in the picker, and an already-added entry
  // cannot be picked again, so the Emoji group cannot grow past the cap.
  const items = h.pickerItems();
  const disabledValues = items.filter((item) => item.disabled)
    .map((item) => item.attributes.get("data-emoji"));
  assert.ok(items.length > 0, "the picker still renders a list");
  assert.deepEqual(
    [...disabledValues].sort(),
    seeded.map((definition) => definition.value).sort(),
    "exactly the seeded emoji are marked as added"
  );
  const pickable = items.find((item) => !item.disabled);
  if (pickable) {
    pickable.fire("click");
    assert.equal(h.settings.customMarkers.length, MAX_CUSTOM_MARKER_ENTRIES,
      "the group cap rejects the extra Emoji");
  }
  assert.deepEqual(h.calls, []);

  // The cap is per group: a full Emoji list must not consume the text tag
  // budget, because the settings page presents the two as independent lists.
  h.input("tag").value = "绘图";
  pressEnter(h, "tag");
  assert.deepEqual(valuesOf(h, "tag"), ["绘图"]);
  assert.equal(h.settings.customMarkers.length, MAX_CUSTOM_MARKER_ENTRIES + 1);
  assert.notEqual(h.error("tag").text, translate("settings.customMarkers.error.limit", "en",
    { count: MAX_CUSTOM_MARKER_ENTRIES }));
});

test("each group owns its message element and typing clears only that message", () => {
  const h = fixture();
  h.input("tag").value = "   ";
  pressEnter(h, "tag");
  assert.equal(h.error("tag").hasClass("is-visible"), true);
  assert.equal(h.error("emoji").text, "");

  h.input("tag").fire("input");
  assert.equal(h.error("tag").text, "");
  assert.equal(h.error("tag").hasClass("is-visible"), false);
  assert.equal(h.error("emoji").text, "");
});

test("each group shows its empty note only while that group has no entries", () => {
  const h = fixture();
  assert.equal(h.emptyNote("emoji").hidden, false);
  assert.equal(h.emptyNote("tag").hidden, false);
  assert.equal(h.emptyNote("emoji").text, translate("settings.customMarkers.emoji.empty", "en"));
  assert.equal(h.emptyNote("tag").text, translate("settings.customMarkers.tag.empty", "en"));
  assert.equal(h.emptyNote("emoji").hasClass("is-visible"), true);

  h.pick("fire", "🔥");
  assert.equal(h.emptyNote("emoji").hidden, true);
  assert.equal(h.emptyNote("emoji").hasClass("is-visible"), false);
  assert.equal(h.emptyNote("tag").hidden, false);
  // The note is a sibling of the grid, so an empty grid stays truly empty.
  assert.equal(h.grid("emoji").children.length, 1);
  assert.equal(h.grid("tag").children.length, 0);
  assert.equal(h.grid("tag").querySelectorAll(".mtn-custom-marker-empty").length, 0);
});

test("Alt+ArrowRight moves the first and middle tiles one slot right and stops at the end", () => {
  const h = fixture({ markers: seed("emoji", 3) });
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-0", "mtn-emoji-seed-1", "mtn-emoji-seed-2"]);

  altArrow(tileOf(h, "mtn-emoji-seed-0"), "ArrowRight");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-0", "mtn-emoji-seed-2"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-0"), "focus follows the moved tile");
  assert.deepEqual(h.calls, ["refresh", "save"]);

  altArrow(tileOf(h, "mtn-emoji-seed-0"), "ArrowRight");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-2", "mtn-emoji-seed-0"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-0"));

  // The last tile has nowhere to go and must not commit or save.
  const last = altArrow(tileOf(h, "mtn-emoji-seed-0"), "ArrowRight");
  assert.equal(last.defaultPrevented, true, "the browser default is still suppressed");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-2", "mtn-emoji-seed-0"]);
  assert.deepEqual(h.calls, ["refresh", "save", "refresh", "save"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-0"));
});

test("Alt+ArrowLeft moves the last and middle tiles one slot left and stops at the start", () => {
  const h = fixture({ markers: seed("emoji", 3) });

  altArrow(tileOf(h, "mtn-emoji-seed-2"), "ArrowLeft");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-0", "mtn-emoji-seed-2", "mtn-emoji-seed-1"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-2"));
  assert.deepEqual(h.calls, ["refresh", "save"]);

  altArrow(tileOf(h, "mtn-emoji-seed-2"), "ArrowLeft");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-2", "mtn-emoji-seed-0", "mtn-emoji-seed-1"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-2"));

  const first = altArrow(tileOf(h, "mtn-emoji-seed-2"), "ArrowLeft");
  assert.equal(first.defaultPrevented, true);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-2", "mtn-emoji-seed-0", "mtn-emoji-seed-1"]);
  assert.deepEqual(h.calls, ["refresh", "save", "refresh", "save"]);
});

test("reordering needs Alt plus a horizontal arrow", () => {
  const h = fixture({ markers: seed("emoji", 3) });
  const before = idsOf(h);
  const tile = tileOf(h, "mtn-emoji-seed-1");

  tile.fire("keydown", { key: "ArrowRight" });
  tile.fire("keydown", { key: "ArrowLeft" });
  tile.fire("keydown", { key: "ArrowUp", altKey: true });
  tile.fire("keydown", { key: "ArrowDown", altKey: true });
  tile.fire("keydown", { key: "a", altKey: true });

  assert.deepEqual(idsOf(h), before);
  assert.deepEqual(h.calls, []);
});

test("dragover highlights the tile whose slot the drop uses and pushes that tile back", () => {
  const h = fixture({ markers: seed("emoji", 3) });
  h.layout("emoji");
  const dragged = tileOf(h, "mtn-emoji-seed-0");
  const over = tileOf(h, "mtn-emoji-seed-2");

  const dataTransfer = startDrag(dragged);
  assert.equal(dataTransfer.getData("text/plain"), "mtn-emoji-seed-0");
  assert.equal(dataTransfer.effectAllowed, "move");
  assert.equal(dragged.hasClass("is-dragging"), true);

  const highlight = hoverLeftHalf(h, over, "emoji", dataTransfer);
  assert.equal(highlight.defaultPrevented, true, "a dragover over the grid allows the drop");
  assert.equal(dataTransfer.dropEffect, "move");
  assert.equal(over.hasClass("is-drop-target"), true);
  assert.equal(h.tiles("emoji").filter((tile) => tile.hasClass("is-drop-target")).length, 1);
  assert.equal(h.grid("emoji").hasClass("is-drop-end"), false);

  dropLeftHalf(h, over);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-0", "mtn-emoji-seed-2"]);
  assert.deepEqual(h.calls, ["refresh", "save"]);
  assert.equal(h.tiles("emoji").some((tile) => tile.hasClass("is-drop-target")), false);
  assert.equal(h.tiles("emoji").some((tile) => tile.hasClass("is-dragging")), false);
});

test("a cross-row drag pushes the target row back and can move a tile to the front", () => {
  const h = fixture({ markers: seed("emoji", 4) });
  h.layout("emoji", 2);
  assert.deepEqual(h.tiles("emoji").map((tile) => [tile.rect.left, tile.rect.top]), [
    [0, 0], [42, 0], [0, 42], [42, 42]
  ]);

  // Drag the last tile of the second row onto the first tile of that row.
  startDrag(tileOf(h, "mtn-emoji-seed-3"));
  const target = tileOf(h, "mtn-emoji-seed-2");
  hoverLeftHalf(h, target);
  assert.equal(target.hasClass("is-drop-target"), true);
  dropLeftHalf(h, target);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-0", "mtn-emoji-seed-1", "mtn-emoji-seed-3", "mtn-emoji-seed-2"]);

  // Drag a row-1 tile into the second row: it lands before the target there.
  h.layout("emoji", 2);
  startDrag(tileOf(h, "mtn-emoji-seed-0"));
  const secondRow = tileOf(h, "mtn-emoji-seed-3");
  hoverLeftHalf(h, secondRow);
  assert.equal(secondRow.hasClass("is-drop-target"), true);
  dropLeftHalf(h, secondRow);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-0", "mtn-emoji-seed-3", "mtn-emoji-seed-2"]);

  // Drag a tile onto its own slot: the order must not change.
  h.layout("emoji", 2);
  startDrag(tileOf(h, "mtn-emoji-seed-0"));
  const itself = tileOf(h, "mtn-emoji-seed-0");
  hoverLeftHalf(h, itself);
  dropLeftHalf(h, itself);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-0", "mtn-emoji-seed-3", "mtn-emoji-seed-2"]);

  // Drag the last tile onto the very first tile: it becomes the first entry.
  h.layout("emoji", 2);
  startDrag(tileOf(h, "mtn-emoji-seed-2"));
  const first = tileOf(h, "mtn-emoji-seed-1");
  hoverLeftHalf(h, first);
  assert.equal(first.hasClass("is-drop-target"), true);
  dropLeftHalf(h, first);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-2", "mtn-emoji-seed-1", "mtn-emoji-seed-0", "mtn-emoji-seed-3"]);
});

test("dropping past the last tile appends it and marks the end of the grid", () => {
  const h = fixture({ markers: seed("emoji", 3) });
  h.layout("emoji");
  const dragged = tileOf(h, "mtn-emoji-seed-0");
  const last = tileOf(h, "mtn-emoji-seed-2");

  startDrag(dragged);
  const beyond = { clientX: last.rect.right + 1, clientY: last.rect.top + 1 };
  h.grid("emoji").fire("dragover", beyond);
  assert.equal(h.grid("emoji").hasClass("is-drop-end"), true);
  assert.equal(h.tiles("emoji").some((tile) => tile.hasClass("is-drop-target")), false);

  h.grid("emoji").fire("drop", beyond);
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-1", "mtn-emoji-seed-2", "mtn-emoji-seed-0"]);
  assert.equal(h.grid("emoji").hasClass("is-drop-end"), false);
  assert.deepEqual(h.calls, ["refresh", "save"]);

  // A drag that ends outside the grid clears its own state without a reorder.
  h.layout("emoji");
  const kept = idsOf(h);
  const lastTile = at(h.tiles("emoji").slice(-1), 0, "last tile");
  const endDrop = { clientX: lastTile.rect.right + 1, clientY: lastTile.rect.top + 1 };
  const cancel = startDrag(tileOf(h, "mtn-emoji-seed-0"));
  assert.equal(cancel.getData("text/plain"), "mtn-emoji-seed-0");
  h.grid("emoji").fire("dragover", endDrop);
  assert.equal(h.grid("emoji").hasClass("is-drop-end"), true);
  h.grid("emoji").fire("dragleave", { relatedTarget: null });
  assert.equal(h.grid("emoji").hasClass("is-drop-end"), false);
  tileOf(h, "mtn-emoji-seed-0").fire("dragend");
  assert.equal(h.tiles("emoji").some((tile) => tile.hasClass("is-dragging")), false);
  assert.deepEqual(idsOf(h), kept);
  assert.deepEqual(h.calls, ["refresh", "save"]);
});

test("removing a tile updates the group and keeps keyboard focus inside the list", () => {
  // Real glyphs, because the Emoji group only ever holds catalogue entries.
  const h = fixture({
    markers: EMOJI_CATALOG.slice(0, 3).map((entry, index) =>
      ({ id: `mtn-emoji-seed-${index}`, kind: "emoji" as const, value: entry.g }))
  });

  removeButton(tileOf(h, "mtn-emoji-seed-1")).fire("click");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-0", "mtn-emoji-seed-2"]);
  assert.deepEqual(h.calls, ["refresh", "save"]);
  assert.equal(h.tiles("emoji").length, 2);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-2"), "focus takes the freed slot");

  removeButton(tileOf(h, "mtn-emoji-seed-2")).fire("click");
  assert.deepEqual(idsOf(h), ["mtn-emoji-seed-0"]);
  assert.equal(h.document.activeElement, tileOf(h, "mtn-emoji-seed-0"), "the last tile hands focus back");

  removeButton(tileOf(h, "mtn-emoji-seed-0")).fire("click");
  assert.deepEqual(idsOf(h), []);
  assert.equal(h.tiles("emoji").length, 0);
  assert.equal(h.emptyNote("emoji").hidden, false);
  assert.equal(h.document.activeElement, h.input("emoji"), "an empty group focuses its input");
  assert.deepEqual(h.calls, ["refresh", "save", "refresh", "save", "refresh", "save"]);
});

test("a failed save reports the save message without rolling back the change", async () => {
  const h = fixture();
  h.failSave(new Error("disk full"));

  h.pick("fire", "🔥");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"], "the panel keeps the change it already rendered");
  assert.equal(h.error("emoji").text, "", "the rejection arrives after the click handler returns");

  await settle();
  assert.equal(h.error("emoji").text, translate("settings.customMarkers.error.save", "en"));
  assert.equal(h.error("emoji").hasClass("is-visible"), true);
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
  assert.deepEqual(h.calls, ["refresh", "save"]);

  h.failSave(undefined);
  h.pick("art", "🎨");
  await settle();
  assert.equal(h.error("emoji").text, "");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥", "🎨"]);
});

test("a failing canvas refresh still persists the change and says the canvas is stale", async () => {
  const h = fixture();
  h.failRefresh(new Error("canvas render failed"));

  h.pick("fire", "🔥");
  await settle();

  assert.deepEqual(h.calls, ["refresh", "save"], "the settings write must not be skipped");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  // The change did reach data.json, so the message must not claim a failed save.
  assert.equal(h.error("emoji").text, translate("settings.customMarkers.error.refresh", "en"));
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
  assert.notEqual(h.error("emoji").text, translate("settings.customMarkers.error.save", "en"));
});

test("a tag Enter that would compose an IME candidate is left to the IME", () => {
  const h = fixture();
  h.input("tag").value = "绘图";
  const composing = pressEnter(h, "tag", { isComposing: true });
  assert.equal(h.settings.customMarkers.length, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(composing.defaultPrevented, false, "the IME keeps its own Enter handling");
  assert.equal(h.input("tag").value, "绘图");

  pressEnter(h, "tag");
  assert.deepEqual(valuesOf(h, "tag"), ["绘图"]);
  assert.equal(h.input("tag").value, "");
});
