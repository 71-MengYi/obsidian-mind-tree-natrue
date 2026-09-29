import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { parse, stringify } from "yaml";
import type { App, TFile } from "obsidian";
import type { FileResourceRef } from "../src/types";
import { performance } from "node:perf_hooks";

// Supply only the public host boundary. The real resource service, YAML parser,
// template copier, uniqueness checks and asynchronous index run unchanged.
const mockUrl = "file:///mind-tree-test-host/obsidian.mjs";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "obsidian" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === mockUrl ? { format: "module", shortCircuit: true, source:
      'export class App {} export class TFile {} export const getLanguage = () => "en"; export const normalizePath = (s) => s.replaceAll(String.fromCharCode(92), "/");' }
      : next(url, context);
  }
});
const { ResourceIndexService, DuplicateResourceIdError, CreatedNoteAssociationError } = await import("../src/services/resource-index");
hooks.deregister();

type File = TFile & { content: string };
function fixture(hostEvents = false) {
  const files = new Map<string, File>();
  const effects: string[] = [];
  let onRead: ((file: File) => Promise<void>) | undefined;
  const counts = { lists: 0, reads: 0 };
  const events = new Set<Promise<unknown>>();
  const eventErrors: unknown[] = [];
  const emit = (file: File, kind: "file" | "metadata") => {
    if (!hostEvents) return;
    const task = service.indexFile(file, kind).catch((error: unknown) => { eventErrors.push(error); })
      .finally(() => { events.delete(task); });
    events.add(task);
  };
  const make = (path: string, content = ""): File => {
    const value = { path, content, stat: { ctime: 1, mtime: 1, size: content.length },
      get name(): string { return value.path.split("/").at(-1)!; },
      get parent(): { path: string; isRoot(): boolean } { const parent = value.path.split("/").slice(0, -1).join("/"); return { path: parent, isRoot: () => !parent }; }
    } as unknown as File;
    files.set(path, value); return value;
  };
  const touch = (file: File) => { file.stat.mtime++; file.stat.size = file.content.length; };
  const app = {
    vault: {
      getFiles: () => { counts.lists++; return [...files.values()]; }, getFileByPath: (path: string) => files.get(path) ?? null,
      getAbstractFileByPath: (path: string) => files.get(path),
      read: async (file: File) => { counts.reads++; await onRead?.(file); return file.content; },
      create: async (path: string, content: string) => {
        effects.push(`create:${path}`); const file = make(path, content);
        emit(file, "file"); queueMicrotask(() => emit(file, "metadata")); return file;
      },
      createFolder: async () => undefined,
      copy: async (source: File, path: string) => { effects.push(`copy:${path}`); return make(path, source.content); }
    },
    fileManager: {
      processFrontMatter: async (file: File, update: (value: Record<string, unknown>) => void) => {
        effects.push(`identity:${file.path}`);
        const match = /^---\n([\s\S]*?)\n---\n?/.exec(file.content);
        const values = match ? parse(match[1]!) as Record<string, unknown> : {};
        update(values);
        file.content = `---\n${stringify(values)}---\n${match ? file.content.slice(match[0].length) : file.content}`;
        touch(file);
        emit(file, "file"); queueMicrotask(() => emit(file, "metadata"));
      },
      renameFile: async (file: File, path: string) => {
        effects.push(`rename:${file.path}->${path}`);
        files.delete(file.path); file.path = path; touch(file); files.set(path, file);
      },
      trashFile: async (file: File) => { effects.push(`trash:${file.path}`); files.delete(file.path); }
    }
  } as unknown as App;
  const cache: unknown[] = [];
  const service = new ResourceIndexService(app, [], (entries) => { cache.push(entries); });
  return { app, files, effects, make, touch, service, cache, counts, eventErrors, emit,
    settle: async () => { while (events.size) await Promise.all(events); },
    onRead: (handler?: (file: File) => Promise<void>) => { onRead = handler; } };
}
const md = (id: string) => `---\nmind-tree-nature:\n  resourceId: ${id}\n---\nbody`;
const ref = (id: string, path: string): FileResourceRef => ({ type: "file", resourceId: id, pathHint: path, fileKind: "note" });

