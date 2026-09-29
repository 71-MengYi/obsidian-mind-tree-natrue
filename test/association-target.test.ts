import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmptyDocument, getNode } from "../src/domain/tree";
import { DocumentSession } from "../src/services/document-session";
import { SharedMindTreeSession } from "../src/services/mind-tree-session-registry";
import {
  AssociationTargetChangedError, isAssociationTargetAvailable, isResourceTargetCurrent,
  requireAssociationTarget, type ResourceTarget
} from "../src/ui/association-target";
import type { FileResourceRef, MindTreeDocument, ResourceRef } from "../src/types";

const file: FileResourceRef = { type: "file", resourceId: "file-id", pathHint: "A.md", fileKind: "note" };
const web: ResourceRef = { type: "url", url: "https://example.com" };

test("every associated file/URL blocks replacement regardless of title synchronization", () => {
  const document = createEmptyDocument("Topic");
  const node = getNode(document, document.rootId);
  const target = { documentSessionToken: "session", nodeId: node.id };
  for (const resource of [file, { ...file, fileKind: "image" }, { ...file, fileKind: "attachment" }, web] as ResourceRef[]) {
    node.resource = resource;
    for (const titleSync of ["bidirectional", "off"] as const) {
      node.titleSync = titleSync;
      assert.equal(isAssociationTargetAvailable(target, "session", document), false);
      assert.throws(() => requireAssociationTarget(target, "session", document), AssociationTargetChangedError);
      assert.equal(node.title, "Topic");
      assert.equal(node.resource, resource);
    }
  }
  delete node.resource;
  delete node.titleSync;
  assert.equal(requireAssociationTarget(target, "session", document), node);
});

test("association validation rejects file switches, closed sessions and deleted nodes without history", () => {
  for (const change of ["switch", "close", "delete"]) {
    let document: MindTreeDocument | undefined = createEmptyDocument("Original");
    const target = { documentSessionToken: "original", nodeId: document.rootId };
    requireAssociationTarget(target, "original", document);
    let currentToken = "original";
    if (change === "switch") currentToken = "another-file";
    if (change === "close") document = undefined;
    if (change === "delete") delete document!.nodes[document!.rootId];
    const session = new DocumentSession();
    assert.throws(() => requireAssociationTarget(target, currentToken, document), AssociationTargetChangedError);
    if (document) {
      const before = JSON.stringify(document);
      assert.throws(() => session.execute(document!, (draft) => {
        const node = requireAssociationTarget(target, currentToken, draft);
        node.title = "Must not appear";
        node.resource = web;
      }), AssociationTargetChangedError);
      assert.equal(JSON.stringify(document), before);
    }
    assert.equal(session.canUndo, false);
    assert.equal(session.dirty, false);
  }
});

test("a second view winning an async association cannot have its resource or history overwritten", async () => {
  const shared = new SharedMindTreeSession("Tree.mtn.md");
  const initial = createEmptyDocument("Topic");
  shared.initialize(initial, "baseline");
  const target = { documentSessionToken: "left-session", nodeId: initial.rootId };
  requireAssociationTarget(target, "left-session", shared.document);
  let resume!: () => void;
  const completed = new Promise<void>((resolve) => { resume = resolve; });
  const pendingAssociation = (async () => {
    await completed;
    const updated = shared.history.execute(shared.document!, (draft) => {
      const node = requireAssociationTarget(target, "left-session", draft);
      node.title = "Late replacement";
      node.resource = web;
    });
    shared.replaceDocument(updated, "left");
  })();
  const winner = shared.history.execute(shared.document!, (draft) => {
    getNode(draft, target.nodeId).title = "Other view's file";
    getNode(draft, target.nodeId).resource = { ...file };
  });
  shared.replaceDocument(winner, "right");
  resume();
  await assert.rejects(pendingAssociation, AssociationTargetChangedError);
  assert.equal(shared.document, winner);
  assert.deepEqual(getNode(shared.document!, target.nodeId).resource, file);
  assert.equal(getNode(shared.document!, target.nodeId).title, "Other view's file");
  assert.equal(shared.history.undo(winner), initial);
  assert.equal(shared.history.canUndo, false, "a rejected association must not add an undo entry");
});

