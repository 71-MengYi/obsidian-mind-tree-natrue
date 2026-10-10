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
  icon = "";
  rect: Rect = { left: 0, top: 0, right: 34, bottom: 34 };

  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") {}

  createEl(tag: string, options: ElementOptions | string = {}): TestElement {
    const child = new TestElement(this.ownerDocument, tag);
    const resolved = typeof options === "string" ? { cls: options } : options;
    if (resolved.cls) child.addClass(resolved.cls);
    if (resolved.text !== undefined) child.text = resolved.text;
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
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())]; }
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

/** Distinct ids and values so a seeded group never collides with a test value. */
function seed(kind: CustomMarkerKind, count: number): CustomMarkerDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `mtn-${kind}-seed-${index}`,
    kind,
    value: `${kind}-${index}`
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
  const group = (kind: CustomMarkerKind, name: string): TestElement =>
    at(byClass(name), kind === "emoji" ? 0 : 1, `${kind} ${name}`);
  const tiles = (kind: CustomMarkerKind): TestElement[] =>
    group(kind, "mtn-custom-marker-grid").querySelectorAll(".mtn-custom-marker-tile");

  return {
    document,
    root,
    settings,
    calls,
    grid: (kind) => group(kind, "mtn-custom-marker-grid"),
    input: (kind) => at(group(kind, "mtn-custom-marker-add").children, 0, `${kind} input`),
    addButton: (kind) => at(group(kind, "mtn-custom-marker-add").children, 1, `${kind} Add button`),
    error: (kind) => group(kind, "mtn-setting-inline-error"),
    emptyNote: (kind) => group(kind, "mtn-custom-marker-empty"),
    tiles,
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
    translate("settings.customMarkers.emoji.desc", "en", {
      count: MAX_CUSTOM_MARKER_ENTRIES, length: MAX_CUSTOM_EMOJI_LENGTH
    }),
    translate("settings.customMarkers.tag.desc", "en", {
      count: MAX_CUSTOM_MARKER_ENTRIES, length: MAX_CUSTOM_TAG_LENGTH
    })
  ]);
  for (const [index, length] of [[0, MAX_CUSTOM_EMOJI_LENGTH], [1, MAX_CUSTOM_TAG_LENGTH]] as const) {
    const description = at(descriptions, index, "group description");
    assert.match(description.text, new RegExp(String(MAX_CUSTOM_MARKER_ENTRIES)));
    assert.match(description.text, new RegExp(String(length)));
    assert.doesNotMatch(description.text, /\{\w+\}/);
  }

  for (const kind of ["emoji", "tag"] as const) {
    const grid = h.grid(kind);
    assert.equal(grid.getAttribute("role"), "list");
    assert.equal(grid.getAttribute("aria-label"), translate(`settings.customMarkers.${kind}.heading`, "en"));
    assert.equal(grid.children.length, 0, "a group without definitions must render an empty grid");
    assert.equal(grid.text, "");

    const input = h.input(kind);
    assert.equal(input.tag, "input");
    assert.equal(input.getAttribute("placeholder"), translate(`settings.customMarkers.${kind}.placeholder`, "en"));
    assert.equal(input.getAttribute("aria-label"), translate(`settings.customMarkers.${kind}.placeholder`, "en"));
    assert.equal(h.addButton(kind).tag, "button");
    assert.equal(h.addButton(kind).text, translate("settings.customMarkers.add", "en"));
    assert.equal(h.addButton(kind).getAttribute("type"), "button");
  }
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

