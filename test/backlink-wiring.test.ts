import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read from the workspace root so this static wiring test can also run from the
// compiled fallback runner (the sandbox cannot spawn esbuild for tsx).
const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const main = source("src/main.ts");
const service = source("src/services/backlink-index.ts");
const view = source("src/ui/mind-tree-view.ts");
const renderer = source("src/ui/renderers/node-renderer.ts");
const model = source("src/ui/renderers/backlink-render-model.ts");
const touch = source("src/ui/controllers/touch-gesture-controller.ts");
const css = source("styles.css");

test("the plugin owns one backlink index and feeds it note events", () => {
  assert.match(main, /backlinks!: BacklinkIndexService;/);
  assert.match(main, /new BacklinkIndexService\(\{/);
  assert.match(main, /this\.backlinks\.start\(\);/);
  assert.match(main, /this\.register\(\(\) => this\.backlinks\.destroy\(\)\);/);
  // Note text is the only source, so every note event must reach the index.
  assert.match(main, /this\.registerEvent\(this\.app\.vault\.on\("create", notifyBacklinkSource\)\);/);
  assert.match(main, /this\.registerEvent\(this\.app\.vault\.on\("modify", notifyBacklinkSource\)\);/);
  assert.match(main, /this\.backlinks\.notifyRemoved\(file\.path\);/);
  assert.match(main, /this\.backlinks\.notifyRenamed\(oldPath, file\.path\);/);
  assert.match(main, /this\.backlinks\.notifyMetadataChanged\(file\.path\);/);
  // Folder events report only the folder, so the index rebuilds in batches.
  assert.equal((main.match(/this\.backlinks\.invalidateAll\(\);/g) ?? []).length, 2);
  // The metadata cache pre-filter never assumes the host keeps a language field.
  assert.match(main, /mayContainCodeBlock: \(path\) => \{[\s\S]*?section\.type === "code"/);
  assert.doesNotMatch(main, /section\.language/);
});

test("the index stays offline, batched and dependency-injected", () => {
  assert.doesNotMatch(service, /from "obsidian"/);
  assert.doesNotMatch(service, /requestUrl|fetch\(|XMLHttpRequest/);
  assert.match(service, /const FILES_PER_TICK = 25;/);
  assert.match(service, /entriesFor\(documentId: string\): BacklinkEntries/);
  assert.match(service, /subscribe\(listener: \(\) => void\): \(\) => void/);
  // A note above the scan budget and an unchanged stat are both skipped.
  assert.match(service, /MAX_BACKLINK_SCAN_BYTES/);
  assert.match(service, /cached\.mtime === note\.mtime && cached\.size === note\.size/);
  assert.match(service, /extractBranchReferences\(source\)/);
});

test("the view subscribes to the index, debounces the reflow and unsubscribes", () => {
  assert.match(view, /const BACKLINK_RENDER_DEBOUNCE_MS = 200;/);
  const subscribeIndex = view.indexOf("this.plugin.backlinks.subscribe(");
  assert.ok(subscribeIndex > 0, "view subscribes to the backlink index");
  assert.match(view.slice(subscribeIndex), /^this\.plugin\.backlinks\.subscribe\(\(\) => this\.scheduleBacklinkRender\(\)\);/);

  const scheduleStart = view.indexOf("private scheduleBacklinkRender(): void {");
  const scheduleEnd = view.indexOf("private cancelPendingBacklinkRender(): void {");
  const schedule = view.slice(scheduleStart, scheduleEnd);
  assert.ok(schedule.length > 0, "debounced backlink render method exists");
  assert.match(schedule, /BACKLINK_RENDER_DEBOUNCE_MS/);
  assert.match(schedule, /this\.render\(\);/);
  // Replacing the node DOM mid-edit would discard the open title editor.
  assert.match(schedule, /if \(this\.editingNodeId\) return;/);

  const detachStart = view.indexOf("private detachBacklinkIndex(): void {");
  const detach = view.slice(detachStart, view.indexOf("private renderConnections(", detachStart));
  assert.match(detach, /this\.backlinkUnsubscribe\?\.\(\);/);
  assert.match(detach, /this\.cancelPendingBacklinkRender\(\);/);
  // Closing the view must release both the listener and the pending timer.
  assert.match(view, /this\.searchController = undefined;\s*this\.detachBacklinkIndex\(\);/);

  // Only a tree with a persisted identity has entries; identity-less ones skip.
  assert.match(
    view,
    /const backlinks = document\.documentId \? this\.plugin\.backlinks\.entriesFor\(document\.documentId\) : undefined;/
  );
  assert.match(view, /imageNodePresentation: this\.imageNodePresentation \?\? fallbackImageNodePresentation,\s*backlinks\s*\}, \{/);
});

test("a pill opens its note through the existing search open-and-locate path", () => {
  assert.match(view, /openBacklink: \(target\) => void this\.openSearchedFileAtLine\(target\.path, target\.line\),/);
  assert.match(renderer, /readonly openBacklink\?: \(target: BacklinkTarget\) => void;/);
  assert.match(renderer, /actions\.openBacklink\?\.\(target\);/);
  // The pill must not start a node drag or a node selection.
  assert.match(renderer, /pill\.addEventListener\("pointerdown", \(event\) => event\.stopPropagation\(\)\);/);
});

test("the node renderer draws circles and the expanding pill list", () => {
  assert.match(renderer, /readonly backlinks\?: BacklinkEntries;/);
  assert.match(renderer, /if \(!state\.readOnly\) this\.renderBacklinks\(/);
  for (const className of [
    "mtn-node-backlinks",
    "mtn-backlink-dots",
    "mtn-backlink-dot",
    "mtn-backlink-overflow",
    "mtn-backlink-list",
    "mtn-backlink-pills",
    "mtn-backlink-pill"
  ]) {
    assert.ok(renderer.includes(className), `${className} is rendered`);
  }
  // The wrapper is a keyboard stop with a translated group name; circles are
  // decoration only and every pill is a real button named by its path.
  assert.match(renderer, /tabindex: "0"/);
  assert.match(renderer, /role: "group"/);
  assert.match(renderer, /t\("node\.backlinks", \{ count: model\.total \}\)/);
  assert.match(renderer, /"aria-hidden": "true"/);
  assert.match(renderer, /cls: "mtn-backlink-pill",\s*text: target\.path,/);
  assert.match(renderer, /title: target\.path, "aria-label": target\.path/);
  // Touch devices have no hover: the circles must be able to take focus.
  assert.match(renderer, /wrapper\.focus\(\{ preventScroll: true \}\)/);
  assert.match(touch, /\.mtn-node-backlinks";/);
});

test("the render model caps dots and pills", () => {
  assert.match(model, /export const MAX_BACKLINK_DOTS = 5;/);
  assert.match(model, /export const MAX_BACKLINK_PILLS = 20;/);
  assert.match(model, /Math\.min\(entries\.length, MAX_BACKLINK_DOTS\)/);
  assert.match(model, /overflow: entries\.length - dots/);
  assert.match(model, /pills: entries\.slice\(0, MAX_BACKLINK_PILLS\)/);
});

test("the stylesheet keeps the layer out of layout and animates it accessibly", () => {
  // The stylesheet uses CRLF, so the section is located by its marker comment.
  const marker = css.indexOf("Node backlinks");
  assert.ok(marker > 0, "backlink style section exists");
  const start = css.lastIndexOf("/*", marker);
  const end = css.indexOf(".mtn-node.is-drop-before::before", marker);
  const section = css.slice(start, end);
  assert.ok(section.length > 0, "backlink style section is bounded");

  const baseRule = section.match(/\.mtn-node-backlinks\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(baseRule, /position:\s*absolute;/);
  assert.match(baseRule, /top:\s*100%;/);
  assert.match(baseRule, /left:\s*0;/);
  assert.match(baseRule, /z-index:\s*9;/);
  // No fixed height: the circles never reserve node layout space.
  assert.doesNotMatch(baseRule, /\bheight:/);

  const collapsed = section.match(/\.mtn-backlink-list\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(collapsed, /grid-template-rows:\s*0fr;/);
  assert.match(collapsed, /opacity:\s*0;/);
  assert.match(collapsed, /visibility:\s*hidden;/);
  assert.match(collapsed, /pointer-events:\s*none;/);
  assert.match(collapsed, /transition:[\s\S]*?200ms/);

  assert.match(section, /\.mtn-node:is\(:hover, :focus-within\) > \.mtn-node-backlinks > \.mtn-backlink-list\s*\{[\s\S]*?grid-template-rows:\s*1fr;/);
  assert.match(section, /\.mtn-backlink-pill:is\(:hover, :focus-visible\)/);

  // No permanent GPU layer and no hardcoded colours: themes own the palette.
  assert.doesNotMatch(section, /will-change/);
  assert.doesNotMatch(section, /#[0-9a-f]{3,8}\b/i);

  const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(reducedMotion, /\.mtn-backlink-list\s*\{\s*transition:\s*none;\s*\}/);
});
