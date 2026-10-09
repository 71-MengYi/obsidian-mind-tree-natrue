import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_DOCUMENT_SETTINGS } from "../src/document-settings";
import {
  placeThemePreview,
  themePreviewDocument,
  THEME_PREVIEW_GAP,
  THEME_PREVIEW_MARGIN,
  type ThemePreviewRect,
  type ThemePreviewTitles
} from "../src/ui/components/theme-preview-model";

const TITLES: ThemePreviewTitles = { root: "Root", branchA: "Branch A", branchB: "Branch B", leaf: "Leaf" };
const VIEWPORT: ThemePreviewRect = { left: 0, top: 0, right: 1200, bottom: 800 };
const PANEL = { width: 280, height: 180 };

test("the sample tree has one root, two first-level branches and a child under branch A", () => {
  const document = themePreviewDocument("ocean", TITLES);
  assert.equal(Object.keys(document.nodes).length, 4);
  const root = document.nodes[document.rootId];
  assert.ok(root);
  assert.equal(root.title, TITLES.root);
  assert.equal(root.childIds.length, 2);
  const [branchAId, branchBId] = root.childIds;
  assert.ok(branchAId);
  assert.ok(branchBId);
  const branchA = document.nodes[branchAId];
  const branchB = document.nodes[branchBId];
  assert.ok(branchA);
  assert.ok(branchB);
  assert.equal(branchA.title, TITLES.branchA);
  assert.equal(branchB.title, TITLES.branchB);
  assert.equal(branchB.childIds.length, 0);
  assert.equal(branchA.childIds.length, 1);
  const leafId = branchA.childIds[0];
  assert.ok(leafId);
  assert.equal(document.nodes[leafId]?.title, TITLES.leaf);
});

test("the sample tree applies the requested theme and keeps every other option on code defaults", () => {
  const document = themePreviewDocument("midnight", TITLES);
  assert.equal(document.settings.theme, "midnight");
  // A horizontal layout keeps the sample readable in a small hover panel.
  assert.equal(document.settings.layoutMode, "right");
  assert.equal(document.settings.nodeShape, DEFAULT_DOCUMENT_SETTINGS.nodeShape);
  assert.equal(document.settings.connectionStyle, DEFAULT_DOCUMENT_SETTINGS.connectionStyle);
  assert.equal(document.settings.collectionMode, DEFAULT_DOCUMENT_SETTINGS.collectionMode);
  assert.equal(document.settings.recursiveScan, DEFAULT_DOCUMENT_SETTINGS.recursiveScan);
  assert.equal(document.title, TITLES.root);
});

test("identical arguments produce deeply equal sample trees with fixed timestamps", () => {
  const first = themePreviewDocument("fresh", TITLES);
  const second = themePreviewDocument("fresh", TITLES);
  assert.deepEqual(second, first);
  // A new object per call is required so a preview update is never skipped.
  assert.notEqual(second, first);
  assert.equal(first.createdAt, first.updatedAt);
  assert.equal(first.nodes[first.rootId]?.createdAt, first.createdAt);
  assert.equal(themePreviewDocument("slate", TITLES).settings.theme, "slate");
});

test("each call returns an independent sample tree", () => {
  const first = themePreviewDocument("vibrant", TITLES);
  const second = themePreviewDocument("vibrant", TITLES);
  assert.notEqual(first.nodes, second.nodes);
  const firstRoot = first.nodes[first.rootId];
  assert.ok(firstRoot);
  firstRoot.title = "changed";
  first.settings.theme = "classic";
  assert.equal(second.nodes[second.rootId]?.title, TITLES.root);
  assert.equal(second.settings.theme, "vibrant");
});

test("placement prefers the right side with the documented default gap", () => {
  const anchor: ThemePreviewRect = { left: 100, top: 300, right: 200, bottom: 320 };
  const layout = placeThemePreview(anchor, PANEL, VIEWPORT);
  assert.deepEqual(layout, {
    left: anchor.right + THEME_PREVIEW_GAP,
    top: (anchor.top + anchor.bottom - PANEL.height) / 2,
    side: "right"
  });
});

test("placement flips to the left when the right side cannot fit", () => {
  const viewport: ThemePreviewRect = { left: 0, top: 0, right: 600, bottom: 800 };
  const anchor: ThemePreviewRect = { left: 300, top: 100, right: 500, bottom: 120 };
  const layout = placeThemePreview(anchor, PANEL, viewport);
  assert.equal(layout.side, "left");
  assert.equal(layout.left, anchor.left - THEME_PREVIEW_GAP - PANEL.width);
  assert.equal(layout.top, (anchor.top + anchor.bottom - PANEL.height) / 2);
});

