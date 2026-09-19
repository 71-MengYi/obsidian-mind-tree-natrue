import test from "node:test";
import assert from "node:assert/strict";
import { KeyboardAvoidanceController } from "../src/ui/controllers/keyboard-avoidance-controller";

function setup(touch = true) {
  const document = new EventTarget();
  const viewport = Object.assign(new EventTarget(), { width: 400, height: 800, offsetLeft: 0, offsetTop: 0 });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const window = Object.assign(new EventTarget(), { visualViewport: viewport, navigator: { maxTouchPoints: touch ? 5 : 0 },
    innerWidth: 400, innerHeight: 800,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id) });
  Object.assign(document, { defaultView: window });
  const rect = { left: 20, right: 180, top: 650, bottom: 680, width: 160, height: 30 };
  const editor = Object.assign(new EventTarget(), { ownerDocument: document, isConnected: true,
    getBoundingClientRect: () => ({ ...rect }) });
  Object.assign(document, { activeElement: editor });
  const canvas = { ownerDocument: document, getBoundingClientRect: () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }) };
  const pans: Array<[number, number]> = [];
  const controller = new KeyboardAvoidanceController(canvas as unknown as HTMLElement, (x, y) => {
    pans.push([x, y]); rect.left += x; rect.right += x; rect.top += y; rect.bottom += y;
  });
  const flush = (): void => { for (const [id, callback] of frames) { frames.delete(id); callback(0); } };
  const resize = (height: number): void => { viewport.height = height; viewport.dispatchEvent(new Event("resize")); flush(); };
  controller.watch(editor as unknown as HTMLTextAreaElement);
  flush();
  return { controller, document, viewport, window, editor, pans, frames, rect, resize, flush };
}

test("keyboard avoidance waits for observable occlusion and restores only after keyboard dismissal", () => {
  const s = setup();
  assert.deepEqual(s.pans, []);
  s.resize(500);
  assert.deepEqual(s.pans, [[0, -192]]);
  s.editor.dispatchEvent(new Event("input")); s.flush();
  assert.equal(s.pans.length, 1, "no repeated move when the field already fits");
  s.controller.end(); s.flush();
  assert.equal(s.pans.length, 1, "blur alone does not jump behind an open keyboard");
  s.resize(800);
  assert.equal(s.pans.length, 2);
  assert.equal(s.pans[1]?.[1], 192);
  assert.equal(s.rect.top, 650);
  s.controller.destroy();
});

test("keyboard offset restoration never overwrites a user's subsequent canvas navigation", () => {
  const s = setup();
  s.resize(500);
  s.controller.userNavigated();
  s.controller.end(); s.flush(); s.resize(800);
  assert.equal(s.pans.length, 1);
  s.controller.destroy();
});

test("screen rotation rebases keyboard height instead of retaining a portrait-sized occlusion", () => {
  const s = setup();
  s.resize(500);
  s.controller.end();
  s.window.innerWidth = 800; s.window.innerHeight = 400;
  s.viewport.width = 800;
  s.resize(400);
  assert.equal(s.rect.top, 650, "landscape without a keyboard releases the old automatic offset");
  s.controller.destroy();
});

test("non-touch editing and destroyed controllers leave viewport events and input inert", () => {
  const desktop = setup(false);
  desktop.resize(500);
  assert.deepEqual(desktop.pans, []);
  desktop.controller.destroy();
  const s = setup();
  s.resize(500);
  s.editor.dispatchEvent(new Event("input"));
  s.controller.destroy(); s.controller.destroy();
  assert.equal(s.frames.size, 0);
  s.editor.dispatchEvent(new Event("input"));
  s.document.dispatchEvent(new Event("selectionchange"));
  s.viewport.dispatchEvent(new Event("scroll"));
  s.window.dispatchEvent(new Event("resize"));
  assert.equal(s.frames.size, 0);
  assert.equal(s.pans.length, 1);
});