test("the Add button and Enter append the cleaned value, clear the input and refresh before saving", () => {
  const h = fixture();
  h.input("emoji").value = "  🔥  ";
  pressEnter(h, "emoji");

  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  assert.equal(h.input("emoji").value, "");
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

test("blank input, whitespace and invisible-only values are rejected without writing", () => {
  for (const value of ["", "   ", "\u200B", "\uFEFF", "\u200B\u200D"]) {
    const h = fixture();
    h.input("emoji").value = value;
    pressEnter(h, "emoji");
    assert.equal(h.settings.customMarkers.length, 0, JSON.stringify(value));
    assert.deepEqual(h.calls, [], JSON.stringify(value));
    assert.equal(h.error("emoji").text, translate("settings.customMarkers.error.empty", "en"));
    assert.equal(h.error("emoji").hasClass("is-visible"), true);
    assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
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

test("an over-long value reports the group's own character limit with the count substituted", () => {
  const h = fixture();
  h.input("emoji").value = "🔥".repeat(MAX_CUSTOM_EMOJI_LENGTH + 1);
  pressEnter(h, "emoji");
  assert.equal(h.error("emoji").text,
    translate("settings.customMarkers.error.tooLong", "en", { length: MAX_CUSTOM_EMOJI_LENGTH }));
  assert.match(h.error("emoji").text, new RegExp(String(MAX_CUSTOM_EMOJI_LENGTH)));
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
  assert.deepEqual(h.calls, []);

  h.input("tag").value = "绘".repeat(MAX_CUSTOM_TAG_LENGTH + 1);
  pressEnter(h, "tag");
  assert.match(h.error("tag").text, new RegExp(String(MAX_CUSTOM_TAG_LENGTH)));
  assert.doesNotMatch(h.error("tag").text, /\{\w+\}/);
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
  const h = fixture({ markers: seed("emoji", MAX_CUSTOM_MARKER_ENTRIES) });
  assert.equal(h.tiles("emoji").length, MAX_CUSTOM_MARKER_ENTRIES);

  h.input("emoji").value = "🔥";
  pressEnter(h, "emoji");
  assert.equal(h.settings.customMarkers.length, MAX_CUSTOM_MARKER_ENTRIES);
  assert.deepEqual(h.calls, []);
  assert.equal(h.error("emoji").text,
    translate("settings.customMarkers.error.limit", "en", { count: MAX_CUSTOM_MARKER_ENTRIES }));
  assert.match(h.error("emoji").text, new RegExp(String(MAX_CUSTOM_MARKER_ENTRIES)));
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);

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
  h.input("emoji").value = "   ";
  pressEnter(h, "emoji");
  assert.equal(h.error("emoji").hasClass("is-visible"), true);
  assert.equal(h.error("tag").text, "");

  h.input("emoji").fire("input");
  assert.equal(h.error("emoji").text, "");
  assert.equal(h.error("emoji").hasClass("is-visible"), false);

  h.input("tag").value = "";
  pressEnter(h, "tag");
  assert.equal(h.error("emoji").text, "");
  assert.equal(h.error("tag").text, translate("settings.customMarkers.error.empty", "en"));
  h.input("tag").fire("input");
  assert.equal(h.error("tag").text, "");
});

test("each group shows its empty note only while that group has no entries", () => {
  const h = fixture();
  assert.equal(h.emptyNote("emoji").hidden, false);
  assert.equal(h.emptyNote("tag").hidden, false);
  assert.equal(h.emptyNote("emoji").text, translate("settings.customMarkers.emoji.empty", "en"));
  assert.equal(h.emptyNote("tag").text, translate("settings.customMarkers.tag.empty", "en"));
  assert.equal(h.emptyNote("emoji").hasClass("is-visible"), true);

  h.input("emoji").value = "🔥";
  pressEnter(h, "emoji");
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
  const h = fixture({ markers: seed("emoji", 3) });

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

  h.input("emoji").value = "🔥";
  pressEnter(h, "emoji");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"], "the panel keeps the change it already rendered");
  assert.equal(h.error("emoji").text, "", "the rejection arrives after the click handler returns");

  await settle();
  assert.equal(h.error("emoji").text, translate("settings.customMarkers.error.save", "en"));
  assert.equal(h.error("emoji").hasClass("is-visible"), true);
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
  assert.deepEqual(h.calls, ["refresh", "save"]);

  h.failSave(undefined);
  h.input("emoji").value = "🎨";
  pressEnter(h, "emoji");
  await settle();
  assert.equal(h.error("emoji").text, "");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥", "🎨"]);
});

test("a failing canvas refresh still persists the change and says the canvas is stale", async () => {
  const h = fixture();
  h.failRefresh(new Error("canvas render failed"));

  h.input("emoji").value = "🔥";
  pressEnter(h, "emoji");
  await settle();

  assert.deepEqual(h.calls, ["refresh", "save"], "the settings write must not be skipped");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  // The change did reach data.json, so the message must not claim a failed save.
  assert.equal(h.error("emoji").text, translate("settings.customMarkers.error.refresh", "en"));
  assert.doesNotMatch(h.error("emoji").text, /\{\w+\}/);
  assert.notEqual(h.error("emoji").text, translate("settings.customMarkers.error.save", "en"));
});

test("an IME-composing Enter confirms the candidate instead of adding the marker", () => {
  const h = fixture();
  h.input("emoji").value = "🔥";
  const composing = pressEnter(h, "emoji", { isComposing: true });
  assert.equal(h.settings.customMarkers.length, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(composing.defaultPrevented, false, "the IME keeps its own Enter handling");
  assert.equal(h.input("emoji").value, "🔥");

  pressEnter(h, "emoji");
  assert.deepEqual(valuesOf(h, "emoji"), ["🔥"]);
  assert.equal(h.input("emoji").value, "");
});
