import test from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./helpers/module-loader";
import type { NodeRenderer, NodeRenderActions, NodeRenderState } from "../src/ui/renderers/node-renderer";
import { fallbackResourceBadgePresentation } from "../src/render/resource-badges";
import { fallbackImageNodePresentation } from "../src/render/image-nodes";
import { fallbackNodeTextMeasurer } from "../src/render/text-measurer";
import type { MindTreeDocument, MindTreeNode, PositionedNode } from "../src/types";

// Exercise the real renderer from source with an isolated Obsidian boundary and a minimal DOM.
class TestElement {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly style = { setProperty: (_name: string, _value: string): void => undefined };
  readonly ownerDocument: { defaultView: { CSS: { supports: () => boolean } } } = {
    defaultView: { CSS: { supports: () => true } }
  };
  text = "";
  disabled = false;
  tabIndex = 0;
  icon = "";
  private readonly listeners = new Map<string, Array<(event: TestEvent) => void>>();

  constructor() {
    this.dataset = {};
  }

  createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): TestElement {
    const child = new TestElement();
    for (const name of (options.cls ?? "").split(/\s+/).filter(Boolean)) child.classes.add(name);
    Object.assign(child.attributes, options.attr ?? {});
    child.text = options.text ?? "";
    this.children.push(child);
    return child;
  }
  createDiv(cls = ""): TestElement { return this.createEl("div", { cls }); }
  createSpan(options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): TestElement {
    return this.createEl("span", options);
  }
  empty(): void { this.children.length = 0; }
  toggleClass(name: string, enabled: boolean): void {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }
  classList = { add: (name: string): void => { this.classes.add(name); } };
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  querySelectorAll(selector: string): TestElement[] {
    const wanted = selector.split(",").map((part) => part.trim().replace(/^\./, ""));
    return this.descendants().filter((element) => wanted.some((name) => element.classes.has(name)));
  }
  addEventListener(type: string, listener: (event: TestEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  click(): void {
    // A disabled button cannot dispatch a click in a real document either.
    if (this.disabled) return;
    const event: TestEvent = { type: "click", prevented: false, stopped: false,
      preventDefault(): void { event.prevented = true; },
      stopPropagation(): void { event.stopped = true; } };
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }
  private descendants(): TestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

interface TestEvent { type: string; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }

const module = { exports: loadModule<{ NodeRenderer: new (element: TestElement) => NodeRenderer }>(
  "src/ui/renderers/node-renderer.ts", {
    obsidian: {
      setIcon(element: TestElement, icon: string) { element.icon = icon; },
      getLanguage: () => "en"
    }
  }) };

function renderNode(node: MindTreeNode, readOnly = false, resourceOpenEnabled?: boolean) {
  const document: MindTreeDocument = {
    settings: { layoutMode: "right", recursiveScan: false, collectionMode: "off", theme: "vibrant",
      connectionStyle: "theme", nodeShape: "rounded" },
    title: "Root", rootId: node.id, nodes: { [node.id]: node }, createdAt: "now", updatedAt: "now"
  };
  const position: PositionedNode = { id: node.id, depth: 0, x: 0, y: 0, contentWidth: 80, width: 80, height: 24 };
  const calls: string[] = [];
  const actions: NodeRenderActions = {
    finishEdit: () => "committed", updateEditDraft: () => undefined, cancelEdit: () => undefined,
    saveImmediately: () => undefined, focusCanvas: () => undefined, toggleCollapsed: () => undefined,
    nodePointerDown: () => undefined, beginEdit: () => undefined, showContextMenu: () => undefined,
    openResource: () => { calls.push("openResource"); },
    goToLinkedNode: () => { calls.push("goToLinkedNode"); },
    beginImageResize: () => undefined
  };
  const state: NodeRenderState = {
    document, positions: [position], width: 80, height: 24, selectedIds: new Set(),
    editingSelectionMode: "all", branchColorSlots: new Map(), foldDirections: new Map(),
    nodeWrapWidth: 240, textMeasurer: fallbackNodeTextMeasurer,
    resourceBadgePresentation: fallbackResourceBadgePresentation,
    imageNodePresentation: fallbackImageNodePresentation,
    readOnly,
    resourceOpenEnabled
  };
  const container = new TestElement();
  new module.exports.NodeRenderer(container).render(state, actions);
  const controls = container.querySelectorAll(".mtn-node-controls")[0]!;
  return { controls, calls };
}

const baseNode = (): MindTreeNode => ({ id: "node", title: "Topic", childIds: [], createdAt: "now", updatedAt: "now" });

test("a node-link-only node renders exactly one control: the link mark", () => {
  const node = { ...baseNode(), nodeLink: "target" };
  const { controls, calls } = renderNode(node);
  assert.ok(controls, "controls container");
  const marks = controls.querySelectorAll(".mtn-link-mark");
  assert.equal(marks.length, 1);
  // The reported regression: an extra open button used to overflow the single
  // reserved slot and cover the title, and it did nothing without a resource.
  assert.equal(controls.querySelectorAll(".mtn-resource-open").length, 0);
  assert.equal(controls.children.length, 1);
  marks[0]!.click();
  assert.deepEqual(calls, ["goToLinkedNode"]);
});

test("a resource node keeps its open control and never renders a link mark", () => {
  const node: MindTreeNode = { ...baseNode(),
    resource: { type: "file", resourceId: "note", pathHint: "Topic.md", fileKind: "note" },
    titleSync: "bidirectional" };
  const { controls, calls } = renderNode(node);
  assert.equal(controls.querySelectorAll(".mtn-link-mark").length, 0);
  const open = controls.querySelectorAll(".mtn-resource-open");
  assert.equal(open.length, 1);
  // A linked note shows the note icon instead of a generic share glyph.
  assert.equal(open[0]!.icon, "file-text");
  open[0]!.click();
  assert.deepEqual(calls, ["openResource"]);
});

test("the open control shows the icon of the linked resource kind", () => {
  const iconFor = (resource: MindTreeNode["resource"]): string => {
    const { controls } = renderNode({ ...baseNode(), resource });
    return controls.querySelectorAll(".mtn-resource-open")[0]!.icon as string;
  };
  assert.equal(iconFor({ type: "url", url: "https://example.com" }), "globe");
  assert.equal(iconFor({ type: "file", resourceId: "pic", pathHint: "pic.png", fileKind: "image" }), "image");
  assert.equal(iconFor({ type: "file", resourceId: "tree", pathHint: "Other.mtn.md", fileKind: "note" }), "git-fork");
  assert.equal(iconFor({ type: "file", resourceId: "pdf", pathHint: "a.pdf", fileKind: "attachment" }), "file-text");
  assert.equal(iconFor({ type: "file", resourceId: "bin", pathHint: "a.bin", fileKind: "attachment" }), "file");
});

test("a stale resource on a linked node keeps only the link mark", () => {
  const node: MindTreeNode = { ...baseNode(), nodeLink: "target",
    resource: { type: "file", resourceId: "note", pathHint: "Topic.md", fileKind: "note" },
    titleSync: "off" };
  const { controls, calls } = renderNode(node);
  assert.equal(controls.children.length, 1);
  assert.equal(controls.querySelectorAll(".mtn-resource-open").length, 0);
  assert.equal(controls.querySelectorAll(".mtn-title-sync-off").length, 0);
  controls.querySelectorAll(".mtn-link-mark")[0]!.click();
  assert.deepEqual(calls, ["goToLinkedNode"]);
});

test("a read-only preview disables the link mark instead of navigating", () => {
  const node = { ...baseNode(), nodeLink: "target" };
  const { controls, calls } = renderNode(node, true);
  const mark = controls.querySelectorAll(".mtn-link-mark")[0]!;
  assert.equal(mark.disabled, true);
  assert.equal(mark.tabIndex, -1);
  mark.click();
  assert.deepEqual(calls, []);
});

test("a read-only preview can opt in to opening a resource while node links stay dead", () => {
  const resourceNode: MindTreeNode = { ...baseNode(),
    resource: { type: "file", resourceId: "note", pathHint: "Topic.md", fileKind: "note" } };
  const enabled = renderNode(resourceNode, true, true);
  const open = enabled.controls.querySelectorAll(".mtn-resource-open")[0]!;
  assert.equal(open.disabled, false);
  assert.equal(open.tabIndex, 0);
  open.click();
  assert.deepEqual(enabled.calls, ["openResource"]);

  // Enabling the open control must not revive link navigation: it would move a
  // view that a read-only preview does not own.
  const linkNode = { ...baseNode(), nodeLink: "target" };
  const linked = renderNode(linkNode, true, true);
  const mark = linked.controls.querySelectorAll(".mtn-link-mark")[0]!;
  assert.equal(mark.disabled, true);
  assert.equal(mark.tabIndex, -1);
  mark.click();
  assert.deepEqual(linked.calls, []);
});

test("a read-only preview keeps its open control disabled unless it opts in", () => {
  const node: MindTreeNode = { ...baseNode(),
    resource: { type: "file", resourceId: "note", pathHint: "Topic.md", fileKind: "note" } };
  const { controls, calls } = renderNode(node, true);
  const open = controls.querySelectorAll(".mtn-resource-open")[0]!;
  assert.equal(open.disabled, true);
  assert.equal(open.tabIndex, -1);
  open.click();
  assert.deepEqual(calls, []);
});
