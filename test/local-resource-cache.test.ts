import test from "node:test";
import assert from "node:assert/strict";
import { LocalResourceCache, normalizeLocalResourceCache } from "../src/services/local-resource-cache";

const entry = { resourceId: "duplicate", path: "Notes/one.md", fileKind: "note" as const };

test("local cache preserves all paths for the same ID and is not a settings object", () => {
  const storage = new Map<string, unknown>();
  const cache = new LocalResourceCache("test", {
    load: (key) => storage.get(key), save: (key, value) => { storage.set(key, value); }
  }, () => assert.fail());
  assert.equal(cache.save([entry, { ...entry, path: "Notes/two.md" }]), true);
  assert.equal(cache.load().length, 2);
  assert.equal(storage.has("test:resource-index:v1"), true);
  assert.equal(storage.has("data.json"), false);
});

test("malformed, old-version and path-escaping cache values rebuild from nothing", () => {
  for (const value of [undefined, {}, { version: 2, entries: [entry] },
    { version: 1, entries: [entry, { ...entry, path: "../outside.md" }] },
    { version: 1, entries: [{ ...entry, fileKind: "invalid" }] },
    { version: 1, entries: [entry, entry] }]) {
    assert.deepEqual(normalizeLocalResourceCache(value), []);
  }
});

test("quota and read failures degrade to memory without throwing or using synced storage", () => {
  let notices = 0;
  const cache = new LocalResourceCache("test", {
    load: () => { throw new Error("unavailable"); },
    save: () => { throw new Error("quota"); }
  }, () => { notices++; });
  assert.deepEqual(cache.load(), []);
  assert.equal(cache.save([entry]), false);
  assert.equal(cache.save([entry]), false);
  assert.equal(notices, 1);
});

test("vault-local storage ports do not share caches across devices or vaults", () => {
  const make = () => {
    const storage = new Map<string, unknown>();
    return new LocalResourceCache("test", {
      load: (key) => storage.get(key), save: (key, value) => { storage.set(key, value); }
    }, () => assert.fail());
  };
  const a = make(); const b = make();
  a.save([entry]);
  assert.deepEqual(b.load(), []);
});
