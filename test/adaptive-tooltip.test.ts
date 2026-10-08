import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";

// Execute the real controller; only the Obsidian boundary and browser scheduling are simulated.
const bundle = buildSync({ entryPoints: ["src/ui/adaptive-tooltip.ts"], bundle: true, write: false,
  format: "cjs", platform: "browser", external: ["obsidian"] }).outputFiles[0]!.text;
class Surface extends EventTarget {
  listenerCount = 0;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options); this.listenerCount++;
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, listener, options); this.listenerCount--;
  }
  emit(type: string, properties: Record<string, unknown> = {}): Event {
    const event = new Event(type, { cancelable: true, bubbles: true });
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
    this.dispatchEvent(event); return event;
  }
}
type Mutation = { type: string; target: Element; addedNodes: Element[]; removedNodes: Element[] };
class TestObserver {
  root?: Element;
  pending: Mutation[] = [];
  constructor(readonly doc: TestDocument, readonly callback: (records: Mutation[]) => void) { doc.observers.add(this); }
  observe(root: Element): void { this.root = root; }
  disconnect(): void { this.root = undefined; this.pending = []; this.doc.observers.delete(this); }
}
class Element extends Surface {
  readonly nodeType = 1;
  parent?: Element;
  children: Element[] = [];
  attributes = new Map<string, string>();
  nativeClasses: string[] = [];
  className = "";
  dataset: Record<string, string> = {};
  textContent = "";
  focusVisible = false;
  displayed = true;
  reads = 0;
  box = { left: 384, top: 100, right: 416, bottom: 132 };
  style = { maxWidth: "", maxHeight: "", left: "", top: "", visibility: "", variables: new Map<string, string>(),
    setProperty(name: string, value: string) { this.variables.set(name, value); } };
  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") { super(); }
  get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parent?.isConnected; }
  contains(other: Element | null): boolean { return other === this || this.children.some((child) => child.contains(other)); }
  matches(selector: string): boolean {
    return selector === ":focus-visible" ? this.focusVisible
      : (this.tag === "button" || this.getAttribute("role") === "button") && this.hasAttribute("aria-label");
  }
  closest(selector: string): Element | undefined { return this.matches(selector) ? this : this.parent?.closest(selector); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "aria-label") this.ownerDocument.mutation({ type: "attributes", target: this, addedNodes: [], removedNodes: [] });
  }
  append(child: Element): void {
    child.remove(); child.parent = this; this.children.push(child);
    this.ownerDocument.mutation({ type: "childList", target: this, addedNodes: [child], removedNodes: [] });
  }
  remove(): void {
    if (!this.parent) return;
    const parent = this.parent; parent.children = parent.children.filter((child) => child !== this); this.parent = undefined;
    this.ownerDocument.mutation({ type: "childList", target: parent, addedNodes: [], removedNodes: [this] });
  }
  getClientRects(): unknown[] { return this.isConnected && this.displayed ? [this.box] : []; }
  getBoundingClientRect() {
    this.reads++;
    if (this.className !== "mtn-adaptive-tooltip") return { ...this.box, width: this.box.right - this.box.left, height: this.box.bottom - this.box.top };
    const text = this.children[0]!;
    const width = Math.min(Number.parseFloat(this.style.maxWidth) || 320, text.textContent.length * 7 + 20);
    const fullHeight = Math.ceil(text.textContent.length * 7 / Math.max(1, width - 20)) * 18 + 12;
    const height = Math.min(fullHeight, Number.parseFloat(text.style.maxHeight) || Infinity);
    const left = Number.parseFloat(this.style.left) || 0, top = Number.parseFloat(this.style.top) || 0;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}
