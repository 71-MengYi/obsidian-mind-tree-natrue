import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeleteDetailsController, type DeleteDetailTarget } from "../src/ui/controllers/delete-details-controller";

/** Minimal DOM surface: exercise real event bindings without Obsidian or a browser framework. */
class Surface extends EventTarget {
  listenerCount = 0;
  scrollHeight = 800;
  clientHeight = 230;
  private offset = 0;
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name)
  };

  // Emulate a WebView returning zero for a hidden element. The controller must
  // remember the offset before hiding, not read the hidden list on re-entry.
  get scrollTop(): number { return this.visible ? this.offset : 0; }
  set scrollTop(value: number) { this.offset = value; }
  get visible(): boolean { return this.classList.contains("is-visible"); }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options);
    this.listenerCount += 1;
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, listener, options);
    this.listenerCount -= 1;
  }
  emit(type: string): void { this.dispatchEvent(new Event(type)); }
  wheel(deltaY: number, deltaMode = 0): TestWheelEvent {
    const event = new TestWheelEvent(deltaY, deltaMode);
    this.dispatchEvent(event);
    return event;
  }
}

class TestWheelEvent extends Event {
  stopped = false;
  constructor(readonly deltaY: number, readonly deltaMode: number) {
    super("wheel", { cancelable: true, bubbles: true });
  }
  override stopPropagation(): void { this.stopped = true; super.stopPropagation(); }
}

function fixture() {
  const topics = { trigger: new Surface(), detail: new Surface() };
  const files = { trigger: new Surface(), detail: new Surface() };
  const positioned: Array<[HTMLElement, HTMLElement]> = [];
  const controller = new DeleteDetailsController(
    [topics, files] as unknown as DeleteDetailTarget[],
    (trigger, detail) => { positioned.push([trigger, detail]); }
  );
  return { topics, files, controller, positioned };
}

test("delete previews close immediately on card exit and their lists never own hover", () => {
  const { topics, files, positioned, controller } = fixture();
  topics.trigger.emit("mouseenter");
  assert.equal(topics.detail.visible, true);
  assert.equal(files.detail.visible, false);
  assert.equal(positioned.length, 1);
  assert.equal(topics.detail.listenerCount, 0);
  topics.trigger.emit("mouseleave");
  assert.equal(topics.detail.visible, false, "No timer tick is needed to reach a delete button");
  topics.detail.emit("mouseenter");
  topics.detail.emit("focus");
  assert.equal(topics.detail.visible, false, "Entering the floating list cannot reopen or retain it");
  controller.destroy();
});

test("click-retained focus never keeps a preview open after the pointer leaves", () => {
  const { topics, controller } = fixture();
  topics.trigger.emit("mouseenter");
  topics.trigger.emit("focus");
  assert.equal(topics.detail.visible, true);
  // No blur: focus is deliberately still on the clicked card.
  topics.trigger.emit("mouseleave");
  assert.equal(topics.detail.visible, false);
  topics.trigger.emit("blur");
  assert.equal(topics.detail.visible, false);
  controller.destroy();
});

test("keyboard focus and card switching show only one preview without stale blur interference", () => {
  const { topics, files, controller } = fixture();
  topics.trigger.emit("focus");
  assert.equal(topics.detail.visible, true);
  files.trigger.emit("mouseenter");
  assert.equal(topics.detail.visible, false);
  assert.equal(files.detail.visible, true);
  topics.trigger.emit("blur");
  assert.equal(files.detail.visible, true);
  files.trigger.emit("mouseleave");
  files.trigger.emit("focus");
  assert.equal(files.detail.visible, true, "Tab focus remains an independent way to inspect details");
  files.trigger.emit("blur");
  assert.equal(files.detail.visible, false);
  controller.destroy();
});

test("rapid alternating hover leaves neither a second preview nor delayed reopening", () => {
  const { topics, files, controller } = fixture();
  for (let index = 0; index < 30; index += 1) {
    topics.trigger.emit("mouseenter");
    files.trigger.emit("mouseenter");
    topics.trigger.emit("mouseleave");
    assert.equal(topics.detail.visible, false);
    assert.equal(files.detail.visible, true);
    files.trigger.emit("mouseleave");
    assert.equal(files.detail.visible, false);
  }
  controller.destroy();
});

test("wheel forwarding handles pixels, lines and pages only over the visible hovered card", () => {
  const { topics, controller } = fixture();
  assert.equal(topics.trigger.wheel(20).defaultPrevented, false);
  topics.trigger.emit("focus");
  assert.equal(topics.trigger.wheel(20).defaultPrevented, false, "Keyboard-only focus is not pointer hover");
  topics.trigger.emit("mouseenter");
  const pixels = topics.trigger.wheel(42);
  assert.equal(pixels.defaultPrevented, true);
  assert.equal(pixels.stopped, true);
  assert.equal(topics.detail.scrollTop, 42);
  topics.trigger.wheel(3, 1);
  assert.equal(topics.detail.scrollTop, 90);
  topics.trigger.wheel(1, 2);
  assert.equal(topics.detail.scrollTop, 320);
  topics.trigger.emit("mouseleave");
  assert.equal(topics.trigger.wheel(20).defaultPrevented, false);
  controller.destroy();
});