test("the command draft is checked again after a different editor commits at the mutation boundary", () => {
  const initial = createEmptyDocument("Topic");
  const target = { documentSessionToken: "view", nodeId: initial.rootId };
  requireAssociationTarget(target, "view", initial);
  const session = new DocumentSession();
  const updated = session.execute(initial, (draft) => { getNode(draft, draft.rootId).resource = file; });
  assert.throws(() => session.execute(updated, (draft) => {
    const node = requireAssociationTarget(target, "view", draft);
    node.title = "Late title";
    node.resource = web;
  }), AssociationTargetChangedError);
  assert.equal(getNode(updated, target.nodeId).title, "Topic");
  assert.equal(session.undo(updated), initial);
});

test("menu identity survives filename/title changes but rejects a new association or document", () => {
  const document = createEmptyDocument("Topic");
  const node = getNode(document, document.rootId);
  node.resource = { ...file };
  const target: ResourceTarget = { documentSessionToken: "view", nodeId: node.id, resource: { ...file } };
  node.resource.pathHint = "Moved/New Name.md";
  node.title = "Renamed";
  node.titleSync = "off";
  assert.equal(isResourceTargetCurrent(target, "view", document), true);
  assert.equal(isResourceTargetCurrent(target, "another-view", document), false);
  assert.equal(isResourceTargetCurrent(target, "view", undefined), false);
  node.resource = { ...file, resourceId: "replacement" };
  assert.equal(isResourceTargetCurrent(target, "view", document), false);
  node.resource = web;
  assert.equal(isResourceTargetCurrent(target, "view", document), false);
  delete node.resource;
  assert.equal(isResourceTargetCurrent(target, "view", document), false);
  const unlinkedTarget: ResourceTarget = { ...target, resource: undefined };
  assert.equal(isResourceTargetCurrent(unlinkedTarget, "view", document), true);
  node.resource = file;
  assert.equal(isResourceTargetCurrent(unlinkedTarget, "view", document), false);
});

test("URL menu snapshots compare the captured URL rather than only the resource type", () => {
  const document = createEmptyDocument("Topic");
  const node = getNode(document, document.rootId);
  node.resource = { ...web };
  const target: ResourceTarget = { documentSessionToken: "view", nodeId: node.id, resource: { ...web } };
  assert.equal(isResourceTargetCurrent(target, "view", document), true);
  node.resource.url = "https://other.example.com";
  assert.equal(isResourceTargetCurrent(target, "view", document), false);
});

test("view wiring shares guards for all association paths and keeps default opening separate from mutations", () => {
  const source = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
  const method = (name: string) => source.split(new RegExp(`  private (?:async )?${name}\\(`))[1]!.split(/\n  private /)[0]!;
  for (const name of ["createNoteForNode", "showTemplateFilePicker", "linkExistingFile", "linkUrl"]) {
    assert.match(method(name), /this\.captureAssociationTarget\(nodeId\)/);
  }
  for (const name of ["createNoteForNode", "createFileFromTemplate", "linkExistingFile"]) {
    assert.match(method(name), /this\.associateFileWithTarget\(target,/);
  }
  assert.match(method("associateFileWithTarget"), /this\.requireAssociationTarget\(target, draft\)/);
  assert.match(method("linkUrl"), /this\.requireAssociationTarget\(target, draft\)/);
  assert.match(method("createNoteForNode"), /notice\.createdNoteNotLinked/);
  assert.doesNotMatch(method("createNoteForNode"), /trash|\.delete\(|\.remove\(/);
  assert.match(method("createFileFromTemplate"), /discardTemplateFile/);
  assert.doesNotMatch(method("openResourceWithDefaultApp"), /this\.commit\(|this\.selectOnly\(|this\.viewport|\.openFile\(/);
  assert.match(method("openResource"), /resourceOpenMode/);
  assert.match(method("openResource"), /window\.open\(/);
  assert.match(method("openResource"), /this\.plugin\.openLinkedFile\(/);
  const plugin = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const open = plugin.split("  async openLinkedFile(")[1]!.split("  async activateMindTree(")[0]!;
  assert.match(open, /if \(isMindTreePath\(file.path\)\)/);
  assert.match(open, /leaf\.openFile\(/);
});
