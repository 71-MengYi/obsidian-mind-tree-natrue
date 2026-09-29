import test from "node:test";
import assert from "node:assert/strict";
import { removeLegacyResourceIndex, SettingsPersistence } from "../src/services/settings-persistence";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("external settings invalidate old queued saves and do not echo a save", async () => {
  const gate = deferred();
  const entered = deferred();
  let disk = { theme: "old" };
  let current = disk;
  const writes: string[] = [];
  const io = new SettingsPersistence({
    read: async () => disk,
    apply: (value) => { current = value; },
    failed: () => assert.fail(),
    write: async (value) => { writes.push(value.theme); entered.resolve(); await gate.promise; }
  });
  const first = io.save({ theme: "writing" });
  await entered.promise;
  const stale = io.save({ theme: "queued old memory" });
  disk = { theme: "synced" };
  const external = io.reload();
  gate.resolve();
  await Promise.all([first, stale, external]);
  assert.deepEqual(writes, ["writing"]);
  assert.deepEqual(current, { theme: "synced" });
  io.destroy();
});

test("rapid explicit settings changes coalesce and persist the newest complete user state", async () => {
  const writes: unknown[] = [];
  const io = new SettingsPersistence({
    read: async () => ({ value: 0 }), apply: () => undefined, failed: () => assert.fail(),
    write: async (value) => { writes.push(value); }
  });
  await Promise.all([io.save({ value: 1 }), io.save({ value: 2 }), io.save({ value: 3 })]);
  assert.deepEqual(writes, [{ value: 3 }]);
  io.destroy();
});

test("read failure keeps memory and prevents overwriting a damaged file", async () => {
  let current = { value: 7 };
  const failures: string[] = [];
  let writes = 0;
  const io = new SettingsPersistence({
    read: async (): Promise<{ value: number }> => { throw new Error("broken JSON"); },
    apply: (value) => { current = value; },
    write: async () => { writes++; }, failed: (_error, operation) => { failures.push(operation); }
  });
  await io.reload();
  await io.save({ value: 1 });
  assert.deepEqual(current, { value: 7 });
  assert.equal(writes, 0);
  assert.deepEqual(failures, ["read", "write"]);
  io.destroy();
});

test("external reload cancels a failed write retry; unloading never starts another save", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let writes = 0;
  let current = "old";
  const io = new SettingsPersistence({
    read: async () => "external", apply: (value) => { current = value; },
    write: async () => { writes++; throw new Error("offline"); }, failed: () => undefined
  });
  await io.save("local");
  await io.reload();
  context.mock.timers.tick(35_000);
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(current, "external");
  io.destroy();
  await io.save("after close");
  context.mock.timers.tick(35_000);
  assert.equal(writes, 1);
});

test("legacy cleanup removes only the index from latest disk text and never normalizes user settings", () => {
  const raw = { settings: { newNoteDefaultContent: "  keep\n ", future: "keep" }, resourceIndex: { copied: {} } };
  assert.deepEqual(JSON.parse(removeLegacyResourceIndex(JSON.stringify(raw))), { settings: raw.settings });
  const unchanged = '{ "settings": {} }\n';
  assert.equal(removeLegacyResourceIndex(unchanged), unchanged);
  assert.throws(() => removeLegacyResourceIndex("not JSON"));
  assert.throws(() => removeLegacyResourceIndex("[]"));
});
