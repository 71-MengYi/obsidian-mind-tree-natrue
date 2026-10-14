import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { translate } from "../src/i18n/catalog";
import {
  DEFAULT_SETTINGS,
  MAX_MCP_PORT,
  MCP_PORT_FALLBACK_ATTEMPTS,
  MIN_MCP_PORT,
  type MindTreeSettings
} from "../src/settings-model";
import { DEFAULT_MCP_HOST, MCP_ENDPOINT_PATH } from "../src/services/mcp/connection";
import type { McpPageState } from "../src/services/mcp/settings-page-model";
import type { SettingsPagePort } from "../src/ui/settings-pages/ports";

// Exercise the real AI settings page with only the Obsidian helpers it uses
// simulated. `Setting` is the page's single Obsidian dependency, so the shim
// below stands in for it; everything else the page needs is its own bundle.
const bundle = buildSync({
  entryPoints: ["src/ui/settings-pages/ai-settings-page.ts"],
  bundle: true, write: false, format: "cjs", platform: "browser", external: ["obsidian"]
}).outputFiles[0]!.text;

interface ElementOptions {
  readonly cls?: string;
  readonly text?: string;
  readonly attr?: Readonly<Record<string, string>>;
  readonly type?: string;
}

interface EventInit {
  readonly key?: string;
}

