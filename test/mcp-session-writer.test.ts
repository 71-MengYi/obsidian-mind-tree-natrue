import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Only the host boundary is stubbed: the writer runs the real sessions, the real
// compare-and-set logic, the real conflict assessment and the real domain
// commands, because those are exactly the parts that must not be re-implemented.
//
// `module.register` (Node >= 20.6) is used instead of `module.registerHooks`
// (Node >= 22.15) because AGENTS.md and the release workflow pin this project at
// Node >= 20: a test that only runs on a newer runtime is not runnable on a
// supported one. The hook is scoped to the i18n facade itself - the only
// `obsidian` importer in this module graph - and the stub source carries a
// file-specific marker so this file's module URL is unique: with
// `--test-isolation=none` the ESM cache is process-wide and keyed by URL.
const OBSIDIAN_STUB = "data:text/javascript," + encodeURIComponent(
  '// obsidian stub for mcp-session-writer.test.ts\nexport const getLanguage = () => "en";\n'
);
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {\n" +
  '  if (specifier === "obsidian" && context.parentURL?.endsWith("/i18n/index.ts")) {\n' +
  `    return { url: ${JSON.stringify(OBSIDIAN_STUB)}, shortCircuit: true };\n` +
  "  }\n" +
  "  return next(specifier, context);\n" +
  "}\n"
));
const { MindTreeSessionWriter } = await import("../src/services/mcp/session-writer");
const { McpToolError } = await import("../src/services/mcp/tool-error");
const { MindTreeSessionRegistry } = await import("../src/services/mind-tree-session-registry");
const { createEmptyDocument, addNode } = await import("../src/domain/tree");
const { parseMindTreeFile, serializeMindTreeFile } = await import("../src/format/document");
const { t } = await import("../src/i18n");

const PATH = "Folder/Tree.mtn.md";

function buildTree() {
  const document = createEmptyDocument("Tree");
  const first = addNode(document, document.rootId, "First").id;
  const second = addNode(document, document.rootId, "Second").id;
  const third = addNode(document, first, "Third").id;
  return { source: serializeMindTreeFile(document), rootId: document.rootId, first, second, third };
}

interface Participant {
  onSessionChange(snapshot: { reason: string }): void;
  commitActiveDraft(): "committed" | "rejected";
}

function fixture(initial = buildTree()) {
  const files = new Map<string, string>([[PATH, initial.source]]);
  const processCalls: string[] = [];
  const writes: string[] = [];
  const notified: string[] = [];
  const createdTrees: Array<Record<string, unknown>> = [];
  let tamper: ((source: string) => string) | undefined;
  let tampering = false;
  const registry = new MindTreeSessionRegistry();
  const writer = new MindTreeSessionWriter({
    sessions: registry,
    fileExists: (path) => files.has(path),
    read: async (path) => {
      const source = files.get(path);
      if (source === undefined) throw new Error(`missing file: ${path}`);
      // Tampering models a second writer landing between our write and our
      // read-back, so it must not affect the read that precedes the write.
      if (tampering && writes.length > 0 && tamper) return tamper(source);
      return source;
    },
    process: async (path, transform) => {
      processCalls.push(path);
      const current = files.get(path);
      if (current === undefined) throw new Error(`missing file: ${path}`);
      const next = transform(current);
      if (next !== current) {
        writes.push(path);
        files.set(path, next);
      }
      return next;
    },
    parseOptions: () => ({}),
    fileReference: async (filePath) => ({
      type: "file",
      resourceId: `rid-${filePath}`,
      pathHint: filePath,
      fileKind: filePath.endsWith(".md") ? "note" : "attachment"
    }),
    creation: {
      create: async (input) => {
        createdTrees.push({ ...input });
        tampering = false;
        return { path: "New/Tree.mtn.md", documentId: "new-id", rootId: "root", childIds: ["child-1"] };
      }
    },
    notifyExternalChange: (path) => { notified.push(path); }
  });
  const documentAt = (path = PATH) => parseMindTreeFile(files.get(path) ?? "").document;
  const titles = (path = PATH) => {
    const document = documentAt(path);
    return Object.values(document.nodes).map((node) => node.title).sort();
  };
  return {
    writer, registry, files, processCalls, writes, notified, createdTrees, documentAt, titles, initial,
    startTamper: (fn: (source: string) => string) => { tamper = fn; tampering = true; },
    stopTamper: () => { tamper = undefined; tampering = false; }
  };
}

