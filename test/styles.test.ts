import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
const nodeRendererSource = readFileSync(new URL("../src/ui/renderers/node-renderer.ts", import.meta.url), "utf8");

test("delete detail previews are pointer-transparent without changing their scrollable geometry", () => {
  const rule = css.match(/\.mtn-delete-summary-detail\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /pointer-events:\s*none;/);
  assert.match(rule, /max-height:\s*230px;/);
  assert.match(rule, /overflow:\s*auto;/);
  assert.match(rule, /position:\s*fixed;/);
  assert.doesNotMatch(css, /\.mtn-delete-summary-detail:hover/);
});

test("canvas accessible labels are visually hidden and ignore pointer input", () => {
  const rule = css.match(/\.mtn-visually-hidden\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /position:\s*absolute !important;/);
  assert.match(rule, /clip-path:\s*inset\(50%\) !important;/);
  assert.match(rule, /pointer-events:\s*none !important;/);
});

test("node grid keeps a fixed title track before trailing UI", () => {
  const nodeRule = css.match(/\.mtn-node\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(nodeRule, /--mtn-node-title-width:\s*1px;/);
  assert.match(nodeRule, /padding:\s*3px 5px;/);
  assert.match(nodeRule,
    /grid-template-columns:\s*var\(--mtn-node-title-width\) var\(--mtn-node-marker-width\) var\(--mtn-node-control-width\);/);
  assert.doesNotMatch(css, /\.mtn-node\.is-content-only/);
});

test("resource controls reuse the same static gray icon and conditional sync indicator", () => {
  const rule = css.match(/\.mtn-node-controls > \.mtn-resource-open:active\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /color:\s*var\(--text-muted\);/);
  assert.match(rule, /border:\s*0;/);
  assert.match(rule, /transform:\s*none;/);
  assert.match(rule, /box-shadow:\s*none;/);
  assert.match(nodeRendererSource, /if \(!visual\.hasResourceControls\) return;/);
  assert.match(nodeRendererSource, /if \(visual\.titleSyncDisabled\)/);
  assert.match(nodeRendererSource, /setIcon\(openButton, SHARE_SQUARE_ICON\)/);
  assert.match(nodeRendererSource, /openButton\.addEventListener\("click", \(event\) => \{\s*event\.preventDefault\(\); event\.stopPropagation\(\); actions\.openResource\(node\.id\);/);
});

test("node titles render the shared measured lines without a second CSS wrap", () => {
  const lineRule = css.match(/\.mtn-node-title-line\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(lineRule, /display:\s*block;/);
  assert.match(lineRule, /white-space:\s*pre;/);
  assert.doesNotMatch(lineRule, /overflow-wrap|word-break/);
  assert.match(nodeRendererSource, /for \(const line of measurement\.lines\)/);
  assert.match(nodeRendererSource, /mtn-node-title-line/);
});

test("canvas text avoids permanent GPU pan layers and ordinary node hover transforms", () => {
  const panRule = css.match(/\.mtn-pan-layer\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.doesNotMatch(panRule, /will-change|transform/);
  assert.doesNotMatch(css, /\.mtn-node:hover:not\(\.is-editing\)/);
  assert.doesNotMatch(viewSource, /presentation\.panTransform|translate3d/);
  assert.match(viewSource, /style\.left = presentation\.panLeft/);
  assert.match(viewSource, /style\.top = presentation\.panTop/);
  assert.match(css, /\.mtn-node:hover\s*>\s*\.mtn-fold-button/);
});

test("title editing uses a neutral floating surface without live tree relayout", () => {
  const editorRule = css.match(/(?:^|\n)\.mtn-title-input\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(editorRule, /position:\s*absolute;/);
  assert.match(editorRule, /background:\s*var\(--background-primary\);/);
  assert.match(editorRule, /color:\s*var\(--text-normal\);/);
  assert.match(editorRule, /border:\s*0;/);
  assert.match(editorRule, /border-radius:\s*0;/);
  assert.match(editorRule, /padding:\s*3px 5px;/);
  assert.match(editorRule, /white-space:\s*break-spaces;/);
  assert.match(css, /\.mtn-node\.is-editing\s*>\s*:is\(\.mtn-node-markers, \.mtn-node-controls, \.mtn-fold-button\)/);
  assert.doesNotMatch(viewSource, /scheduleEditingRelayout|applyLiveLayoutGeometry/);
  assert.match(editorRule, /-webkit-touch-callout:\s*default/);
  assert.match(editorRule, /user-select:\s*text/);
  assert.doesNotMatch(nodeRendererSource, /focusTimer|setTimeout/);
  assert.match(nodeRendererSource, /input\.focus\(\{ preventScroll: true \}\)/);
});

test("image cards use a two-row layout and a low-emphasis resize handle", () => {
  assert.match(css, /\.mtn-node\.has-image\s*\{[\s\S]*grid-template-rows:/u);
  assert.match(css, /\.mtn-node-image\s*\{[\s\S]*object-fit:\s*contain/u);
  assert.match(css, /\.mtn-image-resize-handle,[\s\S]*color:\s*var\(--text-muted\)/u);
  assert.match(css, /\.mtn-node\.has-image:is\(:hover, \.is-selected\) \.mtn-image-resize-handle/u);
  assert.match(css, /\.mtn-view\.is-dragging-node \.mtn-image-resize-handle/u);
});

test("drawing badges use the requested compact purple treatment", () => {
  const commonRule = css.match(/\.mtn-node-marker\.is-resource-badge\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(commonRule, /flex:\s*0 0 auto;/);
  assert.match(commonRule, /width:\s*auto;/);
  assert.match(commonRule, /height:\s*auto;/);
  assert.match(commonRule, /padding:\s*2px;/);
  assert.match(commonRule, /font-size:\s*10px;/);
  assert.match(commonRule, /line-height:\s*12px;/);
  assert.doesNotMatch(commonRule, /46px/);
  const rule = css.match(/\.mtn-node-marker\.is-excalidraw\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /border:\s*0;/);
  assert.match(rule, /border-radius:\s*5px;/);
  assert.match(rule, /background:\s*#7d4fbe;/);
  assert.match(rule, /color:\s*#fff;/);
});

test("extension badges use neutral low-emphasis colors without a fixed width", () => {
  const rule = css.match(/\.mtn-node-marker\.is-extension\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rule, /background:\s*var\(--background-modifier-hover\);/);
  assert.match(rule, /color:\s*var\(--text-muted\);/);
  assert.match(rule, /border:\s*0;/);
  assert.doesNotMatch(css, /(?:flex-basis|width):\s*46px;/);
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

test("note embeds size themselves from the branch and keep a baseline box", () => {
  const embedRule = css.match(/\.mtn-embed\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(embedRule, /position:\s*relative;/);
  assert.match(embedRule, /border:\s*1px solid var\(--background-modifier-border\);/);
  assert.match(embedRule, /background:\s*var\(--background-primary\);/);
  assert.match(embedRule, /overflow:\s*hidden;/);

  const treeRule = css.match(/\.mtn-embed-tree\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(treeRule, /height:\s*var\(--mtn-embed-height,\s*320px\);/);
  assert.match(treeRule, /min-height:\s*120px;/);
  assert.match(treeRule, /max-height:\s*min\(80vh,\s*4000px\);/);

  const invalidRule = css.match(/\.mtn-embed-invalid\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(invalidRule, /padding:\s*12px;/);
  assert.match(invalidRule, /color:\s*var\(--text-muted\);/);
  assert.match(invalidRule, /font-size:\s*var\(--font-ui-small\);/);
});

test("the embed open control fades for hover pointers instead of leaving the tab order", () => {
  const openRule = css.match(/\.mtn-embed-open\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(openRule, /position:\s*absolute;/);
  // The code block's own action row (Obsidian `.embed-actions`: 4px inset and a
  // 4px + 16px + 4px button) keeps the corner, so this control drops below it and
  // only shares the inline end. Defaults stay derived from the host's tokens.
  assert.match(openRule, /top:\s*var\(--mtn-embed-open-top,\s*calc\(/);
  assert.match(openRule, /var\(--size-2-2,\s*4px\)/);
  assert.match(openRule, /var\(--icon-m,\s*16px\)/);
  assert.match(openRule, /inset-inline-end:\s*var\(--mtn-embed-open-right,\s*var\(--size-2-2,\s*4px\)\);/);
  // Native `.embed-action` box: the size comes from its own padding, not a fixed square.
  assert.match(openRule, /padding:\s*var\(--size-2-2,\s*4px\)\s+var\(--size-2-3,\s*6px\);/);
  assert.doesNotMatch(openRule, /width:\s*\d+px;/);
  // Flat in every state, forced so a host/theme button rule (or a sticky
  // :hover/:focus after a click) cannot paint a box behind the icon.
  assert.match(openRule, /border:\s*0 !important;/);
  assert.match(openRule, /background:\s*transparent !important;/);
  assert.match(openRule, /box-shadow:\s*none !important;/);
  assert.match(openRule, /color:\s*var\(--embed-action-color/);
  assert.match(openRule, /border-radius:\s*var\(--embed-action-radius/);
  assert.doesNotMatch(openRule, /background:\s*var\(--background-primary\)/);
  // Hover is exactly the native `.embed-action:hover`: the same translucent gray
  // and nothing else. The shade is overridable through one variable.
  assert.match(css, /\.mtn-embed-open:hover\s*\{\s*background-color:\s*var\(--mtn-embed-open-hover,\s*var\(--background-modifier-hover\)\) !important;\s*\}/);
  assert.match(openRule, /opacity:\s*1;/);
  // Keeping the element in the layout is what makes it keyboard reachable.
  assert.doesNotMatch(openRule, /display:\s*none/);
  assert.match(css, /\.mtn-embed-open:focus-visible\s*\{[\s\S]*?outline:/);

  const hideRule = css.match(/@media \(hover: hover\)\s*\{\s*([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(hideRule, /\.mtn-embed-tree:not\(:hover\):not\(:focus-within\) \.mtn-embed-open\s*\{\s*opacity:\s*0;/);
});

test("note embed rules add no gradients and no permanent GPU layers", () => {
  const start = css.indexOf("/* ─── Note embed");
  assert.ok(start > 0, "embed style section exists");
  const section = css.slice(start);
  assert.doesNotMatch(section, /gradient/i);
  assert.doesNotMatch(section, /will-change/i);
});
