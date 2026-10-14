import test from "node:test";
import assert from "node:assert/strict";
import { confirmUsableSource, readStableSource, type StableSourcePorts } from "../src/services/stable-source-read";

/**
 * Scripted file: `stamps` answers successive `stamp()` calls, `sources` answers
 * successive `read()` calls. A read is settled only when the stamp before and
 * after it are equal, which is what the helpers under test rely on.
 */
function scriptedFile(stamps: Array<string | undefined>, sources: string[]): { ports: StableSourcePorts; waits: number[] } {
  let stampIndex = 0;
  let readIndex = 0;
  const waits: number[] = [];
  return {
    waits,
    ports: {
      stamp: async () => stamps[Math.min(stampIndex++, stamps.length - 1)],
      read: async () => sources[Math.min(readIndex++, sources.length - 1)] ?? "",
      delay: async (milliseconds: number) => { waits.push(milliseconds); }
    }
  };
}

test("a read whose revision did not change is trusted immediately", async () => {
  const file = scriptedFile(["a", "a"], ["complete"]);
  assert.deepEqual(await readStableSource(file.ports), { ok: true, source: "complete" });
  assert.deepEqual(file.waits, []);
});

test("a read caught inside a write is retried until the revision settles", async () => {
  const file = scriptedFile(["a", "b", "b", "b"], ["torn", "settled"]);
  assert.deepEqual(await readStableSource(file.ports), { ok: true, source: "settled" });
  assert.deepEqual(file.waits, [120]);
});

test("a file that never settles is reported as unstable, never as damaged", async () => {
  const file = scriptedFile(["a", "b", "c", "d", "e", "f"], ["x", "y", "z"]);
  assert.deepEqual(await readStableSource(file.ports, [120, 400]), { ok: false, reason: "unstable" });
  assert.deepEqual(file.waits, [120, 400]);
});

test("a missing path is reported as missing instead of unreadable", async () => {
  const file = scriptedFile([undefined], []);
  assert.deepEqual(await readStableSource(file.ports), { ok: false, reason: "missing" });
});

test("an unusable payload is retried before damage is declared", async () => {
  const file = scriptedFile(["a", "a", "a", "a"], ["truncated", "complete"]);
  const result = await confirmUsableSource(file.ports, (source) => source === "complete");
  assert.deepEqual(result, { ok: true, source: "complete" });
  assert.deepEqual(file.waits, [120]);
});

test("a settled but unusable payload is only then reported as damaged", async () => {
  const file = scriptedFile(["a", "a"], ["truncated"]);
  const result = await confirmUsableSource(file.ports, () => false, [120, 400]);
  assert.deepEqual(result, { ok: false, reason: "damaged", source: "truncated" });
  assert.deepEqual(file.waits, [120, 400]);
});

test("a sync client's remove-and-replace window is retried, not treated as deletion", async () => {
  const file = scriptedFile([undefined, "b", "b"], ["replaced"]);
  const result = await confirmUsableSource(file.ports, (source) => source.length > 0);
  assert.deepEqual(result, { ok: true, source: "replaced" });
  assert.deepEqual(file.waits, [120]);
});

test("a path that stays gone is reported as missing", async () => {
  const file = scriptedFile([undefined], []);
  assert.deepEqual(await confirmUsableSource(file.ports, () => true, [120, 400]), { ok: false, reason: "missing" });
});
