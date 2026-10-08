import test from "node:test";
import assert from "node:assert/strict";
import { chooseTooltipPlacement, fitTooltip, type TooltipLayout, type TooltipRect } from "../src/ui/tooltip-placement";

const viewport = { left: 0, top: 0, right: 800, bottom: 600 };
const rect = (left: number, top: number, width = 32, height = 32): TooltipRect => ({ left, top, right: left + width, bottom: top + height });
function assertFits(layout: TooltipLayout, anchor: TooltipRect, bounds = viewport): void {
  assert.ok(layout.left >= bounds.left + 8 && layout.top >= bounds.top + 8);
  assert.ok(layout.left + layout.width <= bounds.right - 8 && layout.top + layout.height <= bounds.bottom - 8);
  assert.ok(layout.left >= anchor.right + 8 || layout.left + layout.width <= anchor.left - 8
    || layout.top >= anchor.bottom + 8 || layout.top + layout.height <= anchor.top - 8, "must stay outside the trigger and its gap");
}

test("tooltips default below, flip above the status bar and point inward at either sidebar", () => {
  for (const [anchor, side] of [[rect(384, 100), "bottom"], [rect(384, 555), "top"],
    [rect(10, 200), "right"], [rect(758, 200), "left"]] as const) {
    const result = chooseTooltipPlacement(anchor, { width: 160, height: 30 }, viewport);
    assert.equal(result.side, side); assertFits(result, anchor);
  }
});

test("all four corners select free space without pushing the tooltip across its trigger", () => {
  for (const anchor of [rect(8, 8), rect(760, 8), rect(8, 560), rect(760, 560)]) {
    const result = chooseTooltipPlacement(anchor, { width: 180, height: 50 }, viewport);
    assertFits(result, anchor);
  }
});

test("fallback chooses the largest region, wraps there and preserves its side", () => {
  const bounds = rect(0, 0, 220, 180), anchor = rect(94, 76);
  const chosen = chooseTooltipPlacement(anchor, { width: 204, height: 110 }, bounds);
  assert.equal(chosen.side, "left");
  assert.equal(chosen.maxWidth, 78);
  const wrapped = fitTooltip(anchor, { width: chosen.maxWidth, height: 240 }, bounds, chosen.side);
  assert.equal(wrapped.side, chosen.side);
  assert.equal(wrapped.height, wrapped.maxHeight);
  assertFits(wrapped, anchor, bounds);
});

test("offset visual viewports use their own coordinates and expose insufficient line height", () => {
  const bounds = rect(100, 200, 300, 200), anchor = rect(220, 350);
  assertFits(chooseTooltipPlacement(anchor, { width: 160, height: 45 }, bounds), anchor, bounds);
  const tiny = chooseTooltipPlacement(rect(8, 8, 20, 20), { width: 100, height: 30 }, rect(0, 0, 36, 36));
  assert.ok(tiny.maxWidth === 0 || tiny.maxHeight === 0);
});

test("a large but shallow region must not hide text when another side can fit a line", () => {
  const bounds = rect(0, 0, 4000, 70), anchor = rect(1984, 19);
  const result = chooseTooltipPlacement(anchor, { width: 320, height: 100 }, bounds, { width: 32, height: 30 });
  assert.equal(result.side, "left"); assert.ok(result.maxHeight >= 30); assertFits(result, anchor, bounds);
});

test("varying viewport sizes, trigger positions and wrapped heights never produce an overlapping visible layout", () => {
  for (const width of [160, 320, 800]) for (const height of [120, 600]) {
    const bounds = rect(37, 59, width, height);
    for (const x of [0, .1, .5, .9, 1]) for (const y of [0, .1, .5, .9, 1]) {
      const anchor = rect(37 + (width - 32) * x, 59 + (height - 32) * y);
      for (const tipWidth of [24, 160, 320]) for (const tipHeight of [30, 90, 400]) {
        const choice = chooseTooltipPlacement(anchor, { width: tipWidth, height: tipHeight }, bounds);
        if (choice.maxWidth < 30 || choice.maxHeight < 30) continue;
        const wrapped = fitTooltip(anchor, { width: Math.min(tipWidth, choice.maxWidth), height: tipHeight * 2 }, bounds, choice.side);
        assertFits(wrapped, anchor, bounds);
      }
    }
  }
});
