import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FileAssociationController } from "../src/ui/controllers/file-association-controller";
import { uncollectedReferences } from "../src/ui/association-target";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { DocumentSession } from "../src/services/document-session";
import type { FileResourceRef } from "../src/types";
import type { FileAssociationProgress } from "../src/services/resource-index";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const row = (id: string, path = `${id}.md`) => ({ reference: {
  type: "file", resourceId: id, pathHint: path, fileKind: "note"
} as FileResourceRef });
const result = () => ({ linked: [row("one"), row("two")], cancelled: false, assertCurrent() {} });

test("repeated Ctrl+E requests for one target share exactly one creation and association", async () => {
  const controller = new FileAssociationController(); const fileIo = deferred();
  let created = 0; let linked = 0;
  const create = async () => { created++; await fileIo.promise; linked++; };
  const a = controller.createOnce("session:node", create);
  const b = controller.createOnce("session:node", create);
  assert.equal(a, b); await Promise.resolve(); assert.equal(created, 1);
  fileIo.resolve(); await Promise.all([a, b]);
  assert.equal(linked, 1);
  await controller.createOnce("session:other", async () => { created++; });
  assert.equal(created, 2);
});

test("failed creation releases its single-flight slot without an automatic second file creation", async () => {
  const controller = new FileAssociationController(); let calls = 0;
  await assert.rejects(controller.createOnce("one", async () => { calls++; throw new Error("failed"); }));
  assert.equal(calls, 1);
  await controller.createOnce("one", async () => { calls++; });
  assert.equal(calls, 2);
});

test("collection publishes progress before I/O and commits all results only once after verification", async () => {
  const controller = new FileAssociationController(); const paint = deferred(); const io = deferred<ReturnType<typeof result>>();
  const progress: Array<FileAssociationProgress | undefined> = [];
  let started = 0; let commits = 0; let renders = 0;
  let document = createEmptyDocument("Root"); const session = new DocumentSession(); session.load("source");
  const operation = controller.collect({
    total: 2, isCurrent: () => true, progress: (value) => { progress.push(value); }, yield: () => paint.promise,
    collect: async (update) => { started++; update({ phase: "associate", completed: 1, total: 2 }); return io.promise; },
    accept: (batch) => {
      const rows = uncollectedReferences(document, batch.linked);
      document = session.execute(document, (draft) => { for (const item of rows) addNode(draft, draft.rootId, item.reference.resourceId).resource = item.reference; });
      session.markChanged(); commits++; renders++;
    }, failed: (error) => { throw error; }
  });
  assert.deepEqual(progress[0], { phase: "verify", completed: 0, total: 2 });
  assert.equal(started, 0); assert.equal(controller.collecting, true); assert.equal(session.dirty, false);
  paint.resolve(); await Promise.resolve(); assert.equal(started, 1); assert.equal(commits, 0);
  await controller.collect({ total: 2, isCurrent: () => true, progress: () => assert.fail("duplicate progress"),
    yield: async () => undefined, collect: async () => { assert.fail("duplicate collection"); }, accept: () => {}, failed: () => {} });
  io.resolve(result()); await operation;
  assert.equal(commits, 1); assert.equal(renders, 1); assert.equal(session.dirty, true);
  assert.equal(document.nodes[document.rootId]!.childIds.length, 2);
  const previous = session.undo(document)!;
  assert.equal(previous.nodes[previous.rootId]!.childIds.length, 0); assert.equal(session.canUndo, false);
  assert.equal(progress.at(-1), undefined); assert.equal(controller.collecting, false);
});

test("switching, closing or conflict locking cancels pending collection without document callbacks", async () => {
  for (const reason of ["switch", "close", "conflict"] as const) {
    const controller = new FileAssociationController(); const io = deferred<ReturnType<typeof result>>();
    let valid = true; let accepts = 0; let errors = 0; const progress: unknown[] = [];
    const operation = controller.collect({
      total: 2, isCurrent: () => valid, progress: (value) => { progress.push(value); }, yield: async () => undefined,
      collect: async () => io.promise, accept: () => { accepts++; }, failed: () => { errors++; }
    });
    await Promise.resolve();
    if (reason === "close") controller.destroy();
    else { valid = false; controller.cancelCollection(); }
    assert.equal(progress.at(-1), undefined); assert.equal(controller.collecting, false);
    io.resolve(result()); await operation;
    assert.equal(accepts, 0); assert.equal(errors, 0);
  }
});

test("an older cancelled collection cannot clear the progress of a new file's collection", async () => {
  const controller = new FileAssociationController(); const oldIo = deferred<ReturnType<typeof result>>();
  const newIo = deferred<ReturnType<typeof result>>(); const events: string[] = [];
  const run = (label: string, io: typeof oldIo) => controller.collect({ total: 1, isCurrent: () => true,
    progress: (value) => { events.push(`${label}:${value ? "progress" : "clear"}`); }, yield: async () => undefined,
    collect: async () => io.promise, accept: () => { events.push(`${label}:accept`); }, failed: () => {} });
  const old = run("old", oldIo); await Promise.resolve(); controller.cancelCollection();
  const next = run("new", newIo); await Promise.resolve();
  oldIo.resolve(result()); await old;
  assert.equal(events.at(-1), "new:progress"); assert.equal(controller.collecting, true);
  newIo.resolve(result()); await next;
  assert.equal(events.at(-1), "new:clear"); assert.ok(!events.includes("old:accept"));
});

test("failed final identity guard reports once, clears progress and never commits", async () => {
  const controller = new FileAssociationController(); let errors = 0; let cleared = false;
  await controller.collect({ total: 1, isCurrent: () => true, yield: async () => undefined,
    progress: (value) => { cleared = value === undefined; },
    collect: async () => ({ cancelled: false, assertCurrent() { throw new Error("changed"); } }),
    accept: () => assert.fail("must not associate a stale resource"), failed: () => { errors++; }
  });
  assert.equal(errors, 1); assert.equal(cleared, true); assert.equal(controller.collecting, false);
});

test("collection filtering checks live references by ID and path without disturbing candidate order", () => {
  const document = createEmptyDocument("Root");
  addNode(document, document.rootId, "Existing").resource = row("already", "moved.md").reference;
  const candidates = [row("already", "old.md"), row("replacement", "moved.md"), row("a"), row("b"), row("a")];
  assert.deepEqual(uncollectedReferences(document, candidates).map((item) => item.reference.resourceId), ["a", "b"]);
  assert.deepEqual(uncollectedReferences(document, [row("already")]), []);
});

test("view wiring separates progress from save state and uses immediate one-command rendering", () => {
  const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
  const collect = view.split("  private async collectCandidates(")[1]!.split("  /** Translate association")[0]!;
  assert.match(collect, /ensureStableReferences/); assert.match(collect, /uncollectedReferences/);
  assert.equal((collect.match(/this\.commit\(/g) ?? []).length, 1);
  assert.match(collect, /if \(references\.length\)/);
  assert.doesNotMatch(collect, /saveState\s*=|selectOnly|centerViewport|flushPendingSave/);
  const progress = view.split("  private renderStatusMessage()")[1]!;
  assert.doesNotMatch(progress, /saveState\s*=|markChanged|markDocumentDirty/);
  assert.match(view, /onClose\(\)[\s\S]*?acceptingAssociations = false/);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /metadataCache\.on\("changed",[\s\S]*?refreshResource\(file, "metadata"\)/);
});