class TestEvent {
  defaultPrevented = false;
  propagationStopped = false;
  constructor(readonly type: string, private readonly init: EventInit = {}) {}
  get key(): string { return this.init.key ?? ""; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
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
  readOnly = false;
  checked = false;

  constructor(readonly ownerDocument: TestDocument, readonly tag = "div") {}

  createEl(tag: string, options: ElementOptions | string = {}): TestElement {
    const child = new TestElement(this.ownerDocument, tag);
    const resolved = typeof options === "string" ? { cls: options } : options;
    if (resolved.cls) child.addClass(resolved.cls);
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
  /** Only the selectors this harness uses are supported; anything else is a bug. */
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
  contains(other: TestElement | null): boolean {
    return other !== null && (other === this || this.children.some((child) => child.contains(other)));
  }
  focus(): void { this.ownerDocument.activeElement = this; }
  all(): TestElement[] {
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

/** One Obsidian control component; the page only uses the listed methods. */
class TestToggle {
  readonly toggleEl: TestElement;
  constructor(parent: TestElement) { this.toggleEl = parent.createEl("input", { attr: { type: "checkbox" } }); }
  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  setDisabled(value: boolean): this { this.toggleEl.disabled = value; return this; }
  onChange(handler: (value: boolean) => unknown): this {
    // Obsidian reads the switch's own state when it dispatches, so the shim does
    // the same instead of remembering a value the DOM could disagree with.
    this.toggleEl.addEventListener("change", () => { handler(this.toggleEl.checked); });
    return this;
  }
}

class TestText {
  readonly inputEl: TestElement;
  constructor(parent: TestElement) { this.inputEl = parent.createEl("input", { attr: { type: "text" } }); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
}

class TestTextArea {
  readonly inputEl: TestElement;
  constructor(parent: TestElement) { this.inputEl = parent.createEl("textarea", {}); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
}

class TestButton {
  readonly buttonEl: TestElement;
  constructor(parent: TestElement) { this.buttonEl = parent.createEl("button", { attr: { type: "button" } }); }
  setButtonText(text: string): this { this.buttonEl.setText(text); return this; }
  onClick(handler: () => unknown): this { this.buttonEl.addEventListener("click", handler); return this; }
}

/** Obsidian's `Setting` row: an info column plus a control column. */
class TestSetting {
  readonly settingEl: TestElement;
  readonly nameEl: TestElement;
  readonly descEl: TestElement;
  readonly controlEl: TestElement;
  readonly toggles: TestToggle[] = [];
  readonly texts: TestText[] = [];
  readonly textAreas: TestTextArea[] = [];
  readonly buttons: TestButton[] = [];

  constructor(containerEl: TestElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    const info = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = info.createDiv({ cls: "setting-item-name" });
    this.descEl = info.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(name: string): this { this.nameEl.setText(name); return this; }
  setDesc(desc: string): this { this.descEl.setText(desc); return this; }
  addToggle(configure: (component: TestToggle) => unknown): this {
    const component = new TestToggle(this.controlEl);
    this.toggles.push(component);
    configure(component);
    return this;
  }
  addText(configure: (component: TestText) => unknown): this {
    const component = new TestText(this.controlEl);
    this.texts.push(component);
    configure(component);
    return this;
  }
  addTextArea(configure: (component: TestTextArea) => unknown): this {
    const component = new TestTextArea(this.controlEl);
    this.textAreas.push(component);
    configure(component);
    return this;
  }
  addButton(configure: (component: TestButton) => unknown): this {
    const component = new TestButton(this.controlEl);
    this.buttons.push(component);
    configure(component);
    return this;
  }
}

type PageInstance = { readonly element: TestElement; destroy?(): void };
type PageConstructor = new (parent: TestElement, port: SettingsPagePort) => PageInstance;

interface Sandbox {
  readonly Page: PageConstructor;
  /** Every `Setting` row the page built, in creation order. */
  readonly settings: TestSetting[];
  /** Pending `setTimeout` callbacks, so timer ownership can be asserted. */
  readonly timers: Map<number, () => void>;
  readonly document: TestDocument;
}

/**
 * Build a fresh realm per fixture: the page's timer and the row registry are
 * per-instance state, and `--test-isolation=none` means cross-fixture globals
 * would leak between cases.
 */
function evaluate(): Sandbox {
  const settings: TestSetting[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  const document = new TestDocument();
  const module = { exports: {} as Record<string, unknown> };
  class SandboxSetting extends TestSetting {
    constructor(containerEl: TestElement) {
      super(containerEl);
      settings.push(this);
    }
  }
  runInNewContext(bundle, {
    module,
    exports: module.exports,
    console,
    // Fake timers: the copy confirmation must be cancellable by `destroy`.
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    require: (id: string) => {
      assert.equal(id, "obsidian");
      return { getLanguage: () => "en", Setting: SandboxSetting };
    }
  });
  return { Page: module.exports["AiSettingsPage"] as PageConstructor, settings, timers, document };
}

interface HarnessOptions {
  readonly supported?: boolean;
  readonly enabled?: boolean;
  readonly allowWrites?: boolean;
  readonly port?: number;
  readonly configuredPort?: number;
  readonly token?: string;
  /** `false` makes the clipboard write fail, which the page must handle. */
  readonly copySucceeds?: boolean;
  /** `true` makes the enable transition reject, as a busy port would. */
  readonly failEnable?: boolean;
  /** Port text this page would parse but the host still refuses. */
  readonly refusePortInput?: readonly string[];
}

interface Harness {
  readonly root: TestElement;
  readonly settings: TestSetting[];
  readonly calls: string[];
  readonly copied: string[];
  readonly timers: Map<number, () => void>;
  readonly state: McpPageState;
  page: PageInstance;
  enableToggle(): TestElement;
  writeToggle(): TestElement;
  portField(): TestElement;
  portError(): TestElement;
  statusLine(): TestElement;
  notice(): TestElement;
  configSection(): TestElement;
  configText(): TestElement;
  copyButton(): TestElement;
  copyFeedback(): TestElement;
  byClass(name: string): TestElement[];
  typePort(value: string): void;
  pressEnter(value: string): void;
  copy(): void;
  runTimers(): void;
}

/** The client JSON the model documents, restated so the page's copy is checked. */
const expectedConfig = (port: number, token: string): string => JSON.stringify({
  mcpServers: {
    "mind-tree-nature": {
      url: `http://${DEFAULT_MCP_HOST}:${port}${MCP_ENDPOINT_PATH}`,
      headers: { Authorization: `Bearer ${token}` }
    }
  }
}, null, 2);

function fixture(options: HarnessOptions = {}): Harness {
  const sandbox = evaluate();
  const root = sandbox.document.createElement("div");
  const settings: MindTreeSettings = structuredClone(DEFAULT_SETTINGS);
  const calls: string[] = [];
  const copied: string[] = [];
  const configuredPort = options.configuredPort ?? options.port ?? DEFAULT_SETTINGS.mcpPort;
  // A host that cannot serve MCP reports `unsupported` whatever the stored
  // preferences say, so the fixture reports it too and the page only has to
  // render what the model decided.
  const status: McpPageState["status"] = !(options.supported ?? true)
    ? { kind: "unsupported" }
    : (options.enabled ?? false)
      ? { kind: "running", url: `http://${DEFAULT_MCP_HOST}:${configuredPort}${MCP_ENDPOINT_PATH}` }
      : { kind: "stopped" };
  const state: McpPageState = {
    supported: options.supported ?? true,
    enabled: options.enabled ?? false,
    allowWrites: options.allowWrites ?? false,
    port: options.port ?? configuredPort,
    status,
    configuredPort,
    token: options.token ?? "test-token-0123456789"
  };
  const port: SettingsPagePort = {
    settings,
    save: async () => { calls.push("save"); },
    refreshOpenLayouts: () => { calls.push("refresh"); },
    rebuildResourceIndex: async () => assert.fail("the AI page never rebuilds the file index"),
    updates: {
      check: async () => assert.fail("the AI page never checks for updates"),
      showAvailable: () => assert.fail("the AI page never opens the update dialog"),
      subscribe: () => () => undefined
    },
    mcp: {
      state: () => state,
      setEnabled: async (enabled) => {
        calls.push(`setEnabled:${enabled}`);
        if (options.failEnable) throw new Error("address already in use");
        state.enabled = enabled;
        state.status = enabled
          ? { kind: "running", url: `http://${DEFAULT_MCP_HOST}:${state.configuredPort}${MCP_ENDPOINT_PATH}` }
          : { kind: "stopped" };
      },
      setAllowWrites: async (allowWrites) => {
        calls.push(`setAllowWrites:${allowWrites}`);
        state.allowWrites = allowWrites;
      },
      setPort: async (value) => {
        calls.push(`setPort:${value}`);
        state.port = value;
      },
      applyPortInput: async (raw) => {
        calls.push(`applyPortInput:${raw}`);
        if ((options.refusePortInput ?? []).includes(raw)) return false;
        if (!/^\d{1,5}$/.test(raw)) return false;
        const value = Number(raw);
        if (value < MIN_MCP_PORT || value > MAX_MCP_PORT) return false;
        state.port = value;
        return true;
      },
      start: async () => {
        calls.push("start");
        return state.status;
      },
      stop: async () => { calls.push("stop"); state.status = { kind: "stopped" }; },
      copyText: async (text) => {
        calls.push("copyText");
        copied.push(text);
        return options.copySucceeds ?? true;
      }
    }
  };

  const page = new sandbox.Page(root, port);
  assert.equal(page.element, root, "the page must expose the panel it filled");

  const byClass = (name: string): TestElement[] => root.all().filter((element) => element.hasClass(name));
  const only = (name: string): TestElement => {
    const found = byClass(name);
    assert.equal(found.length, 1, `expected exactly one .${name}`);
    return found[0]!;
  };
  const field = (): TestElement => {
    const input = at(sandbox.settings, 2, "port Setting").texts[0]?.inputEl;
    assert.ok(input, "the port Setting needs a text field");
    return input;
  };
  /** Completing the edit the way a user does: type, then leave the field. */
  const typePort = (value: string): void => {
    const input = field();
    input.value = value;
    input.fire("blur");
  };

  return {
    root,
    settings: sandbox.settings,
    calls,
    copied,
    timers: sandbox.timers,
    state,
    page,
    byClass,
    enableToggle: () => at(at(sandbox.settings, 0, "enable Setting").toggles, 0, "enable toggle").toggleEl,
    writeToggle: () => at(at(sandbox.settings, 1, "writes Setting").toggles, 0, "writes toggle").toggleEl,
    portField: field,
    portError: () => only("mtn-settings-ai-port-error"),
    statusLine: () => only("mtn-settings-ai-status"),
    notice: () => only("mtn-settings-ai-notice"),
    configSection: () => only("mtn-settings-ai-config"),
    configText: () => {
      const area = at(sandbox.settings, 3, "config Setting").textAreas[0]?.inputEl;
      assert.ok(area, "the config Setting needs a textarea");
      return area;
    },
    copyButton: () => at(at(sandbox.settings, 3, "config Setting").buttons, 0, "copy button").buttonEl,
    copyFeedback: () => only("mtn-settings-ai-copy-feedback"),
    typePort,
    pressEnter: (value) => {
      const input = field();
      input.value = value;
      input.fire("keydown", { key: "Enter" });
    },
    copy: () => { at(at(sandbox.settings, 3, "config Setting").buttons, 0, "copy button").buttonEl.fire("click"); },
    runTimers: () => {
      const pending = [...sandbox.timers.values()];
      sandbox.timers.clear();
      for (const callback of pending) callback();
    }
  };
}

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  assert.ok(item, `expected ${what} at index ${index}`);
  return item;
}

const settle = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

test("renders the AI tab heading and the model's MCP heading and description", () => {
  const h = fixture();

  assert.equal(at(h.root.children, 0, "page heading").tag, "h3");
  assert.equal(at(h.root.children, 0, "page heading").text, translate("settings.tabs.ai", "en"));
  const heading = at(h.root.children, 1, "section heading");
  assert.equal(heading.tag, "h4");
  assert.equal(heading.text, translate("settings.ai.mcp.heading", "en"));
  const description = at(h.root.children, 2, "section description");
  assert.equal(description.hasClass("setting-item-description"), true);
  assert.equal(description.text, translate("settings.ai.mcp.desc", "en"));

  // The four rows are the enable switch, the write switch, the port and the
  // client config, in the order the panel documents.
  assert.deepEqual(h.settings.map((setting) => setting.nameEl.text), [
    translate("settings.ai.mcp.enable", "en"),
    translate("settings.ai.mcp.writes", "en"),
    translate("settings.ai.mcp.port", "en"),
    ""
  ]);
  assert.deepEqual(h.settings.map((setting) => setting.descEl.text), [
    translate("settings.ai.mcp.enable.desc", "en"),
    translate("settings.ai.mcp.writes.desc", "en"),
    translate("settings.ai.mcp.port.desc", "en", {
      min: MIN_MCP_PORT, max: MAX_MCP_PORT, fallbacks: MCP_PORT_FALLBACK_ATTEMPTS
    }),
    translate("settings.ai.mcp.config.secretWarning", "en")
  ]);

  // No description may reach the user with an unreplaced placeholder.
  for (const element of h.byClass("setting-item-description")) {
    assert.doesNotMatch(element.text, /\{\w+\}/);
  }
});

test("both switches show the resolved state and the write switch is inert while the server is off", () => {
  const off = fixture({ enabled: false, allowWrites: true });
  assert.equal(off.enableToggle().checked, false);
  assert.equal(off.enableToggle().disabled, false);
  assert.equal(off.writeToggle().checked, true);
  assert.equal(off.writeToggle().disabled, true, "write tools are meaningless while the server is off");

  const on = fixture({ enabled: true });
  assert.equal(on.enableToggle().checked, true);
  assert.equal(on.writeToggle().disabled, false);
});

test("flipping the server switch runs the named transition and re-reads the port's state", async () => {
  const h = fixture({ enabled: false });
  h.enableToggle().checked = true;
  h.enableToggle().fire("change");
  await settle();

  assert.deepEqual(h.calls, ["setEnabled:true"]);
  assert.equal(h.state.enabled, true);
  assert.equal(h.writeToggle().disabled, false, "the write switch follows the new state");
  assert.equal(h.statusLine().dataset["status"], "running");
  assert.equal(h.statusLine().text, translate("settings.ai.mcp.status.running", "en", {
    url: `http://${DEFAULT_MCP_HOST}:${h.state.configuredPort}${MCP_ENDPOINT_PATH}`
  }));

  h.writeToggle().checked = true;
  h.writeToggle().fire("change");
  await settle();
  assert.deepEqual(h.calls, ["setEnabled:true", "setAllowWrites:true"]);
  assert.equal(h.state.allowWrites, true);
});

test("a rejected transition explains itself on the status line without a false state", async () => {
  const h = fixture({ enabled: false, failEnable: true });
  h.enableToggle().checked = true;
  h.enableToggle().fire("change");
  await settle();

  assert.equal(h.statusLine().dataset["status"], "failed");
  assert.equal(h.statusLine().text,
    translate("settings.ai.mcp.status.failed", "en", { message: "address already in use" }));
  assert.equal(h.state.enabled, false, "a rejected transition must not look applied");
});

test("a platform without MCP support disables every control, hides the config and shows the notice", () => {
  const h = fixture({ supported: false });

  assert.equal(h.enableToggle().disabled, true);
  assert.equal(h.enableToggle().checked, false);
  assert.equal(h.writeToggle().disabled, true);
  assert.equal(h.portField().disabled, true);
  assert.equal(h.statusLine().dataset["status"], "unsupported");
  assert.equal(h.statusLine().text, translate("settings.ai.mcp.status.desktopOnly", "en"));
  assert.equal(h.configSection().hidden, true, "no token is handed out where nothing can serve it");
  assert.equal(h.notice().hidden, false);
  assert.equal(h.notice().text, translate("settings.ai.mcp.status.desktopOnly", "en"));

  const supported = fixture({ supported: true });
  assert.equal(supported.notice().hidden, true);
  assert.equal(supported.configSection().hidden, false);
});

test("the config textarea is readonly and holds the model's client configuration", () => {
  const h = fixture({ configuredPort: DEFAULT_SETTINGS.mcpPort, token: "token-abcdefghij" });

  assert.equal(h.configText().readOnly, true, "the credential must not be editable by hand");
  assert.equal(h.configText().value, expectedConfig(DEFAULT_SETTINGS.mcpPort, "token-abcdefghij"));
  assert.equal(h.configText().getAttribute("aria-label"), translate("settings.ai.mcp.config.heading", "en"));
  assert.equal(h.copyButton().text, translate("settings.ai.mcp.config.copy", "en"));
});

test("copying sends the model JSON and confirms once the clipboard accepted it", async () => {
  const h = fixture({ configuredPort: 27321, token: "token-abcdefghij" });
  h.copy();
  await settle();

  assert.deepEqual(h.calls, ["copyText"]);
  assert.deepEqual(h.copied, [expectedConfig(27321, "token-abcdefghij")]);
  assert.equal(h.copyFeedback().text, translate("settings.ai.mcp.config.copied", "en"));
  assert.equal(h.copyFeedback().getAttribute("aria-live"), "polite");
  // The confirmation is transient and its timer belongs to the page.
  assert.equal(h.timers.size, 1);
  h.runTimers();
  assert.equal(h.copyFeedback().text, "");
  assert.equal(h.timers.size, 0);
});

test("a failed automatic copy reveals the readonly textarea and shows the manual hint", async () => {
  const h = fixture({ copySucceeds: false });
  h.copy();
  await settle();

  assert.equal(h.copyFeedback().text, translate("settings.ai.mcp.config.copyFailed", "en"));
  assert.equal(h.configText().hidden, false, "the text the hint points at must be visible");
  assert.equal(h.configText().readOnly, true);
});

test("destroy clears the pending copy timer", async () => {
  const h = fixture();
  h.copy();
  await settle();
  assert.equal(h.timers.size, 1);

  h.page.destroy?.();
  assert.equal(h.timers.size, 0, "no timer may outlive the page");
});

test("a valid port is committed on blur and the field reflects the stored port", async () => {
  const h = fixture({ port: DEFAULT_SETTINGS.mcpPort });
  h.typePort("1025");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:1025"]);
  assert.equal(h.state.port, 1025);
  assert.equal(h.portField().value, "1025");
  assert.equal(h.portError().hidden, true);
  assert.equal(h.portError().text, "");
});

test("Enter commits the port the same way leaving the field does", async () => {
  const h = fixture({ port: DEFAULT_SETTINGS.mcpPort });
  h.pressEnter("1200");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:1200"]);
  assert.equal(h.state.port, 1200);
  assert.equal(h.portField().value, "1200");
});

test("non-numeric and out-of-range text is rejected, named, and the stored port is restored", async () => {
  const cases = ["", "abc", "1.5", "12 34", "-1", String(MIN_MCP_PORT - 1), String(MAX_MCP_PORT + 1), "999999"];
  for (const raw of cases) {
    const h = fixture({ port: DEFAULT_SETTINGS.mcpPort });
    h.typePort(raw);
    await settle();

    assert.deepEqual(h.calls, [], `"${raw}" must be refused before it reaches the port`);
    assert.equal(h.state.port, DEFAULT_SETTINGS.mcpPort, `"${raw}" must not change the stored port`);
    assert.equal(h.portError().hidden, false, `"${raw}" must be reported`);
    assert.equal(h.portError().text,
      translate("settings.ai.mcp.port.invalid", "en", { min: MIN_MCP_PORT, max: MAX_MCP_PORT }));
    assert.doesNotMatch(h.portError().text, /\{\w+\}/);
    assert.equal(h.portField().value, String(DEFAULT_SETTINGS.mcpPort),
      `"${raw}" must not look stored`);
  }
});

test("the port is not validated while the user is still typing", async () => {
  const h = fixture({ port: DEFAULT_SETTINGS.mcpPort });
  const input = h.portField();
  input.value = "1";
  input.fire("input");
  input.value = "10";
  input.fire("input");
  await settle();

  assert.deepEqual(h.calls, [], "a half-typed port must not be committed");
  assert.equal(h.portError().hidden, true);
  assert.equal(input.value, "10", "the field keeps what the user typed");
});

test("a port the page parsed but the host refused is reported and rolled back", async () => {
  // applyPortInput is the only authority, so an in-range value the host still
  // refuses must be reported and must not look stored.
  const h = fixture({ port: DEFAULT_SETTINGS.mcpPort, refusePortInput: ["1500"] });
  h.typePort("1500");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:1500"]);
  assert.equal(h.state.port, DEFAULT_SETTINGS.mcpPort, "the host's refusal wins");
  assert.equal(h.portError().hidden, false);
  assert.equal(h.portError().text,
    translate("settings.ai.mcp.port.invalid", "en", { min: MIN_MCP_PORT, max: MAX_MCP_PORT }));
  assert.equal(h.portField().value, String(DEFAULT_SETTINGS.mcpPort));
});