test("overflow lists consume wheel input at both boundaries without scrolling the modal", () => {
  const { topics, controller } = fixture();
  topics.trigger.emit("mouseenter");
  const atTop = topics.trigger.wheel(-100);
  assert.equal(topics.detail.scrollTop, 0);
  assert.equal(atTop.defaultPrevented, true);
  assert.equal(atTop.stopped, true);
  topics.trigger.wheel(1000);
  assert.equal(topics.detail.scrollTop, 570);
  const atBottom = topics.trigger.wheel(100);
  assert.equal(topics.detail.scrollTop, 570);
  assert.equal(atBottom.defaultPrevented, true);
  assert.equal(atBottom.stopped, true);
  controller.destroy();
});

test("short lists, inactive cards and empty wheel deltas retain native scrolling", () => {
  const { topics, files, controller } = fixture();
  topics.detail.scrollHeight = topics.detail.clientHeight;
  topics.trigger.emit("mouseenter");
  const short = topics.trigger.wheel(20);
  assert.equal(short.defaultPrevented, false);
  assert.equal(short.stopped, false);
  files.trigger.emit("mouseenter");
  assert.equal(topics.trigger.wheel(20).defaultPrevented, false);
  assert.equal(files.trigger.wheel(0).defaultPrevented, false);
  assert.equal(files.trigger.wheel(Number.NaN).defaultPrevented, false);
  controller.destroy();
});

test("the two lists retain separate scroll offsets across hiding and re-entry", () => {
  const { topics, files, controller } = fixture();
  topics.trigger.emit("mouseenter");
  topics.trigger.wheel(200);
  topics.trigger.emit("mouseleave");
  assert.equal(topics.detail.scrollTop, 0, "Fixture simulates hidden-element geometry");
  files.trigger.emit("mouseenter");
  files.trigger.wheel(80);
  files.trigger.emit("mouseleave");
  topics.trigger.emit("mouseenter");
  assert.equal(topics.detail.scrollTop, 200);
  files.trigger.emit("mouseenter");
  assert.equal(files.detail.scrollTop, 80);
  controller.destroy();
});

test("destroy closes previews, releases every card listener and is idempotent", () => {
  const { topics, files, positioned, controller } = fixture();
  topics.trigger.emit("mouseenter");
  assert.equal(topics.trigger.listenerCount, 5);
  assert.equal(files.trigger.listenerCount, 5);
  controller.destroy();
  controller.destroy();
  assert.equal(topics.detail.visible, false);
  assert.equal(topics.trigger.listenerCount, 0);
  assert.equal(files.trigger.listenerCount, 0);
  assert.equal(topics.detail.listenerCount, 0);
  assert.equal(files.detail.listenerCount, 0);
  topics.trigger.emit("mouseenter");
  files.trigger.emit("focus");
  assert.equal(topics.trigger.wheel(20).defaultPrevented, false);
  assert.equal(files.detail.visible, false);
  assert.equal(positioned.length, 1);
});

test("separate modal/window controllers never share active details or cleanup", () => {
  const first = fixture();
  const second = fixture();
  first.topics.trigger.emit("mouseenter");
  second.files.trigger.emit("focus");
  assert.equal(first.topics.detail.visible, true);
  assert.equal(second.files.detail.visible, true);
  first.controller.destroy();
  assert.equal(second.files.detail.visible, true);
  second.controller.destroy();
});

test("modal wiring retains accessibility and default deletion action, with owner-window cleanup", () => {
  const source = readFileSync(new URL("../src/ui/modals/delete-branch-modal.ts", import.meta.url), "utf8");
  assert.match(source, /tabindex: "0"/);
  assert.match(source, /card\.setAttribute\("aria-describedby", detailId\)/);
  assert.match(source, /role: "tooltip"/);
  assert.match(source, /this\.detailController\?\.destroy\(\)/);
  assert.match(source, /this\.focusWindow = this\.modalEl\.ownerDocument\.defaultView/);
  assert.match(source, /this\.focusWindow\?\.clearTimeout\(this\.focusTimer\)/);
  assert.match(source, /if \(topics\.isConnected\) topics\.focus\(\)/);
  assert.match(source, /topics\.addEventListener\("click", \(\) => this\.submit\("topics-only"\)\)/);
  assert.doesNotMatch(source, /hideTimer|scheduleHide|detail\.addEventListener|matches\(":hover"\)/);
});