class TestWindow extends Surface {
  innerWidth = 800; innerHeight = 600;
  visualViewport: { offsetLeft: number; offsetTop: number; width: number; height: number } | null = null;
  private sequence = 0;
  timers = new Map<number, { callback: () => void; delay: number }>();
  frames = new Map<number, () => void>();
  resizeObservers = new Set<{ disconnect(): void }>();
  MutationObserver: new (callback: (records: Mutation[]) => void) => TestObserver;
  ResizeObserver: new (callback: () => void) => { observe(element: Element): void; disconnect(): void };
  constructor(doc: TestDocument) {
    super();
    this.MutationObserver = class extends TestObserver { constructor(callback: (records: Mutation[]) => void) { super(doc, callback); } };
    const observers = this.resizeObservers;
    this.ResizeObserver = class {
      constructor(readonly callback: () => void) { observers.add(this); }
      observe(_element: Element): void {}
      disconnect(): void { observers.delete(this); }
    };
  }
  setTimeout = (callback: () => void, delay: number): number => { const id = ++this.sequence; this.timers.set(id, { callback, delay }); return id; };
  clearTimeout = (id: number): void => { this.timers.delete(id); };
  requestAnimationFrame = (callback: () => void): number => { const id = ++this.sequence; this.frames.set(id, callback); return id; };
  cancelAnimationFrame = (id: number): void => { this.frames.delete(id); };
  getComputedStyle = () => ({ lineHeight: "18px", fontSize: "12px", paddingTop: "6px", paddingBottom: "6px", paddingLeft: "10px", paddingRight: "10px" });
  tick(): void { const tasks = [...this.timers]; this.timers.clear(); for (const [, task] of tasks) task.callback(); }
  frame(): void { const tasks = [...this.frames]; this.frames.clear(); for (const [, task] of tasks) task(); }
}
class TestDocument extends Surface {
  hidden = false;
  observers = new Set<TestObserver>();
  body = new Element(this);
  defaultView = new TestWindow(this);
  createElement(tag: string): Element { return new Element(this, tag); }
  mutation(record: Mutation): void {
    for (const observer of this.observers) if (observer.root?.contains(record.target)) observer.pending.push(record);
  }
  flush(): void {
    for (let count = 0; [...this.observers].some((observer) => observer.pending.length); count++) {
      assert.ok(count < 10, "native tooltip setup must not create a mutation loop");
      for (const observer of this.observers) if (observer.pending.length) observer.callback(observer.pending.splice(0));
    }
  }
  tooltips(): Element[] { return this.body.children.filter((child) => child.className === "mtn-adaptive-tooltip"); }
}
interface Controller { destroy(): void }
const module = { exports: {} as { AdaptiveTooltipController: new (root: Element, standalone?: boolean) => Controller } };
runInNewContext(bundle, { module, exports: module.exports, console, require(id: string) {
  assert.equal(id, "obsidian");
  return { setTooltip(button: Element, label: string, options: { classes: string[] }) {
    button.setAttribute("aria-label", label); button.nativeClasses = [...options.classes];
  } };
} });
function fixture(doc = new TestDocument(), standalone = false) {
  const root = doc.createElement(standalone ? "div" : "section"); doc.body.append(root);
  const button = standalone ? root : doc.createElement("button");
  if (!standalone) root.append(button);
  button.setAttribute("aria-label", "保存思维树 / Save mind tree");
  const controller = new module.exports.AdaptiveTooltipController(root, standalone);
  const hover = (target = button, pointerType = "mouse") => root.emit("pointerover", { target, pointerType, buttons: 0 });
  return { doc, win: doc.defaultView, root, button, controller, hover,
    tip: () => doc.tooltips()[0]!, text: () => doc.tooltips()[0]?.children[0]?.textContent };
}

test("delegated hover measures a body-mounted tooltip, hides its native copy, and leaves activation intact", () => {
  const f = fixture(); assert.equal(f.button.getAttribute("aria-label"), "保存思维树 / Save mind tree");
  assert.deepEqual(f.button.nativeClasses, ["mtn-native-tooltip-hidden"]);
  const icon = f.doc.createElement("svg"); f.button.append(icon);
  assert.equal(f.hover(icon).defaultPrevented, false); f.doc.flush();
  assert.equal([...f.win.timers.values()][0]?.delay, 300); assert.equal(f.doc.tooltips().length, 0);
  f.win.tick(); assert.equal(f.tip().parent, f.doc.body); assert.equal(f.tip().dataset.side, "bottom");
  assert.equal(f.text(), f.button.getAttribute("aria-label"));
  assert.equal(f.doc.emit("click").defaultPrevented, false); assert.equal(f.doc.tooltips().length, 0);
  f.controller.destroy(); assert.deepEqual(f.button.nativeClasses, []);
});

test("leaving or switching controls cancels delayed results, including mouse exit after a click", () => {
  const f = fixture(); f.hover(); f.root.emit("pointerout", { relatedTarget: null }); f.win.tick();
  assert.equal(f.doc.tooltips().length, 0);
  const second = f.doc.createElement("button"); second.setAttribute("aria-label", "Undo"); f.root.append(second); f.doc.flush();
  f.hover(); f.hover(second); f.win.tick(); assert.equal(f.text(), "Undo");
  f.root.emit("pointerout", { relatedTarget: null }); assert.equal(f.doc.tooltips().length, 0);
  f.controller.destroy();
});

test("keyboard focus is immediate, Escape closes it, and touch or dragging never opens a hover tooltip", () => {
  const f = fixture();
  f.hover(f.button, "touch"); f.win.tick(); assert.equal(f.doc.tooltips().length, 0);
  f.root.emit("pointerover", { target: f.button, pointerType: "mouse", buttons: 1 });
  assert.equal(f.win.timers.size, 0);
  f.doc.emit("pointerdown"); f.button.focusVisible = true;
  f.root.emit("focusin", { target: f.button }); assert.equal(f.doc.tooltips().length, 0);
  f.doc.emit("keydown", { key: "Tab" }); f.root.emit("focusin", { target: f.button });
  assert.equal(f.doc.tooltips().length, 1); assert.equal(f.win.timers.size, 0);
  f.doc.emit("keydown", { key: "Escape" }); assert.equal(f.doc.tooltips().length, 0);
  f.root.emit("focusin", { target: f.button }); f.root.emit("focusout");
  assert.equal(f.doc.tooltips().length, 0); f.controller.destroy();
});

