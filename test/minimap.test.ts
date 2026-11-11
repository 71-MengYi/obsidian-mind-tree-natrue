import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMinimapSize,
  createMinimapProjection,
  minimapProjectionForScene,
  projectMinimapPoint,
  projectMinimapRect,
  unionWorldRects,
  unprojectMinimapPoint,
  visibleWorldRect
} from "../src/render/minimap";
import { centerViewportOnPoint } from "../src/render/viewport";

/** World/minimap math is floating point, so compare with a tiny tolerance. */
function assertClose(actual: number, expected: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-9,
    message ?? `expected ${actual} to be close to ${expected}`
  );
}

test("minimap size follows the display ratio and clamps to its bounds", () => {
  // 12% of 1920x1080 is 230.4 x 129.6 -> rounded, then inside both min/max bounds.
  assert.deepEqual(computeMinimapSize(1920, 1080, 1000, 800), { width: 230, height: 130 });
  // 12% of 4K exceeds both maximums, so the caps win.
  assert.deepEqual(computeMinimapSize(3840, 2160, 1600, 1000), { width: 320, height: 240 });
  // A small laptop display falls below both minimums, so the minimums win.
  assert.deepEqual(computeMinimapSize(1024, 768, 1000, 800), { width: 150, height: 110 });
});

test("minimap size is capped by the live canvas and hidden when unusable", () => {
  // A narrow panel caps the width before it starts fighting the tree for space.
  assert.deepEqual(computeMinimapSize(1920, 1080, 1000, 800), { width: 230, height: 130 });
  assert.deepEqual(computeMinimapSize(1920, 1080, 300, 500), { width: 165, height: 130 });
  assert.deepEqual(computeMinimapSize(1920, 1080, 400, 300), { width: 220, height: 130 });
  // Below the usable minimum the thumbnail is hidden instead of drawn as a sliver.
  assert.deepEqual(computeMinimapSize(1920, 1080, 160, 300), { width: 0, height: 0 });
  assert.deepEqual(computeMinimapSize(1920, 1080, 400, 150), { width: 0, height: 0 });
  // Non-positive or non-finite inputs must not produce a size.
  assert.deepEqual(computeMinimapSize(0, 1080, 1000, 800), { width: 0, height: 0 });
  assert.deepEqual(computeMinimapSize(1920, 1080, 0, 800), { width: 0, height: 0 });
  assert.deepEqual(computeMinimapSize(Number.NaN, 1080, 1000, 800), { width: 0, height: 0 });
});

test("visibleWorldRect converts pan and zoom into the shown world rectangle", () => {
  assert.deepEqual(
    visibleWorldRect({ x: 100, y: 50, zoom: 2 }, 800, 600),
    { x: -50, y: -25, width: 400, height: 300 }
  );
  // A broken/zero zoom falls back to 1 instead of producing infinities.
  assert.deepEqual(
    visibleWorldRect({ x: 100, y: 50, zoom: 0 }, 800, 600),
    { x: -100, y: -50, width: 800, height: 600 }
  );
  assert.deepEqual(
    visibleWorldRect({ x: 100, y: 50, zoom: -2 }, 800, 600),
    { x: -100, y: -50, width: 800, height: 600 }
  );
  assert.deepEqual(
    visibleWorldRect({ x: 0, y: 0, zoom: 1 }, 0, 0),
    { x: 0, y: 0, width: 0, height: 0 }
  );
});

test("unionWorldRects covers both rectangles including negative origins", () => {
  assert.deepEqual(
    unionWorldRects({ x: 0, y: 0, width: 100, height: 50 }, { x: 60, y: -20, width: 80, height: 30 }),
    { x: 0, y: -20, width: 140, height: 70 }
  );
  assert.deepEqual(
    unionWorldRects({ x: -50, y: -40, width: 20, height: 20 }, { x: 0, y: 0, width: 10, height: 10 }),
    { x: -50, y: -40, width: 60, height: 50 }
  );
  const outer = { x: 10, y: 20, width: 300, height: 200 };
  assert.deepEqual(unionWorldRects(outer, { x: 50, y: 60, width: 10, height: 10 }), outer);
});

