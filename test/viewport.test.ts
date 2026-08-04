import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerViewportOnRect,
  panViewportByWheel,
  preserveViewportPointAfterLayout,
  viewportToCssPresentation,
  wheelDeltaToPixels,
  ZOOM_STEP,
  zoomViewportAt
} from "../src/ui/viewport";

test("viewport CSS keeps scale out of the composited pan transform", () => {
  const presentation = viewportToCssPresentation({ x: 80, y: 40, zoom: 1.3 });
  assert.equal(presentation.panTransform, "translate3d(80px, 40px, 0)");
  assert.equal(presentation.contentZoom, "1.3");
  assert.doesNotMatch(presentation.panTransform, /scale/);
});

test("zoom uses exact ten-point steps and keeps the anchor world point fixed", () => {
  const initial = { x: 80, y: 40, zoom: 1 };
  const anchor = { x: 320, y: 220 };
  const worldX = (anchor.x - initial.x) / initial.zoom;
  const worldY = (anchor.y - initial.y) / initial.zoom;

  const zoomed = zoomViewportAt(initial, ZOOM_STEP, anchor.x, anchor.y);
  assert.equal(zoomed.zoom, 1.1);
  assert.ok(Math.abs((anchor.x - zoomed.x) / zoomed.zoom - worldX) < 1e-9);
  assert.ok(Math.abs((anchor.y - zoomed.y) / zoomed.zoom - worldY) < 1e-9);

  const restored = zoomViewportAt(zoomed, -ZOOM_STEP, anchor.x, anchor.y);
  assert.equal(restored.zoom, 1);
  assert.ok(Math.abs(restored.x - initial.x) < 1e-9);
  assert.ok(Math.abs(restored.y - initial.y) < 1e-9);
});

test("zoom steps respect the existing minimum and maximum scale", () => {
  assert.equal(zoomViewportAt({ x: 0, y: 0, zoom: MIN_ZOOM }, -ZOOM_STEP, 10, 10).zoom, MIN_ZOOM);
  assert.equal(zoomViewportAt({ x: 0, y: 0, zoom: MAX_ZOOM }, ZOOM_STEP, 10, 10).zoom, MAX_ZOOM);
});

test("wheel panning moves only the requested canvas axis", () => {
  const initial = { x: 80, y: 40, zoom: 1.3 };
  assert.deepEqual(panViewportByWheel(initial, 24, "vertical"), { x: 80, y: 16, zoom: 1.3 });
  assert.deepEqual(panViewportByWheel(initial, -30, "horizontal"), { x: 110, y: 40, zoom: 1.3 });
});

test("wheel line and page deltas normalize to canvas pixels", () => {
  assert.equal(wheelDeltaToPixels(2, 0, 600), 2);
  assert.equal(wheelDeltaToPixels(2, 1, 600), 32);
  assert.equal(wheelDeltaToPixels(-1, 2, 600), -600);
});

test("centering a viewport aligns the node center with the canvas center", () => {
  assert.deepEqual(
    centerViewportOnRect(1_000, 600, { x: 100, y: 50, width: 200, height: 40 }),
    { x: 300, y: 230, zoom: 1 }
  );
  assert.deepEqual(
    centerViewportOnRect(1_000, 600, { x: 100, y: 50, width: 200, height: 40 }, 1.5),
    { x: 200, y: 195, zoom: 1.5 }
  );
});

test("layout compensation keeps an anchor at the same screen coordinate", () => {
  const initial = { x: 90, y: 60, zoom: 1.25 };
  const before = { x: 200, y: 140 };
  const after = { x: 260, y: 92 };
  const beforeScreen = {
    x: initial.x + before.x * initial.zoom,
    y: initial.y + before.y * initial.zoom
  };

  const compensated = preserveViewportPointAfterLayout(initial, before, after);
  assert.equal(compensated.zoom, initial.zoom);
  assert.equal(compensated.x + after.x * compensated.zoom, beforeScreen.x);
  assert.equal(compensated.y + after.y * compensated.zoom, beforeScreen.y);
});
