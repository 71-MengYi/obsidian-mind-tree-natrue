import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import { DEFAULT_SETTINGS } from "../src/settings-model";
import { UpdateError, type PluginRelease, type ReleaseClient } from "../src/services/updates/release-client";
import { UpdateCoordinator, type UpdateRuntime, type UpdateState } from "../src/services/updates/update-coordinator";
import type { UpdateStore } from "../src/services/updates/update-store";
import type { SettingsPagePort } from "../src/ui/settings-pages/ports";

// Isolate the Obsidian boundary without changing module hooks shared by other tests.
// The plugin, modal, settings section, translations and coordinator run unchanged.
const bundles = buildSync({ entryPoints: ["src/main.ts", "src/ui/settings-pages/plugin-update-section.ts"],
  outdir: "unused", bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian", "electron"] }).outputFiles;

type ElementOptions = string | { cls?: string; text?: string; attr?: Record<string, string> };
class TestDocument {
  activeElement?: TestElement;
  timers = new Map<number, () => void>();
  private nextTimer = 0;
  defaultView = {
    setTimeout: (callback: () => void) => { const id = ++this.nextTimer; this.timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { this.timers.delete(id); }
  };
  createElement(tag: string): TestElement { return new TestElement(this, tag); }
  flushTimers(): void { for (const callback of this.timers.values()) callback(); this.timers.clear(); }
}
class TestElement {
  children: TestElement[] = [];
  classes = new Set<string>();
  attributes: Record<string, string> = {};
  text = "";
  disabled = false;
  hidden = false;
  handlers = new Map<string, () => void>();
  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") {}
  createEl(tag: string, options: ElementOptions = {}): TestElement {
    const child = this.ownerDocument.createElement(tag);
    const opts = typeof options === "string" ? { cls: options } : options;
    if (opts.cls) child.addClass(opts.cls);
    child.text = opts.text ?? ""; child.attributes = opts.attr ?? {};
    this.append(child); return child;
  }
  createDiv(options?: ElementOptions): TestElement { return this.createEl("div", options); }
  addClass(value: string): void { for (const name of value.split(" ")) this.classes.add(name); }
  append(child: TestElement): void { this.children.push(child); }
  setText(text: string): void { this.empty(); this.text = text; }
  empty(): void { this.children = []; this.text = ""; }
  focus(): void { this.ownerDocument.activeElement = this; }
  addEventListener(type: string, handler: () => void): void { this.handlers.set(type, handler); }
  click(): void { if (!this.disabled) this.handlers.get("click")?.(); }
  all(): TestElement[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}
class TestComponent {
  loaded = false;
  cleanups: Array<() => unknown> = [];
  children: TestComponent[] = [];
  load(): void { this.loaded = true; this.children.forEach((child) => child.load()); }
  unload(): void {
    if (!this.loaded) return;
    this.loaded = false; this.children.forEach((child) => child.unload());
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
  }
  register(cleanup: () => unknown): void { this.cleanups.push(cleanup); }
  addChild<T extends TestComponent>(child: T): T { this.children.push(child); if (this.loaded) child.load(); return child; }
}
type TestApp = { document: TestDocument; modals: TestModal[] };
class TestModal {
  visible = false;
  readonly containerEl: TestElement;
  readonly modalEl: TestElement;
  readonly titleEl: TestElement;
  readonly contentEl: TestElement;
  constructor(readonly app: TestApp) {
    this.containerEl = app.document.createElement("div");
    this.modalEl = this.containerEl.createDiv();
    this.titleEl = this.modalEl.createEl("h2");
    this.contentEl = this.modalEl.createDiv("modal-content");
    app.modals.push(this);
  }
  open(): void { this.visible = true; this.onOpen(); }
  close(): void { if (!this.visible) return; this.visible = false; this.onClose(); }
  // Obsidian's Modal owns these two dismissal routes.
  pressEscape(): void { this.close(); }
  clickClose(): void { this.close(); }
  onOpen(): void {}
  onClose(): void {}
}
class TestSetting {
  constructor(readonly element: TestElement) {}
  setName(_name: string): this { return this; }
  setHeading(): this { return this; }
  addToggle(setup: (toggle: { setValue(value: boolean): unknown; onChange(handler: () => void): unknown }) => void): this {
    const toggle = { setValue(_value: boolean) { return toggle; }, onChange(_handler: () => void) { return toggle; } };
    setup(toggle); return this;
  }
  addButton(setup: (button: { buttonEl: TestElement; setButtonText(text: string): unknown; onClick(callback: () => void): unknown }) => void): this {
    const buttonEl = this.element.createEl("button");
    const button = { buttonEl, setButtonText(text: string) { buttonEl.setText(text); return button; },
      onClick(callback: () => void) { buttonEl.addEventListener("click", callback); return button; } };
    setup(button); return this;
  }
}
interface RunningPlugin {
  updates: UpdateCoordinator;
  updateRuntime: UpdateRuntime;
  showAvailableUpdate(): void;
  onunload(): void;
}
type RenderCall = { source: string; element: TestElement; sourcePath: string; component: TestComponent };
function fixture(language = "en", notes = "## Changes\n\n- **Improved** navigation") {
  const app: TestApp = { document: new TestDocument(), modals: [] };
  const renders: RenderCall[] = [];
  let render = async (call: RenderCall) => { call.element.createEl("h2", { text: "Rendered release heading" }); };
  class TestPlugin extends TestComponent {
    constructor(readonly app: TestApp, readonly manifest: { name: string }) { super(); }
  }
  const obsidian = { Plugin: TestPlugin, Modal: TestModal, Component: TestComponent, Setting: TestSetting,
    PluginSettingTab: class {}, TextFileView: class {}, FuzzySuggestModal: class {},
    getLanguage: () => language, Platform: { isMobile: false },
    MarkdownRenderer: { async render(renderApp: TestApp, source: string, element: TestElement, sourcePath: string, component: TestComponent) {
      assert.equal(renderApp, app);
      const call = { source, element, sourcePath, component }; renders.push(call); await render(call);
    } } };
  const load = (suffix: string): Record<string, unknown> => {
    const module = { exports: {} };
    runInNewContext(bundles.find((output) => output.path.replaceAll("\\", "/").endsWith(suffix))!.text,
      { module, exports: module.exports, structuredClone, console,
        require: (id: string) => { assert.equal(id, "obsidian"); return obsidian; } });
    return module.exports;
  };
  const Plugin = load("/main.js").default as new (app: TestApp, manifest: { name: string }) => RunningPlugin;
  const plugin = new Plugin(app, { name: "Mind Tree Nature" });
  let release: PluginRelease = { id: 42, version: "1.0.2", notes, assets: {} as PluginRelease["assets"],
    manifest: { id: "mind-tree-nature", version: "1.0.2", minAppVersion: "1.8.7", isDesktopOnly: false } };
  let checks = 0, subscriptions = 0;
  const installs: PluginRelease[] = [];
  const notifications: UpdateState[] = [];
  const client = {
    async latest() { checks++; return { ...release }; },
    async download(value: PluginRelease) { installs.push(value); throw new UpdateError("network"); }
  } as unknown as ReleaseClient;
  const updates = new UpdateCoordinator(client, {} as UpdateStore, {
    assertSupported() { assert.equal(app.modals.some((modal) => modal.visible), false, "confirmation must close before installation"); },
    async prepare() { return assert.fail("download stops this test before staging"); }
  }, plugin.updateRuntime, "1.0.1", (state) => {
    notifications.push(state);
    if (state.phase === "available") plugin.showAvailableUpdate();
  });
  const subscribe = updates.subscribe.bind(updates);
  updates.subscribe = (listener) => {
    subscriptions++;
    const unsubscribe = subscribe(listener);
    return () => { subscriptions--; unsubscribe(); };
  };
  plugin.updates = updates;
  return { app, plugin, updates, renders, installs, notifications, load,
    render: (handler: typeof render) => { render = handler; },
    release: (value: PluginRelease) => { release = value; },
    counts: () => ({ checks, subscriptions }),
    modal: () => app.modals.at(-1)!,
    open: async () => { await updates.check(); return app.modals.at(-1)!; } };
}
const button = (modal: TestModal, text: string) => modal.contentEl.all().find((element) => element.tag === "button" && element.text === text)!;
const notesRegion = (modal: TestModal) => modal.contentEl.all().find((element) => element.attributes.role === "region")!;
const settleRender = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test("startup, manual checks and repeated views share a single plugin-owned modal", async () => {
  const f = fixture();
  f.updates.startup(true); await f.updates.check();
  const first = f.modal();
  f.plugin.showAvailableUpdate(); f.plugin.showAvailableUpdate();
  assert.equal(f.app.modals.length, 1); assert.equal(f.counts().checks, 1);
  const checking = f.updates.check();
  assert.equal(first.visible, false); assert.equal(f.counts().subscriptions, 0);
  assert.equal(checking, f.updates.check());
  await checking;
  assert.equal(f.app.modals.length, 2); assert.equal(f.modal().visible, true);
  assert.equal(f.app.modals.filter((modal) => modal.visible).length, 1);
  assert.equal(f.counts().subscriptions, 1); assert.equal(f.installs.length, 0);
  f.plugin.onunload();
  assert.equal(f.modal().visible, false); assert.equal(f.counts().subscriptions, 0);
  f.plugin.showAvailableUpdate(); assert.equal(f.app.modals.length, 2);
});

test("Later, Escape and the close button dismiss without installation and allow reopening", async () => {
  for (const dismiss of [(modal: TestModal) => button(modal, "Later").click(),
    (modal: TestModal) => modal.pressEscape(), (modal: TestModal) => modal.clickClose()]) {
    const f = fixture(); const modal = await f.open();
    f.app.document.flushTimers();
    assert.equal(f.app.document.activeElement, button(modal, "Later"));
    dismiss(modal);
    assert.equal(f.installs.length, 0); assert.equal(f.counts().subscriptions, 0);
    assert.equal(modal.contentEl.children.length, 0);
    f.plugin.showAvailableUpdate();
    assert.equal(f.counts().checks, 1); assert.equal(f.app.modals.length, 2);
    assert.equal(f.modal().visible, true); f.plugin.onunload();
  }
});

test("confirmation installs once after closing, while stale callbacks cannot install another release", async () => {
  const f = fixture(); const old = await f.open();
  const oldClick = button(old, "Update now").handlers.get("click")!;
  f.release({ ...f.updates.state.availableRelease!, id: 43, version: "1.0.3", notes: "Newer notes" });
  await f.updates.check();
  oldClick();
  assert.equal(f.installs.length, 0);
  assert.equal(f.modal().visible, true);
  const click = button(f.modal(), "Update now").handlers.get("click")!;
  click(); click();
  await f.updates.install();
  assert.equal(f.installs.length, 1);
  assert.equal(f.installs[0]!.version, "1.0.3");
  assert.equal(f.counts().subscriptions, 0);
  assert.equal(f.notifications.at(-1)!.phase, "error");
});

test("both languages show plugin and versions, render the original Markdown, and focus Later", async () => {
  for (const [language, later, install, empty] of [
    ["en", "Later", "Update now", "No release notes provided for this version."],
    ["zh", "稍后", "立即更新", "此版本未提供更新日志"]
  ]) {
    const source = "## 更新\n\n- **Original** wording\n\n".repeat(150);
    const f = fixture(language!, source); const modal = await f.open(); await settleRender();
    assert.match(modal.titleEl.text, /Mind Tree Nature/);
    assert.ok(modal.contentEl.all().some((element) => element.text.includes("1.0.2")));
    assert.ok(modal.contentEl.all().some((element) => element.text.includes("1.0.1")));
    assert.equal(f.renders.length, 1); assert.equal(f.renders[0]!.source, source);
    assert.equal(f.renders[0]!.sourcePath, "");
    assert.equal(f.renders[0]!.component.loaded, true);
    assert.equal(notesRegion(modal).children[0], f.renders[0]!.element);
    assert.ok(button(modal, install!)); f.app.document.flushTimers();
    assert.equal(f.app.document.activeElement, button(modal, later!));
    f.plugin.onunload(); assert.equal(f.renders[0]!.component.loaded, false);
    const noNotes = fixture(language!, ""); const emptyModal = await noNotes.open();
    assert.equal(noNotes.renders.length, 0);
    assert.ok(notesRegion(emptyModal).all().some((element) => element.text === empty));
    noNotes.plugin.onunload();
  }
});

test("failed Markdown rendering discards partial output and preserves the original text", async () => {
  const f = fixture("en", "<broken>\n## Original\n  unchanged");
  let cleaned = 0;
  f.render(async (call) => {
    call.component.register(() => { cleaned++; });
    call.element.createDiv({ text: "partial rendering" });
    throw new Error("renderer failed");
  });
  const modal = await f.open(); await settleRender();
  assert.equal(cleaned, 1);
  assert.equal(notesRegion(modal).children[0]!.text, "<broken>\n## Original\n  unchanged");
  assert.ok(!notesRegion(modal).all().some((element) => element.text === "partial rendering"));
  assert.ok(button(modal, "Update now")); f.plugin.onunload();
});

test("closing during async rendering releases resources and ignores late output and registrations", async () => {
  for (const reject of [false, true]) {
    const f = fixture(); let finish!: () => void; let cleaned = 0, lateCleaned = 0;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    f.render(async (call) => {
      call.component.register(() => { cleaned++; });
      await gate;
      call.component.register(() => { lateCleaned++; });
      const child = new TestComponent(); child.load();
      call.component.addChild(child); assert.equal(child.loaded, false);
      call.element.createDiv({ text: "late content" });
      if (reject) throw new Error("late failure");
    });
    const modal = await f.open();
    const region = notesRegion(modal);
    f.plugin.onunload();
    assert.equal(cleaned, 1); assert.equal(f.app.document.timers.size, 0);
    assert.equal(f.counts().subscriptions, 0);
    finish(); await settleRender();
    assert.equal(lateCleaned, 1); assert.equal(region.children.length, 0);
    assert.equal(modal.contentEl.children.length, 0);
  }
});

test("settings View update reopens the cached release without checking or installing", async () => {
  for (const [language, viewText, checkText] of [["en", "View update", "Check for updates"], ["zh", "查看更新", "检查更新"]]) {
    const f = fixture(language); const modal = await f.open(); modal.close();
    const Section = f.load("/plugin-update-section.js").PluginUpdateSection as new (parent: TestElement, port: SettingsPagePort) => { destroy(): void };
    const parent = f.app.document.createElement("div");
    const port: SettingsPagePort = { settings: structuredClone(DEFAULT_SETTINGS), save: async () => undefined,
      refreshOpenLayouts() {}, rebuildResourceIndex: async () => assert.fail(),
      updates: { check: () => f.updates.check(), showAvailable: () => f.plugin.showAvailableUpdate(),
        subscribe: (listener) => f.updates.subscribe(listener) } };
    const section = new Section(parent, port);
    const view = parent.all().find((element) => element.text === viewText)!;
    assert.equal(view.hidden, false); view.click();
    assert.equal(f.counts().checks, 1); assert.equal(f.modal().visible, true); assert.equal(f.installs.length, 0);
    parent.all().find((element) => element.text === checkText)!.click();
    assert.equal(view.hidden, true); await f.updates.check();
    assert.equal(view.hidden, false); assert.equal(f.counts().checks, 2);
    section.destroy(); assert.equal(f.counts().subscriptions, 1);
    f.plugin.onunload(); assert.equal(f.counts().subscriptions, 0);
  }
});