test("real service blocks duplicate linking and every mutation across Markdown, trees and binary files", async () => {
  for (const [first, second, content, id] of [
    ["a.md", "b.md", md("same"), "same"],
    ["a.mtn.md", "b.mtn.md", "---\ndocumentId: same\nschemaVersion: 2\n---\npayload", "same"],
    ["a@Ab123.pdf", "b%Ab123.pdf", "binary", "Ab123"]
  ]) {
    const f = fixture(); const a = f.make(first!, content!); f.make(second!, content!);
    const report = await f.service.rebuild(); assert.equal(report.conflicts.length, 1);
    await assert.rejects(f.service.ensureStableReference(a), DuplicateResourceIdError);
    await assert.rejects(f.service.renameLinkedFile(ref(id!, first!), "new"), DuplicateResourceIdError);
    await assert.rejects(f.service.moveLinkedFile(ref(id!, first!), "folder"), DuplicateResourceIdError);
    await assert.rejects(f.service.trashLinkedFile(ref(id!, first!)), DuplicateResourceIdError);
    assert.equal(await f.service.resolveVerified(ref(id!, first!)), a);
    assert.equal(await f.service.resolveVerified(ref(id!, "unknown.md")), undefined);
    assert.deepEqual(f.effects, []);
    assert.equal(a.content, content);
  }
});

test("rebuild never assigns missing identities or touches document content", async () => {
  const f = fixture();
  f.make("ordinary.md", "plain note"); f.make("tree.mtn.md", "---\nschemaVersion: 2\n---\npayload"); f.make("image.png", "binary");
  const report = await f.service.rebuild();
  assert.equal(report.indexedFiles, 0); assert.deepEqual(f.effects, []);
});

test("identity restoration scans actual owners and its guard detects a later index change", async () => {
  const f = fixture();
  f.make("tree.mtn.md", "---\nschemaVersion: 2\n---\npayload");
  const guard = await f.service.prepareIdentityRestore("original", "tree.mtn.md");
  guard();
  const other = f.make("other.mtn.md", "---\ndocumentId: original\n---\npayload");
  await f.service.indexFile(other);
  assert.throws(guard);
  await assert.rejects(f.service.prepareIdentityRestore("original", "tree.mtn.md"), (error: unknown) => {
    assert.ok(error instanceof DuplicateResourceIdError);
    assert.deepEqual(error.paths, ["other.mtn.md"]);
    return true;
  });
  assert.deepEqual(f.effects, []);
});

test("an unreadable candidate blocks restoration rather than treating the index as authoritative", async () => {
  const f = fixture();
  f.make("tree.mtn.md", "---\nschemaVersion: 2\n---\npayload");
  const unreadable = f.make("offline.md", "");
  f.onRead(async (file) => { if (file === unreadable) throw new Error("sync unavailable"); });
  await assert.rejects(f.service.prepareIdentityRestore("original", "tree.mtn.md"));
  assert.deepEqual(f.effects, []);
});

test("concurrent first associations share one identity for every file type", async () => {
  for (const path of ["ordinary.md", "tree.mtn.md", "image.png"]) {
    const f = fixture(); const file = f.make(path, path.endsWith(".mtn.md") ? "---\nschemaVersion: 2\n---\npayload" : "body");
    const references = await Promise.all([f.service.ensureStableReference(file), f.service.ensureStableReference(file)]);
    assert.equal(references[0]!.resourceId, references[1]!.resourceId);
    assert.equal(f.effects.length, 1);
    assert.equal(await f.service.resolveVerified(references[0]!), file);
  }
});

test("unique linked resources rename, move and trash only after actual-identity validation", async () => {
  const f = fixture(); const file = f.make("old.md", md("stable")); await f.service.rebuild();
  const reference = ref("stable", "old.md");
  assert.equal(await f.service.renameLinkedFile(reference, "new"), file);
  assert.equal(file.path, "new.md");
  assert.equal(await f.service.moveLinkedFile(reference, "folder"), file);
  assert.equal(file.path, "folder/new.md");
  assert.equal(await f.service.trashLinkedFile(reference), file);
  assert.equal(f.files.size, 0);
});

