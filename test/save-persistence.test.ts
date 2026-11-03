import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { markSettingsEdited } from "../src/document-settings-state";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { planMindTreeSave } from "../src/services/save-plan";

/**
 * Persistence rule: a save may only edit the `.mtn.md` when it has bytes to
 * write. Obsidian calls `TextFileView.save()` whenever a leaf unloads or
 * switches file, and every write bumps the file's mtime — which makes sync
 * clients re-upload a note the user never touched.
 */

const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
const parse = (source: string) => parseMindTreeFile(source).document;

test("a save that would reproduce the file plans no write at all", () => {
  const document = createEmptyDocument("Tree");
  const source = serializeMindTreeFile(document);
  const plan = planMindTreeSave(source, document, source);
  assert.equal(plan.kind, "identical");
  // Returning the callback's own bytes is what makes Vault.process skip the
  // write; anything else (even semantically equal bytes) would touch the file.
  assert.equal(plan.source, source);
  assert.equal(serializeMindTreeFile(parse(source), source), source);
});

test("a modified tree still plans the exact bytes to write, and they stay stable", () => {
  const document = createEmptyDocument("Tree");
  const baseline = serializeMindTreeFile(document);
  addNode(document, document.rootId, "Child");
  const plan = planMindTreeSave(baseline, document, baseline);
  assert.equal(plan.kind, "write");
  assert.notEqual(plan.source, baseline);
  assert.match(plan.source, /Child/);
  // A written file must be a fixed point: the next save must not rewrite it.
  const reparsed = parse(plan.source);
  assert.equal(serializeMindTreeFile(reparsed, plan.source), plan.source);
  assert.equal(planMindTreeSave(plan.source, reparsed, plan.source).kind, "identical");
});

test("an external machine-data change defers instead of overwriting the file", () => {
  const local = createEmptyDocument("Tree");
  const baseline = serializeMindTreeFile(local);
  const external = createEmptyDocument("Tree");
  addNode(external, external.rootId, "External");
  const disk = serializeMindTreeFile(external);
  const plan = planMindTreeSave(baseline, local, disk);
  assert.equal(plan.kind, "deferred");
  assert.equal(plan.source, disk);
});

test("a document-setting edit is a real write even when the tree itself is unchanged", () => {
  const document = createEmptyDocument("Tree");
  const baseline = serializeMindTreeFile(document);
  const local = parse(baseline);
  local.settings.theme = "flat";
  markSettingsEdited(local, ["theme"]);
  const plan = planMindTreeSave(baseline, local, baseline);
  assert.equal(plan.kind, "write");
  assert.match(plan.source, /^theme: flat$/m);
});

test("MindTreeView refuses to save a clean document and never publishes a no-op write", () => {
  const body = view.split("  override async save(")[1]?.split("  getViewData(")[0] ?? "";
  assert.ok(body.length > 0, "save() must remain a top-level method");
  const guard = body.indexOf("if (!this.hasUnsavedState()) return;");
  assert.ok(guard > 0, "save() must return early when the document has no unsaved work");
  const request = body.indexOf("this.documentSession.requestSave");
  assert.ok(request > guard, "the clean-document guard must run before the write request");
  assert.doesNotMatch(body, /app\.vault\.(modify|process|create)/);

  const queued = view.split("  private async performQueuedSave(")[1]?.split("  /** Event payloads can be stale")[0] ?? "";
  assert.ok(queued.length > 0, "performQueuedSave must remain a top-level method");
  assert.match(queued, /planMindTreeSave\(baseline, document, disk, this\.parseOptions\(\)\)/);
  assert.match(queued, /if \(plan\.kind === "deferred"\) return disk;/);
  const identical = queued.indexOf('if (plan.kind === "identical") return disk;');
  assert.ok(identical > 0, "identical bytes must be handed back so Vault.process skips the write");
  assert.ok(identical < queued.indexOf("this.pendingSerializedSource = plan.source;"),
    "an identical save must not publish a write receipt");
  assert.ok(identical < queued.indexOf("session?.beginWrite(plan.source);"),
    "an identical save must not register a pending write");
  assert.equal((view.match(/this\.app\.vault\.process\(/g) ?? []).length, 1,
    "the view keeps a single file-write entry point");
});