test("projection fits a domain with one uniform scale and centers it", () => {
  // Height is the limiting dimension: 88/500 < 188/1000.
  const wide = createMinimapProjection({ x: 0, y: 0, width: 1000, height: 500 }, { width: 200, height: 100 });
  assertClose(wide.scale, 0.176);
  assertClose(wide.offsetX, 12);
  assertClose(wide.offsetY, 6);

  // A square domain is also height-limited and therefore has side margins.
  const square = createMinimapProjection({ x: 100, y: 50, width: 100, height: 100 }, { width: 200, height: 100 }, 10);
  assertClose(square.scale, 0.8);
  assertClose(square.offsetX, -20);
  assertClose(square.offsetY, -30);

  // The domain's corners land on a centered, undistorted box.
  const topLeft = projectMinimapPoint(square, 100, 50);
  const bottomRight = projectMinimapPoint(square, 200, 150);
  assertClose(topLeft.x, 60);
  assertClose(topLeft.y, 10);
  assertClose(bottomRight.x, 140);
  assertClose(bottomRight.y, 90);
  assertClose((topLeft.x + bottomRight.x) / 2, 100);
  assertClose((topLeft.y + bottomRight.y) / 2, 50);
  // Uniform scale: the aspect ratio is preserved, never distorted per axis.
  assertClose((bottomRight.x - topLeft.x) / (bottomRight.y - topLeft.y), 1);
});

test("projection falls back to identity for degenerate or non-finite input", () => {
  const identity = { scale: 1, offsetX: 0, offsetY: 0 };
  assert.deepEqual(createMinimapProjection({ x: 0, y: 0, width: 0, height: 0 }, { width: 200, height: 100 }), identity);
  assert.deepEqual(createMinimapProjection({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }), identity);
  assert.deepEqual(createMinimapProjection({ x: Number.NaN, y: 0, width: 100, height: 100 }, { width: 200, height: 100 }), identity);
  // A padding that consumes the whole surface is degenerate too.
  assert.deepEqual(createMinimapProjection({ x: 0, y: 0, width: 100, height: 100 }, { width: 10, height: 10 }), identity);
});

test("project and unproject are exact inverses and scale rectangles uniformly", () => {
  const projection = createMinimapProjection({ x: -250, y: 80, width: 700, height: 420 }, { width: 210, height: 120 }, 5);
  const points = [
    { x: 0, y: 0 },
    { x: 123.5, y: -45.25 },
    { x: 700, y: 420 },
    { x: -250, y: 80 }
  ];
  for (const point of points) {
    const mapped = projectMinimapPoint(projection, point.x, point.y);
    const roundTrip = unprojectMinimapPoint(projection, mapped.x, mapped.y);
    assertClose(roundTrip.x, point.x);
    assertClose(roundTrip.y, point.y);
  }

  // The whole domain maps to a centered, height-limited box with side margins.
  const mappedDomain = projectMinimapRect(projection, { x: -250, y: 80, width: 700, height: 420 });
  assertClose(mappedDomain.width, 700 * projection.scale);
  assertClose(mappedDomain.height, 110);
  assertClose(mappedDomain.y, 5);
  assertClose(mappedDomain.x + mappedDomain.width / 2, 105);
  assertClose(mappedDomain.y + mappedDomain.height / 2, 60);
});