/**
 * One open view for the path. A headless write drops a session nobody else uses,
 * so every conflict-shaped scenario needs the view that keeps the session (and
 * therefore its baseline and history) alive across calls — which is exactly the
 * situation the safety rules exist for.
 */
function openView(fixtureState: ReturnType<typeof fixture>, participant?: Participant) {
  const session = fixtureState.registry.acquire(PATH);
  const reasons: string[] = [];
  session.attach("view-1", participant ?? {
    onSessionChange: (snapshot) => { reasons.push(snapshot.reason); },
    commitActiveDraft: () => "committed"
  });
  return { session, reasons };
}

async function expectError(run: () => Promise<unknown>, code: string, message: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof McpToolError, `expected McpToolError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

test("adding a node writes it, returns its id, and leaves the tree parseable", async () => {
  const fixtureState = fixture();
  const outcome = await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Added");

  assert.deepEqual(fixtureState.writes, [PATH]);
  assert.equal(fixtureState.documentAt().nodes[outcome.nodeId]!.title, "Added");
  assert.deepEqual(fixtureState.titles(), ["Added", "First", "Second", "Third", "Tree"]);
  assert.equal(outcome.path, PATH);
});

test("an open view shares the session, the history and the refresh", async () => {
  const fixtureState = fixture();
  const session = fixtureState.registry.acquire(PATH);
  const reasons: string[] = [];
  const participant: Participant = {
    onSessionChange: (snapshot) => { reasons.push(snapshot.reason); },
    commitActiveDraft: () => "committed"
  };
  session.attach("view-1", participant);

  const outcome = await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Shared");

  // The canvas is told to repaint from the same document that reached the disk.
  assert.ok(reasons.includes("document"), `expected a document refresh, got ${reasons.join(",")}`);
  assert.ok(reasons.includes("source"));
  assert.equal(session.document!.nodes[outcome.nodeId]!.title, "Shared");
  // An ordinary command: the user can undo it in the canvas.
  assert.equal(session.history.canUndo, true);
  assert.equal(session.history.dirty, false);
  assert.equal(session.source, fixtureState.files.get(PATH));
});

test("a locked session is refused and the file is left byte-for-byte untouched", async () => {
  const fixtureState = fixture();
  const { session } = openView(fixtureState);
  await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Warm up");
  const before = fixtureState.files.get(PATH)!;
  const writesBefore = fixtureState.writes.length;

  session.restoring = true;
  await expectError(
    () => fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Forbidden"),
    "conflict-locked",
    t("mcp.error.conflictLocked")
  );
  session.restoring = false;

  session.restoreError = "unresolved version";
  await expectError(
    () => fixtureState.writer.renameNode(PATH, fixtureState.initial.first, "Forbidden"),
    "conflict-locked",
    t("mcp.error.conflictLocked")
  );
  session.restoreError = undefined;

  // Not "the promise rejected": nothing was read for writing, nothing was
  // processed, nothing was written, and the bytes are identical.
  assert.equal(fixtureState.files.get(PATH), before);
  assert.equal(fixtureState.writes.length, writesBefore);
  assert.equal(fixtureState.processCalls.length, 1);
  assert.deepEqual(fixtureState.notified, []);
});

test("a view holding a rejected draft blocks the tool write entirely", async () => {
  const fixtureState = fixture();
  const { session } = openView(fixtureState, {
    onSessionChange: () => undefined,
    commitActiveDraft: () => "rejected"
  });
  await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Warm up");
  const before = fixtureState.files.get(PATH)!;
  session.claimEditor("view-1");

  await expectError(
    () => fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Forbidden"),
    "conflict-locked",
    t("mcp.error.conflictLocked")
  );
  assert.equal(fixtureState.files.get(PATH), before);
  assert.equal(fixtureState.processCalls.length, 1);
});

test("an external edit is refused and never overwritten", async () => {
  const fixtureState = fixture();
  const { session } = openView(fixtureState);
  await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Mine");
  const mine = fixtureState.files.get(PATH)!;

  // Another editor rewrites the file behind the session's back.
  const external = buildTree().source;
  fixtureState.files.set(PATH, external);

  await expectError(
    () => fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Theirs"),
    "save-conflict",
    t("mcp.error.saveConflict")
  );

  assert.equal(fixtureState.files.get(PATH), external);
  assert.notEqual(fixtureState.files.get(PATH), mine);
  assert.deepEqual(fixtureState.writes, [PATH]);
  assert.deepEqual(fixtureState.notified, [PATH]);
  // The session document is not published as if the write had happened.
  assert.equal(session.document!.nodes[fixtureState.initial.first]!.title, "First");
});

test("a write that cannot be verified afterwards is reported and not published", async () => {
  const fixtureState = fixture();
  const { session, reasons } = openView(fixtureState);
  await fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Warm up");
  const writesBefore = fixtureState.writes.length;
  // The read-back after the write sees someone else's content.
  fixtureState.startTamper(() => buildTree().source);

  await expectError(
    () => fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "Doomed"),
    "file-changed",
    t("mcp.error.fileChanged")
  );

  assert.equal(fixtureState.writes.length, writesBefore + 1);
  assert.deepEqual(fixtureState.notified, [PATH]);
  assert.equal(session.history.dirty, false);
  // The session still describes the last *verified* write, not the doomed one.
  const titles = Object.values(session.document!.nodes).map((node) => node.title);
  assert.ok(titles.includes("Warm up"));
  assert.ok(!titles.includes("Doomed"));
  assert.ok(reasons.includes("document"));
});

test("renaming trims the title and deleting promotes the children", async () => {
  const fixtureState = fixture();
  await fixtureState.writer.renameNode(PATH, fixtureState.initial.first, "  Renamed  ");
  assert.equal(fixtureState.documentAt().nodes[fixtureState.initial.first]!.title, "Renamed");

  const deleted = await fixtureState.writer.deleteNode(PATH, fixtureState.initial.first);
  assert.equal(deleted.removedId, fixtureState.initial.first);
  assert.deepEqual(deleted.promotedChildIds, [fixtureState.initial.third]);
  const document = fixtureState.documentAt();
  assert.equal(document.nodes[fixtureState.initial.first], undefined);
  assert.equal(document.nodes[fixtureState.initial.third]!.title, "Third");
  assert.equal(document.nodes[document.rootId]!.childIds.includes(fixtureState.initial.third), true);
});

test("moving a node changes its parent without touching the other branches", async () => {
  const fixtureState = fixture();
  await fixtureState.writer.moveNode(PATH, fixtureState.initial.third, fixtureState.initial.second);
  const document = fixtureState.documentAt();
  assert.deepEqual(document.nodes[fixtureState.initial.second]!.childIds, [fixtureState.initial.third]);
  assert.deepEqual(document.nodes[fixtureState.initial.first]!.childIds, []);
});

test("missing nodes and blank titles never reach the file", async () => {
  const fixtureState = fixture();
  await expectError(
    () => fixtureState.writer.renameNode(PATH, "nope", "X"),
    "node-not-found",
    t("mcp.error.nodeNotFound", { nodeId: "nope" })
  );
  await expectError(
    () => fixtureState.writer.addNode(PATH, "nope", "X"),
    "node-not-found",
    t("mcp.error.nodeNotFound", { nodeId: "nope" })
  );
  await expectError(
    () => fixtureState.writer.addNode(PATH, fixtureState.initial.rootId, "   "),
    "invalid-arguments",
    t("mcp.error.invalidArguments", { detail: "title" })
  );
  await expectError(
    () => fixtureState.writer.deleteNode(PATH, fixtureState.initial.rootId),
    "invalid-operation",
    "The root node cannot be deleted."
  );
  // Every refusal happened inside the compare-and-set callback, which is why the
  // disk was read but never rewritten: the tree keeps exactly its old bytes.
  assert.deepEqual(fixtureState.writes, []);
  assert.equal(fixtureState.files.get(PATH), fixtureState.initial.source);
});

test("a linked file keeps its own name: no sync is started by a tool", async () => {
  const fixtureState = fixture();
  const outcome = await fixtureState.writer.linkFile(PATH, fixtureState.initial.second, "Notes/Report.pdf");
  const node = fixtureState.documentAt().nodes[fixtureState.initial.second]!;
  assert.deepEqual(node.resource, {
    type: "file", resourceId: "rid-Notes/Report.pdf", pathHint: "Notes/Report.pdf", fileKind: "attachment"
  });
  assert.equal(node.titleSync, "off");
  assert.equal(node.title, "Second");
  assert.equal(outcome.nodeId, fixtureState.initial.second);
});

test("an association is refused on a node that already carries one", async () => {
  const fixtureState = fixture();
  await fixtureState.writer.linkFile(PATH, fixtureState.initial.second, "Notes/Report.pdf");
  await expectError(
    () => fixtureState.writer.linkFile(PATH, fixtureState.initial.second, "Notes/Other.pdf"),
    "invalid-operation",
    t("notice.associationTargetChanged")
  );
  const unlinked = await fixtureState.writer.unlinkFile(PATH, fixtureState.initial.second);
  const node = fixtureState.documentAt().nodes[unlinked.nodeId]!;
  assert.equal(node.resource, undefined);
  assert.equal(node.titleSync, undefined);
});

test("node links are one-way and reject self or second links", async () => {
  const fixtureState = fixture();
  await fixtureState.writer.linkNode(PATH, fixtureState.initial.second, fixtureState.initial.third);
  assert.equal(fixtureState.documentAt().nodes[fixtureState.initial.second]!.nodeLink, fixtureState.initial.third);
  assert.equal(fixtureState.documentAt().nodes[fixtureState.initial.third]!.nodeLink, undefined);

  await expectError(
    () => fixtureState.writer.linkNode(PATH, fixtureState.initial.second, fixtureState.initial.first),
    "invalid-operation",
    t("notice.associationTargetChanged")
  );
  await expectError(
    () => fixtureState.writer.linkNode(PATH, fixtureState.initial.third, fixtureState.initial.third),
    "invalid-operation",
    t("notice.associationTargetChanged")
  );

  await fixtureState.writer.unlinkNode(PATH, fixtureState.initial.second);
  assert.equal(fixtureState.documentAt().nodes[fixtureState.initial.second]!.nodeLink, undefined);
});

test("create_tree never steals focus and forwards only what the caller asked for", async () => {
  const fixtureState = fixture();
  const created = await fixtureState.writer.createTree({ title: "New", folder: "New", children: ["One"] });
  assert.deepEqual(fixtureState.createdTrees, [
    { title: "New", folderPath: "New", children: ["One"], focus: false }
  ]);
  assert.deepEqual(created, { path: "New/Tree.mtn.md", documentId: "new-id", rootId: "root", childIds: ["child-1"] });
});

test("create_tree invents no folder or children and always asks for no focus", async () => {
  const fixtureState = fixture();
  await fixtureState.writer.createTree({ title: "Solo" });
  // The writer has no permission port any more: the boundary is that `create_tree`
  // is only served by the write server, which `test/mcp-tools.test.ts` pins.
  assert.deepEqual(fixtureState.createdTrees, [{ title: "Solo", focus: false }]);
});
