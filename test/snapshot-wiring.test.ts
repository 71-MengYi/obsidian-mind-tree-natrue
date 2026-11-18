import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate } from "../src/i18n/catalog";

/**
 * Version history wiring is DOM/Obsidian code, so these tests read the small,
 * stable seams instead of booting a view: the status-bar slot, the one capture
 * point after a verified write, and the session-owned restore path.
 */

const view = readFileSync(new URL("../src/ui/mind-tree-view.ts", import.meta.url), "utf8");
const bar = readFileSync(new URL("../src/ui/components/bottom-status-bar.ts", import.meta.url), "utf8");
const modal = readFileSync(new URL("../src/ui/modals/version-history-modal.ts", import.meta.url), "utf8");
const modalIndex = readFileSync(new URL("../src/ui/modals/index.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("../src/services/snapshot-store.ts", import.meta.url), "utf8");
const session = readFileSync(new URL("../src/services/document-session.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("status bar places a localized version-history button beside Save", () => {
  assert.match(bar, /readonly history: string;/);
  assert.match(bar, /readonly history: \(\) => void;/);
  const save = bar.indexOf("labels.save, actions.save");
  const history = bar.indexOf('"clock", labels.history, actions.history');
  assert.ok(save > 0, "the save button must exist");
  assert.ok(history > save, "the history button must follow the save button in the same panel");
  assert.match(view, /history: t\("statusBar\.history"\)/);
  assert.match(view, /history: \(\) => this\.openVersionHistory\(\)/);
});

test("the view captures exactly after a verified write and never on a no-op pass", () => {
  const queued = view.split("  private async performQueuedSave(")[1]?.split("  /** Event payloads can be stale")[0] ?? "";
  assert.ok(queued.length > 0, "performQueuedSave must remain a top-level method");
  const verified = queued.indexOf("if (!verified)");
  const capture = queued.indexOf("if (wroteBytes && serialized !== undefined) this.captureVersionSnapshot(written.document, serialized);");
  assert.ok(verified > 0, "the write must be verified against disk");
  assert.ok(capture > verified, "capture must run only after the verified write path");
  assert.ok(queued.indexOf("this.documentSession.markSaved(revision, latest)") < capture,
    "the baseline must be accepted before the snapshot is published");
  assert.match(view, /void this\.plugin\.snapshots\.capture\(\{/);
  assert.match(view, /source\s*\n\s*\}\);/);
  assert.match(main, /snapshots!: TreeSnapshotStore/);
  assert.match(main, /this\.snapshots = new TreeSnapshotStore\(this\.app\.vault\.adapter\)/);
});

test("restore is one undoable session replacement and failures only produce Notices", () => {
  assert.match(view, /private openVersionHistory\(\): void/);
  assert.match(view, /new VersionHistoryModal\(this\.app/);
  assert.match(view, /restoreSnapshotDocument\(snapshot/);
  assert.match(view, /this\.documentSession\.replaceDocument\(current, restored\.document\)/);
  assert.match(view, /this\.markDocumentDirty\(true, "document", false\)/);
  assert.match(view, /new Notice\(t\(restored\.reason === "mismatch" \? "snapshot\.mismatch" : "snapshot\.restoreInvalid"\)\)/);
  assert.match(session, /replaceDocument\(previous: MindTreeDocument, replacement: MindTreeDocument\)/);
  assert.match(session, /retainConfirmedSnapshot\(previous\);[\s\S]*?this\.markChanged\(\);/);
});

test("the modal reuses the read-only preview and never writes a file", () => {
  assert.match(modalIndex, /version-history-modal/);
  assert.match(modal, /new ReadOnlyTreePreview/);
  assert.match(modal, /t\("snapshot\.restore"\)/);
  assert.match(modal, /entry\.nodeCount/);
  assert.match(modal, /formatSize\(entry\.size\)/);
  assert.doesNotMatch(modal, /vault\.(modify|process|create|delete)|app\.vault/);
});

test("snapshots stay in the vault-root dot directory and remain mobile-safe", () => {
  assert.match(store, /export const SNAPSHOT_DIRECTORY = "\.mind-tree-nature-data\/snapshots";/);
  assert.doesNotMatch(store, /from "node:|\.obsidian|data\.json/);
  assert.match(store, /MAX_SNAPSHOT_SOURCE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(store, /MAX_SNAPSHOTS_PER_TREE = 30/);
  assert.match(store, /this\.lane\.serial\(/);
});

test("version-history labels exist in both languages", () => {
  const keys = [
    "statusBar.history", "snapshot.title", "snapshot.select", "snapshot.empty", "snapshot.loading",
    "snapshot.invalid", "snapshot.listFailed", "snapshot.entryMeta", "snapshot.entryLabel",
    "snapshot.selected", "snapshot.previewLabel", "snapshot.restore", "snapshot.restored",
    "snapshot.mismatch", "snapshot.restoreInvalid", "snapshot.restoreFailed", "snapshot.restoreBusy",
    "snapshot.sizeBytes", "snapshot.sizeKb", "snapshot.sizeMb"
  ] as const;
  for (const language of ["en", "zh"]) {
    for (const key of keys) {
      const value = translate(key, language);
      assert.notEqual(value, key, `${language}: ${key}`);
      assert.ok(value.trim(), `${language}: ${key}`);
    }
  }
  assert.equal(translate("statusBar.history", "zh"), "版本历史");
  assert.equal(translate("snapshot.restore", "en"), "Restore this version");
});