test("old cached identity is never used to rename or delete a replacement file", async () => {
  const f = fixture(); const file = f.make("same.md", md("old")); await f.service.rebuild();
  file.content = md("new"); // Force direct read to detect it even before host metadata events.
  await assert.rejects(f.service.renameLinkedFile(ref("old", file.path), "wrong"));
  await assert.rejects(f.service.trashLinkedFile(ref("old", file.path)));
  assert.deepEqual(f.effects, []);
});

test("a duplicate arriving during final verification prevents the pending file mutation", async () => {
  const f = fixture(); const file = f.make("first.md", md("same")); await f.service.rebuild();
  let arrived = false;
  f.onRead(async (reading) => {
    if (reading !== file || arrived) return;
    arrived = true;
    const duplicate = f.make("synced-copy.md", md("same"));
    await f.service.indexFile(duplicate);
  });
  await assert.rejects(f.service.renameLinkedFile(ref("same", "first.md"), "wrong"), DuplicateResourceIdError);
  assert.deepEqual(f.effects, []);
});

test("template copies still allocate new independent identities without modifying sources", async () => {
  for (const [path, content] of [["templates/source.md", md("source")],
    ["templates/source.mtn.md", "---\nschemaVersion: 2\ndocumentId: source\n---\nopaque payload"],
    ["templates/source@Ab123.png", "binary-data"]]) {
    const f = fixture(); const source = f.make(path!, content!); await f.service.rebuild();
    const a = await f.service.createFileFromTemplate("", "copy", source, () => true);
    const b = await f.service.createFileFromTemplate("", "copy", source, () => true);
    assert.notEqual(a.reference.resourceId, b.reference.resourceId);
    assert.equal(source.content, content);
    assert.notEqual(a.file, source); assert.notEqual(a.file.path, b.file.path);
    assert.equal(await f.service.resolveVerified(a.reference), a.file);
  }
});

test("non-Markdown identity arriving during a scan is adopted, never replaced", async () => {
  const f = fixture(); const image = f.make("image.png"); f.make("scan.md", "text");
  let once = false;
  f.onRead(async () => {
    if (once) return; once = true;
    f.files.delete(image.path); image.path = "image@Ab123.png"; f.files.set(image.path, image); f.touch(image);
  });
  const linked = await f.service.ensureStableReference(image);
  assert.equal(linked.resourceId, "Ab123"); assert.deepEqual(f.effects, []);
});

test("new notes survive real create/modify/metadata notification interleavings and associate once", async () => {
  const f = fixture(true); f.make("other.md", md("existing")); await f.service.rebuild();
  let signalled = false;
  f.onRead(async (file) => {
    if (file.path === "new.md" && !signalled) {
      signalled = true; f.emit(file, "metadata"); f.emit(file, "metadata");
    }
  });
  const created = await f.service.createNote("", "new", "body");
  await f.settle();
  assert.equal(await f.service.resolveVerified(created.reference), created.file);
  assert.equal(f.effects.filter((value) => value.startsWith("create:")).length, 1);
  assert.equal(f.effects.filter((value) => value.startsWith("identity:")).length, 1);
  assert.deepEqual(f.eventErrors, []);
});

test("post-create verification failures retain the file and carry its path to the UI", async () => {
  const f = fixture();
  f.onRead(async (file) => { if (file.path === "new.md") throw new Error("disk read failed"); });
  await assert.rejects(f.service.createNote("", "new", "initial body"), (error: unknown) => {
    assert.ok(error instanceof CreatedNoteAssociationError);
    assert.equal(error.file.path, "new.md");
    assert.equal(error.file, f.files.get("new.md"));
    return true;
  });
  assert.equal(f.files.get("new.md")?.content, "initial body");
  assert.deepEqual(f.effects, ["create:new.md"]);
});

