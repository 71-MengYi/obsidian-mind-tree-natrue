import test from "node:test";
import assert from "node:assert/strict";
import { SerialTaskQueue } from "../src/services/serial-lane";

/**
 * The file-level serial lanes depend on two tail semantics that look alike but
 * differ in whether a failed task can poison the next one. These tests pin both
 * so a future "unify the queue" refactor cannot silently change save behavior.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("serial() runs tasks in order and a rejection does not block the next task", async () => {
  const lane = new SerialTaskQueue();
  const order: string[] = [];
  const first = lane.serial(async () => {
    order.push("first");
    throw new Error("first failed");
  });
  // A 族 keeps the rejecting tail, so a failed task is still observable there.
  const failingTail = lane.settledTail;
  const second = lane.serial(async () => {
    order.push("second");
  });

  await assert.rejects(first, /first failed/);
  await assert.rejects(failingTail, /first failed/);
  await second;
  assert.deepEqual(order, ["first", "second"]);
});

test("serial() starts the next task only after the previous one settled", async () => {
  const lane = new SerialTaskQueue();
  const gate = deferred();
  const order: string[] = [];
  const first = lane.serial(async () => {
    order.push("start-first");
    await gate.promise;
    order.push("end-first");
  });
  const second = lane.serial(async () => { order.push("second"); });

  // Let the lane's chained microtasks run before asserting the second task waits.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start-first"], "the second task must wait for the gate");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start-first", "end-first", "second"]);
});

test("serialNormalized() keeps the stored tail resolved while callers still see the failure", async () => {
  const lane = new SerialTaskQueue();
  const order: string[] = [];
  const failing = lane.serialNormalized(async () => {
    order.push("failing");
    throw new Error("boom");
  });

  await assert.rejects(failing, /boom/);
  // B 族 guarantees: awaiting or re-comparing the tail never throws.
  await lane.settledTail;
  const settled = lane.settledTail;
  assert.equal(settled, lane.settledTail);

  const recovered = lane.serialNormalized(async () => { order.push("recovered"); });
  await recovered;
  assert.deepEqual(order, ["failing", "recovered"]);
});

test("settledTail is a stable reference while a task is still running", async () => {
  const lane = new SerialTaskQueue();
  const gate = deferred();
  const running = lane.serialNormalized(async () => { await gate.promise; });
  const observed = lane.settledTail;

  assert.equal(observed, lane.settledTail);
  gate.resolve();
  await running;
  // Once the task settles the marker still resolves and is safe to await again.
  await lane.settledTail;
});
