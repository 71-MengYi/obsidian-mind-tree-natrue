import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BACKLINK_SCAN_BYTES,
  MAX_BACKLINK_BLOCKS_PER_FILE,
  extractBranchReferences
} from "../src/domain/branch-reference-scan";
import { createBranchReference, renderBranchReferenceBlock } from "../src/domain/branch-reference";
import {
  BacklinkIndexService,
  type BacklinkIndexClock,
  type BacklinkNote
} from "../src/services/backlink-index";
import {
  MAX_BACKLINK_DOTS,
  MAX_BACKLINK_PILLS,
  createBacklinkRenderModel
} from "../src/ui/renderers/backlink-render-model";
import type { BacklinkTarget } from "../src/domain/backlink";

function block(tree: string, node: string, path?: string): string {
  return renderBranchReferenceBlock(createBranchReference(tree, node, path));
}

test("extract reports 1-based payload lines across several blocks", () => {
  const source = [
    "# Note",
    "",
    block("tree-a", "node-1"),
    "",
    block("tree-b", "node-2", "Trees/B.mtn.md"),
    ""
  ].join("\n");
  assert.deepEqual(extractBranchReferences(source), [
    { documentId: "tree-a", nodeId: "node-1", line: 4 },
    { documentId: "tree-b", nodeId: "node-2", line: 8 }
  ]);
});

test("extract keeps CRLF line numbers and accepts a tilde fence", () => {
  const source = [
    "# Note",
    "~~~mind-tree-ref",
    '{"tree":"tree-a","node":"tilde"}',
    "~~~"
  ].join("\r\n");
  assert.deepEqual(extractBranchReferences(source), [
    { documentId: "tree-a", nodeId: "tilde", line: 3 }
  ]);
});

test("invalid JSON and oversized payloads are skipped without throwing", () => {
  const invalid = ["```mind-tree-ref", "{not json}", "```"].join("\n");
  assert.deepEqual(extractBranchReferences(invalid), []);
  const oversizedPayload = `{"tree":"tree-a","node":"node-1","path":"${"x".repeat(5000)}"}`;
  const oversized = ["```mind-tree-ref", oversizedPayload, "```"].join("\n");
  assert.deepEqual(extractBranchReferences(oversized), []);
  // A block without a closing fence swallows the rest of the note.
  assert.deepEqual(extractBranchReferences(["```mind-tree-ref", '{"tree":"tree-a","node":"open"}'].join("\n")), []);
});

test("a reference example nested inside another fence is not a backlink", () => {
  const nested = [
    "````markdown",
    "```mind-tree-ref",
    '{"tree":"tree-a","node":"example"}',
    "```",
    "````"
  ].join("\n");
  assert.deepEqual(extractBranchReferences(nested), []);
});

test("one note processes at most the block cap", () => {
  const blocks = Array.from(
    { length: MAX_BACKLINK_BLOCKS_PER_FILE + 6 },
    (_, index) => block("tree-a", `node-${index}`)
  );
  const occurrences = extractBranchReferences(blocks.join("\n"));
  assert.equal(occurrences.length, MAX_BACKLINK_BLOCKS_PER_FILE);
  assert.equal(occurrences[0]?.nodeId, "node-0");
  assert.equal(occurrences[MAX_BACKLINK_BLOCKS_PER_FILE - 1]?.nodeId, `node-${MAX_BACKLINK_BLOCKS_PER_FILE - 1}`);
});

test("a note above the scan budget is never parsed", () => {
  const source = `${"x".repeat(MAX_BACKLINK_SCAN_BYTES + 1)}\n${block("tree-a", "node-1")}`;
  assert.deepEqual(extractBranchReferences(source), []);
});

class FakeClock implements BacklinkIndexClock {
  private nextId = 1;
  private readonly handlers = new Map<number, () => void>();

  setTimeout(handler: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.handlers.set(id, handler);
    return id;
  }

  clearTimeout(handle: number): void { this.handlers.delete(handle); }

  get pending(): number { return this.handlers.size; }

  take(): Array<() => void> {
    const due = [...this.handlers.values()];
    this.handlers.clear();
    return due;
  }
}