test("status labels and geometry update while visible without creating more tooltip nodes", () => {
  const f = fixture(); f.hover(); f.win.tick(); const tip = f.tip();
  f.button.setAttribute("aria-label", "保存失败，请重试 / Save failed. Try again.");
  f.button.box = { left: 380, right: 412, top: 550, bottom: 582 }; f.doc.flush(); f.win.frame();
  assert.equal(f.tip(), tip); assert.equal(f.tip().dataset.side, "top"); assert.match(f.text()!, /Save failed/);
  const measured = tip.reads; f.win.frame(); assert.equal(tip.reads, measured, "stable frames must not remeasure text");
  f.button.box = { left: 8, right: 40, top: 200, bottom: 232 }; f.win.frame(); assert.equal(tip.dataset.side, "right");
  f.button.box = { left: 758, right: 790, top: 200, bottom: 232 }; f.win.frame(); assert.equal(tip.dataset.side, "left");
  f.controller.destroy();
});

test("each document has one active tooltip across surfaces, and popout windows remain independent", () => {
  const a = fixture(), b = fixture(a.doc), popout = fixture();
  a.hover(); a.win.tick(); b.hover(); b.win.tick(); assert.equal(a.doc.tooltips().length, 1);
  a.controller.destroy(); assert.equal(b.doc.tooltips().length, 1);
  popout.hover(); popout.win.tick(); assert.equal(popout.doc.tooltips().length, 1);
  b.win.emit("blur"); assert.equal(b.doc.tooltips().length, 0); assert.equal(popout.doc.tooltips().length, 1);
  b.controller.destroy(); popout.controller.destroy();
});

test("dynamic buttons, standalone ribbon entries and removal release native suppression and active resources", () => {
  const f = fixture(undefined, true); f.hover(); f.win.tick(); assert.equal(f.doc.tooltips().length, 1);
  f.root.remove(); f.win.frame(); assert.equal(f.doc.tooltips().length, 0); f.controller.destroy();
  assert.equal(f.win.frames.size, 0); assert.equal(f.win.timers.size, 0); assert.equal(f.win.resizeObservers.size, 0);
  assert.equal(f.doc.observers.size, 0); assert.equal(f.doc.listenerCount, 0); assert.equal(f.win.listenerCount, 0); assert.equal(f.root.listenerCount, 0);
  const other = fixture(); other.hover(); other.win.tick(); other.button.remove(); other.doc.flush();
  assert.equal(other.doc.tooltips().length, 0); assert.deepEqual(other.button.nativeClasses, []);
  other.controller.destroy(); other.controller.destroy();
});

test("visual viewport offsets, long labels and tiny windows remain contained without covering the trigger", () => {
  const f = fixture(); f.button.setAttribute("aria-label", "A very long explanation 很长的提示文字 ".repeat(20));
  f.win.visualViewport = { offsetLeft: 100, offsetTop: 100, width: 230, height: 220 };
  f.button.box = { left: 194, right: 226, top: 254, bottom: 286 }; f.hover(); f.win.tick();
  const box = f.tip().getBoundingClientRect();
  assert.equal(f.tip().style.visibility, "visible"); assert.ok(box.left >= 108 && box.right <= 322);
  assert.ok(box.top >= 108 && box.bottom <= 312); assert.ok(box.bottom <= f.button.box.top - 8);
  f.win.visualViewport = { offsetLeft: 190, offsetTop: 250, width: 36, height: 36 }; f.win.frame();
  assert.equal(f.tip().style.visibility, "hidden"); assert.ok(f.button.getAttribute("aria-label"));
  f.controller.destroy();
});

test("host buttons and non-button accessible regions are not adopted; hiding a view dismisses a tooltip", () => {
  const f = fixture(); const host = f.doc.createElement("button"); host.setAttribute("aria-label", "Obsidian action"); f.doc.body.append(host);
  const region = f.doc.createElement("div"); region.setAttribute("aria-label", "Canvas"); f.root.append(region); f.doc.flush();
  assert.deepEqual(host.nativeClasses, []); assert.deepEqual(region.nativeClasses, []);
  f.hover(); f.win.tick(); f.button.displayed = false; f.win.frame(); assert.equal(f.doc.tooltips().length, 0);
  f.controller.destroy();
});

test("tooltip styles isolate native suppression and preserve theme variables and pointer transparency", () => {
  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.mtn-native-tooltip-hidden\s*\{\s*display: none !important;/);
  assert.match(css, /\.mtn-adaptive-tooltip\s*\{[^}]*position: fixed;[^}]*var\(--background-modifier-message\)[^}]*pointer-events: none;/);
  for (const side of ["top", "bottom", "left", "right"]) assert.ok(css.includes(`[data-side="${side}"]::after`));
});
