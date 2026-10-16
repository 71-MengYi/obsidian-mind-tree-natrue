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
import {
  DEFAULT_MCP_HOST,
  MCP_ENDPOINT_PATH,
  mcpServerName,
  type McpServerGroup
} from "../src/services/mcp/connection";
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
  /** The master switch. */
  readonly enabled?: boolean;
  /** The write server's own switch; there is no per-tool switch any more. */
  readonly writeEnabled?: boolean;
  readonly readPort?: number;
  readonly writePort?: number;
  readonly readToken?: string;
  readonly writeToken?: string;
  /** `false` makes the clipboard write fail, which the page must handle. */
  readonly copySucceeds?: boolean;
  /** `true` makes the master transition reject, as a busy port would. */
  readonly failEnable?: boolean;
  /** `true` makes the write-server transition reject. */
  readonly failWrite?: boolean;
  /** `true` makes the port transition reject outright. */
  readonly failPort?: boolean;
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
  serverBlock(server: McpServerGroup): TestElement;
  serverHeading(server: McpServerGroup): TestElement;
  serverScope(server: McpServerGroup): TestElement;
  statusLine(server: McpServerGroup): TestElement;
  portField(server: McpServerGroup): TestElement;
  portError(server: McpServerGroup): TestElement;
  configSection(): TestElement;
  configText(): TestElement;
  copyButton(): TestElement;
  copyFeedback(): TestElement;
  secretWarning(): TestElement;
  notice(): TestElement;
  byClass(name: string): TestElement[];
  indexOf(element: TestElement): number;
  typePort(server: McpServerGroup, value: string): void;
  pressEnter(server: McpServerGroup, value: string): void;
  copy(): void;
  runTimers(): void;
}

const READ_TOKEN = "read-token-0123456789";
const WRITE_TOKEN = "write-token-0123456789";

/** One advertised server, so the page's copy is checked against the model. */
interface Connection {
  readonly group: McpServerGroup;
  readonly port: number;
  readonly token: string;
}

/**
 * The client JSON the model documents, restated so the page's copy is checked.
 *
 * Both servers are separate `mcpServers` entries — that split is the whole point
 * of the redesign, because a client attaches approval to a server.
 */
const expectedConfig = (connections: readonly Connection[]): string => {
  const mcpServers: Record<string, unknown> = {};
  for (const connection of connections) {
    mcpServers[mcpServerName(connection.group)] = {
      url: `http://${DEFAULT_MCP_HOST}:${connection.port}${MCP_ENDPOINT_PATH}`,
      headers: { Authorization: `Bearer ${connection.token}` }
    };
  }
  return JSON.stringify({ mcpServers }, null, 2);
};