test("an ID changed after allocation stops association without assigning a second ID", async () => {
  const f = fixture(); let replaced = false;
  f.onRead(async (file) => {
    if (!replaced && f.effects.some((value) => value === "identity:new.md")) {
      replaced = true; file.content = md("external-replacement"); f.touch(file);
    }
  });
  await assert.rejects(f.service.createNote("", "new", "body"), CreatedNoteAssociationError);
  assert.equal(f.files.get("new.md")?.content, md("external-replacement"));
  assert.equal(f.effects.filter((value) => value.startsWith("identity:")).length, 1);
  assert.equal(f.effects.filter((value) => value.startsWith("create:")).length, 1);
});

test("batch association preserves order, de-duplicates input and reports duplicate-ID failures", async () => {
  const f = fixture(); const a = f.make("a.md", md("same")); f.make("duplicate.md", md("same"));
  const b = f.make("b.md", "body"); const c = f.make("c@Ab123.pdf", "binary");
  const progress: number[] = [];
  const batch = await f.service.ensureStableReferences([a, b, c, b], (state) => { progress.push(state.completed); });
  batch.assertCurrent();
  assert.deepEqual(batch.linked.map((item) => item.file.path), ["b.md", "c@Ab123.pdf"]);
  assert.deepEqual(batch.failures.map((item) => item.path), ["a.md"]);
  assert.ok(batch.failures[0]?.error instanceof DuplicateResourceIdError);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 3);
  assert.equal(a.content, md("same"));
});

test("a duplicate introduced at batch completion is rejected by the final inventory check", async () => {
  const f = fixture(); const a = f.make("a.md", md("stable")); const b = f.make("b.md", md("other"));
  const result = await f.service.ensureStableReferences([a, b], (state) => {
    if (state.phase === "finish") f.make("synced.md", md("stable"));
  });
  assert.deepEqual(result.linked.map((item) => item.file.path), ["b.md"]);
  assert.ok(result.failures[0]?.error instanceof DuplicateResourceIdError);
  assert.deepEqual(f.effects, []);
  result.assertCurrent();
});

test("cancelled collection stops before touching further files and never returns a partial insertion", async () => {
  const f = fixture(); const a = f.make("a.md", "body"); const b = f.make("b.md", "body");
  let current = true;
  const batch = await f.service.ensureStableReferences([a, b], (state) => {
    if (state.completed === 1) current = false;
  }, () => current);
  assert.equal(batch.cancelled, true); assert.deepEqual(batch.linked, []);
  assert.deepEqual(f.effects, ["identity:a.md"]);
  assert.equal(b.content, "body");
});

test("batch guards reject replacement identities after preparation, including lagging stat data", async () => {
  const f = fixture(); const a = f.make("a.md", md("before"));
  const batch = await f.service.ensureStableReferences([a]);
  batch.assertCurrent();
  a.content = md("after");
  await f.service.indexFile(a, "metadata");
  assert.throws(() => batch.assertCurrent());
  assert.deepEqual(f.effects, []);
});

test("collecting 30 files in a verified 1,000-file vault uses batch-wide scans rather than per-file scans", async (t) => {
  const f = fixture(); for (let i = 0; i < 1000; i++) f.make(`existing-${i}.md`, md(`id-${i}`));
  await f.service.rebuild(); f.counts.lists = 0; f.counts.reads = 0;
  const selected = Array.from({ length: 30 }, (_,i) => f.make(`new-${i}.md`, "body"));
  const started = performance.now();
  const batch = await f.service.ensureStableReferences(selected);
  batch.assertCurrent();
  const elapsed = performance.now() - started;
  assert.equal(batch.linked.length, 30); assert.deepEqual(batch.failures, []);
  assert.ok(f.counts.lists <= 10, `expected only boundary inventories, got ${f.counts.lists}`);
  assert.ok(f.counts.reads <= 125, `unchanged existing files were reread: ${f.counts.reads}`);
  assert.equal(f.effects.filter((value) => value.startsWith("identity:")).length, 30);
  t.diagnostic(`1,000 existing + 30 new: ${elapsed.toFixed(1)} ms, ${f.counts.lists} inventories, ${f.counts.reads} reads`);
});