interface FakeNote extends BacklinkNote {
  text: string;
  hasCodeBlock: boolean | undefined;
}

interface Harness {
  readonly vault: Map<string, FakeNote>;
  readonly reads: string[];
  readonly prefilterCalls: string[];
  readonly errors: unknown[];
  readonly failing: Set<string>;
  readonly clock: FakeClock;
  readonly service: BacklinkIndexService;
  put(path: string, text: string, hasCodeBlock?: boolean, mtime?: number, size?: number): void;
  rename(oldPath: string, newPath: string): void;
}

function harness(initial: ReadonlyArray<readonly [string, string]> = []): Harness {
  const vault = new Map<string, FakeNote>();
  const reads: string[] = [];
  const prefilterCalls: string[] = [];
  const errors: unknown[] = [];
  const failing = new Set<string>();
  const clock = new FakeClock();
  const service = new BacklinkIndexService({
    notes: () => [...vault.values()].map(({ path, mtime, size }) => ({ path, mtime, size })),
    noteAt: (path) => {
      const note = vault.get(path);
      return note ? { path: note.path, mtime: note.mtime, size: note.size } : undefined;
    },
    mayContainCodeBlock: (path) => {
      prefilterCalls.push(path);
      return vault.get(path)?.hasCodeBlock;
    },
    read: async (path) => {
      reads.push(path);
      const note = vault.get(path);
      if (!note || failing.has(path)) throw new Error(`unreadable note: ${path}`);
      return note.text;
    },
    clock,
    reportError: (error) => errors.push(error)
  });
  const put = (path: string, text: string, hasCodeBlock: boolean | undefined = true, mtime = 1, size?: number): void => {
    const note: FakeNote = { path, text, hasCodeBlock, mtime, size: size ?? text.length };
    vault.set(path, note);
  };
  for (const [path, text] of initial) put(path, text);
  return {
    vault, reads, prefilterCalls, errors, failing, clock, service, put,
    rename: (oldPath, newPath) => {
      const note = vault.get(oldPath);
      if (!note) throw new Error(`missing note: ${oldPath}`);
      vault.delete(oldPath);
      vault.set(newPath, { ...note, path: newPath });
    }
  };
}