function fixture(options: HarnessOptions = {}): Harness {
  const sandbox = evaluate();
  const root = sandbox.document.createElement("div");
  const settings: MindTreeSettings = structuredClone(DEFAULT_SETTINGS);
  const calls: string[] = [];
  const copied: string[] = [];
  const supported = options.supported ?? true;
  const enabled = options.enabled ?? false;
  const writeEnabled = options.writeEnabled ?? false;
  const readPort = options.readPort ?? DEFAULT_SETTINGS.mcpReadPort;
  const writePort = options.writePort ?? DEFAULT_SETTINGS.mcpWritePort;
  const readToken = options.readToken ?? READ_TOKEN;
  const writeToken = options.writeToken ?? WRITE_TOKEN;
  const running = (port: number): McpPageState["read"]["status"] => ({
    kind: "running",
    url: `http://${DEFAULT_MCP_HOST}:${port}${MCP_ENDPOINT_PATH}`
  });

  /**
   * What a host does after every transition: each listener reports its own
   * resolved state, so the page only ever renders what actually happened.
   */
  const settleStatus = (): void => {
    state.read.status = !supported ? { kind: "unsupported" } : state.enabled ? running(state.read.port) : { kind: "stopped" };
    state.write.status = !supported
      ? { kind: "unsupported" }
      : state.enabled && state.writeEnabled ? running(state.write.port) : { kind: "stopped" };
  };

  const state: McpPageState = {
    supported,
    enabled,
    read: {
      port: readPort,
      status: supported ? (enabled ? running(readPort) : { kind: "stopped" }) : { kind: "unsupported" },
      token: readToken
    },
    writeEnabled,
    write: {
      port: writePort,
      status: supported ? (enabled && writeEnabled ? running(writePort) : { kind: "stopped" }) : { kind: "unsupported" },
      token: writeToken
    }
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
      setEnabled: async (value) => {
        calls.push(`setEnabled:${value}`);
        if (options.failEnable) throw new Error("address already in use");
        state.enabled = value;
        settleStatus();
      },
      setWriteEnabled: async (value) => {
        calls.push(`setWriteEnabled:${value}`);
        if (options.failWrite) throw new Error("address already in use");
        state.writeEnabled = value;
        settleStatus();
      },
      setPort: async (server, value) => {
        calls.push(`setPort:${server}:${value}`);
        state[server].port = value;
      },
      applyPortInput: async (server, raw) => {
        calls.push(`applyPortInput:${server}:${raw}`);
        if (options.failPort) throw new Error("address already in use");
        if ((options.refusePortInput ?? []).includes(raw)) return false;
        if (!/^\d{1,5}$/.test(raw)) return false;
        const value = Number(raw);
        if (value < MIN_MCP_PORT || value > MAX_MCP_PORT) return false;
        state[server].port = value;
        return true;
      },
      start: async () => {
        calls.push("start");
        settleStatus();
      },
      stop: async () => {
        calls.push("stop");
        state.enabled = false;
        state.writeEnabled = false;
        settleStatus();
      },
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
  const serverBlock = (server: McpServerGroup): TestElement => {
    const found = byClass("mtn-settings-ai-server")
      .filter((element) => element.getAttribute("data-server") === server);
    assert.equal(found.length, 1, `expected exactly one ${server} server block`);
    return found[0]!;
  };
  const serverPart = (server: McpServerGroup, name: string): TestElement => {
    const found = serverBlock(server).all().filter((element) => element.hasClass(name));
    assert.equal(found.length, 1, `expected exactly one .${name} in the ${server} block`);
    return found[0]!;
  };
  const portField = (server: McpServerGroup): TestElement => serverPart(server, "mtn-settings-ai-port-input");

  return {
    root,
    settings: sandbox.settings,
    calls,
    copied,
    timers: sandbox.timers,
    state,
    page,
    byClass,
    serverBlock,
    indexOf: (element) => root.all().indexOf(element),
    serverHeading: (server) => serverPart(server, "mtn-settings-ai-server-heading"),
    serverScope: (server) => serverPart(server, "mtn-settings-ai-server-scope"),
    statusLine: (server) => serverPart(server, "mtn-settings-ai-status"),
    portField,
    portError: (server) => serverPart(server, "mtn-settings-ai-port-error"),
    enableToggle: () => at(at(sandbox.settings, 0, "enable Setting").toggles, 0, "enable toggle").toggleEl,
    writeToggle: () => at(at(sandbox.settings, 2, "write enable Setting").toggles, 0, "write toggle").toggleEl,
    configSection: () => only("mtn-settings-ai-config"),
    configText: () => {
      const area = at(sandbox.settings, 4, "config Setting").textAreas[0]?.inputEl;
      assert.ok(area, "the config Setting needs a textarea");
      return area;
    },
    copyButton: () => at(at(sandbox.settings, 4, "config Setting").buttons, 0, "copy button").buttonEl,
    copyFeedback: () => only("mtn-settings-ai-copy-feedback"),
    secretWarning: () => only("mtn-settings-ai-secret-warning"),
    notice: () => only("mtn-settings-ai-notice"),
    typePort: (server, value) => {
      const input = portField(server);
      input.value = value;
      input.fire("blur");
    },
    pressEnter: (server, value) => {
      const input = portField(server);
      input.value = value;
      input.fire("keydown", { key: "Enter" });
    },
    copy: () => { at(at(sandbox.settings, 4, "config Setting").buttons, 0, "copy button").buttonEl.fire("click"); },
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

const portDesc = (): string => translate("settings.ai.mcp.port.desc", "en", {
  min: MIN_MCP_PORT,
  max: MAX_MCP_PORT,
  fallbacks: MCP_PORT_FALLBACK_ATTEMPTS
});

const portInvalid = (): string => translate("settings.ai.mcp.port.invalid", "en", {
  min: MIN_MCP_PORT,
  max: MAX_MCP_PORT
});

test("renders the AI tab heading, the model's section heading and one port row per server", () => {
  const h = fixture();

  assert.equal(at(h.root.children, 0, "page heading").tag, "h3");
  assert.equal(at(h.root.children, 0, "page heading").text, translate("settings.tabs.ai", "en"));
  const heading = at(h.root.children, 1, "section heading");
  assert.equal(heading.tag, "h4");
  assert.equal(heading.text, translate("settings.ai.mcp.heading", "en"));
  const description = at(h.root.children, 2, "section description");
  assert.equal(description.hasClass("setting-item-description"), true);
  assert.equal(description.text, translate("settings.ai.mcp.desc", "en"));

  // The rows are the master switch, the read port, the write switch, the write
  // port and the client config, in the order the panel documents.
  assert.deepEqual(h.settings.map((setting) => setting.nameEl.text), [
    translate("settings.ai.mcp.enable", "en"),
    translate("settings.ai.mcp.port", "en"),
    translate("settings.ai.mcp.write.enable", "en"),
    translate("settings.ai.mcp.port", "en"),
    ""
  ]);
  assert.deepEqual(h.settings.map((setting) => setting.descEl.text), [
    translate("settings.ai.mcp.enable.desc", "en"),
    portDesc(),
    "",
    portDesc(),
    translate("settings.ai.mcp.config.desc", "en", { clients: translate("settings.ai.mcp.config.clients", "en") })
  ]);

  // No description may reach the user with an unreplaced placeholder.
  for (const element of h.byClass("setting-item-description")) {
    assert.doesNotMatch(element.text, /\{\w+\}/);
  }
});

test("lays the section out as master, read, write, config and token warning, in that order", () => {
  const h = fixture();

  const masterRow = at(h.settings, 0, "master Setting").settingEl;
  const readBlock = h.serverBlock("read");
  const writeBlock = h.serverBlock("write");
  const config = h.configSection();
  const warning = h.secretWarning();

  assert.ok(h.indexOf(masterRow) < h.indexOf(readBlock), "the master switch comes before the read server");
  assert.ok(h.indexOf(readBlock) < h.indexOf(writeBlock), "the read server comes before the write server");
  assert.ok(h.indexOf(writeBlock) < h.indexOf(config), "the servers come before the client config");
  assert.ok(h.indexOf(config) < h.indexOf(warning), "the client config comes before the token warning");
  assert.ok(h.indexOf(h.copyFeedback()) < h.indexOf(h.configText()), "the manual hint names the field below it");
  assert.ok(h.indexOf(h.configText()) < h.indexOf(h.copyButton()), "the textarea comes before the button that copies it");

  // Inside the read block: heading, scope, port, status.
  assert.ok(h.indexOf(h.serverHeading("read")) < h.indexOf(h.serverScope("read")));
  assert.ok(h.indexOf(h.serverScope("read")) < h.indexOf(h.portField("read")));
  assert.ok(h.indexOf(h.portField("read")) < h.indexOf(h.statusLine("read")));
  // Inside the write block: heading, scope, its own switch, port, status.
  assert.ok(h.indexOf(h.serverHeading("write")) < h.indexOf(h.serverScope("write")));
  assert.ok(h.indexOf(h.serverScope("write")) < h.indexOf(h.writeToggle()));
  assert.ok(h.indexOf(h.writeToggle()) < h.indexOf(h.portField("write")));
  assert.ok(h.indexOf(h.portField("write")) < h.indexOf(h.statusLine("write")));
  // The rejection sits with the field it is about, between port and status.
  assert.ok(h.indexOf(h.portField("read")) < h.indexOf(h.portError("read")));
  assert.ok(h.indexOf(h.portError("read")) < h.indexOf(h.statusLine("read")));

  assert.equal(h.serverHeading("read").text, translate("settings.ai.mcp.read.heading", "en"));
  assert.equal(h.serverScope("read").text, translate("settings.ai.mcp.read.scope", "en"));
  assert.equal(h.serverHeading("write").text, translate("settings.ai.mcp.write.heading", "en"));
  assert.equal(h.serverScope("write").text, translate("settings.ai.mcp.write.scope", "en"));
  assert.equal(h.secretWarning().text, translate("settings.ai.mcp.config.secretWarning", "en"));
});

test("both servers' ports and the write switch are inert while the master switch is off", () => {
  const off = fixture({ enabled: false });
  assert.equal(off.enableToggle().checked, false);
  assert.equal(off.enableToggle().disabled, false);
  assert.equal(off.writeToggle().checked, false);
  assert.equal(off.writeToggle().disabled, true, "a second listener is meaningless while nothing listens");
  assert.equal(off.portField("read").disabled, true, "no port is bindable while nothing listens");
  assert.equal(off.portField("write").disabled, true);

  const on = fixture({ enabled: true, writeEnabled: false });
  assert.equal(on.enableToggle().checked, true);
  assert.equal(on.enableToggle().disabled, false);
  assert.equal(on.writeToggle().disabled, false, "the write switch is the user's to flip once the master switch is on");
  assert.equal(on.portField("read").disabled, false);
  assert.equal(on.portField("write").disabled, true, "a server that is switched off cannot bind a port");
});

test("the write switch never disables the read server", async () => {
  const h = fixture({ enabled: true, writeEnabled: false });
  assert.equal(h.portField("read").disabled, false);
  assert.equal(h.statusLine("read").dataset["status"], "running");

  h.writeToggle().checked = true;
  h.writeToggle().fire("change");
  await settle();

  assert.deepEqual(h.calls, ["setWriteEnabled:true"]);
  assert.equal(h.state.writeEnabled, true);
  assert.equal(h.portField("read").disabled, false, "the read server follows the master switch only");
  assert.equal(h.portField("write").disabled, false);
  assert.equal(h.statusLine("read").dataset["status"], "running");
  assert.equal(h.statusLine("write").dataset["status"], "running");
});

test("flipping the master switch runs setEnabled and re-reads both servers' state", async () => {
  const h = fixture({ enabled: false });
  assert.equal(h.statusLine("read").dataset["status"], "stopped");
  assert.equal(h.statusLine("read").text, translate("settings.ai.mcp.status.stopped", "en"));

  h.enableToggle().checked = true;
  h.enableToggle().fire("change");
  await settle();

  assert.deepEqual(h.calls, ["setEnabled:true"]);
  assert.equal(h.state.enabled, true);
  assert.equal(h.statusLine("read").dataset["status"], "running");
  assert.equal(h.statusLine("read").text, translate("settings.ai.mcp.status.running", "en", {
    url: `http://${DEFAULT_MCP_HOST}:${h.state.read.port}${MCP_ENDPOINT_PATH}`
  }));
  assert.equal(h.writeToggle().disabled, false, "the write switch follows the new state");
  assert.equal(h.statusLine("write").dataset["status"], "stopped", "the write server was never switched on");
});

test("flipping the write switch starts that server only", async () => {
  const h = fixture({ enabled: true, writeEnabled: false });

  h.writeToggle().checked = true;
  h.writeToggle().fire("change");
  await settle();

  assert.deepEqual(h.calls, ["setWriteEnabled:true"]);
  assert.equal(h.state.writeEnabled, true);
  assert.equal(h.statusLine("write").dataset["status"], "running");
  assert.equal(h.statusLine("write").text, translate("settings.ai.mcp.status.running", "en", {
    url: `http://${DEFAULT_MCP_HOST}:${h.state.write.port}${MCP_ENDPOINT_PATH}`
  }));
  assert.equal(h.statusLine("read").dataset["status"], "running", "the read server keeps its own state");
});

test("a rejected master transition explains itself without a false state", async () => {
  // The failure crosses the vm realm boundary, so this also pins the message
  // extraction: an `instanceof Error` check would leak an "Error:" prefix.
  const h = fixture({ enabled: false, failEnable: true });
  h.enableToggle().checked = true;
  h.enableToggle().fire("change");
  await settle();

  assert.equal(h.statusLine("read").dataset["status"], "failed");
  assert.equal(h.statusLine("read").text,
    translate("settings.ai.mcp.status.failed", "en", { message: "address already in use" }));
  assert.equal(h.state.enabled, false, "a rejected transition must not look applied");
  assert.equal(h.enableToggle().checked, false, "the switch snaps back to the stored value");
});

test("a rejected write transition explains itself on the write status line only", async () => {
  const h = fixture({ enabled: true, failWrite: true });
  h.writeToggle().checked = true;
  h.writeToggle().fire("change");
  await settle();

  assert.equal(h.statusLine("write").dataset["status"], "failed");
  assert.equal(h.statusLine("write").text,
    translate("settings.ai.mcp.status.failed", "en", { message: "address already in use" }));
  assert.equal(h.statusLine("read").dataset["status"], "running", "the read server keeps its own state");
  assert.equal(h.writeToggle().checked, false);
});

test("a platform without MCP support disables every control, hides the config and shows the notice", () => {
  const h = fixture({ supported: false });

  assert.equal(h.enableToggle().disabled, true);
  assert.equal(h.enableToggle().checked, false);
  assert.equal(h.writeToggle().disabled, true);
  assert.equal(h.portField("read").disabled, true);
  assert.equal(h.portField("write").disabled, true);
  assert.equal(h.statusLine("read").dataset["status"], "unsupported");
  assert.equal(h.statusLine("read").text, translate("settings.ai.mcp.status.desktopOnly", "en"));
  assert.equal(h.statusLine("write").dataset["status"], "unsupported");
  assert.equal(h.configSection().hidden, true, "no token is handed out where nothing can serve it");
  assert.equal(h.secretWarning().text, translate("settings.ai.mcp.config.secretWarning", "en"));
  assert.equal(h.notice().hidden, false);
  assert.equal(h.notice().text, translate("settings.ai.mcp.status.desktopOnly", "en"));

  const supported = fixture({ supported: true });
  assert.equal(supported.notice().hidden, true);
  assert.equal(supported.configSection().hidden, false);
});

test("the config textarea is readonly and holds the model's two-server JSON", () => {
  const h = fixture({
    enabled: true, writeEnabled: true,
    readPort: 27321, writePort: 27322, readToken: READ_TOKEN, writeToken: WRITE_TOKEN
  });

  assert.equal(h.configText().readOnly, true, "the credentials must not be editable by hand");
  assert.equal(h.configText().value, expectedConfig([
    { group: "read", port: 27321, token: READ_TOKEN },
    { group: "write", port: 27322, token: WRITE_TOKEN }
  ]));
  assert.match(h.configText().value, /"mind-tree-nature-read"/);
  assert.match(h.configText().value, /"mind-tree-nature-write"/);
  assert.equal(h.configText().getAttribute("aria-label"), translate("settings.ai.mcp.config.heading", "en"));
  assert.equal(h.copyButton().text, translate("settings.ai.mcp.config.copy", "en"));
});

test("the copied configuration only advertises a server that is meant to listen", () => {
  const readOnly = fixture({ enabled: true, writeEnabled: false });
  assert.equal(readOnly.configText().value, expectedConfig([
    { group: "read", port: DEFAULT_SETTINGS.mcpReadPort, token: READ_TOKEN }
  ]));

  const stopped = fixture({ enabled: false, writeEnabled: true });
  assert.deepEqual(JSON.parse(stopped.configText().value), { mcpServers: {} },
    "a plugin that is switched off advertises nothing");
});

test("copying sends the model JSON and confirms once the clipboard accepted it", async () => {
  const h = fixture({ enabled: true, writeEnabled: true, readPort: 27321, writePort: 27322 });
  h.copy();
  await settle();

  assert.deepEqual(h.calls, ["copyText"]);
  assert.deepEqual(h.copied, [expectedConfig([
    { group: "read", port: 27321, token: READ_TOKEN },
    { group: "write", port: 27322, token: WRITE_TOKEN }
  ])]);
  assert.equal(h.copyFeedback().text, translate("settings.ai.mcp.config.copied", "en"));
  assert.equal(h.copyFeedback().getAttribute("aria-live"), "polite");
  // The confirmation is transient and its timer belongs to the page.
  assert.equal(h.timers.size, 1);
  h.runTimers();
  assert.equal(h.copyFeedback().text, "");
  assert.equal(h.timers.size, 0);
});

test("a failed automatic copy reveals the readonly textarea and shows the manual hint", async () => {
  const h = fixture({ enabled: true, copySucceeds: false });
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

test("each server's port commits on blur through that server's named transition", async () => {
  const h = fixture({ enabled: true, writeEnabled: true });
  h.typePort("read", "1025");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:read:1025"]);
  assert.equal(h.state.read.port, 1025);
  assert.equal(h.state.write.port, DEFAULT_SETTINGS.mcpWritePort, "the other server keeps its port");
  assert.equal(h.portField("read").value, "1025");
  assert.equal(h.portError("read").hidden, true);
  assert.equal(h.portError("read").text, "");

  h.typePort("write", "1030");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:read:1025", "applyPortInput:write:1030"]);
  assert.equal(h.state.write.port, 1030);
  assert.equal(h.portField("write").value, "1030");
  assert.equal(h.portField("read").value, "1025", "committing one server must not rewrite the other's field");
});

test("Enter commits a port the same way leaving the field does", async () => {
  const h = fixture({ enabled: true });
  h.pressEnter("read", "1200");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:read:1200"]);
  assert.equal(h.state.read.port, 1200);
  assert.equal(h.portField("read").value, "1200");
});

test("non-numeric and out-of-range text is rejected, named and rolled back per server", async () => {
  const cases = ["", "abc", "1.5", "12 34", "-1", String(MIN_MCP_PORT - 1), String(MAX_MCP_PORT + 1), "999999"];
  for (const server of ["read", "write"] as const) {
    const stored = server === "read" ? 27321 : 27322;
    const other: McpServerGroup = server === "read" ? "write" : "read";
    for (const raw of cases) {
      const h = fixture({ enabled: true, writeEnabled: true, readPort: 27321, writePort: 27322 });
      h.typePort(server, raw);
      await settle();

      assert.deepEqual(h.calls, [], `"${raw}" must be refused before it reaches the port`);
      assert.equal(h.state[server].port, stored, `"${raw}" must not change the ${server} port`);
      assert.equal(h.portError(server).hidden, false, `"${raw}" must be reported`);
      assert.equal(h.portError(server).text, portInvalid());
      assert.doesNotMatch(h.portError(server).text, /\{\w+\}/);
      assert.equal(h.portField(server).value, String(stored), `"${raw}" must not look stored`);
      assert.equal(h.portError(other).hidden, true, "the other server's rejection line stays quiet");
    }
  }
});

test("the port is not validated while the user is still typing", async () => {
  const h = fixture({ enabled: true });
  const input = h.portField("read");
  input.value = "1";
  input.fire("input");
  input.value = "10";
  input.fire("input");
  await settle();

  assert.deepEqual(h.calls, [], "a half-typed port must not be committed");
  assert.equal(h.portError("read").hidden, true);
  assert.equal(input.value, "10", "the field keeps what the user typed");
});

test("a port the page parsed but the host refused is reported and rolled back", async () => {
  // applyPortInput is the only authority, so an in-range value the host still
  // refuses must be reported and must not look stored.
  const h = fixture({ enabled: true, refusePortInput: ["1500"] });
  h.typePort("read", "1500");
  await settle();

  assert.deepEqual(h.calls, ["applyPortInput:read:1500"]);
  assert.equal(h.state.read.port, DEFAULT_SETTINGS.mcpReadPort, "the host's refusal wins");
  assert.equal(h.portError("read").hidden, false);
  assert.equal(h.portError("read").text, portInvalid());
  assert.equal(h.portField("read").value, String(DEFAULT_SETTINGS.mcpReadPort));
});

test("a port transition that fails outright reports the failure and restores the field", async () => {
  const h = fixture({ enabled: true, failPort: true });
  h.typePort("read", "1500");
  await settle();

  assert.equal(h.statusLine("read").dataset["status"], "failed");
  assert.equal(h.statusLine("read").text,
    translate("settings.ai.mcp.status.failed", "en", { message: "address already in use" }));
  assert.equal(h.portField("read").value, String(DEFAULT_SETTINGS.mcpReadPort));
  assert.equal(h.portError("read").hidden, true, "a host failure is not a port-format problem");
});
