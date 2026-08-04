import test from "node:test";
import assert from "node:assert/strict";
import { DragDropController, extractVaultPathCandidates } from "../src/ui/file-drop";

test("extracts internal Obsidian paths from links and application URIs", () => {
  assert.deepEqual(extractVaultPathCandidates([
    "[[notes/Project plan.md|Plan]]\n![[assets/mockup.png]]",
    "obsidian://open?vault=Vault&file=notes%2FMeeting.md",
    "app://obsidian.md/Vault/files/report.pdf"
  ], "Vault"), [
    "notes/Project plan.md",
    "assets/mockup.png",
    "notes/Meeting.md",
    "files/report.pdf"
  ]);
});

test("extracts path fields from custom JSON drag payloads and ignores external URLs", () => {
  assert.deepEqual(extractVaultPathCandidates([
    JSON.stringify({ files: [{ path: "docs/A.md" }, { filePath: "images/B.png" }] }),
    "https://example.com/file.pdf",
    "file:///C:/outside/file.pdf"
  ], "Vault"), ["docs/A.md", "images/B.png"]);
});

test("unsafe or excessively nested structured drag data is ignored", () => {
  let nested: unknown = { path: "must-not-resolve.md" };
  for (let index = 0; index <= 256; index += 1) nested = { child: nested };
  assert.deepEqual(extractVaultPathCandidates([
    JSON.stringify(nested),
    '{"constructor":{"path":"also-ignored.md"}}'
  ], "Vault"), []);
});

test("external-file batches confirm over 100 MiB and reject individual files over 1 GiB", () => {
  const controller = new DragDropController();
  const batch = controller.classifyExternalFiles([
    { name: "a.bin", size: 60 * 1024 ** 2 } as File,
    { name: "b.bin", size: 60 * 1024 ** 2 } as File,
    { name: "huge.bin", size: 1024 ** 3 + 1 } as File
  ]);
  assert.equal(batch.importable.length, 2);
  assert.equal(batch.rejected[0]?.name, "huge.bin");
  assert.equal(batch.needsConfirmation, true);
});
