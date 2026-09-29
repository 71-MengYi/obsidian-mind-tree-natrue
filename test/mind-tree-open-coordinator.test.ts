import test from "node:test";
import assert from "node:assert/strict";
import { MindTreeOpenCoordinator } from "../src/services/mind-tree-open-coordinator";
import { deferred } from "./helpers/pending-conflict-io";

function setup() {
  const leaves = new Map<string, string>();
  const revealed: string[] = [];
  const discarded: string[] = [];
  const coordinator = new MindTreeOpenCoordinator<string>({
    findExisting: (path, requested) => [...leaves].find(([leaf, file]) => leaf !== requested && file === path)?.[0],
    reveal: async (leaf) => { revealed.push(leaf); },
    discardRedirected: (leaf) => { discarded.push(leaf); }
  });
  return { leaves, revealed, discarded, coordinator };
}

test("same path reuses existing tab across splits/popouts independently of document identity", async () => {
  const f = setup();
  f.leaves.set("popout", "Folder/Tree.mtn.md");
  const winner = await f.coordinator.open("Folder\\Tree.mtn.md", "split", async () => assert.fail("duplicate open"));
  assert.equal(winner, "popout");
  assert.deepEqual(f.revealed, ["popout"]);
  assert.deepEqual(f.discarded, ["split"]);
});

test("simultaneous requests share an opening task and nested routing recognizes its owner", async () => {
  const f = setup();
  const gate = deferred();
  let calls = 0;
  const open = async () => {
    calls++;
    assert.equal(f.coordinator.isOpening("Tree.mtn.md", "first"), true);
    await gate.promise;
    f.leaves.set("first", "Tree.mtn.md");
  };
  const first = f.coordinator.open("Tree.mtn.md", "first", open);
  const second = f.coordinator.open("Tree.mtn.md", "second", open);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "first"]);
  assert.equal(calls, 1);
  assert.deepEqual(f.discarded, ["second"]);
  assert.equal(f.coordinator.isOpening("Tree.mtn.md", "first"), false);
});

test("background restore does not steal focus; unrelated paths are independent", async () => {
  const f = setup();
  await Promise.all(["A", "B"].map((name) => f.coordinator.open(`${name}.mtn.md`, name,
    async () => { f.leaves.set(name, `${name}.mtn.md`); }, false)));
  assert.equal(f.leaves.size, 2);
  assert.deepEqual(f.revealed, []);
});

test("a rejected open releases reservations so a later request can retry", async () => {
  const f = setup();
  await assert.rejects(f.coordinator.open("Tree.mtn.md", "first", async () => { throw new Error("load failed"); }));
  assert.equal(await f.coordinator.open("Tree.mtn.md", "second", async () => undefined), "second");
});

test("only one host delegation bypasses routing; repeated same-leaf requests share the task", async () => {
  const f = setup();
  const gate = deferred();
  let calls = 0;
  const first = f.coordinator.open("Tree.mtn.md", "leaf", async () => {
    calls++;
    assert.equal(f.coordinator.consumeNestedRoute("Tree.mtn.md", "leaf"), true);
    assert.equal(f.coordinator.consumeNestedRoute("Tree.mtn.md", "leaf"), false);
    await gate.promise;
  }, false, true);
  const repeat = f.coordinator.open("Tree.mtn.md", "leaf", async () => { calls++; }, false);
  gate.resolve();
  await Promise.all([first, repeat]);
  assert.equal(calls, 1);
});
