import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { DEFAULT_SETTINGS } from "../src/settings-model";
import type { MindTreeSettings } from "../src/settings-model";
import type { CustomMarkerDefinition } from "../src/domain/custom-markers";
import type { MarkerPopoverHandle, MarkerPopoverOptions } from "../src/ui/marker-popover";
import type { MindTreeNode } from "../src/types";

// The real popover runs against a minimal DOM stub, so the assertions describe
// rendering and marker semantics instead of a browser. Only the Obsidian
// boundary (`setIcon`, `setTooltip`, `getLanguage`) and browser scheduling are
// simulated, the same way the other UI suites do it.
const bundle = buildSync({
  entryPoints: ["src/ui/marker-popover.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  external: ["obsidian"]
}).outputFiles[0]!.text;

/** Element stub carrying exactly the helpers the popover and tooltips call. */
class StubElement {
  readonly childNodes: StubElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly classes: string[] = [];
  readonly style = {
    left: "",
    top: "",
    setProperty(_name: string, _value: string): void {}
  };
  textContent = "";
  disabled = false;
  readonly clickListeners: EventListener[] = [];
  parent?: StubElement;

  constructor(readonly tagName: string, readonly ownerStubDocument: StubDocument) {}

  get ownerDocument(): Document { return this.ownerStubDocument.asDocument(); }

  get className(): string { return this.classes.join(" "); }
  set className(value: string) {
    this.classes.splice(0, this.classes.length, ...value.split(" ").filter(Boolean));
  }

  /** Obsidian's `Node.children` is element-only, but these stubs never add text nodes. */
  get children(): StubElement[] { return this.childNodes; }

  createDiv(options: { cls?: string; text?: string } = {}): StubElement {
    return this.createEl("div", options);
  }

  createSpan(options: { cls?: string; text?: string } = {}): StubElement {
    return this.createEl("span", options);
  }

  createEl(tag: string, options: {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
  } = {}): StubElement {
    const child = new StubElement(tag, this.ownerStubDocument);
    if (options.cls) child.className = options.cls;
    if (options.text !== undefined) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) child.attributes.set(name, value);
    this.childNodes.push(child);
    child.parent = this;
    return child;
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  matches(): boolean { return true; }
  closest(): StubElement { return this; }
  contains(other: StubElement | null): boolean {
    return other === this || this.childNodes.some((child) => child.contains(other));
  }
  get isConnected(): boolean { return this === this.ownerStubDocument.body || this.parent?.isConnected === true; }
  empty(): void { this.childNodes.length = 0; }
  remove(): void {
    if (!this.parent) return;
    const index = this.parent.childNodes.indexOf(this);
    if (index >= 0) this.parent.childNodes.splice(index, 1);
    this.parent = undefined;
  }
  addEventListener(type: string, listener: EventListener): void {
    // Only the click path is exercised; every other binding is accepted and ignored.
    if (type === "click") this.clickListeners.push(listener);
  }
  removeEventListener(): void {}
  getClientRects(): unknown[] { return [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 252, height: 240 }; }
  /** Every descendant with an accessible name, like the controller's `[aria-label]` query. */
  querySelectorAll(): StubElement[] {
    return this.childNodes.flatMap((child) => [
      ...(child.hasAttribute("aria-label") ? [child] : []),
      ...child.querySelectorAll()
    ]);
  }
  click(): void {
    const event = new Event("click", { cancelable: true });
    for (const listener of [...this.clickListeners]) listener(event);
  }
}

/** The controller only needs these two methods; scheduling stays inert. */
class StubObserver {
  observe(): void {}
  disconnect(): void {}
}

class StubDocument {
  readonly body: StubElement;
  readonly listeners: { type: string; listener: EventListener }[] = [];
  readonly documentElement = { clientWidth: 1024, clientHeight: 768 };
  readonly defaultView = {
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: null,
    MutationObserver: StubObserver,
    ResizeObserver: StubObserver,
    addEventListener: (_type: string, _listener: EventListener): void => {},
    removeEventListener: (_type: string, _listener: EventListener): void => {},
    getComputedStyle: () => ({
      fontSize: "12px",
      lineHeight: "18px",
      paddingTop: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      paddingRight: "0px"
    })
  };

  constructor() { this.body = new StubElement("body", this); }

  asDocument(): Document { return this as unknown as Document; }

  addEventListener(type: string, listener: EventListener): void { this.listeners.push({ type, listener }); }
  removeEventListener(type: string, listener: EventListener): void {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
}

interface PopoverModule { openMarkerPopover(options: MarkerPopoverOptions): MarkerPopoverHandle }
const module = { exports: {} as PopoverModule };
// The bundle runs in its own realm with a stubbed Obsidian boundary. `window`
// points back at the sandbox because the bundled code reads `window`, and the
// i18n catalog resolves to the real English strings.
const sandbox: Record<string, unknown> = {
  module,
  exports: module.exports,
  console,
  Event,
  require(id: string) {
    assert.equal(id, "obsidian");
    return {
      // `setIcon` marks the button so a test can prove icons are still used for
      // the built-in choices but never for a custom emoji or tag.
      setIcon(button: StubElement, icon: string): void { button.setAttribute("data-icon", icon); },
      setTooltip(button: StubElement, label: string): void { button.setAttribute("aria-label", label); },
      getLanguage: () => "en"
    };
  }
};
sandbox["window"] = sandbox;
createContext(sandbox);
runInContext(bundle, sandbox);
const { openMarkerPopover } = module.exports;

function definition(id: string, kind: "emoji" | "tag", value: string): CustomMarkerDefinition {
  return { id, kind, value };
}

function fixture(options: {
  markers?: MindTreeNode["markers"];
  custom?: CustomMarkerDefinition[];
} = {}) {
  const doc = new StubDocument();
  const node: MindTreeNode = {
    id: "n1",
    title: "Node",
    childIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  if (options.markers) node.markers = options.markers;
  const settings: MindTreeSettings = { ...DEFAULT_SETTINGS, customMarkers: options.custom ?? [] };
  openMarkerPopover({
    ownerDocument: doc.asDocument(),
    position: { x: 40, y: 40 },
    settings: () => settings,
    readNode: () => node,
    updateNode: (mutator) => mutator(node)
  });
  const panel = doc.body.children[0];
  assert.ok(panel, "the popover panel must be mounted on the document body");
  // Rebuilt on every commit, so every group is read back from the live panel.
  // The panel lives in the bundle's realm, so lists are copied into host arrays
  // before they are compared: a cross-realm array is not reference-equal to one
  // built here even when it holds identical strings.
  const groups = () => panel.children.map((category) => ({
    title: category.children[0]?.children[0]?.textContent ?? "",
    choices: [...category.children[1]?.children ?? []]
  }));
  const titles = () => [...groups().map((group) => group.title)];
  const buttonsOfKind = (kind: string) => [...groups().flatMap((group) =>
    group.choices.filter((choice) => choice.classes.includes(`is-${kind}`)))];
  /** Marker types the popover committed to the draft node, in payload order. */
  const markerTypes = () => [...(node.markers ?? []).map((marker) => marker.type)];
  const markerValue = (type: string) => (node.markers ?? []).find((marker) => marker.type === type)?.value;
  return { settings, panel, titles, buttonsOfKind, markerTypes, markerValue };
}

test("built-in categories always render, and custom groups with no definition render nothing at all", () => {
  const f = fixture();
  assert.deepEqual(f.titles(), ["Progress", "Priority", "Highlight"]);
  assert.deepEqual(f.buttonsOfKind("emoji"), []);
  assert.deepEqual(f.buttonsOfKind("tag"), []);
});

test("emoji and tag definitions render text buttons with localized labels and pressed state", () => {
  const f = fixture({ custom: [definition("e1", "emoji", "🌟"), definition("t1", "tag", "待办")] });
  assert.deepEqual(f.titles(), ["Progress", "Priority", "Highlight", "Emoji", "Text tags"]);
  const [emoji] = f.buttonsOfKind("emoji");
  const [tag] = f.buttonsOfKind("tag");
  assert.ok(emoji && tag);
  assert.equal(emoji.textContent, "🌟");
  assert.equal(emoji.getAttribute("aria-label"), "Emoji 🌟");
  assert.equal(emoji.getAttribute("aria-pressed"), "false");
  assert.equal(emoji.getAttribute("data-icon"), null);
  assert.equal(tag.textContent, "待办");
  assert.equal(tag.getAttribute("aria-label"), "Text tag 待办");
  assert.equal(tag.getAttribute("aria-pressed"), "false");
  assert.equal(tag.getAttribute("data-icon"), null);
  // The built-in groups keep their icon buttons.
  assert.equal(f.buttonsOfKind("progress")[0]?.getAttribute("data-icon"), "circle");
});

test("choosing another value in a custom group replaces it and never adds a second one", () => {
  const f = fixture({
    custom: [definition("e1", "emoji", "🌟"), definition("e2", "emoji", "🔥"), definition("t1", "tag", "待办")],
    markers: [
      { type: "progress", value: "done" },
      { type: "emoji", value: "🌟" },
      { type: "tag", value: "待办" }
    ]
  });
  const [selected, other] = f.buttonsOfKind("emoji");
  assert.ok(selected && other);
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  assert.equal(other.getAttribute("aria-pressed"), "false");
  other.click();
  assert.deepEqual(f.markerTypes(), ["progress", "emoji", "tag"]);
  assert.equal(f.markerValue("emoji"), "🔥");
  assert.equal(f.markerValue("tag"), "待办");
  assert.equal((f.buttonsOfKind("emoji")[1])?.getAttribute("aria-pressed"), "true");
});

test("clicking the selected custom value clears that category only", () => {
  const f = fixture({
    custom: [definition("e1", "emoji", "🌟"), definition("t1", "tag", "待办")],
    markers: [{ type: "emoji", value: "🌟" }, { type: "tag", value: "待办" }]
  });
  const [tag] = f.buttonsOfKind("tag");
  assert.equal(tag?.getAttribute("aria-pressed"), "true");
  tag?.click();
  assert.deepEqual(f.markerTypes(), ["emoji"]);
  // The tag group is rebuilt unselected while the emoji marker survives.
  assert.equal(f.buttonsOfKind("tag")[0]?.getAttribute("aria-pressed"), "false");
});

test("the custom registry is read on every render, so a group appears without reopening the popover", () => {
  const f = fixture();
  assert.deepEqual(f.titles(), ["Progress", "Priority", "Highlight"]);
  f.settings.customMarkers = [definition("t1", "tag", "重要")];
  // Any click re-renders the palette, which must pick the new registry up.
  f.buttonsOfKind("progress")[0]?.click();
  assert.deepEqual(f.titles(), ["Progress", "Priority", "Highlight", "Text tags"]);
  assert.equal(f.buttonsOfKind("tag")[0]?.textContent, "重要");
});

test("a custom category delete button clears only its own group and follows the selection state", () => {
  const f = fixture({
    custom: [definition("e1", "emoji", "🌟"), definition("t1", "tag", "待办")],
    markers: [{ type: "emoji", value: "🌟" }, { type: "tag", value: "待办" }]
  });
  const tagHeader = f.panel.children[4]?.children[0];
  const removeButton = tagHeader?.children[1];
  assert.ok(removeButton, "the tag group must expose its own delete button");
  assert.equal(removeButton.disabled, false);
  assert.equal(removeButton.getAttribute("aria-label"), "Remove Text tags marker");
  removeButton.click();
  assert.deepEqual(f.markerTypes(), ["emoji"]);
  assert.equal(f.panel.children[4]?.children[0]?.children[1]?.disabled, true);
});
