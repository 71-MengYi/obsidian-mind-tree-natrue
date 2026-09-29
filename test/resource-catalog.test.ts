import test from "node:test";
import assert from "node:assert/strict";
import { ResourceCatalog, ResourceVerificationChangedError, readResourceIdentity, type ResourceFile } from "../src/services/resource-catalog";
import type { IndexedResource } from "../src/services/local-resource-cache";
import type { FileResourceRef } from "../src/types";

interface File extends ResourceFile { content: string }
const markdown = (id: string) => `---\nmind-tree-nature:\n  resourceId: ${id}\n---\nBody`;
const reference = (id: string, path = "missing.md"): FileResourceRef => ({ type: "file", resourceId: id, pathHint: path, fileKind: "note" });

function fixture(hints: IndexedResource[] = []) {
  const files = new Map<string, File>();
  const persisted: IndexedResource[][] = [];
  let beforeRead: ((file: File) => Promise<void>) | undefined;
  let failList = false;
  const reads: string[] = [];
  const catalog = new ResourceCatalog<File>({
    files: () => { if (failList) throw new Error("unavailable vault"); return [...files.values()]; },
    file: (path) => files.get(path),
    read: async (file) => { reads.push(file.path); await beforeRead?.(file); return file.content; },
    changed: (entries) => { persisted.push(entries); }, yield: async () => undefined
  }, hints);
  const add = (path: string, content = ""): File => {
    const file = { path, content, stat: { mtime: 1, size: content.length, ctime: 1 } };
    files.set(path, file); catalog.invalidate(path); return file;
  };
  const change = (file: File, content: string) => {
    file.content = content; file.stat.mtime++; file.stat.size = content.length;
    catalog.invalidate(file.path);
  };
  return { files, catalog, add, change, persisted, reads,
    onRead: (handler?: (file: File) => Promise<void>) => { beforeRead = handler; },
    failList: () => { failList = true; }
  };
}

test("identity reads cover notes, trees, Excalidraw, binary short/legacy IDs without modifying content", () => {
  assert.equal(readResourceIdentity("one.md", markdown("n"))?.resourceId, "n");
  assert.equal(readResourceIdentity("one.mtn.md", "---\ndocumentId: tree\n---\ncompressed data ignored")?.resourceId, "tree");
  assert.equal(readResourceIdentity("one.mtn.md", "---\nschemaVersion: 2\n---\n...")?.resourceId, undefined);
  assert.equal(readResourceIdentity("drawing.md", markdown("d").replace("---\nBody", "excalidraw-plugin: parsed\n---\nBody"))?.fileSubtype, "excalidraw");
  for (const path of ["one@Ab123.png", "one%Ab123.pdf"]) assert.equal(readResourceIdentity(path)?.resourceId, "Ab123");
  assert.equal(readResourceIdentity("one~mtn-nm3mqkjrym.canvas")?.resourceId, "nm3mqkjrym");
  assert.equal(readResourceIdentity("plain.pdf"), undefined);
  assert.throws(() => readResourceIdentity("bad.md", "---\nmind-tree-nature: [\n---\n"));
});

test("persisted cache hints never resolve files until current bytes have been verified", async () => {
  const f = fixture([{ resourceId: "claimed", path: "one.md", fileKind: "note" }]);
  f.add("one.md", markdown("actual"));
  assert.equal(f.catalog.resolve(reference("claimed", "one.md")), undefined);
  await f.catalog.rebuild();
  assert.equal(f.catalog.resolve(reference("claimed", "one.md")), undefined);
  assert.equal(f.catalog.resolve(reference("actual"))?.path, "one.md");
});

test("duplicate IDs keep every candidate, allow exact read-only hints and never fall back to a historical owner", async () => {
  const f = fixture([{ resourceId: "same", path: "a.md", fileKind: "note" }]);
  f.add("a.md", markdown("same")); f.add("b.md", markdown("same"));
  const report = await f.catalog.rebuild();
  assert.deepEqual(report.conflicts, [{ resourceId: "same", paths: ["a.md", "b.md"] }]);
  assert.equal(f.catalog.resolve(reference("same")), undefined);
  assert.equal(f.catalog.resolve(reference("same", "a.md"))?.path, "a.md");
  assert.equal((await f.catalog.resolveVerified(reference("same", "b.md")))?.path, "b.md");
  assert.equal(f.persisted.at(-1)?.length, 2);
  assert.equal(f.files.get("a.md")?.content, markdown("same"));
  assert.equal(f.files.get("b.md")?.content, markdown("same"));
});

