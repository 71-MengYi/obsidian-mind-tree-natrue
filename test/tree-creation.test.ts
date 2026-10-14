import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Only the host boundary is supplied. The real format parser, serializer and
// domain commands run unchanged, so these tests cover the extraction itself
// rather than a re-implementation of it.
//
// The mock lives at a test-file-specific URL: test files share one process and
// the ESM cache is keyed by URL, so two files reusing a URL would fight over
// which subset of `obsidian` every other file sees.
const mockUrl = "file:///mind-tree-test-host/obsidian-tree-creation.mjs";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "obsidian" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === mockUrl ? { format: "module", shortCircuit: true, source:
      'export const getLanguage = () => "en";\nexport const normalizePath = (value) => value.replaceAll(String.fromCharCode(92), "/");' }
      : next(url, context);
  }
});
const { MindTreeCreationService, createMindTreePathCandidates, sanitizeMindTreeTitle } =
  await import("../src/services/tree-creation");
const { parseMindTreeFile, serializeMindTreeFile } = await import("../src/format/document");
const { addNode } = await import("../src/domain/tree");
const { t } = await import("../src/i18n");
hooks.deregister();

interface StoredFile {
  path: string;
}

function fixture(existing: readonly string[] = [], alwaysPresent = false) {
  const sources = new Map<string, string>();
  for (const path of existing) sources.set(path, "existing");
  const created: string[] = [];
  const appended: Array<{ path: string; titles: string[] }> = [];
  const activated: Array<{ path: string; focus: boolean }> = [];
  const service = new MindTreeCreationService<StoredFile>({
    fileExists: (path) => alwaysPresent || sources.has(path),
    createFile: async (path, source) => {
      created.push(path);
      sources.set(path, source);
      return { file: { path }, document: parseMindTreeFile(source).document };
    },
    appendChildren: async (file, titles) => {
      appended.push({ path: file.path, titles: [...titles] });
      const previous = sources.get(file.path) ?? "";
      const document = parseMindTreeFile(previous).document;
      const ids: string[] = [];
      for (const title of titles) ids.push(addNode(document, document.rootId, title).id);
      sources.set(file.path, serializeMindTreeFile(document, previous));
      return ids;
    },
    activate: async (file, focus) => { activated.push({ path: file.path, focus }); }
  });
  const documentAt = (path: string) => parseMindTreeFile(sources.get(path) ?? "").document;
  return { service, sources, created, appended, activated, documentAt };
}

test("a tree title is sanitised with the shared file-name rules", () => {
  assert.equal(sanitizeMindTreeTitle(`a/b:c*d?e"f<g>h|i`), "a b c d e f g h i");
  assert.equal(sanitizeMindTreeTitle("  A   B \n C  "), "A B C");
  assert.equal(sanitizeMindTreeTitle("///"), "");
  assert.equal(sanitizeMindTreeTitle(""), "");
});

test("path candidates follow the numbered collision sequence", () => {
  const candidates = createMindTreePathCandidates("", "Tree");
  assert.equal(candidates.length, 1000);
  assert.deepEqual(candidates.slice(0, 3), ["Tree.mtn.md", "Tree 2.mtn.md", "Tree 3.mtn.md"]);
  assert.deepEqual(
    createMindTreePathCandidates("Folder/Sub", "Tree", 2),
    ["Folder/Sub/Tree.mtn.md", "Folder/Sub/Tree 2.mtn.md"]
  );
  // A directory that arrives with Windows separators or stray slashes must not
  // produce a doubled or leading separator in the vault path.
  assert.deepEqual(
    createMindTreePathCandidates("\\Folder\\\\Sub\\", "Tree", 2),
    ["Folder/Sub/Tree.mtn.md", "Folder/Sub/Tree 2.mtn.md"]
  );
  // A nonsense limit still yields one usable candidate instead of an empty list.
  assert.deepEqual(createMindTreePathCandidates("", "Tree", 0), ["Tree.mtn.md"]);
});

test("creation takes the first free numbered path and reports the new identity", async () => {
  const { service, created, sources, activated, documentAt } =
    fixture(["Tree.mtn.md", "Tree 2.mtn.md"]);
  const result = await service.create({ title: "Tree" });

  assert.deepEqual(created, ["Tree 3.mtn.md"]);
  assert.equal(result.path, "Tree 3.mtn.md");
  assert.equal(result.documentId, undefined);
  const document = documentAt("Tree 3.mtn.md");
  assert.equal(result.rootId, document.rootId);
  assert.equal(document.title, "Tree");
  assert.deepEqual(result.childIds, []);
  assert.deepEqual(activated, [{ path: "Tree 3.mtn.md", focus: true }]);
  assert.equal(sources.get("Tree.mtn.md"), "existing");
});

test("a blank or fully illegal title keeps the existing prompt wording", async () => {
  const { service, created } = fixture();
  for (const title of ["", "   ", "///", "\\\\:*?"]) {
    await assert.rejects(
      () => service.create({ title }),
      (error: unknown) => {
        assert.equal((error as Error).message, t("tree.invalidName"));
        return true;
      }
    );
  }
  assert.deepEqual(created, []);
});

test("initial children are trimmed, dropped when empty, and appended in order", async () => {
  const { service, appended, documentAt } = fixture();
  const result = await service.create({
    title: "Tree",
    folderPath: "Folder",
    children: [" First ", "", "   ", "Second", "Third"]
  });

  const path = "Folder/Tree.mtn.md";
  assert.deepEqual(appended, [{ path, titles: ["First", "Second", "Third"] }]);
  const document = documentAt(path);
  const root = document.nodes[document.rootId]!;
  assert.equal(root.childIds.length, 3);
  assert.deepEqual(root.childIds.map((id) => document.nodes[id]!.title), ["First", "Second", "Third"]);
  assert.deepEqual(result.childIds, root.childIds);
});

test("children are only appended when there is at least one usable title", async () => {
  const { service, appended } = fixture();
  await service.create({ title: "Empty", children: ["  ", ""] });
  await service.create({ title: "Absent" });
  assert.deepEqual(appended, []);
});

test("an MCP creation may ask for no focus without changing anything else", async () => {
  const { service, activated, created } = fixture();
  await service.create({ title: "Quiet", focus: false });
  await service.create({ title: "Loud", focus: true });
  assert.deepEqual(created, ["Quiet.mtn.md", "Loud.mtn.md"]);
  assert.deepEqual(activated, [
    { path: "Quiet.mtn.md", focus: false },
    { path: "Loud.mtn.md", focus: true }
  ]);
});

test("an exhausted name sequence refuses instead of overwriting an existing tree", async () => {
  const { service, created } = fixture([], true);
  await assert.rejects(
    () => service.create({ title: "Taken" }),
    (error: unknown) => {
      assert.equal((error as Error).message, t("mcp.error.duplicateTitle", { title: "Taken" }));
      return true;
    }
  );
  assert.deepEqual(created, []);
});
