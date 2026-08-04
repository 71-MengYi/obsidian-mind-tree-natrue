import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("drawing badges use the requested compact purple treatment", () => {
  const rule = css.match(/\.mtn-node-marker\.is-excalidraw\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /border:\s*0;/);
  assert.match(rule, /border-radius:\s*5px;/);
  assert.match(rule, /background:\s*#7d4fbe;/);
  assert.match(rule, /color:\s*#fff;/);
});

test("collapsed count buttons stay visible while drag hiding remains authoritative", () => {
  const expandRule = css.match(/\.mtn-node\s*>\s*\.mtn-fold-button\.is-expand\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(expandRule, /opacity:\s*1;/);
  assert.match(expandRule, /visibility:\s*visible;/);
  assert.match(expandRule, /pointer-events:\s*auto;/);

  const expandIndex = css.indexOf(".mtn-node > .mtn-fold-button.is-expand");
  const dragIndex = css.indexOf(".mtn-node.is-drag-hidden > .mtn-fold-button");
  assert.ok(expandIndex >= 0 && dragIndex > expandIndex);
});

test("fold controls stay neutral instead of inheriting branch accent colors", () => {
  const baseRule = css.match(/\.mtn-node\s*>\s*\.mtn-fold-button\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(baseRule, /border:\s*1px solid var\(--background-modifier-border\);/);
  assert.match(baseRule, /background:\s*var\(--background-modifier-hover\);/);
  assert.match(baseRule, /color:\s*var\(--text-muted\);/);
  assert.match(baseRule, /box-shadow:\s*none;/);

  const interactionRule = css.match(/\.mtn-node\s*>\s*\.mtn-fold-button:is\(:hover,\s*:focus-visible\)\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(interactionRule, /background:\s*var\(--background-modifier-border\);/);
  assert.match(interactionRule, /color:\s*var\(--text-muted\);/);
  assert.doesNotMatch(interactionRule, /--mtn-node-accent|--interactive-accent|#fff/i);

  const expandRule = css.match(/\.mtn-node\s*>\s*\.mtn-fold-button\.is-expand\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.doesNotMatch(expandRule, /background:|border-color:|color:|box-shadow:|--mtn-node-accent|#fff/i);
});

test("fold controls define four outward positions and matching hover bridges", () => {
  for (const direction of ["left", "right", "up", "down"]) {
    assert.match(css, new RegExp(`\\.mtn-fold-button\\.is-fold-${direction}\\s*\\{`));
    assert.match(css, new RegExp(`\\.mtn-fold-button\\.is-fold-${direction}::before\\s*\\{`));
  }
});
