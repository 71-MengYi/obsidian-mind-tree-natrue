import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { McpToolError } from "../src/services/mcp/tool-error";

// The locator reaches user-facing wording through `t()`, which reads the host
// language. Only that boundary is stubbed; the resolver runs unchanged. The URL
// is unique to this file because test files share one process and the ESM cache
// is keyed by URL.
const mockUrl = "file:///mind-tree-test-host/obsidian-tree-locator.mjs";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "obsidian" ? { url: mockUrl, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === mockUrl ? { format: "module", shortCircuit: true, source:
      'export const getLanguage = () => "en";' } : next(url, context);
  }
});
const { MindTreePathLocator } = await import("../src/services/mcp/tree-locator");
const { t } = await import("../src/i18n");
hooks.deregister();

const treeSource = (documentId?: string, schemaVersion = 2) =>
  `---\n${documentId ? `documentId: ${documentId}\n` : ""}schemaVersion: ${schemaVersion}\n---\n\n- Root\n`;

function fixture(
  files: Record<string, string>,
  options: { indexed?: Record<string, string[]>; active?: string } = {}
) {
  const sources = new Map(Object.entries(files));
  const locator = new MindTreePathLocator({
    indexedTreePaths: (documentId) => options.indexed?.[documentId] ?? [],
    filePaths: () => [...sources.keys()],
    fileExists: (path) => sources.has(path),
    read: async (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error(`missing file: ${path}`);
      return source;
    },
    activeTreePath: () => options.active
  });
  return { locator, sources };
}

