import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static contract checks for the minimap overlay.
 *
 * Repo files are read through `process.cwd()` rather than `import.meta.url` so
 * this suite also runs from the compiled fallback build (`.mtn-test-build`),
 * where the emitted `.js` files no longer sit next to the real sources.
 */
const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const component = readSource("src/ui/components/mind-tree-minimap.ts");
const geometry = readSource("src/render/minimap.ts");
const css = readSource("styles.css");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Body of the first rule for one exact selector, without its braces. */
function cssRule(selector: string): string {
  const rule = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  return rule?.[1] ?? "";
}

test("the minimap is an accessible image overlay that is hidden until enabled", () => {
  assert.match(component, /extends DisposableUiObject/);
  assert.match(component, /createElement\("div"\)/);
  assert.match(component, /classList\.add\("mtn-minimap"\)/);
  assert.match(component, /setAttribute\("role", "img"\)/);
  assert.match(component, /setAttribute\("aria-label", labels\.ariaLabel\)/);
  assert.match(component, /this\.element\.hidden = true/);
  // The SVG is a decorative implementation detail of the labelled image.
  assert.match(component, /createElementNS\(SVG_NAMESPACE, "svg"\)/);
  assert.match(component, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(component, /createElementNS\(SVG_NAMESPACE, "g"\)/);
  assert.match(component, /createElementNS\(SVG_NAMESPACE, "rect"\)/);
  assert.match(component, /createElementNS\(SVG_NAMESPACE, "line"\)/);
});

test("content is appended before the viewport indicator so the indicator paints above", () => {
  const contentAppend = component.indexOf("this.surface.appendChild(this.content)");
  const indicatorAppend = component.indexOf("this.surface.appendChild(this.indicator)");
  assert.ok(contentAppend > 0, "content layer is appended");
  assert.ok(indicatorAppend > contentAppend, "indicator is appended after the content layer");
});

test("a drag freezes the projection and unprojects map points into canvas moves", () => {
  assert.match(component, /pointerdown/);
  assert.match(component, /pointermove/);
  assert.match(component, /pointerup/);
  assert.match(component, /pointercancel/);
  assert.match(component, /lostpointercapture/);
  assert.match(component, /setPointerCapture/);
  assert.match(component, /releasePointerCapture/);
  assert.match(component, /event\.button !== 0 \|\| event\.isPrimary === false/);
  assert.match(component, /classList\.add\("is-dragging"\)/);
  assert.match(component, /this\.dragProjection = projection/);
  // Pointer movement uses the frozen projection, never the freshly rendered one.
  assert.match(component, /this\.dragProjection \?\? sceneProjection/);
  assert.match(component, /unprojectMinimapPoint\(projection, mapPoint\.x, mapPoint\.y\)/);
  assert.match(component, /this\.actions\.centerOnWorldPoint\(world\.x, world\.y\)/);
  assert.match(component, /getBoundingClientRect\(\)/);
  // Map points are clamped into the surface bounds before unprojection.
  assert.match(component, /Math\.min\(this\.size\.width, Math\.max\(0, x\)\)/);
  assert.match(component, /Math\.min\(this\.size\.height, Math\.max\(0, y\)\)/);
});

test("setEnabled hides and clears the gesture while update stores state when disabled", () => {
  assert.match(component, /setEnabled\(enabled: boolean\): void \{[\s\S]*?this\.enabled = enabled;/);
  assert.match(component, /if \(!enabled\) \{[\s\S]*?this\.clearDrag\(\);[\s\S]*?this\.element\.hidden = true;/);
  assert.match(component, /update\(state: Readonly<MindTreeMinimapState>\): void \{[\s\S]*?this\.state = state;[\s\S]*?if \(!this\.enabled\) return;/);
  // Content cache keys: layout identity, branch colours and map pixel size only.
  assert.match(component, /this\.renderedLayout !== state\.layout/);
  assert.match(component, /this\.renderedSlots !== state\.branchColorSlots/);
  assert.match(component, /this\.renderedWidth !== size\.width/);
  assert.match(component, /this\.renderedHeight !== size\.height/);
  // A viewport-only change must not rebuild nodes: the live scene projection is
  // re-applied as a group transform over the cached content layer.
  assert.match(component, /this\.content\.setAttribute\(\s*"transform"/);
  assert.match(component, /sceneProjection\.scale \/ contentProjection\.scale/);
});

test("minimap colours come from theme cues instead of literals", () => {
  assert.match(component, /line\.style\.stroke = branchColorCss/);
  assert.match(component, /rect\.style\.fill = branchColorCss/);
  assert.match(component, /branchColorCss\(state\.branchColorSlots\.get\(connection\.from\)\)/);
  assert.match(component, /branchColorCss\(state\.branchColorSlots\.get\(node\.id\)\)/);
  // No embedded palette: the canvas theme variables are the only colour source.
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(component, /\brgba?\(|\bhsla?\(/i);
  assert.doesNotMatch(component, /from "obsidian"/);
  assert.doesNotMatch(component, /from "\.\.\/\.\.\/main"|mind-tree-view/);
});

test("the pure geometry module stays DOM-free and Obsidian-free", () => {
  assert.doesNotMatch(geometry, /\bdocument\./);
  assert.doesNotMatch(geometry, /\bwindow\./);
  assert.doesNotMatch(geometry, /from "obsidian"/);
  assert.match(geometry, /export function computeMinimapSize/);
  assert.match(geometry, /export function minimapProjectionForScene/);
});

test("styles pin the minimap to the bottom-right with theme variables only", () => {
  const rule = cssRule(".mtn-minimap");
  assert.match(rule, /position:\s*absolute;/);
  assert.match(rule, /z-index:\s*39;/);
  assert.match(rule, /right:\s*12px;/);
  assert.match(rule, /bottom:\s*12px;/);
  assert.match(rule, /border:\s*1px solid var\(--background-modifier-border\);/);
  assert.match(rule, /border-radius:\s*9px;/);
  assert.match(rule, /background:\s*color-mix\(in srgb, var\(--mtn-canvas-base\) 88%, transparent\);/);
  assert.match(rule, /box-shadow:\s*0 6px 18px rgb\(0 0 0 \/ 10%\);/);
  assert.match(rule, /overflow:\s*hidden;/);
  assert.match(rule, /cursor:\s*crosshair;/);
  assert.match(rule, /touch-action:\s*none;/);

  assert.match(css, /\.mtn-minimap\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
  assert.match(css, /\.mtn-minimap\.is-dragging\s*\{\s*cursor:\s*grabbing;\s*\}/);
  assert.match(css, /@media \(max-width:\s*620px\)\s*\{[\s\S]*?\.mtn-minimap\s*\{\s*right:\s*8px;\s*bottom:\s*56px;\s*\}/);
});

test("minimap layer CSS keeps the native scale and a quiet hierarchy", () => {
  assert.match(cssRule(".mtn-minimap-surface"), /display:\s*block;/);
  assert.match(cssRule(".mtn-minimap-surface"), /width:\s*100%;/);
  assert.match(cssRule(".mtn-minimap-surface"), /height:\s*100%;/);
  assert.match(cssRule(".mtn-minimap-content"), /pointer-events:\s*none;/);
  assert.match(cssRule(".mtn-minimap-node"), /opacity:\s*\.78;/);
  const rootRule = css.match(/\.mtn-minimap-node\.is-root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rootRule, /opacity:\s*1;/);
  assert.match(cssRule(".mtn-minimap-connection"), /stroke-width:\s*\.75;/);
  assert.match(cssRule(".mtn-minimap-connection"), /opacity:\s*\.5;/);

  const viewportRule = cssRule(".mtn-minimap-viewport");
  assert.match(viewportRule, /fill:\s*color-mix\(in srgb, var\(--interactive-accent\) 12%, transparent\);/);
  assert.match(viewportRule, /stroke:\s*var\(--interactive-accent\);/);
  assert.match(viewportRule, /stroke-width:\s*1\.5;/);
  assert.match(viewportRule, /vector-effect:\s*non-scaling-stroke;/);
});

test("the minimap block is appended once at the end of styles.css without gradients", () => {
  const start = css.indexOf(".mtn-minimap {");
  assert.ok(start > 0);
  assert.ok(start > css.indexOf(".mtn-embed-message"));
  const section = css.slice(start);
  assert.doesNotMatch(section, /gradient/i);
  assert.doesNotMatch(section, /will-change/i);
  // One authored rgb() shadow is the only non-variable colour; no palette hexes.
  assert.doesNotMatch(section, /#[0-9a-f]{3,8}\b/i);
  assert.equal((section.match(/\brgba?\(/g) ?? []).length, 1);
});
