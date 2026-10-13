import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const embedSource = readFileSync(new URL("../src/ui/components/mind-tree-reference-embed.ts", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../src/ui/components/read-only-tree-preview.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("the reference embed reuses the shared read-only preview instead of the view", () => {
  assert.match(embedSource, /export class MindTreeReferenceEmbed extends DisposableUiObject/);
  assert.match(embedSource, /export class MindTreeReferenceRenderChild extends MarkdownRenderChild/);
  assert.match(embedSource, /new ReadOnlyTreePreview\(/);
  assert.match(embedSource, /export interface MindTreeReferenceEmbedPorts/);
  // UI components must never reach back into the view or the plugin entry.
  assert.doesNotMatch(embedSource, /MindTreeView/);
  assert.doesNotMatch(embedSource, /from "\.\.\/\.\.\/main"/);
});

test("the reference embed wires an opted-in open control and a pass-through wheel", () => {
  assert.match(embedSource, /className: "mtn-view mtn-embed-tree"/);
  assert.match(embedSource, /startId: nodeId/);
  assert.match(embedSource, /fit: "width"/);
  // The box height is derived from the layout, so the first fit still measures a
  // placeholder height: the embed must re-fit until the reader takes over.
  assert.match(embedSource, /refitOnResize: true/);
  assert.match(embedSource, /allowResourceOpen: true/);
  assert.match(embedSource, /wheelPassThrough: true/);
  // The host receives the node itself: only the document being rendered knows
  // which resource that node points at.
  assert.match(embedSource, /openResource: \(node: Readonly<MindTreeNode>\) => void/);
  assert.match(embedSource, /openResource: \(node\) => \{ this\.ports\.openResource\(node\); \}/);
  assert.match(embedSource, /setIcon\(button, "git-fork"\)/);
  assert.match(embedSource, /"aria-label": t\("embed\.openTree"\)/);
  assert.match(embedSource, /--mtn-embed-height/);
  assert.match(embedSource, /subscribe\(\(\) => this\.scheduleRefresh\(\)\)/);
  assert.match(embedSource, /clearRefreshTimer/);
  // An in-place refresh must also refresh the accessible name of the branch.
  assert.match(embedSource, /this\.preview\.setLabel\(/);
});

test("the read-only preview keeps the contract the version comparison asserts on", () => {
  assert.match(previewSource, /readOnly: true/);
  assert.match(previewSource, /if \(!this\.fitted && width > 0 && height > 0\)/);
  // Contain fitting is the untouched default; "width" is the embed-only path.
  assert.match(previewSource, /this\.options\.fit === "width"/);
  assert.match(previewSource, /this\.options\.startId \?\? document\.rootId/);
  assert.match(previewSource, /options\.className \?\? "mtn-view mtn-version-tree"/);
  assert.match(previewSource, /wheelPassThrough === true\) return;/);
  // A refresh reuses the preview, so the open control must resolve its node from
  // the document of the current pass instead of a captured one.
  assert.match(previewSource, /const node = document\.nodes\[id\];/);
  assert.match(previewSource, /setLabel\(label: string\): void/);
  // Re-centering is bounded: it stops the moment the reader moves the viewport,
  // and ignores hair-thin box churn that could otherwise oscillate.
  assert.match(previewSource, /refitOnResize === true && !this\.userAdjusted/);
  assert.match(previewSource, /Math\.abs\(height - this\.fittedHeight\) >= 2/);
  assert.match(previewSource, /private fitToContainer\(/);
  assert.equal((previewSource.match(/this\.userAdjusted = true;/g) ?? []).length, 3);
});

test("the embed stylesheet keeps the height variable and its clamp", () => {
  assert.match(css, /min\(80vh, 4000px\)/);
  assert.match(css, /--mtn-embed-height/);
});

test("the embedded open button opens the mind-tree view and never the source file", () => {
  assert.match(mainSource, /registerMarkdownCodeBlockProcessor\(BRANCH_REFERENCE_LANGUAGE/);
  // Rule C.14: no entry may open the `.mtn.md` source. This handler must route
  // through the plugin's mind-tree view instead of any file open/read path.
  assert.match(mainSource, /openTree: \(path\) => \{[\s\S]{0,300}?activateMindTree\(file\)/);
  assert.doesNotMatch(mainSource, /openTree: \(path\) => \{[\s\S]{0,300}?openFile\(/);
  assert.doesNotMatch(mainSource, /openTree: \(path\) => \{[\s\S]{0,300}?vault\.read\(/);
  // Harden the rule: exactly one file-open path may exist (the non-tree branch of
  // openLinkedFile), and the global leaf patch that reroutes every `.mtn.md` open
  // must stay registered.
  assert.equal((mainSource.match(/\.openFile\(/g) ?? []).length, 1);
  assert.match(mainSource, /around\(WorkspaceLeaf\.prototype/);
});
