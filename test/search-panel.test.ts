import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import type { SearchCard, SearchHit, SearchRange, SearchResult } from "../src/ui/search/search-core";
import type { MindTreeSearchPanel as SearchPanel } from "../src/ui/search/search-panel";

// The panel imports `setIcon` from the real Obsidian runtime, which node:test
// cannot load. A resolve hook scoped to that one module stubs it, so the
// component itself stays byte-for-byte the code that ships.
const OBSIDIAN_STUB = "data:text/javascript," + encodeURIComponent(
  "export const setIcon = (element, name) => { element.icon = name; };\n"
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian" && context.parentURL?.endsWith("/search-panel.ts")) {
      return { url: OBSIDIAN_STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

const { MindTreeSearchPanel } = await import("../src/ui/search/search-panel");

const LABELS = {
  title: "Search",
  placeholder: "Search nodes, file names and Markdown content",
  close: "Close search",
  count: "{count} matches",
  empty: "No matches",
  loading: "Searching…",
  truncated: "Only the first {count} hits are shown"
} as const;

// ─── minimal DOM double ───────────────────────────────────────────────────────
// Only the Obsidian element extensions the panel actually uses are implemented;
// any other call is a bug this file is meant to surface.

interface ElementOptions {
  readonly cls?: string;
  readonly text?: string;
  readonly attr?: Readonly<Record<string, string>>;
  readonly type?: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly title?: string;
}

interface EventInit {
  readonly key?: string;
  readonly relatedTarget?: TestElement | null;
}

class TestEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(readonly type: string, private readonly init: EventInit = {}) {}

  get key(): string { return this.init.key ?? ""; }
  get relatedTarget(): TestElement | null { return this.init.relatedTarget ?? null; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, Array<(event: TestEvent) => void>>();
  parent?: TestElement;
  text = "";
  value = "";
  placeholder = "";
  icon = "";
  selectCalls = 0;
  selectionStart = 0;
  selectionEnd = 0;
  private hiddenValue = false;

  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") {}

  get hidden(): boolean { return this.hiddenValue; }
  set hidden(value: boolean) {
    this.hiddenValue = value;
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  /** Total bound listeners, so a test can prove teardown unbound everything. */
  get handlerCount(): number {
    let total = 0;
    for (const registered of this.handlers.values()) total += registered.length;
    return total;
  }

  createEl(tag: string, options: ElementOptions | string = {}): TestElement {
    const child = new TestElement(this.ownerDocument, tag);
    const resolved: ElementOptions = typeof options === "string" ? { cls: options } : options;
    if (resolved.cls) child.addClass(resolved.cls);
    if (resolved.text !== undefined) child.text = resolved.text;
    if (resolved.type !== undefined) child.attributes.set("type", resolved.type);
    if (resolved.placeholder !== undefined) child.placeholder = resolved.placeholder;
    if (resolved.value !== undefined) child.value = resolved.value;
    if (resolved.title !== undefined) child.attributes.set("title", resolved.title);
    for (const [name, value] of Object.entries(resolved.attr ?? {})) child.attributes.set(name, value);
    this.append(child);
    return child;
  }

  createDiv(options: ElementOptions | string = {}): TestElement { return this.createEl("div", options); }
  createSpan(options: ElementOptions | string = {}): TestElement { return this.createEl("span", options); }

  append(child: TestElement): void {
    child.parent = this;
    this.children.push(child);
  }

  appendText(value: string): void {
    const node = new TestElement(this.ownerDocument, "#text");
    node.text = value;
    this.append(node);
  }

  empty(): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
    this.text = "";
  }

  setText(value: string): void {
    this.empty();
    this.text = value;
  }

  addClass(value: string): void {
    for (const name of value.split(" ")) if (name) this.classes.add(name);
  }

  removeClass(value: string): void { this.classes.delete(value); }
  hasClass(value: string): boolean { return this.classes.has(value); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }

  addEventListener(type: string, handler: (event: TestEvent) => void): void {
    const registered = this.handlers.get(type) ?? [];
    registered.push(handler);
    this.handlers.set(type, registered);
  }

  removeEventListener(type: string, handler: (event: TestEvent) => void): void {
    const registered = this.handlers.get(type);
    if (!registered) return;
    const index = registered.indexOf(handler);
    if (index >= 0) registered.splice(index, 1);
  }

  fire(type: string, init: EventInit = {}): TestEvent { return this.dispatchEvent(new TestEvent(type, init)); }

  dispatchEvent(event: TestEvent): TestEvent {
    let node: TestElement | undefined = this;
    while (node && !event.propagationStopped) {
      for (const handler of [...(node.handlers.get(event.type) ?? [])]) handler(event);
      node = node.parent;
    }
    return event;
  }

  focus(): void { this.ownerDocument.activeElement = this; }

  select(): void {
    this.selectCalls += 1;
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = undefined;
  }

  matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
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

  all(): TestElement[] {
    const result: TestElement[] = [];
    const pending: TestElement[] = [this];
    while (pending.length > 0) {
      const current = pending.pop()!;
      result.push(current);
      for (let index = current.children.length - 1; index >= 0; index -= 1) pending.push(current.children[index]!);
    }
    return result;
  }
}

class TestDocument {
  activeElement?: TestElement;
  createElement(tag: string): TestElement { return new TestElement(this, tag); }
}

/** A clock the test advances by hand, so the debounce is deterministic. */
class TestClock {
  readonly delays: number[] = [];
  private nextHandle = 1;
  private readonly pending = new Map<number, () => void>();

  get pendingCount(): number { return this.pending.size; }

  setTimeout = (handler: () => void, delay: number): number => {
    this.delays.push(delay);
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, handler);
    return handle;
  };

  clearTimeout = (handle: number): void => { this.pending.delete(handle); };

  /** Runs every timer that was pending when called; none of them re-schedule. */
  runAll(): void {
    const handlers = [...this.pending.values()];
    this.pending.clear();
    for (const handler of handlers) handler();
  }
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected ${what} at index ${index}`);
  return item;
}

function contentHit(text: string, ranges: readonly SearchRange[], line = 1): SearchHit {
  return { source: "content", line, text, ranges };
}

function fileHit(text: string, ranges: readonly SearchRange[]): SearchHit {
  return { source: "file", line: 1, text, ranges };
}

interface CardOptions {
  readonly titleHit?: Extract<SearchHit, { source: "title" }>;
  readonly resourceId?: string;
  readonly path?: string;
  readonly fileName?: string;
  readonly hits?: readonly SearchHit[];
  readonly hitsLimited?: boolean;
}

function card(nodeId: string, title: string, options: CardOptions = {}): SearchCard {
  return {
    nodeId,
    title,
    titleHit: options.titleHit,
    resourceId: options.resourceId,
    path: options.path,
    fileName: options.fileName,
    hits: options.hits ?? [],
    hitsLimited: options.hitsLimited
  };
}

function titleHitOf(text: string, ranges: readonly SearchRange[]): Extract<SearchHit, { source: "title" }> {
  return { source: "title", line: 1, text, ranges };
}

interface Harness {
  readonly document: TestDocument;
  readonly mount: TestElement;
  readonly root: TestElement;
  readonly clock: TestClock;
  readonly panel: SearchPanel;
  readonly searches: string[];
  readonly jumps: string[];
  readonly opened: Array<[string, number]>;
  readonly notified: boolean[];
  input(): TestElement;
  count(): TestElement;
  results(): TestElement;
  closeButton(): TestElement;
  cards(): TestElement[];
  hits(cardElement: TestElement): TestElement[];
  marks(row: TestElement): TestElement[];
  empty(): TestElement | undefined;
  typeQuery(value: string): void;
}

function fixture(options: {
  readonly search?: (query: string) => Promise<SearchResult | undefined>;
  readonly debounceMs?: number;
} = {}): Harness {
  const ownerDocument = new TestDocument();
  const mount = ownerDocument.createElement("div");
  const clock = new TestClock();
  const searches: string[] = [];
  const jumps: string[] = [];
  const opened: Array<[string, number]> = [];
  const notified: boolean[] = [];
  const search = options.search ?? (async (): Promise<SearchResult> => ({ cards: [], hitCount: 0 }));

  const panel = new MindTreeSearchPanel(mount as unknown as HTMLElement, LABELS, {
    search: (query) => {
      searches.push(query);
      return search(query);
    },
    jumpToNode: (nodeId) => { jumps.push(nodeId); },
    openFileAtLine: (path, line) => { opened.push([path, line]); },
    visibilityChanged: (open) => { notified.push(open); }
  }, { debounceMs: options.debounceMs, clock });
  const root = panel.element as unknown as TestElement;

  const results = (): TestElement => at(root.querySelectorAll(".mtn-search-panel-results"), 0, "results");
  const input = (): TestElement => at(root.querySelectorAll(".mtn-search-panel-input"), 0, "search input");

  return {
    document: ownerDocument,
    mount,
    root,
    clock,
    panel,
    searches,
    jumps,
    opened,
    notified,
    input,
    count: () => at(root.querySelectorAll(".mtn-search-panel-count"), 0, "count"),
    results,
    closeButton: () => at(root.querySelectorAll(".mtn-search-panel-close"), 0, "close button"),
    cards: () => results().querySelectorAll(".mtn-search-card"),
    hits: (cardElement) => cardElement.querySelectorAll(".mtn-search-card-hit"),
    marks: (row) => row.querySelectorAll(".mtn-search-mark"),
    empty: () => results().querySelector(".mtn-search-empty"),
    typeQuery: (value) => {
      const field = input();
      field.value = value;
      field.fire("input");
    }
  };
}

// ─── DOM contract ─────────────────────────────────────────────────────────────

test("builds the contracted DOM tree with labels, roles and one setIcon close button", () => {
  const h = fixture();

  assert.equal(h.root.hasClass("mtn-search-panel"), true);
  assert.equal(h.root.hidden, true, "the window starts hidden");
  assert.equal(h.root.children.length, 3);
  // The floating card never opens blank: the empty state is present up front.
  assert.equal(h.empty()?.text, "No matches");

  const header = at(h.root.querySelectorAll(".mtn-search-panel-header"), 0, "header");
  const title = at(h.root.querySelectorAll(".mtn-search-panel-title"), 0, "title");
  const close = h.closeButton();
  const searchRow = at(h.root.querySelectorAll(".mtn-search-panel-search"), 0, "search row");
  const input = h.input();
  const count = h.count();
  const results = h.results();

  assert.equal(header.parent, h.root);
  assert.equal(title.parent, header);
  assert.equal(close.parent, header);
  assert.equal(searchRow.parent, h.root);
  assert.equal(input.parent, searchRow);
  assert.equal(count.parent, searchRow);
  assert.equal(results.parent, h.root);

  assert.equal(title.tag, "span");
  assert.equal(title.textContent, LABELS.title);

  assert.equal(close.tag, "button");
  assert.equal(close.getAttribute("type"), "button");
  assert.equal(close.getAttribute("aria-label"), LABELS.close);
  assert.equal(close.icon, "x", "the close button is an Obsidian icon button");

  assert.equal(input.tag, "input");
  assert.equal(input.getAttribute("type"), "search");
  assert.equal(input.placeholder, LABELS.placeholder);
  assert.equal(input.getAttribute("aria-label"), LABELS.placeholder);

  assert.equal(count.hidden, true);
  assert.equal(count.textContent, "");
});

test("open reveals the window, focuses the input and selects its whole value", () => {
  const h = fixture();
  h.input().value = "note";

  h.panel.open();
  assert.equal(h.panel.isOpen, true);
  assert.equal(h.root.hidden, false);
  assert.equal(h.document.activeElement, h.input());
  assert.deepEqual([h.input().selectionStart, h.input().selectionEnd], [0, 4], "the query is ready to be replaced");
  assert.deepEqual(h.notified, [true]);

  // Opening an already-open panel only re-focuses: no second visibility event.
  h.panel.open();
  assert.deepEqual(h.notified, [true]);
  assert.equal(h.input().selectCalls, 2);

  h.panel.toggle();
  assert.equal(h.panel.isOpen, false);
  assert.equal(h.root.hidden, true);
  assert.deepEqual(h.notified, [true, false]);

  h.panel.toggle();
  assert.equal(h.panel.isOpen, true);
  assert.deepEqual(h.notified, [true, false, true]);
});

test("the close button and Escape are the only ways out, and clearing happens on close", async () => {
  const h = fixture({
    search: async () => ({ cards: [card("n1", "Alpha", { path: "a.md" })], hitCount: 1 })
  });
  h.panel.open();
  h.typeQuery("alpha");
  h.clock.runAll();
  await settle();
  assert.equal(h.cards().length, 1);

  h.closeButton().fire("click");
  assert.equal(h.panel.isOpen, false);
  assert.equal(h.root.hidden, true);
  assert.equal(h.cards().length, 0, "closing drops the result cards");
  assert.equal(h.empty()?.textContent, LABELS.empty, "closing leaves the invite-to-search state");
  assert.equal(h.input().value, "");
  assert.deepEqual(h.notified, [true, false]);

  // Escape pressed inside the window closes it and never reaches the canvas.
  h.panel.open();
  h.typeQuery("alpha");
  h.clock.runAll();
  await settle();
  const escape = h.input().fire("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.propagationStopped, true);
  assert.equal(h.panel.isOpen, false);
  assert.equal(h.root.hidden, true);
  assert.equal(h.cards().length, 0);

  // The same key on the panel background (not the input) also closes it.
  h.panel.open();
  const onPanel = h.root.fire("keydown", { key: "Escape" });
  assert.equal(onPanel.defaultPrevented, true);
  assert.equal(h.panel.isOpen, false);

  // Any other key is left alone.
  h.panel.open();
  const other = h.input().fire("keydown", { key: "a" });
  assert.equal(other.defaultPrevented, false);
  assert.equal(other.propagationStopped, false);
  assert.equal(h.panel.isOpen, true);
});

test("losing focus never closes the window and no blur listener is registered", () => {
  const h = fixture();
  h.panel.open();

  h.input().fire("blur", { relatedTarget: null });
  h.input().fire("focusout", { relatedTarget: null });
  h.root.fire("focusout", { relatedTarget: null });

  assert.equal(h.panel.isOpen, true);
  assert.equal(h.root.hidden, false);
  assert.deepEqual(h.notified, [true]);
  assert.equal(h.input().handlers.has("blur"), false);
  assert.equal(h.input().handlers.has("focusout"), false);
  assert.equal(h.root.handlers.has("blur"), false);
  assert.equal(h.root.handlers.has("focusout"), false);
});

// ─── debounce and staleness ───────────────────────────────────────────────────

test("typing is debounced through the injected clock and only the last query runs", async () => {
  const h = fixture({
    search: async (query) => ({ cards: [card("n1", query)], hitCount: 1 })
  });
  h.panel.open();

  assert.equal(h.clock.delays.at(-1), undefined, "nothing is scheduled before typing");
  h.typeQuery("n");
  h.typeQuery("no");
  h.typeQuery("note");

  assert.deepEqual(h.searches, [], "the search port is not called before the debounce elapses");
  assert.equal(h.clock.pendingCount, 1, "each keystroke replaces the previous timer");
  assert.equal(h.clock.delays.at(-1), 120, "the documented default debounce applies");

  h.clock.runAll();
  assert.deepEqual(h.searches, ["note"]);
  await settle();
  assert.equal(h.cards().length, 1);
  assert.equal(at(h.cards(), 0, "card").querySelector(".mtn-search-card-title")?.textContent, "note");

  // A non-empty query schedules exactly one timer with the configured delay.
  const custom = fixture({ debounceMs: 250, search: async () => ({ cards: [], hitCount: 0 }) });
  custom.panel.open();
  custom.typeQuery("x");
  assert.deepEqual(custom.clock.delays, [250]);

  // Whitespace is not a query: no timer, no count, no results.
  const blank = fixture();
  blank.panel.open();
  blank.typeQuery("   ");
  assert.equal(blank.clock.pendingCount, 0);
  assert.deepEqual(blank.searches, []);
  assert.equal(blank.count().hidden, true);
});

test("a superseded search never renders its late answer, and undefined renders nothing", async () => {
  const pending = new Map<string, Deferred<SearchResult | undefined>>();
  const h = fixture({
    search: (query) => {
      const entry = deferred<SearchResult | undefined>();
      pending.set(query, entry);
      return entry.promise;
    }
  });
  const answer = (query: string, value: SearchResult | undefined): void => {
    const entry = pending.get(query);
    assert.ok(entry, `no pending search for ${query}`);
    entry.resolve(value);
  };

  h.panel.open();
  h.typeQuery("first");
  h.clock.runAll();
  h.typeQuery("second");
  h.clock.runAll();
  assert.deepEqual(h.searches, ["first", "second"]);

  // The newer answer lands first.
  answer("second", { cards: [card("n2", "Second", { path: "b.md" })], hitCount: 1 });
  await settle();
  assert.equal(h.cards().length, 1);

  // The older answer arrives afterwards and must be dropped, not merged in.
  answer("first", { cards: [card("n1", "First", { path: "a.md" })], hitCount: 3 });
  await settle();
  assert.equal(h.cards().length, 1);
  assert.equal(at(h.cards(), 0, "card").querySelector(".mtn-search-card-title")?.textContent, "Second");
  assert.equal(h.count().textContent, "1 matches");

  // The host may also declare an answer stale by resolving undefined.
  const stale = fixture({ search: async () => undefined });
  stale.panel.open();
  stale.typeQuery("gone");
  stale.clock.runAll();
  await settle();
  assert.equal(stale.cards().length, 0);
  assert.equal(stale.empty(), undefined);
  assert.equal(stale.count().textContent, LABELS.loading, "the window keeps waiting for a fresh answer");
});

// ─── count and rendering ──────────────────────────────────────────────────────

test("the count appears only with a query and reports the rendered card count", async () => {
  const h = fixture({
    search: async () => ({
      cards: [card("n1", "Alpha"), card("n2", "Beta")],
      hitCount: 7
    })
  });

  assert.equal(h.count().hidden, true);

  h.panel.open();
  assert.equal(h.count().hidden, true, "an open window without a query shows no count");

  h.typeQuery("a");
  assert.equal(h.count().hidden, false);
  assert.equal(h.count().textContent, LABELS.loading);

  h.clock.runAll();
  await settle();
  // The contract counts cards, not the raw hit total.
  assert.equal(h.count().textContent, "2 matches");
  assert.equal(h.cards().length, 2);

  h.typeQuery("");
  assert.equal(h.count().hidden, true);
  assert.equal(h.cards().length, 0);
  assert.equal(h.empty()?.textContent, LABELS.empty, "an empty query returns to the invite state");

  const none = fixture({ search: async () => ({ cards: [], hitCount: 0 }) });
  none.panel.open();
  none.typeQuery("zzz");
  none.clock.runAll();
  await settle();
  assert.equal(none.count().textContent, "0 matches");
  assert.equal(none.empty()?.textContent, LABELS.empty);
});

test("hit rows keep the whole text, one mark per range, and a hover title", async () => {
  const text = "alpha foo omega foo tail";
  const h = fixture({
    search: async () => ({
      cards: [card("n1", "Alpha", { path: "notes/a.md", hits: [contentHit(text, [[6, 9], [16, 19]], 3)] })],
      hitCount: 2
    })
  });
  h.panel.open();
  h.typeQuery("foo");
  h.clock.runAll();
  await settle();

  const row = at(h.hits(at(h.cards(), 0, "card")), 0, "hit row");
  assert.equal(row.textContent, text, "highlighting never drops the surrounding text");
  assert.deepEqual(h.marks(row).map((mark) => mark.textContent), ["foo", "foo"]);
  assert.ok(h.marks(row).every((mark) => mark.hasClass("mtn-search-mark")));
  assert.equal(row.getAttribute("title"), text, "the full line stays available on hover");
  assert.equal(row.getAttribute("role"), "button");
  assert.equal(row.getAttribute("tabindex"), "0");

  // A single range leaves exactly one mark.
  const single = fixture({
    search: async () => ({
      cards: [card("n1", "Alpha", { path: "a.md", hits: [fileHit("name-foo.md", [[5, 8]])] })],
      hitCount: 1
    })
  });
  single.panel.open();
  single.typeQuery("foo");
  single.clock.runAll();
  await settle();
  const singleRow = at(single.hits(at(single.cards(), 0, "card")), 0, "single hit row");
  assert.deepEqual(single.marks(singleRow).map((mark) => mark.textContent), ["foo"]);
  assert.equal(singleRow.textContent, "name-foo.md");
});

test("the title row always renders, highlights a title hit and keeps the full title on hover", async () => {
  const h = fixture({
    search: async () => ({
      cards: [
        card("n1", "Alpha note", { titleHit: titleHitOf("Alpha note", [[0, 5]]), path: "a.md" }),
        card("n2", "Beta", { path: "b.md" })
      ],
      hitCount: 1
    })
  });
  h.panel.open();
  h.typeQuery("alpha");
  h.clock.runAll();
  await settle();

  const hitTitle = at(at(h.cards(), 0, "card").querySelectorAll(".mtn-search-card-title"), 0, "title row");
  assert.equal(hitTitle.textContent, "Alpha note");
  assert.deepEqual(h.marks(hitTitle).map((mark) => mark.textContent), ["Alpha"]);
  assert.equal(hitTitle.getAttribute("title"), "Alpha note");

  const plainTitle = at(at(h.cards(), 1, "card").querySelectorAll(".mtn-search-card-title"), 0, "title row");
  assert.equal(plainTitle.textContent, "Beta");
  assert.equal(h.marks(plainTitle).length, 0);
  assert.equal(plainTitle.getAttribute("title"), "Beta");
});

test("separator rules sit between hit rows only", async () => {
  const h = fixture({
    search: async () => ({
      cards: [
        card("n1", "Alpha", {
          path: "a.md",
          hits: [contentHit("one", [[0, 3]], 1), contentHit("two", [[0, 3]], 2), contentHit("three", [[0, 3]], 5)]
        }),
        card("n2", "Beta", { path: "b.md", hits: [contentHit("only", [[0, 4]], 1)] })
      ],
      hitCount: 4
    })
  });
  h.panel.open();
  h.typeQuery("o");
  h.clock.runAll();
  await settle();

  const many = at(h.cards(), 0, "card");
  assert.equal(many.querySelectorAll(".mtn-search-card-separator").length, 2);
  assert.deepEqual(many.children.map((child) => {
    if (child.hasClass("mtn-search-card-title")) return "title";
    if (child.tag === "hr") return "separator";
    if (child.hasClass("mtn-search-card-hit")) return "hit";
    return "other";
  }), ["title", "hit", "separator", "hit", "separator", "hit"]);

  assert.equal(at(h.cards(), 1, "card").querySelectorAll(".mtn-search-card-separator").length, 0);
});

test("a card without a path renders only its title row", async () => {
  const h = fixture({
    search: async () => ({
      cards: [card("n1", "Alpha", { hits: [contentHit("orphan hit", [[0, 6]], 2)] })],
      hitCount: 1
    })
  });
  h.panel.open();
  h.typeQuery("orphan");
  h.clock.runAll();
  await settle();

  const element = at(h.cards(), 0, "card");
  assert.equal(element.querySelectorAll(".mtn-search-card-title").length, 1);
  assert.equal(h.hits(element).length, 0, "without a path there is nothing to open");
  assert.equal(element.querySelectorAll(".mtn-search-card-separator").length, 0);
});

test("a core-capped card ends with a plain truncation note that is never a target", async () => {
  const h = fixture({
    search: async () => ({
      cards: [
        card("n1", "Alpha", {
          path: "a.md",
          hits: [contentHit("one", [[0, 3]], 1), contentHit("two", [[0, 3]], 2), contentHit("three", [[0, 3]], 3)],
          hitsLimited: true
        }),
        card("n2", "Beta", { path: "b.md", hits: [contentHit("only", [[0, 4]], 1)] })
      ],
      hitCount: 7
    })
  });
  h.panel.open();
  h.typeQuery("o");
  h.clock.runAll();
  await settle();

  const limited = at(h.cards(), 0, "limited card");
  const note = at(limited.querySelectorAll(".mtn-search-card-truncated"), 0, "truncation note");
  assert.equal(note.textContent, "Only the first 3 hits are shown", "the label count is the rendered row count");
  assert.equal(limited.children.at(-1), note, "the note closes the card");
  assert.equal(note.getAttribute("role"), null);
  assert.equal(note.getAttribute("tabindex"), null);
  assert.equal(note.handlerCount, 0, "the note binds nothing");

  // Clicking or pressing keys on the note must not jump or open a file.
  note.fire("click");
  note.fire("keydown", { key: "Enter" });
  note.fire("keydown", { key: " " });
  assert.deepEqual(h.jumps, []);
  assert.deepEqual(h.opened, []);

  // The input count still reports the rendered cards, per contract.
  assert.equal(h.count().textContent, "2 matches");
  assert.equal(
    at(h.cards(), 1, "plain card").querySelectorAll(".mtn-search-card-truncated").length,
    0,
    "an uncapped card carries no note"
  );
});

test("click and Enter/Space activate the title row and every hit row", async () => {
  const h = fixture({
    search: async () => ({
      cards: [card("node-1", "Alpha", { path: "notes/a.md", hits: [contentHit("foo", [[0, 3]], 12)] })],
      hitCount: 1
    })
  });
  h.panel.open();
  h.typeQuery("foo");
  h.clock.runAll();
  await settle();

  const element = at(h.cards(), 0, "card");
  const titleRow = at(element.querySelectorAll(".mtn-search-card-title"), 0, "title row");
  const hitRow = at(h.hits(element), 0, "hit row");

  titleRow.fire("click");
  assert.deepEqual(h.jumps, ["node-1"]);
  const enter = titleRow.fire("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  titleRow.fire("keydown", { key: " " });
  assert.deepEqual(h.jumps, ["node-1", "node-1", "node-1"]);

  hitRow.fire("click");
  assert.deepEqual(h.opened, [["notes/a.md", 12]]);
  hitRow.fire("keydown", { key: "Enter" });
  hitRow.fire("keydown", { key: " " });
  assert.deepEqual(h.opened, [["notes/a.md", 12], ["notes/a.md", 12], ["notes/a.md", 12]]);

  // An unrelated key must not activate anything.
  const other = titleRow.fire("keydown", { key: "Tab" });
  assert.equal(other.defaultPrevented, false);
  assert.equal(h.jumps.length, 3);
  assert.equal(h.opened.length, 3);
});

test("setContext invalidates cached answers and re-runs the current query at once", async () => {
  const pending: Array<Deferred<SearchResult | undefined>> = [];
  const h = fixture({
    search: () => {
      const entry = deferred<SearchResult | undefined>();
      pending.push(entry);
      return entry.promise;
    }
  });

  h.panel.open();
  h.typeQuery("alpha");
  h.clock.runAll();
  assert.deepEqual(h.searches, ["alpha"]);

  h.panel.setContext();
  assert.deepEqual(h.searches, ["alpha", "alpha"], "no debounce is applied after a context change");
  assert.equal(h.clock.pendingCount, 0);

  at(pending, 1, "second request").resolve({ cards: [card("n2", "Second")], hitCount: 1 });
  await settle();
  assert.equal(at(h.cards(), 0, "card").querySelector(".mtn-search-card-title")?.textContent, "Second");

  at(pending, 0, "first request").resolve({ cards: [card("n1", "First")], hitCount: 1 });
  await settle();
  assert.equal(h.cards().length, 1);
  assert.equal(at(h.cards(), 0, "card").querySelector(".mtn-search-card-title")?.textContent, "Second");

  // A context change with an empty query just clears the window.
  h.panel.setContext();
  h.typeQuery("");
  h.panel.setContext();
  assert.equal(h.cards().length, 0);
  assert.equal(h.empty()?.textContent, LABELS.empty);
  assert.equal(h.count().hidden, true);
});

test("no user-visible copy is invented outside the labels and the result data", async () => {
  const cardTitle = "Alpha";
  const hitText = "alpha foo omega";
  const h = fixture({
    search: async () => ({
      cards: [card("n1", cardTitle, { path: "a.md", hits: [contentHit(hitText, [[6, 9]])] })],
      hitCount: 1
    })
  });
  h.panel.open();
  h.typeQuery("foo");
  h.clock.runAll();
  await settle();

  // Every text node is either a supplied label, substituted count, or data.
  const allowed = new Set<string>([
    LABELS.title, LABELS.close, LABELS.placeholder, LABELS.loading, LABELS.empty, LABELS.truncated,
    "1 matches", cardTitle, "alpha ", " omega", "foo"
  ]);
  for (const node of h.root.all()) {
    if (node.tag === "#text") {
      assert.ok(allowed.has(node.text), `unexpected text ${JSON.stringify(node.text)}`);
      continue;
    }
    if (node.children.length === 0 && node.text !== "") {
      assert.ok(allowed.has(node.text), `unexpected leaf text ${JSON.stringify(node.text)}`);
    }
  }
  assert.doesNotMatch(h.root.textContent, /\{count\}/, "the count placeholder must be substituted");
});

// ─── lifecycle ────────────────────────────────────────────────────────────────

test("destroy is idempotent, empties the DOM, clears the timer and drops late answers", async () => {
  const h = fixture({ search: async () => ({ cards: [card("n1", "Alpha")], hitCount: 1 }) });
  h.panel.open();
  h.typeQuery("alpha");
  assert.equal(h.clock.pendingCount, 1);
  const input = h.input();

  h.panel.destroy();
  assert.equal(h.clock.pendingCount, 0, "the pending debounce is cancelled");
  assert.equal(h.root.parent, undefined, "the element leaves the DOM");
  assert.equal(h.mount.children.length, 0);
  assert.equal(h.root.children.length, 0, "the panel empties its own subtree");
  assert.equal(h.root.handlerCount, 0, "the panel element unbound its listeners");
  assert.equal(input.handlerCount, 0, "the input unbound its listeners");
  assert.equal(h.panel.isOpen, false);

  h.panel.destroy();
  assert.equal(h.root.parent, undefined);
  assert.equal(h.mount.children.length, 0);
  assert.equal(h.root.children.length, 0);

  h.clock.runAll();
  await settle();
  assert.equal(h.root.children.length, 0, "a cancelled debounce renders nothing");

  // An answer that lands after destroy must not touch the detached DOM.
  const pending = deferred<SearchResult | undefined>();
  const late = fixture({ search: () => pending.promise });
  late.panel.open();
  late.typeQuery("late");
  late.clock.runAll();
  late.panel.destroy();
  pending.resolve({ cards: [card("n9", "Late")], hitCount: 1 });
  await settle();
  assert.equal(late.root.children.length, 0);
});

// ─── source and stylesheet contract ───────────────────────────────────────────

test("the component imports only types from the core and never the view or the main plugin", () => {
  const source = readFileSync(new URL("../src/ui/search/search-panel.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ setIcon \} from "obsidian";/);
  assert.match(source, /import type \{[^}]*\} from "\.\/search-core";/);
  assert.doesNotMatch(source, /MindTreeView|mind-tree-view/);
  assert.doesNotMatch(source, /from "\.\.\/\.\.\/main"/);
  assert.doesNotMatch(source, /i18n|catalog/);
});

test("the appended stylesheet keeps the window floating, clamped, scrollable and theme-driven", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(match, `expected a rule for ${selector}`);
    return match[1] ?? "";
  };

  // The window is one rounded floating card, not a docked sidebar: it clears the
  // toolbar, stays inside the view and shares the toolbar's surface treatment.
  const panel = rule(".mtn-search-panel");
  assert.match(panel, /position:\s*absolute;/);
  assert.match(panel, /top:\s*62px;/);
  assert.match(panel, /right:\s*12px;/);
  assert.deepEqual(panel.match(/bottom:/g), null, "a floating card must not stretch to the bottom edge");
  assert.match(panel, /width:\s*min\(360px,\s*calc\(100%\s*-\s*24px\)\);/);
  assert.match(panel, /max-height:\s*calc\(100%\s*-\s*74px\);/);
  assert.match(panel, /overflow:\s*hidden;/);
  assert.match(panel, /display:\s*flex;/);
  assert.match(panel, /flex-direction:\s*column;/);
  assert.match(panel, /z-index:\s*44;/);
  assert.match(panel, /border-radius:\s*13px;/);
  assert.match(panel, /background:\s*color-mix\(in srgb,\s*var\(--background-primary\) 92%,\s*transparent\);/);
  assert.match(panel, /box-shadow:\s*0 8px 24px/);
  assert.match(panel, /backdrop-filter:\s*blur\(10px\);/);

  // The toolbar keeps the same surface, so the two must not drift apart.
  const toolbar = rule(".mtn-toolbar");
  assert.match(toolbar, /border-radius:\s*13px;/);
  assert.match(toolbar, /box-shadow:\s*0 8px 24px/);
  assert.match(toolbar, /backdrop-filter:\s*blur\(10px\);/);

  const results = rule(".mtn-search-panel-results");
  assert.match(results, /flex:\s*1;/);
  assert.match(results, /min-height:\s*0;/);
  assert.match(results, /overflow-y:\s*auto;/);

  const rowRule = css.match(/\.mtn-search-card-title,\s*\n\.mtn-search-card-hit\s*\{([\s\S]*?)\}/);
  assert.ok(rowRule, "expected one shared rule for the clickable rows");
  const row = rowRule[1] ?? "";
  assert.match(row, /white-space:\s*nowrap;/);
  assert.match(row, /overflow:\s*hidden;/);
  assert.match(row, /text-overflow:\s*ellipsis;/);
  assert.match(row, /min-height:\s*28px;/, "touch targets stay at least 28px tall");
  assert.match(row, /cursor:\s*pointer;/);

  assert.match(rule(".mtn-search-mark"), /background:\s*var\(--text-highlight-bg\);/);

  // The whole appended block uses theme variables only: no gradients, no hex.
  const appended = css.slice(css.indexOf(".mtn-search-panel"));
  assert.doesNotMatch(appended, /gradient/i);
  assert.doesNotMatch(appended, /#[0-9a-f]{3,8}\b/i);
  assert.match(appended, /\.mtn-search-card-title:hover,\s*\n\.mtn-search-card-hit:hover\s*\{/);
});
