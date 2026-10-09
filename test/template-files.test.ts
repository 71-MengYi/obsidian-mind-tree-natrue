import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { addNode, cloneDocument, createEmptyDocument, getNode } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { markSettingsEdited } from "../src/document-settings-state";
import { extractNonMarkdownResourceId, linkedFileTitle } from "../src/format/resource-id";
import {
  filesInTemplateFolder, templateFileExtension, TemplateFileService,
  TemplateCopyRollbackError, TemplateTargetChangedError, type TemplateFilePorts
} from "../src/services/template-files";
import { isAssociationTargetAvailable } from "../src/ui/association-target";
import type { FileResourceRef } from "../src/types";

interface FakeFile { path: string; bytes: Uint8Array }

function markdownParts(file: FakeFile): { properties: Record<string, unknown>; body: string } {
  const text = new TextDecoder().decode(file.bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return { properties: match ? parseYaml(match[1]!) as Record<string, unknown> : {}, body: match ? text.slice(match[0].length) : text };
}

/** Only this fake Frontmatter port reads text; the production service treats files as opaque. */
function fixture() {
  const files = new Map<string, FakeFile>();
  const references = new Map<string, FileResourceRef>();
  const copies: FakeFile[] = [];
  const trashed: FakeFile[] = [];
  const frontmatterWrites: FakeFile[] = [];
  const folders: string[] = [];
  let serial = 0;
  const add = (path: string, contents: string | Uint8Array = "template content"): FakeFile => {
    const file = { path, bytes: typeof contents === "string" ? new TextEncoder().encode(contents) : contents.slice() };
    files.set(path, file);
    return file;
  };
  const ports: TemplateFilePorts<FakeFile> = {
    exists: (path) => files.has(path),
    isCurrentFile: (file) => files.get(file.path) === file,
    ensureFolder: async (path) => { folders.push(path); },
    copy: async (source, destination) => {
      assert.equal(files.has(destination), false, "copy must never overwrite an existing file");
      const file = add(destination, source.bytes);
      copies.push(file);
      return file;
    },
    processFrontMatter: async (file, update) => {
      assert.match(file.path, /\.md$/i, "binary copies must never pass through text/Frontmatter processing");
      frontmatterWrites.push(file);
      const { properties, body } = markdownParts(file);
      update(properties);
      file.bytes = new TextEncoder().encode(`---\n${stringifyYaml(properties)}---\n${body}`);
    },
    createResourceId: (markdown) => markdown
      ? `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`
      : `A${String(++serial).padStart(4, "0")}`,
    resourceIdExists: (id) => references.has(id),
    register: (reference) => { references.set(reference.resourceId, reference); },
    trash: async (file) => {
      assert.equal(files.get(file.path), file);
      files.delete(file.path);
      trashed.push(file);
    },
    removePath: (_path, id) => { references.delete(id); }
  };
  const service = new TemplateFileService(ports);
  return { add, files, references, copies, trashed, frontmatterWrites, folders, ports, service };
}

test("template selection recursively lists all formats within the configured directory only", () => {
  const paths = ["Templates/Z.md", "Templates/deep/Map.mtn.md", "Templates/deep/Sketch.excalidraw.md",
    "Templates/A.png", "Templates/A.pdf", "Templates/A.zip", "Templates/A.canvas", "Templates/README",
    "Templates-extra/Wrong.md", "Other/Templates/Wrong.md"];
  const files = paths.map((path) => ({ path }));
  assert.deepEqual(filesInTemplateFolder(files, "Templates").map((file) => file.path),
    paths.filter((path) => path.startsWith("Templates/")).sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(filesInTemplateFolder(files, ""), []);
  assert.deepEqual(filesInTemplateFolder(files, "Missing"), []);
  assert.deepEqual(files.map((file) => file.path), paths, "sorting must not mutate the Vault list");
});

test("template names retain only the final extension except for .mtn.md", () => {
  for (const [source, extension] of [
    ["A.md", ".md"], ["A.excalidraw.md", ".md"], ["A.mtn.md", ".mtn.md"],
    ["A.MTN.MD", ".MTN.MD"], ["archive.tar.gz", ".gz"], ["A.PDF", ".PDF"],
    ["README", ""], [".hidden", ""], ["nested.folder/README", ""]
  ]) assert.equal(templateFileExtension(source!), extension);
});

test("binary template copies preserve bytes and use fresh short identities and actual file kinds", async () => {
  const formats = ["png", "jpg", "gif", "webp", "avif", "bmp", "svg", "pdf", "zip", "canvas", "tar.gz", "excalidraw", ""];
  for (const extension of formats) {
    for (const separator of ["@", "%"] as const) {
      const f = fixture();
      const bytes = new Uint8Array([0, 255, 254, 128, 1, 13, 10, 42]);
      const source = f.add(`Templates/Original${extension ? `.${extension}` : ""}`, bytes);
      const result = await f.service.create(source, "Maps", "新文件", separator, () => true);
      const finalExtension = extension ? `.${extension.split(".").at(-1)}` : "";
      assert.equal(result.file.path, `Maps/新文件${separator}${result.reference.resourceId}${finalExtension}`);
      assert.match(result.reference.resourceId, /^[A-Za-z0-9]{5}$/);
      assert.equal(extractNonMarkdownResourceId(result.file.path), result.reference.resourceId);
      assert.equal(result.reference.fileKind, /^(png|jpg|gif|webp|avif|bmp|svg)$/.test(extension) ? "image" : "attachment");
      assert.equal(result.reference.fileSubtype, undefined);
      assert.equal(result.reference.pathHint, result.file.path);
      assert.equal(linkedFileTitle(result.file.path), "新文件");
      assert.deepEqual(result.file.bytes, bytes);
      assert.deepEqual(source.bytes, bytes);
      assert.notEqual(result.file, source);
      assert.deepEqual(f.frontmatterWrites, []);
      assert.deepEqual(f.folders, ["Maps"]);
    }
  }
});

test("Markdown copies replace only their nested resource identity, without filling or expanding content", async () => {
  const f = fixture();
  const source = f.add("Templates/Note.md", "---\ntags: [template]\ncustom: keep\nmind-tree-nature:\n  resourceId: original-id\n  extra: keep\n---\n# {{title}}\n\n  [[Other|link]] [asset](image.png)\ntrailing  \n");
  const original = source.bytes.slice();
  const { file, reference } = await f.service.create(source, "", "副本", "@", () => true);
  assert.equal(file.path, "副本.md");
  assert.equal(reference.fileKind, "note");
  assert.match(reference.resourceId, /^[0-9a-f-]{36}$/);
  const before = markdownParts(source);
  const after = markdownParts(file);
  assert.deepEqual(after.properties, {
    ...before.properties, "mind-tree-nature": { resourceId: reference.resourceId, extra: "keep" }
  });
  assert.equal(after.body, before.body);
  assert.deepEqual(source.bytes, original);
  assert.deepEqual(f.frontmatterWrites, [file]);
  assert.deepEqual(f.folders, []);
});

test("Markdown with no Frontmatter receives identity without introducing a heading or default body", async () => {
  const f = fixture();
  const source = f.add("Templates/Note.md", "  {{date}}\n\ntext\n");
  const { file } = await f.service.create(source, "", "A", "@", () => true);
  assert.equal(markdownParts(file).body, "  {{date}}\n\ntext\n");
  assert.equal(markdownParts(source).body, markdownParts(file).body);
});

test("Excalidraw templates retain raw/parsed recognition properties even after ordinary .md naming", async () => {
  for (const mode of ["raw", "parsed"]) {
    const f = fixture();
    const source = f.add("Templates/Drawing.excalidraw.md", `---\nexcalidraw-plugin: ${mode}\n---\nopaque drawing data`);
    const { file, reference } = await f.service.create(source, "Maps", "Drawing", "@", () => true);
    assert.equal(file.path, "Maps/Drawing.md");
    assert.equal(reference.fileKind, "note");
    assert.equal(reference.fileSubtype, "excalidraw");
    assert.equal(markdownParts(file).properties["excalidraw-plugin"], mode);
    assert.equal(markdownParts(file).body, markdownParts(source).body);
  }
});

test("mind-tree copies replace only documentId and preserve compressed data, settings and every internal reference", async () => {
  const f = fixture();
  const document = createEmptyDocument("Template");
  document.documentId = "00000000-0000-4000-8000-999999999999";
  document.settings.theme = "flat";
  // Only an explicit per-tree choice is written into the template's Frontmatter.
  markSettingsEdited(document, ["theme"]);
  const child = addNode(document, document.rootId, "Existing link");
  child.resource = { type: "file", resourceId: "existing-resource", pathHint: "Files/original.pdf", fileKind: "attachment" };
  const source = f.add("Templates/Tree.mtn.md", serializeMindTreeFile(document));
  const original = source.bytes.slice();
  const results = await Promise.all([1, 2].map(() => f.service.create(source, "Trees", "副本", "@", () => true)));
  assert.deepEqual(results.map((result) => result.file.path), ["Trees/副本.mtn.md", "Trees/副本 2.mtn.md"]);
  const ids = new Set([document.documentId, ...results.map((result) => result.reference.resourceId)]);
  assert.equal(ids.size, 3);
  for (const result of results) {
    const before = markdownParts(source);
    const after = markdownParts(result.file);
    assert.equal(after.body, before.body, "the entire non-Frontmatter region must remain byte-for-byte identical");
    assert.deepEqual(after.properties, { ...before.properties, documentId: result.reference.resourceId });
    const parsed = parseMindTreeFile(new TextDecoder().decode(result.file.bytes)).document;
    assert.equal(parsed.documentId, result.reference.resourceId);
    assert.deepEqual(parsed.nodes[child.id]?.resource, child.resource);
    assert.deepEqual(parsed.settings, document.settings);
    assert.equal(result.reference.fileKind, "note");
  }
  assert.deepEqual(source.bytes, original);
});

test("mind-tree copies without an original documentId get independent IDs without touching machine data", async () => {
  const f = fixture();
  const source = f.add("Templates/Tree.mtn.md", serializeMindTreeFile(createEmptyDocument("Unlinked")));
  const { file, reference } = await f.service.create(source, "", "Copy", "@", () => true);
  assert.equal(markdownParts(source).properties["documentId"], undefined);
  assert.equal(markdownParts(file).properties["documentId"], reference.resourceId);
  assert.equal(markdownParts(file).body, markdownParts(source).body);
});

test("new and legacy template filename IDs are never inherited, including repeated copies", async () => {
  const f = fixture();
  for (const path of ["Templates/A@Ab123.png", "Templates/A%zZ123.pdf", "Templates/A~mtn-0123456789.canvas"]) {
    const source = f.add(path);
    const first = await f.service.create(source, "", "Copy", "%", () => true);
    const second = await f.service.create(source, "", "Copy", "%", () => true);
    for (const copy of [first, second]) {
      assert.notEqual(copy.reference.resourceId, extractNonMarkdownResourceId(source.path));
      assert.equal(extractNonMarkdownResourceId(copy.file.path), copy.reference.resourceId);
      assert.equal(linkedFileTitle(copy.file.path), "Copy");
    }
    assert.notEqual(first.reference.resourceId, second.reference.resourceId);
    assert.equal(source.path, path);
  }
});

test("existing files and concurrent copies have unique names and reserved identities", async () => {
  const f = fixture();
  const source = f.add("Templates/Note.md");
  const existing = f.add("Notes/Topic.md", "must stay");
  const results = await Promise.all([1, 2, 3].map(() => f.service.create(source, "Notes", "Topic", "@", () => true)));
  assert.deepEqual(results.map((result) => result.file.path), ["Notes/Topic 2.md", "Notes/Topic 3.md", "Notes/Topic 4.md"]);
  assert.equal(new Set(results.map((result) => result.reference.resourceId)).size, 3);
  assert.equal(new TextDecoder().decode(existing.bytes), "must stay");
  const png = f.add("Templates/A.png");
  f.add("Notes/Photo@A0099.png", "collision");
  f.ports.createResourceId = () => "A0099";
  const copy = await f.service.create(png, "Notes", "Photo", "@", () => true);
  assert.equal(copy.file.path, "Notes/Photo 2@A0099.png");
});

test("generated identities already in the index or reserved by another copy are retried", async () => {
  const f = fixture();
  f.references.set("A0001", { type: "file", fileKind: "image", resourceId: "A0001", pathHint: "Existing.png" });
  const ids = ["A0001", "A0002", "A0002", "A0003"];
  f.ports.createResourceId = () => ids.shift()!;
  const source = f.add("Templates/A.png");
  const copies = await Promise.all([1, 2].map(() => f.service.create(source, "Images", "A", "@", () => true)));
  assert.deepEqual(copies.map((result) => result.reference.resourceId), ["A0002", "A0003"]);
  assert.equal(f.references.get("A0001")?.pathHint, "Existing.png");
});

test("copy reservations suppress transient inherited-identity indexing and release after completion", async () => {
  const f = fixture();
  const originalCopy = f.ports.copy;
  f.ports.copy = async (source, path) => {
    assert.equal(f.service.isPendingPath(path), true);
    return originalCopy(source, path);
  };
  const originalMetadata = f.ports.processFrontMatter;
  f.ports.processFrontMatter = async (file, update) => {
    assert.equal(f.service.isPendingPath(file.path), true);
    return originalMetadata(file, update);
  };
  const result = await f.service.create(f.add("Templates/A.md"), "", "A", "@", () => true);
  assert.equal(f.service.isPendingPath(result.file.path), false);
});

test("target guards reject changed sessions, missing nodes, or already-associated nodes", () => {
  const document = createEmptyDocument("Target");
  const target = { documentSessionToken: "session-a", nodeId: document.rootId };
  assert.equal(isAssociationTargetAvailable(target, "session-a", document), true);
  assert.equal(isAssociationTargetAvailable(target, "session-b", cloneDocument(document)), false);
  assert.equal(isAssociationTargetAvailable(target, "session-a", undefined), false);
  const node = getNode(document, target.nodeId);
  node.resource = { type: "url", url: "https://example.com" };
  assert.equal(isAssociationTargetAvailable(target, "session-a", document), false);
  node.resource = { type: "file", resourceId: "id", pathHint: "A.md", fileKind: "note" };
  assert.equal(isAssociationTargetAvailable(target, "session-a", document), false);
  delete document.nodes[target.nodeId];
  assert.equal(isAssociationTargetAvailable(target, "session-a", document), false);
});

test("target invalidation before copying, during copy or during identity write safely aborts", async () => {
  for (const stage of ["before", "copy", "identity"]) {
    const f = fixture();
    const source = f.add("Templates/A.md");
    const existing = f.add("Other.md");
    let valid = stage !== "before";
    const originalCopy = f.ports.copy;
    f.ports.copy = async (file, path) => {
      const copy = await originalCopy(file, path);
      if (stage === "copy") valid = false;
      return copy;
    };
    const originalMetadata = f.ports.processFrontMatter;
    f.ports.processFrontMatter = async (file, update) => {
      await originalMetadata(file, update);
      if (stage === "identity") valid = false;
    };
    await assert.rejects(f.service.create(source, "", "New", "@", () => valid), TemplateTargetChangedError);
    assert.equal(f.copies.length, stage === "before" ? 0 : 1);
    assert.deepEqual(f.trashed, f.copies);
    assert.deepEqual([...f.files.values()], [source, existing]);
    assert.equal(f.references.size, 0);
    assert.equal(f.service.isPendingPath("New.md"), false);
  }
});

test("folder/copy/identity/registration failures only roll back newly owned copies", async () => {
  for (const stage of ["folder", "copy", "identity", "registration"]) {
    const f = fixture();
    const source = f.add("Templates/A.md");
    const original = source.bytes.slice();
    const failure = new Error(stage);
    if (stage === "folder") f.ports.ensureFolder = async () => { throw failure; };
    if (stage === "copy") f.ports.copy = async () => { throw failure; };
    if (stage === "identity") f.ports.processFrontMatter = async () => { throw failure; };
    if (stage === "registration") f.ports.register = (ref) => { f.references.set(ref.resourceId, ref); throw failure; };
    await assert.rejects(f.service.create(source, "Copies", "New", "@", () => true), (error) => error === failure);
    assert.deepEqual(f.trashed, f.copies);
    assert.deepEqual([...f.files.values()], [source]);
    assert.deepEqual(source.bytes, original);
    assert.equal(f.references.size, 0);
    assert.equal(f.service.isPendingPath("Copies/New.md"), false);
  }
});

test("a missing template or a source returned as a copy is never deleted", async () => {
  const f = fixture();
  const source = f.add("Templates/A.md");
  f.files.delete(source.path);
  await assert.rejects(f.service.create(source, "", "New", "@", () => true), /no longer available/);
  f.files.set(source.path, source);
  f.ports.copy = async () => source;
  await assert.rejects(f.service.create(source, "", "New", "@", () => true), /independent/);
  assert.equal(f.files.get(source.path), source);
  assert.deepEqual(f.trashed, []);
});

test("a file renamed to another type during copy is rolled back without editing its contents", async () => {
  const f = fixture();
  const source = f.add("Templates/A.md");
  const originalCopy = f.ports.copy;
  f.ports.copy = async (file, path) => {
    const copied = await originalCopy(file, path);
    f.files.delete(path);
    copied.path = "New.png";
    f.files.set(copied.path, copied);
    return copied;
  };
  await assert.rejects(f.service.create(source, "", "New", "@", () => true), /type or identity changed/);
  assert.deepEqual(f.frontmatterWrites, []);
  assert.deepEqual(f.trashed, f.copies);
  assert.equal(f.files.get(source.path), source);
});

test("post-copy invalidation removes its index, but accepted copies survive later navigation failures", async () => {
  const f = fixture();
  const source = f.add("Templates/A.md");
  const result = await f.service.create(source, "", "New", "@", () => true);
  await f.service.discard(result.file);
  await f.service.discard(result.file);
  assert.equal(f.references.size, 0);
  assert.equal(f.trashed.length, 1);
  const accepted = await f.service.create(source, "", "New", "@", () => true);
  f.service.accept(accepted.file);
  await f.service.discard(accepted.file);
  await f.service.discard(source);
  assert.equal(f.files.get(accepted.file.path), accepted.file);
  assert.equal(f.references.has(accepted.reference.resourceId), true);
  assert.equal(f.files.get(source.path), source);
  assert.equal(f.trashed.length, 1);
});

test("rollback does not trash a different file that has replaced the copy at the same path", async () => {
  const f = fixture();
  const result = await f.service.create(f.add("Templates/A.md"), "", "New", "@", () => true);
  const replacement = f.add(result.file.path, "unrelated replacement");
  await f.service.discard(result.file);
  assert.equal(f.files.get(result.file.path), replacement);
  assert.deepEqual(f.trashed, []);
});

test("failed trash preserves the new file and reports its full path and original failure", async () => {
  const f = fixture();
  const source = f.add("Templates/A.md");
  const failure = new Error("identity write failed");
  f.ports.processFrontMatter = async () => { throw failure; };
  f.ports.trash = async () => { throw new Error("trash failed"); };
  await assert.rejects(f.service.create(source, "Copies", "New", "@", () => true), (error) => {
    assert.ok(error instanceof TemplateCopyRollbackError);
    assert.equal(error.path, "Copies/New.md");
    assert.equal(error.originalError, failure);
    return true;
  });
  assert.equal(f.files.get(source.path), source);
  assert.ok(f.files.get("Copies/New.md"));
  assert.deepEqual(f.trashed, []);
});
