import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { assessExternalVersion, decideExternalChange } from "../src/services/document-conflict";
import { SharedMindTreeSession, type SharedSessionSnapshot } from "../src/services/mind-tree-session-registry";

/**
 * Persistence/refresh rule: a settled disk version replaces an open tree when
 * the session has no local work. Only local work (unsaved edits, an unconfirmed
 * title draft, an editor in use, unfinished filename side effects) or an unsafe
 * identity/format change keeps the explicit version comparison.
 */

const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");

function remoteTree(): { document: ReturnType<typeof createEmptyDocument>; source: string } {
  const document = createEmptyDocument("Tree");
  addNode(document, document.rootId, "Remote");
  return { document, source: serializeMindTreeFile(document) };
}

test("a session without local work adopts external machine data", () => {
  const local = createEmptyDocument("Tree");
  const baseline = serializeMindTreeFile(local);
  const remote = remoteTree();
  const external = assessExternalVersion(baseline, local, remote.source);
  assert.equal(external.kind, "choose");

  const clean = decideExternalChange(external, false);
  assert.equal(clean.kind, "adopt");
  if (clean.kind === "adopt") {
    assert.equal(clean.assessment.external.document.nodes[remote.document.rootId]?.childIds.length, 1);
  }
  assert.equal(decideExternalChange(external, true).kind, "conflict");

  const unchanged = assessExternalVersion(baseline, local, baseline);
  assert.equal(decideExternalChange(unchanged, false).kind, "merge");
  assert.equal(decideExternalChange(unchanged, true).kind, "merge");
});

test("identity and format blocks still require an explicit choice", () => {
  const local = createEmptyDocument("Tree");
  local.documentId = "tree-a";
  const baseline = serializeMindTreeFile(local);

  const other = createEmptyDocument("Tree");
  other.documentId = "tree-b";
  const identity = assessExternalVersion(baseline, local, serializeMindTreeFile(other));
  assert.equal(identity.kind, "blocked");
  assert.equal(decideExternalChange(identity, false).kind, "conflict");

  const invalid = assessExternalVersion(baseline, local, "not a mind tree");
  assert.equal(invalid.kind, "blocked");
  assert.equal(decideExternalChange(invalid, false).kind, "conflict");
});

test("adopting a disk version rebuilds the document, baseline and history", () => {
  const session = new SharedMindTreeSession("Tree.mtn.md");
  const document = createEmptyDocument("Tree");
  const source = serializeMindTreeFile(document);
  session.initialize(document, source);

  // A saved edit: the document has history but no unsaved work.
  const edited = session.history.execute(document, (draft) => { addNode(draft, draft.rootId, "Local"); });
  const editedSource = serializeMindTreeFile(edited, source);
  session.history.markChanged();
  session.history.markSaved(session.history.currentRevision, editedSource);
  session.replaceDocument(edited, "view");
  assert.equal(session.history.dirty, false);
  assert.equal(session.history.canUndo, true);

  const updates: SharedSessionSnapshot[] = [];
  session.attach("view", { onSessionChange: (snapshot) => updates.push(snapshot), commitActiveDraft: () => "committed" });
  const remote = remoteTree();
  const parsed = parseMindTreeFile(remote.source).document;

  session.adoptExternalVersion(remote.source, parsed);

  assert.equal(session.document, parsed);
  assert.equal(session.source, remote.source);
  assert.equal(session.history.dirty, false);
  assert.equal(session.history.sourceBaseline, remote.source);
  assert.equal(session.history.canUndo, false);
  assert.equal(updates.at(-1)?.reason, "source");
  assert.equal(updates.at(-1)?.dirty, false);
  assert.equal(updates.at(-1)?.hasConflict, false);
});

test("the view adopts only a clean session and keeps local work in the comparison", () => {
  const accept = view.split("  private async acceptExternalSource(")[1]?.split("  private adoptExternalVersion(")[0] ?? "";
  assert.ok(accept.length > 0, "acceptExternalSource must remain a top-level method");
  assert.match(accept, /const decision = decideExternalChange\(assessment, this\.hasLocalWork\(\)\);/);
  assert.match(accept, /if \(decision\.kind === "conflict"\) \{ await this\.enterVersionPreview\(\); return; \}/);
  assert.match(accept, /if \(decision\.kind === "adopt"\) \{[\s\S]*?this\.adoptExternalVersion\(source, decision\.assessment\.external\.document\);[\s\S]*?return;/);
  // Both outcomes come from the same decision, computed before any preview exists.
  assert.ok(accept.indexOf("decideExternalChange(assessment") < accept.indexOf("await this.enterVersionPreview()"));

  const adopt = view.split("  private adoptExternalVersion(")[1]?.split("  private hasLocalWork(")[0] ?? "";
  assert.ok(adopt.length > 0, "adoptExternalVersion must remain a top-level method");
  assert.match(adopt, /session\.adoptExternalVersion\(source, external\)/);
  assert.match(adopt, /this\.documentSession\.load\(source\)/);

  const localWork = view.split("  private hasLocalWork(")[1]?.split("  private async enterVersionPreview(")[0] ?? "";
  assert.ok(localWork.length > 0, "hasLocalWork must remain a top-level method");
  assert.match(localWork, /this\.hasUnsavedState\(\)/);
  assert.match(localWork, /this\.pendingTitleFileOperation !== undefined/);
  assert.match(localWork, /this\.sharedSession\?\.hasActiveEditor === true/);
});