test("binary duplicate IDs receive exactly the same duplicate protection", async () => {
  const f = fixture(); f.add("a@Ab123.pdf"); f.add("b%Ab123.png");
  const report = await f.catalog.rebuild();
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0]?.resourceId, "Ab123");
  assert.equal(f.reads.length, 0, "binary bytes must never be read for indexing");
  assert.equal(f.catalog.resolve(reference("Ab123")), undefined);
});

test("a replacement at an old hint cannot inherit the cached identity", async () => {
  const f = fixture(); const a = f.add("a.md", markdown("original"));
  await f.catalog.rebuild();
  f.change(a, markdown("replacement"));
  assert.equal(f.catalog.resolve(reference("original", "a.md")), undefined);
  assert.equal(await f.catalog.resolveVerified(reference("original", "a.md")), undefined);
  const moved = f.add("new/a.md", markdown("original"));
  assert.equal(await f.catalog.resolveVerified(reference("original", "a.md")), moved);
});

test("explicit reads notice identity changes even if file stats/metadata cache lag", async () => {
  const f = fixture(); const file = f.add("a.md", markdown("old"));
  await f.catalog.rebuild();
  file.content = markdown("new"); // Simulate sync bytes arriving before metadata and notifications.
  assert.equal(await f.catalog.resolveVerified(reference("old", "a.md")), undefined);
  assert.equal(await f.catalog.resolveVerified(reference("new", "a.md")), file);
});

test("partial failures exclude old mappings and prevent guessing unique IDs", async () => {
  const f = fixture(); const bad = f.add("bad.md", markdown("same"));
  f.add("good.md", markdown("same")); await f.catalog.rebuild();
  f.onRead(async (file) => { if (file === bad) throw new Error("read failed"); });
  const report = await f.catalog.rebuild();
  assert.deepEqual(report.failures.map((item) => item.path), ["bad.md"]);
  assert.equal(f.catalog.resolve(reference("same")), undefined);
  assert.equal(f.catalog.resolve(reference("same", "good.md"))?.path, "good.md");
  assert.equal(f.catalog.resolve(reference("same", "bad.md")), undefined);
});

test("rebuild reconciles rename, addition and deletion occurring during the scan", async () => {
  const f = fixture(); const first = f.add("first.md", markdown("first"));
  f.add("deleted.md", markdown("deleted"));
  let changed = false;
  f.onRead(async () => {
    if (changed) return;
    changed = true;
    f.files.delete(first.path); f.catalog.invalidate(first.path);
    first.path = "renamed.md"; f.files.set(first.path, first); f.catalog.invalidate(first.path);
    f.files.delete("deleted.md"); f.catalog.invalidate("deleted.md");
    f.add("added.md", markdown("added"));
  });
  const report = await f.catalog.rebuild();
  assert.equal(report.failures.length, 0);
  assert.deepEqual(f.catalog.entries().map((item) => item.path).sort(), ["added.md", "renamed.md"]);
  assert.equal(f.catalog.resolve(reference("first")), first);
});

test("whole scan failures retain the previous verified runtime index", async () => {
  const f = fixture(); const file = f.add("valid.md", markdown("valid"));
  await f.catalog.rebuild(); f.failList();
  await assert.rejects(f.catalog.rebuild());
  assert.equal(f.catalog.resolve(reference("valid", "valid.md")), file);
});

test("rebuild is single-flight, reports progress and does not repeatedly persist unchanged entries", async () => {
  const f = fixture(); for (let i = 0; i < 80; i++) f.add(`${i}.md`, markdown(`id${i}`));
  const progress: number[] = [];
  const [a, b] = await Promise.all([f.catalog.rebuild(true, (p) => progress.push(p.completed)), f.catalog.rebuild()]);
  assert.equal(a, b); assert.equal(a.indexedFiles, 80);
  assert.equal(progress.at(-1), 80); assert.equal(f.reads.length, 80);
  const writes = f.persisted.length;
  await f.catalog.rebuild(); assert.equal(f.persisted.length, writes);
});

test("refresh after invalidation restores safe unique fallback without needing a manual rebuild", async () => {
  const f = fixture(); const a = f.add("a.md", markdown("a")); await f.catalog.rebuild();
  f.change(a, `${markdown("a")}\nupdated`); await f.catalog.refresh(a);
  assert.equal(f.catalog.resolve(reference("a")), a);
});

test("foreground and duplicate metadata reads share a task and request only one trailing read", async () => {
  const f = fixture(); const file = f.add("new.md", markdown("one"));
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  f.onRead(async () => { if (first) { first = false; entered(); await gate; } });
  const foreground = f.catalog.refresh(file);
  await started;
  const notifications = [f.catalog.refresh(file, true), f.catalog.refresh(file, true), f.catalog.refresh(file)];
  release();
  const results = await Promise.all([foreground, ...notifications]);
  assert.ok(results.every((entry) => entry?.resourceId === "one"));
  assert.equal(f.reads.length, 2, "one active read plus one shared trailing verification");
});

