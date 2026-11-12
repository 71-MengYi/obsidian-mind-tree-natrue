import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read from the workspace root so this static wiring test can also run from the
// compiled fallback runner (the sandbox cannot spawn esbuild for tsx).
const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const view = source("src/ui/mind-tree-view.ts");
const component = source("src/ui/components/mind-tree-minimap.ts");

test("the view mounts one minimap on the canvas root and disposes it with the shell", () => {
  assert.match(view, /import \{ MindTreeMinimap \} from "\.\/components\/mind-tree-minimap";/);
  assert.match(view, /new MindTreeMinimap\(this\.rootEl, \{ ariaLabel: t\("minimap\.aria"\) \}/);
  assert.match(view, /centerOnWorldPoint: \(worldX, worldY\) => this\.centerCanvasOnWorldPoint\(worldX, worldY\)/);
  // Both a shell rebuild and view close must drop the overlay's listeners.
  assert.ok((view.match(/this\.minimap\?\.destroy\(\);/g) ?? []).length >= 2);
});

test("minimap state follows the persisted setting, layout, pan/zoom and resize", () => {
  assert.match(view, /private updateMinimap\(\): void \{[\s\S]*?this\.plugin\.settings\.minimapEnabled/);
  assert.match(view, /minimap\.setEnabled\(enabled\);/);
  // The thumbnail is a neutral node overview: no branch palette reaches it.
  const updateStart = view.indexOf("minimap.update({");
  const updateCall = updateStart >= 0 ? view.slice(updateStart, view.indexOf("});", updateStart) + 3) : "";
  assert.match(updateCall, /layout,/);
  assert.match(updateCall, /viewport: this\.viewport,/);
  assert.doesNotMatch(updateCall, /branchColorSlots/);
  // applyViewport is the single pan/zoom path, so the indicator is refreshed there.
  assert.match(view, /private applyViewport\(\): void \{[\s\S]*?this\.updateMinimap\(\);/);
  // A canvas resize re-fits the display-ratio-derived minimap size.
  assert.match(view, /resize: \(\) => \{[\s\S]*?this\.updateMinimap\(\);/);
  // The settings page reuses the global appearance refresh hook.
  assert.match(view, /refreshLayoutFromSettings\(\): void \{[\s\S]*?this\.updateMinimap\(\);/);
});

test("a minimap jump centers one world point without changing zoom", () => {
  assert.match(view, /this\.viewport = centerViewportOnPoint\(width, height, \{ x: worldX, y: worldY \}, this\.viewport\.zoom\)/);
  // Parsing failures and cleared documents must hide the stale overlay.
  assert.match(view, /if \(this\.parseError\) \{[\s\S]*?this\.minimap\?\.setEnabled\(false\);/);
  assert.match(view, /private applyViewport\(\): void \{[\s\S]*?if \(!this\.document\) \{[\s\S]*?this\.minimap\?\.setEnabled\(false\);/);
});

test("the minimap component stays a UI-only, theme-driven render surface", () => {
  assert.match(component, /class MindTreeMinimap extends DisposableUiObject/);
  assert.doesNotMatch(component, /from "obsidian"/);
  assert.doesNotMatch(component, /mind-tree-view|from "\.\.\/\.\.\/main"/);
  assert.match(component, /role=?"img"|"role", "img"/);
  assert.match(component, /setPointerCapture/);
  assert.match(component, /unprojectMinimapPoint/);
  // The overview is neutral: no branch palette, one theme colour in CSS.
  assert.doesNotMatch(component, /branchColorCss|branchColorSlots/);
  // Colour literals are forbidden here: the minimap inherits the live tree theme.
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}\b/i);
});
