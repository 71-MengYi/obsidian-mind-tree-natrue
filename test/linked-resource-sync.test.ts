import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { reconcileLinkedFileReferences } from "../src/services/linked-resource-sync";

test("pending title-to-file rename keeps the new title while still correcting cached metadata", () => {
  const document = createEmptyDocument("Tree");
  const node = addNode(document, document.rootId, "New title");
  node.titleSync = "bidirectional";
  node.resource = { type: "file", resourceId: "id", pathHint: "Old.md", fileKind: "note" };
  reconcileLinkedFileReferences(document, () => ({ path: "Folder/Old.md", fileSubtype: "excalidraw" }), new Set([node.id]));
  assert.equal(node.title, "New title");
  assert.equal(node.resource.pathHint, "Folder/Old.md");
  assert.equal(node.resource.fileSubtype, "excalidraw");
});

test("repairs a stale compressed title after an external rename and persists it", () => {
  const document = createEmptyDocument("Rename race");
  const longTitle = `12312312${"2".repeat(110)}3`;
  const node = addNode(document, document.rootId, "Old attachment");
  node.resource = {
    type: "file",
    resourceId: "nm3mqkjrym",
    pathHint: "Old attachment~mtn-nm3mqkjrym.canvas",
    fileKind: "attachment"
  };
  node.titleSync = "bidirectional";

  // Obsidian can reload this stale source after rewriting its readable link.
  const staleSource = serializeMindTreeFile(document);
  const reloaded = parseMindTreeFile(staleSource).document;
  const renamedPath = `${longTitle}~mtn-nm3mqkjrym.canvas`;
  const resolvedFile = { path: renamedPath };
  const changed = reconcileLinkedFileReferences(reloaded, () => resolvedFile);
  const reloadedNode = reloaded.nodes[node.id]!;

  assert.equal(changed, true);
  assert.equal(reloadedNode.title, longTitle);
  assert.equal(reloadedNode.resource?.type, "file");
  if (reloadedNode.resource?.type === "file") assert.equal(reloadedNode.resource.pathHint, renamedPath);

  const repairedSource = serializeMindTreeFile(reloaded, staleSource);
  assert.ok(repairedSource.includes(`[[${renamedPath}|${longTitle}]]`));
  const reopened = parseMindTreeFile(repairedSource).document.nodes[node.id]!;
  assert.equal(reopened.title, longTitle);
  assert.equal(reconcileLinkedFileReferences(reloaded, () => resolvedFile), false);
});

test("updates every synchronized alias while preserving titles with sync disabled", () => {
  const document = createEmptyDocument("Shared note");
  const synchronizedA = addNode(document, document.rootId, "Old A");
  const synchronizedB = addNode(document, document.rootId, "Old B");
  const independent = addNode(document, document.rootId, "My custom label");
  for (const node of [synchronizedA, synchronizedB, independent]) {
    node.resource = {
      type: "file",
      resourceId: "shared-resource",
      pathHint: "notes/Old note.md",
      fileKind: "note"
    };
    node.titleSync = node === independent ? "off" : "bidirectional";
  }

  assert.equal(reconcileLinkedFileReferences(document, () => ({ path: "notes/Renamed note.md" })), true);
  assert.equal(synchronizedA.title, "Renamed note");
  assert.equal(synchronizedB.title, "Renamed note");
  assert.equal(independent.title, "My custom label");
  for (const node of [synchronizedA, synchronizedB, independent]) {
    assert.equal(node.resource?.type, "file");
    if (node.resource?.type === "file") assert.equal(node.resource.pathHint, "notes/Renamed note.md");
  }
});

test("moving a linked file between folders updates only its cached path", () => {
  const document = createEmptyDocument("Move only");
  const node = addNode(document, document.rootId, "Same name");
  node.resource = {
    type: "file",
    resourceId: "move-resource",
    pathHint: "old/Same name.md",
    fileKind: "note"
  };
  node.titleSync = "bidirectional";

  assert.equal(reconcileLinkedFileReferences(document, () => ({ path: "new/Same name.md" })), true);
  assert.equal(node.title, "Same name");
  assert.equal(reconcileLinkedFileReferences(document, () => ({ path: "new/Same name.md" })), false);
});

test("repairs and removes the cached Excalidraw subtype from resolved Frontmatter state", () => {
  const document = createEmptyDocument("Drawing metadata");
  const node = addNode(document, document.rootId, "Drawing");
  node.resource = {
    type: "file",
    resourceId: "drawing-resource",
    pathHint: "drawings/Drawing.md",
    fileKind: "note"
  };
  node.titleSync = "off";

  assert.equal(reconcileLinkedFileReferences(document, () => ({
    path: "drawings/Drawing.md",
    fileSubtype: "excalidraw"
  })), true);
  assert.equal(node.resource.fileSubtype, "excalidraw");
  assert.equal(reconcileLinkedFileReferences(document, () => ({
    path: "drawings/Drawing.md",
    fileSubtype: "excalidraw"
  })), false);

  assert.equal(reconcileLinkedFileReferences(document, () => ({ path: "drawings/Drawing.md" })), true);
  assert.equal(node.resource.fileSubtype, undefined);

  node.resource.fileSubtype = "excalidraw";
  assert.equal(reconcileLinkedFileReferences(document, () => undefined), false);
  assert.equal(node.resource.fileSubtype, "excalidraw");
});

test("derives canonical titles for notes, mind trees, and current or legacy attachment IDs", () => {
  const cases = [
    ["notes/New note.md", "New note", "note"],
    ["maps/New tree.mtn.md", "New tree", "note"],
    ["assets/New image@A1b2C.png", "New image", "image"],
    ["assets/New canvas~mtn-nm3mqkjrym.canvas", "New canvas", "attachment"]
  ] as const;

  for (const [path, expectedTitle, fileKind] of cases) {
    const document = createEmptyDocument("File kinds");
    const node = addNode(document, document.rootId, "Old title");
    node.resource = { type: "file", resourceId: `id-${expectedTitle}`, pathHint: "old/path", fileKind };
    node.titleSync = "bidirectional";

    assert.equal(reconcileLinkedFileReferences(document, () => ({ path })), true);
    assert.equal(node.title, expectedTitle);
  }
});

test("leaves unresolved file references and URL nodes untouched", () => {
  const document = createEmptyDocument("Unresolved");
  const fileNode = addNode(document, document.rootId, "Missing custom title");
  fileNode.resource = {
    type: "file",
    resourceId: "missing-resource",
    pathHint: "missing/Old.md",
    fileKind: "note"
  };
  fileNode.titleSync = "bidirectional";
  const urlNode = addNode(document, document.rootId, "Website title");
  urlNode.resource = { type: "url", url: "https://example.com" };

  assert.equal(reconcileLinkedFileReferences(document, () => undefined), false);
  assert.equal(fileNode.title, "Missing custom title");
  assert.equal(urlNode.title, "Website title");
});