test("a real modification during the read retries current bytes without publishing stale identity", async () => {
  const f = fixture(); const file = f.add("one.md", markdown("old"));
  let changed = false;
  f.onRead(async () => { if (!changed) { changed = true; f.change(file, markdown("new")); } });
  assert.equal((await f.catalog.refresh(file))?.resourceId, "new");
  assert.equal(f.reads.length, 2);
  assert.equal(f.catalog.resolve(reference("old", file.path)), undefined);
  assert.equal(f.catalog.resolve(reference("new", file.path)), file);
});

test("a continuously changing file stops after three reads, while permanent read errors are not retried", async () => {
  const f = fixture(); const file = f.add("one.md", markdown("one"));
  f.onRead(async () => { f.change(file, `${file.content}\n`); });
  await assert.rejects(f.catalog.refresh(file), ResourceVerificationChangedError);
  assert.equal(f.reads.length, 3);
  assert.equal(f.catalog.resolve(reference("one", file.path)), undefined);
  f.reads.length = 0;
  const scan = await f.catalog.rebuild(false);
  assert.equal(f.reads.length, 3, "inventory retries must not multiply the per-path read budget");
  assert.equal(scan.failures.length, 1);
  f.reads.length = 0;
  f.onRead(async () => { throw new Error("permission denied"); });
  await assert.rejects(f.catalog.refresh(file), /permission denied/);
  assert.equal(f.reads.length, 1);
});

test("a replacement file cannot inherit an in-flight read from the previous path owner", async () => {
  const f = fixture(); const original = f.add("one.md", markdown("old"));
  let replacement: File | undefined;
  f.onRead(async (file) => {
    if (file === original && !replacement) replacement = f.add("one.md", markdown("new"));
  });
  await assert.rejects(f.catalog.refresh(original), ResourceVerificationChangedError);
  assert.equal((await f.catalog.refresh(replacement!))?.resourceId, "new");
  assert.equal(f.catalog.resolve(reference("old", "one.md")), undefined);
});

test("metadata revalidation notices changed identity before stat or vault notifications arrive", async () => {
  const f = fixture(); const file = f.add("one.md", markdown("old"));
  await f.catalog.rebuild();
  const previous = f.catalog.generation;
  file.content = markdown("new");
  await f.catalog.refresh(file, true);
  assert.ok(f.catalog.generation > previous, "outstanding uniqueness guards must expire");
  assert.equal(f.catalog.resolve(reference("old", file.path)), undefined);
  assert.equal(f.catalog.resolve(reference("new", file.path)), file);
  const unchanged = f.catalog.generation;
  await f.catalog.refresh(file, true);
  assert.equal(f.catalog.generation, unchanged, "duplicate metadata does not manufacture another revision");
});

test("verified cached scans do not yield timers or reread every vault file", async () => {
  const f = fixture(); for (let i = 0; i < 1000; i++) f.add(`${i}.md`, markdown(`id-${i}`));
  await f.catalog.rebuild(); f.reads.length = 0;
  await f.catalog.rebuild(false);
  assert.equal(f.reads.length, 0);
});

test("a rebuild cannot replace a newer metadata observation with its older same-stat candidate", async () => {
  const f = fixture(); const a = f.add("a.md", markdown("old")); const b = f.add("b.md", markdown("b"));
  await f.catalog.rebuild();
  let changed = false;
  f.onRead(async (file) => {
    if (file === b && !changed) {
      changed = true; a.content = markdown("new");
      await f.catalog.refresh(a, true);
    }
  });
  await f.catalog.rebuild();
  assert.equal(f.catalog.entry(a)?.resourceId, "new");
  assert.equal(f.catalog.resolve(reference("old", a.path)), undefined);
});

test("uniqueness verification waits for pending metadata reads even when file stats have not changed", async () => {
  const f = fixture(); const a = f.add("a.md", markdown("a")); const b = f.add("b.md", markdown("b"));
  await f.catalog.rebuild();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  f.onRead(async (file) => { if (file === b && first) { first = false; entered(); await gate; } });
  b.content = markdown("a");
  const pending = f.catalog.refresh(b, true); await started;
  assert.equal(f.catalog.isFullyVerified(), false);
  let finished = false;
  const scan = f.catalog.rebuild(false).then((result) => { finished = true; return result; });
  await Promise.resolve(); assert.equal(finished, false);
  release(); await pending;
  assert.deepEqual((await scan).conflicts, [{ resourceId: "a", paths: [a.path, b.path] }]);
});