async function expectError(run: () => Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof McpToolError, `expected McpToolError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

test("an explicit tree path is normalised and returned without reading anything else", async () => {
  const { locator } = fixture({ "Folder/Tree.mtn.md": treeSource("tree-1") });
  assert.equal(await locator.resolve({ treePath: "Folder/Tree.mtn.md" }), "Folder/Tree.mtn.md");
  assert.equal(await locator.resolve({ treePath: "\\Folder\\Tree.mtn.md" }), "Folder/Tree.mtn.md");
  assert.equal(await locator.resolve({ treePath: "/Folder//Tree.mtn.md" }), "Folder/Tree.mtn.md");
});

test("a path that is missing or not a mind tree fails by name", async () => {
  const { locator } = fixture({ "Notes/plain.md": "# note" });
  const notFound = t("mcp.error.treeNotFound", { target: "Missing.mtn.md" });
  await expectError(() => locator.resolve({ treePath: "Missing.mtn.md" }), "tree-not-found", notFound);
  await expectError(() => locator.resolve({ treePath: "Notes/plain.md" }), "tree-not-found",
    t("mcp.error.treeNotFound", { target: "Notes/plain.md" }));
});

test("a document id resolves through the resource index", async () => {
  const { locator } = fixture(
    { "A/Tree.mtn.md": treeSource("tree-1"), "B/Other.mtn.md": treeSource("tree-2") },
    { indexed: { "tree-1": ["A/Tree.mtn.md"] } }
  );
  assert.equal(await locator.resolve({ documentId: "tree-1" }), "A/Tree.mtn.md");
  assert.equal(await locator.resolve({ documentId: "tree-2" }), "B/Other.mtn.md");
});

test("a document id the index never saw is found by a vault sweep", async () => {
  const { locator } = fixture({ "Deep/Nested/Tree.mtn.md": treeSource("hidden") });
  assert.equal(await locator.resolve({ documentId: "hidden" }), "Deep/Nested/Tree.mtn.md");
});

test("a candidate whose identity is missing or different is never accepted", async () => {
  const { locator } = fixture(
    {
      "A/Tree.mtn.md": treeSource("tree-2"),
      "B/NoIdentity.mtn.md": treeSource(),
      "Notes/plain.md": "# note",
      "B/Tree.mtn.md": treeSource("tree-1")
    },
    { indexed: { "tree-1": ["A/Tree.mtn.md", "B/NoIdentity.mtn.md", "Notes/plain.md", "B/Tree.mtn.md"] } }
  );
  assert.equal(await locator.resolve({ documentId: "tree-1" }), "B/Tree.mtn.md");
});

test("two files with one identity are ambiguous instead of one being picked", async () => {
  const { locator } = fixture(
    { "A/Tree.mtn.md": treeSource("dup"), "B/Copy.mtn.md": treeSource("dup") },
    { indexed: { dup: ["A/Tree.mtn.md", "B/Copy.mtn.md"] } }
  );
  await expectError(() => locator.resolve({ documentId: "dup" }), "tree-ambiguous",
    t("mcp.error.treeAmbiguous", { target: "dup" }));
});

test("an explicit path occupied by another tree contradicts its document id", async () => {
  const { locator } = fixture(
    { "A/Tree.mtn.md": treeSource("tree-1"), "B/Other.mtn.md": treeSource("tree-2") },
    { indexed: { "tree-2": ["B/Other.mtn.md"] } }
  );
  await expectError(
    () => locator.resolve({ treePath: "A/Tree.mtn.md", documentId: "tree-2" }),
    "tree-ambiguous",
    t("mcp.error.treeAmbiguous", { target: "A/Tree.mtn.md" })
  );
});

test("a stale explicit path does not block resolution by document id", async () => {
  const { locator } = fixture(
    { "A/Tree.mtn.md": treeSource("tree-1") },
    { indexed: { "tree-1": ["A/Tree.mtn.md"] } }
  );
  assert.equal(await locator.resolve({ treePath: "Old/Gone.mtn.md", documentId: "tree-1" }), "A/Tree.mtn.md");
});

test("data that cannot be verified never becomes a match", async () => {
  const { locator } = fixture(
    { "A/Broken.mtn.md": "---\nthis is: [not, closed\n" },
    { indexed: { wanted: ["A/Broken.mtn.md"] } }
  );
  await expectError(() => locator.resolve({ documentId: "wanted" }), "tree-ambiguous",
    t("mcp.error.treeAmbiguous", { target: "wanted" }));
});

test("an unverifiable explicit path is refused even when the id is elsewhere", async () => {
  const { locator } = fixture(
    { "A/Broken.mtn.md": "---\nthis is: [not, closed\n", "B/Tree.mtn.md": treeSource("tree-1") },
    { indexed: { "tree-1": ["B/Tree.mtn.md"] } }
  );
  await expectError(
    () => locator.resolve({ treePath: "A/Broken.mtn.md", documentId: "tree-1" }),
    "tree-ambiguous",
    t("mcp.error.treeAmbiguous", { target: "A/Broken.mtn.md" })
  );
});

test("an unknown document id fails by name", async () => {
  const { locator } = fixture({ "A/Tree.mtn.md": treeSource("tree-1") });
  await expectError(() => locator.resolve({ documentId: "nope" }), "tree-not-found",
    t("mcp.error.treeNotFound", { target: "nope" }));
});

test("with no selector the tree the user has open wins", async () => {
  const { locator } = fixture(
    { "A/Tree.mtn.md": treeSource("tree-1") },
    { active: "A/Tree.mtn.md" }
  );
  assert.equal(await locator.resolve({}), "A/Tree.mtn.md");
});

test("with no selector and nothing open the missing input is named", async () => {
  const { locator } = fixture({ "A/Tree.mtn.md": treeSource("tree-1") });
  await expectError(() => locator.resolve({}), "invalid-arguments",
    t("mcp.error.invalidArguments", { detail: "treePath or documentId" }));
  const { locator: notATree } = fixture({ "Notes/plain.md": "# note" }, { active: "Notes/plain.md" });
  await expectError(() => notATree.resolve({}), "invalid-arguments",
    t("mcp.error.invalidArguments", { detail: "treePath or documentId" }));
});