test("placement clamps vertically inside the viewport margin", () => {
  const below: ThemePreviewRect = { left: 100, top: 760, right: 200, bottom: 780 };
  assert.equal(placeThemePreview(below, PANEL, VIEWPORT).top, VIEWPORT.bottom - THEME_PREVIEW_MARGIN - PANEL.height);
  const above: ThemePreviewRect = { left: 100, top: 0, right: 200, bottom: 10 };
  assert.equal(placeThemePreview(above, PANEL, VIEWPORT).top, VIEWPORT.top + THEME_PREVIEW_MARGIN);
});

test("placement keeps the whole panel inside the viewport when neither side fits", () => {
  const viewport: ThemePreviewRect = { left: 0, top: 0, right: 300, bottom: 200 };
  const anchor: ThemePreviewRect = { left: 140, top: 60, right: 150, bottom: 80 };
  const layout = placeThemePreview(anchor, PANEL, viewport);
  assert.equal(layout.side, "left");
  assert.equal(layout.left, THEME_PREVIEW_MARGIN);
  assert.equal(layout.top, THEME_PREVIEW_MARGIN);
  assert.ok(layout.left + PANEL.width <= viewport.right - THEME_PREVIEW_MARGIN);
  assert.ok(layout.top + PANEL.height <= viewport.bottom - THEME_PREVIEW_MARGIN);
});

test("a panel larger than the viewport is clamped instead of overflowing", () => {
  const viewport: ThemePreviewRect = { left: 0, top: 0, right: 300, bottom: 200 };
  const anchor: ThemePreviewRect = { left: 100, top: 50, right: 120, bottom: 70 };
  const layout = placeThemePreview(anchor, { width: 500, height: 300 }, viewport);
  assert.equal(layout.side, "left");
  assert.equal(layout.left, THEME_PREVIEW_MARGIN);
  assert.equal(layout.top, THEME_PREVIEW_MARGIN);
});

test("placement is relative to the viewport origin and honors an explicit gap", () => {
  const viewport: ThemePreviewRect = { left: 200, top: 150, right: 900, bottom: 850 };
  const anchor: ThemePreviewRect = { left: 400, top: 160, right: 420, bottom: 180 };
  const layout = placeThemePreview(anchor, { width: 680, height: 180 }, viewport);
  assert.equal(layout.side, "left");
  assert.equal(layout.left, viewport.left + THEME_PREVIEW_MARGIN);
  assert.equal(layout.top, viewport.top + THEME_PREVIEW_MARGIN);

  const wide: ThemePreviewRect = { left: 0, top: 0, right: 1200, bottom: 800 };
  const near: ThemePreviewRect = { left: 100, top: 300, right: 200, bottom: 320 };
  assert.equal(placeThemePreview(near, PANEL, wide, 20).left, near.right + 20);
});

test("preview geometry keeps the documented 8px gap and margin", () => {
  assert.equal(THEME_PREVIEW_GAP, 8);
  assert.equal(THEME_PREVIEW_MARGIN, 8);
});

test("the sample model stays free of Obsidian imports so node tests can load it directly", () => {
  const source = readFileSync(new URL("../src/ui/components/theme-preview-model.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+"obsidian"/);
  assert.doesNotMatch(source, /import\s*\(\s*"obsidian"\s*\)/);
});

test("the panel reuses the read-only preview and stays outside the menu's pointer path", () => {
  const panel = readFileSync(new URL("../src/ui/components/theme-preview.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(panel, /new ReadOnlyTreePreview\(/);
  assert.match(panel, /themePreviewDocument\(theme, this\.titles\(\)\)/);
  assert.match(panel, /"aria-hidden", "true"/);
  assert.match(panel, /theme\.preview\.root/);
  const rule = css.match(/\.mtn-theme-preview\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /pointer-events:\s*none;/);
  assert.match(rule, /position:\s*fixed;/);
  assert.match(rule, /z-index:\s*calc\(var\(--layer-menu, 65\) \+ 1\);/);
  assert.match(rule, /width:\s*280px;/);
  assert.match(rule, /height:\s*180px;/);
  assert.match(css, /\.mtn-theme-preview \.mtn-canvas\s*\{\s*cursor:\s*default;/);
});