test("node growth shrinks the projected viewport indicator", () => {
  const size = { width: 200, height: 130 };
  const viewport = { x: 0, y: 0, zoom: 1 };
  const canvasWidth = 800;
  const canvasHeight = 600;
  const indicatorFor = (layoutWidth: number, layoutHeight: number) => {
    const projection = minimapProjectionForScene(
      { layout: { width: layoutWidth, height: layoutHeight }, viewport, canvasWidth, canvasHeight },
      size
    );
    return projectMinimapRect(projection, visibleWorldRect(viewport, canvasWidth, canvasHeight));
  };

  const small = indicatorFor(800, 600);
  const large = indicatorFor(8000, 6000);
  // The visible rectangle is the same, but the content domain now spans more
  // world units, so the indicator must become smaller.
  assert.ok(large.width < small.width);
  assert.ok(large.height < small.height);

  // A far-panned viewport stays inside the minimap because the scene domain
  // unions the layout with the visible rectangle.
  const panned = minimapProjectionForScene(
    { layout: { width: 1000, height: 500 }, viewport: { x: -9000, y: 4000, zoom: 1 }, canvasWidth, canvasHeight },
    size
  );
  const pannedIndicator = projectMinimapRect(panned, visibleWorldRect({ x: -9000, y: 4000, zoom: 1 }, canvasWidth, canvasHeight));
  assert.ok(pannedIndicator.x >= 0);
  assert.ok(pannedIndicator.y >= 0);
  assert.ok(pannedIndicator.x + pannedIndicator.width <= size.width + 1e-9);
  assert.ok(pannedIndicator.y + pannedIndicator.height <= size.height + 1e-9);
});

test("cached content plus its group transform equals the live scene projection", () => {
  const size = { width: 220, height: 140 };
  const layout = { width: 1400, height: 900 };
  const viewport = { x: -300, y: 200, zoom: 1.4 };
  const canvasWidth = 900;
  const canvasHeight = 700;
  // The component caches content in a layout-only projection and expresses the
  // viewport-dependent scene projection as `translate(offset) scale(ratio)`.
  // That equivalence is what keeps pan/zoom both cheap and correctly aligned.
  const contentProjection = createMinimapProjection({ x: 0, y: 0, width: layout.width, height: layout.height }, size);
  const sceneProjection = minimapProjectionForScene({ layout, viewport, canvasWidth, canvasHeight }, size);
  const ratio = sceneProjection.scale / contentProjection.scale;
  const offsetX = sceneProjection.offsetX - contentProjection.offsetX * ratio;
  const offsetY = sceneProjection.offsetY - contentProjection.offsetY * ratio;

  for (const point of [{ x: 0, y: 0 }, { x: 700, y: 450 }, { x: 1400, y: 900 }]) {
    const cached = projectMinimapPoint(contentProjection, point.x, point.y);
    const direct = projectMinimapPoint(sceneProjection, point.x, point.y);
    assertClose(cached.x * ratio + offsetX, direct.x);
    assertClose(cached.y * ratio + offsetY, direct.y);
  }
});

test("a minimap click unprojects to a world point and centers the viewport on it", () => {
  const viewport = { x: 40, y: 60, zoom: 1.25 };
  const layout = { width: 1000, height: 600 };
  const canvasWidth = 800;
  const canvasHeight = 600;
  const size = { width: 200, height: 120 };
  const projection = minimapProjectionForScene({ layout, viewport, canvasWidth, canvasHeight }, size);

  // Clicking the middle of the map names the middle of the scene domain.
  const mapPoint = { x: size.width / 2, y: size.height / 2 };
  const worldPoint = unprojectMinimapPoint(projection, mapPoint.x, mapPoint.y);
  const centered = centerViewportOnPoint(canvasWidth, canvasHeight, worldPoint, viewport.zoom);

  // The world point now sits exactly at the canvas center at the same zoom;
  // world -> screen is the inverse of visibleWorldRect's pan formula.
  assert.equal(centered.zoom, viewport.zoom);
  assertClose(centered.x + worldPoint.x * centered.zoom, canvasWidth / 2);
  assertClose(centered.y + worldPoint.y * centered.zoom, canvasHeight / 2);

  // A click near the indicator's own center is a no-op move: projected back,
  // it lands on the center of the visible world rectangle.
  const visible = visibleWorldRect(viewport, canvasWidth, canvasHeight);
  const indicator = projectMinimapRect(projection, visible);
  const centeredOnVisible = unprojectMinimapPoint(projection, indicator.x + indicator.width / 2, indicator.y + indicator.height / 2);
  assertClose(centeredOnVisible.x, visible.x + visible.width / 2);
  assertClose(centeredOnVisible.y, visible.y + visible.height / 2);
});