/** Flush pending microtasks; fake reads resolve without a macrotask hop. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function runTick(clock: FakeClock): Promise<void> {
  for (const handler of clock.take()) handler();
  await settle();
}

async function drain(clock: FakeClock): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    if (clock.pending === 0) {
      await settle();
      if (clock.pending === 0) return;
    }
    await runTick(clock);
  }
  throw new Error("backlink scheduler did not settle");
}

function notePath(index: number): string {
  return `Notes/Note-${String(index).padStart(2, "0")}.md`;
}

test("a full scan is batched to at most 25 notes per tick", async () => {
  const h = harness();
  for (let index = 0; index < 30; index += 1) {
    h.put(notePath(index), block("tree-a", `node-${index}`));
  }
  h.service.start();
  assert.equal(h.clock.pending, 1);
  await runTick(h.clock);
  assert.equal(h.reads.length, 25);
  await drain(h.clock);
  assert.equal(h.reads.length, 30);
  assert.equal(h.service.entriesFor("tree-a").size, 30);
  h.service.destroy();
});

test("the metadata pre-filter skips a note without code sections and trusts unknown", async () => {
  const h = harness();
  h.put("Plain.md", "no blocks here", false);
  h.put("Unknown.md", block("tree-a", "node-unknown"), undefined);
  h.put("Code.md", block("tree-a", "node-code"), true);
  h.service.start();
  await drain(h.clock);
  assert.deepEqual([...h.reads].sort(), ["Code.md", "Unknown.md"]);
  assert.ok(h.prefilterCalls.includes("Plain.md"));
  h.service.destroy();
});

test("an unchanged note is not read again on a later scan or event", async () => {
  const h = harness([
    ["A.md", block("tree-a", "node-a")],
    ["B.md", block("tree-a", "node-b")]
  ]);
  h.service.start();
  await drain(h.clock);
  assert.equal(h.reads.length, 2);
  // A second startup pass reuses the mtime+size cache.
  h.service.start();
  await drain(h.clock);
  assert.equal(h.reads.length, 2);
  // A modify event with an unchanged stat is a no-op as well.
  h.service.notifyChanged("A.md");
  await drain(h.clock);
  assert.equal(h.reads.length, 2);
  // A changed stat is the one case that re-reads.
  h.put("A.md", block("tree-a", "node-a"), true, 2);
  h.service.notifyChanged("A.md");
  await drain(h.clock);
  assert.equal(h.reads.length, 3);
  h.service.destroy();
});

test("a later metadata parse revisits only a note the pre-filter had skipped", async () => {
  const h = harness();
  h.put("Late.md", block("tree-a", "node-late"), false);
  h.put("Empty.md", "just prose", true);
  h.service.start();
  await drain(h.clock);
  assert.deepEqual(h.reads, ["Empty.md"]);
  // The host's parse now sees a code section in the note it had skipped.
  h.put("Late.md", block("tree-a", "node-late"), true);
  h.service.notifyMetadataChanged("Late.md");
  await drain(h.clock);
  assert.deepEqual(h.reads, ["Empty.md", "Late.md"]);
  assert.deepEqual(h.service.entriesFor("tree-a").get("node-late"), [{ path: "Late.md", line: 2 }]);
  // A note that was read stays cached even when the parse reports code blocks.
  h.service.notifyMetadataChanged("Empty.md");
  await drain(h.clock);
  assert.equal(h.reads.length, 2);
  h.service.destroy();
});

test("modify, rename and delete only touch the affected note path", async () => {
  const h = harness();
  h.put("A.md", block("tree-a", "node-x"));
  h.put("B.md", block("tree-a", "node-y"));
  h.service.start();
  await drain(h.clock);
  assert.deepEqual(h.service.entriesFor("tree-a").get("node-x"), [{ path: "A.md", line: 2 }]);

  h.put("A.md", block("tree-a", "node-z"), true, 2);
  h.service.notifyChanged("A.md");
  await drain(h.clock);
  assert.equal(h.service.entriesFor("tree-a").has("node-x"), false);
  assert.deepEqual(h.service.entriesFor("tree-a").get("node-z"), [{ path: "A.md", line: 2 }]);

  h.rename("A.md", "Moved/A.md");
  h.service.notifyRenamed("A.md", "Moved/A.md");
  await drain(h.clock);
  assert.deepEqual(h.service.entriesFor("tree-a").get("node-z"), [{ path: "Moved/A.md", line: 2 }]);

  h.vault.delete("B.md");
  h.service.notifyRemoved("B.md");
  // A removal is visible immediately, without waiting for the next batch.
  assert.equal(h.service.entriesFor("tree-a").has("node-y"), false);
  await drain(h.clock);
  assert.deepEqual([...h.service.entriesFor("tree-a").keys()], ["node-z"]);
  h.service.destroy();
});

test("entriesFor aggregates notes and orders them by path then line", async () => {
  const h = harness();
  h.put("Zeta.md", `${block("tree-a", "shared")}\n\n${block("tree-a", "shared")}`);
  h.put("Alpha.md", block("tree-a", "shared"));
  h.put("Other.md", block("tree-b", "shared"));
  h.service.start();
  await drain(h.clock);
  assert.deepEqual(h.service.entriesFor("tree-a").get("shared"), [
    { path: "Alpha.md", line: 2 },
    { path: "Zeta.md", line: 2 },
    { path: "Zeta.md", line: 6 }
  ]);
  // Other tree identities are isolated from each other.
  assert.deepEqual(h.service.entriesFor("tree-b").get("shared"), [{ path: "Other.md", line: 2 }]);
  assert.equal(h.service.entriesFor("tree-c").size, 0);
  h.service.destroy();
});

test("an oversized note is skipped before any read", async () => {
  const h = harness();
  h.put("Huge.md", block("tree-a", "node-huge"), true, 1, MAX_BACKLINK_SCAN_BYTES + 1);
  h.service.start();
  await drain(h.clock);
  assert.deepEqual(h.reads, []);
  assert.equal(h.service.entriesFor("tree-a").size, 0);
  h.service.destroy();
});

test("a failing read is reported, never thrown, and is retried on the next event", async () => {
  const h = harness([["Flaky.md", block("tree-a", "node-flaky")]]);
  h.failing.add("Flaky.md");
  h.service.start();
  await drain(h.clock);
  assert.equal(h.errors.length, 1);
  assert.equal(h.service.entriesFor("tree-a").size, 0);
  // The failure is not cached: the next event re-reads the note.
  h.failing.delete("Flaky.md");
  h.service.notifyChanged("Flaky.md");
  await drain(h.clock);
  assert.deepEqual(h.service.entriesFor("tree-a").get("node-flaky"), [{ path: "Flaky.md", line: 2 }]);
  h.service.destroy();
});

test("a note deleted while it is being read never publishes a stale backlink", async () => {
  const clock = new FakeClock();
  let resolveRead: ((source: string) => void) | undefined;
  let note: BacklinkNote | undefined = { path: "Gone.md", mtime: 1, size: 120 };
  const service = new BacklinkIndexService({
    notes: () => (note ? [note] : []),
    noteAt: () => note,
    mayContainCodeBlock: () => true,
    read: () => new Promise<string>((resolve) => { resolveRead = resolve; }),
    clock
  });
  service.start();
  for (const handler of clock.take()) handler();
  assert.ok(resolveRead);
  // The delete event arrives while the vault read is still in flight.
  note = undefined;
  service.notifyRemoved("Gone.md");
  resolveRead(block("tree-a", "node-gone"));
  await settle();
  assert.equal(service.entriesFor("tree-a").size, 0);
  service.destroy();
});

test("subscribers hear real changes and stop after unsubscribing", async () => {
  const h = harness([["A.md", block("tree-a", "node-a")]]);
  let calls = 0;
  const unsubscribe = h.service.subscribe(() => { calls += 1; });
  h.service.start();
  await drain(h.clock);
  assert.equal(calls, 1);
  // A second full scan finds the same answer, so nothing is announced.
  h.service.start();
  await drain(h.clock);
  assert.equal(calls, 1);
  unsubscribe();
  h.vault.delete("A.md");
  h.service.notifyRemoved("A.md");
  assert.equal(calls, 1);
  h.service.destroy();
});

test("destroy cancels the scheduled batch and the subscription", async () => {
  const h = harness([["A.md", block("tree-a", "node-a")]]);
  let calls = 0;
  h.service.subscribe(() => { calls += 1; });
  h.service.start();
  assert.equal(h.clock.pending, 1);
  h.service.destroy();
  assert.equal(h.clock.pending, 0);
  await drain(h.clock);
  assert.equal(h.reads.length, 0);
  assert.equal(calls, 0);
});

test("the render model caps dots, reports overflow and truncates pills", () => {
  assert.equal(createBacklinkRenderModel(undefined), undefined);
  assert.equal(createBacklinkRenderModel([]), undefined);

  const target = (index: number): BacklinkTarget => ({ path: `Note-${index}.md`, line: index + 1 });
  const single = createBacklinkRenderModel([target(0)]);
  assert.deepEqual(single, { dots: 1, overflow: 0, pills: [target(0)], total: 1 });

  const seven = createBacklinkRenderModel(Array.from({ length: 7 }, (_, index) => target(index)));
  assert.equal(seven?.dots, MAX_BACKLINK_DOTS);
  assert.equal(seven?.overflow, 2);
  assert.equal(seven?.pills.length, 7);
  assert.equal(seven?.total, 7);

  const many = createBacklinkRenderModel(Array.from({ length: 30 }, (_, index) => target(index)));
  assert.equal(many?.dots, MAX_BACKLINK_DOTS);
  assert.equal(many?.overflow, 30 - MAX_BACKLINK_DOTS);
  assert.equal(many?.pills.length, MAX_BACKLINK_PILLS);
  // The index already orders entries; the model must not reorder them.
  assert.equal(many?.pills[0]?.path, "Note-0.md");
  assert.equal(many?.pills[MAX_BACKLINK_PILLS - 1]?.path, `Note-${MAX_BACKLINK_PILLS - 1}.md`);
  assert.equal(many?.total, 30);
});
