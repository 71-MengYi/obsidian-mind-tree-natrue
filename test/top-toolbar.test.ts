import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import type { TopToolbar, TopToolbarActions, TopToolbarLabels } from "../src/ui/components/top-toolbar";

// Exercise the real toolbar with an isolated Obsidian boundary and native-button semantics.
const bundle = buildSync({ entryPoints: ["src/ui/components/top-toolbar.ts"], bundle: true,
  write: false, format: "cjs", platform: "browser", external: ["obsidian"] }).outputFiles[0]!.text;

class TestElement extends EventTarget {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  disabled = false;
  text = "";

  createEl(_tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): TestElement {
    const child = new TestElement();
    child.attributes = options.attr ?? {};
    child.text = options.text ?? "";
    this.children.push(child);
    return child;
  }
  createDiv(_className: string): TestElement { return this.createEl("div"); }
  setText(text: string): void { this.text = text; }
  remove(): void {}
  click(): void { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

const module = { exports: {} as { TopToolbar: new (
  parent: TestElement, labels: TopToolbarLabels, actions: TopToolbarActions
) => Pick<TopToolbar, "update" | "destroy"> & { element: TestElement } } };
runInNewContext(bundle, { module, exports: module.exports, require(id: string) {
  assert.equal(id, "obsidian");
  return { setIcon() {} };
} });

function fixture() {
  const labels: TopToolbarLabels = {
    expandAll: "Expand", collapseAll: "Collapse", collapseLevel: "Level", markers: "Markers",
    fit: "Fit", zoomOut: "Zoom out", zoomIn: "Zoom in", search: "Search",
    copy: "Copy", importText: "Import", exportTree: "Export"
  };
  const calls: string[] = [];
  const record = (label: keyof TopToolbarLabels) => () => { calls.push(label); };
  const toolbar = new module.exports.TopToolbar(new TestElement(), labels, {
    expandAll: record("expandAll"), collapseAll: record("collapseAll"), showCollapseLevel: record("collapseLevel"),
    showMarkers: record("markers"), fit: record("fit"), zoomOut: record("zoomOut"), zoomIn: record("zoomIn"),
    search: record("search"), showCopyMenu: record("copy"), importText: record("importText"), showExportMenu: record("exportTree")
  });
  const button = (label: keyof TopToolbarLabels) => {
    const element = toolbar.element.children.find((child) => child.attributes["aria-label"] === labels[label]);
    assert.ok(element, label);
    return element;
  };
  return { toolbar, button, calls };
}

test("node actions are disabled before selection and follow selection being made or cleared", () => {
  const { toolbar, button, calls } = fixture();
  const nodeActions = ["markers", "copy", "exportTree"] as const;
  for (const label of nodeActions) {
    assert.equal(button(label).disabled, true);
    button(label).click();
  }
  assert.deepEqual(calls, []);
  for (const hasSelection of [true, false, true]) {
    calls.length = 0;
    toolbar.update({ zoom: 1.25, hasSelection });
    for (const label of nodeActions) {
      assert.equal(button(label).disabled, !hasSelection);
      button(label).click();
    }
    assert.deepEqual(calls, hasSelection ? [...nodeActions] : []);
  }
  toolbar.destroy();
});

test("whole-tree and canvas actions remain available without a selection while zoom keeps updating", () => {
  const { toolbar, button, calls } = fixture();
  const globalActions = ["expandAll", "collapseAll", "collapseLevel", "fit", "zoomOut", "zoomIn", "search", "importText"] as const;
  for (const hasSelection of [false, true, false]) {
    calls.length = 0;
    toolbar.update({ zoom: 0.85, hasSelection });
    for (const label of globalActions) {
      assert.equal(button(label).disabled, false);
      button(label).click();
    }
    assert.deepEqual(calls, [...globalActions]);
    assert.equal(toolbar.element.children.find((child) => child.dataset.role === "zoom")?.text, "85%");
  }
  toolbar.destroy();
});
