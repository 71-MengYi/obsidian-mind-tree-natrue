import test from "node:test";
import assert from "node:assert/strict";
import { addNode, cloneDocument, createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import { assessExternalVersion, createManagedMindTreeSnapshot, sameManagedMindTreeSnapshot } from "../src/services/document-conflict";

test("generated heading, outline, prose, unknown YAML and Base64 wrapping are not version changes", () => {
  const document = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(document);
  const external = baseline.replace("schemaVersion: 2", "schemaVersion: 2\ncustom: retained")
    .replace("# Root", "# Renamed externally\n\nKeep this prose").replace("- Root", "- Changed outline");
  const result = assessExternalVersion(baseline, document, external);
  assert.equal(result.kind, "unchanged");
  if (result.kind === "unchanged") {
    assert.match(serializeMindTreeFile(result.document, external), /Keep this prose/);
    assert.match(serializeMindTreeFile(result.document, external), /custom: retained/);
  }
  const wrapped = baseline.replace(/(\x60\x60\x60mtn-data-gzip\r?\n)([A-Za-z0-9+/=\r\n]+?)(\r?\n\x60\x60\x60)/,
    (_all, start: string, data: string, end: string) => start + data.replace(/\s+/g, "").replace(/.{1,37}/g, "$&\n").trimEnd() + end);
  assert.ok(sameManagedMindTreeSnapshot(createManagedMindTreeSnapshot(baseline), createManagedMindTreeSnapshot(wrapped)));
});

test("pure filename/heading change and supported format normalization do not require choice", () => {
  const original = createEmptyDocument("Old");
  const baseline = serializeMindTreeFile(original);
  const renamed = cloneDocument(original);
  renamed.title = renamed.nodes[renamed.rootId]!.title = "New";
  assert.equal(assessExternalVersion(baseline, renamed, baseline.replace("# Old", "# New")).kind, "unchanged");
  assert.equal(assessExternalVersion(baseline, original, baseline.replace("schemaVersion: 2", "schemaVersion: 1")).kind, "unchanged");
});

test("remote-only and divergent machine data require explicit choice; identical results do not", () => {
  const original = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(original);
  const local = cloneDocument(original);
  const external = cloneDocument(original);
  addNode(local, local.rootId, "Local");
  addNode(external, external.rootId, "External");
  const remote = serializeMindTreeFile(external);
  assert.equal(assessExternalVersion(baseline, original, remote).kind, "choose");
  assert.equal(assessExternalVersion(baseline, local, remote).kind, "choose");
  assert.equal(assessExternalVersion(baseline, external, remote).kind, "unchanged");
});

test("all six settings are metadata updates rather than version choices", () => {
  const original = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(original);
  const local = cloneDocument(original);
  local.settings.layoutMode = "tree";
  const changes = { theme: "flat", layoutMode: "left", nodeShape: "square", connectionStyle: "straight", recursiveScan: true, collectionMode: "collect" } as const;
  for (const [key, value] of Object.entries(changes)) {
    const external = cloneDocument(original);
    Object.assign(external.settings, { [key]: value });
    const result = assessExternalVersion(baseline, local, serializeMindTreeFile(external));
    assert.equal(result.kind, "unchanged", key);
    if (result.kind === "unchanged") {
      assert.equal(result.document.settings[key as keyof typeof changes], value);
      if (key !== "layoutMode") assert.equal(result.document.settings.layoutMode, "tree");
    }
  }
});

test("identity is protected while a first assignment is accepted without version choice", () => {
  const original = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(original);
  const identified = cloneDocument(original);
  identified.documentId = "stable";
  const first = assessExternalVersion(baseline, original, serializeMindTreeFile(identified));
  assert.equal(first.kind, "unchanged");
  if (first.kind === "unchanged") assert.equal(first.document.documentId, "stable");
  const different = cloneDocument(identified);
  different.documentId = "other";
  assert.equal(assessExternalVersion(baseline, identified, serializeMindTreeFile(different)).kind, "blocked");
  const established = serializeMindTreeFile(identified);
  for (const doc of [original, different]) {
    assert.equal(assessExternalVersion(established, identified, serializeMindTreeFile(doc)).kind, "blocked");
  }
});

test("future version, missing or damaged machine data and invalid baseline prevent any overwrite", () => {
  const document = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(document);
  for (const text of ["", baseline.replace("schemaVersion: 2", "schemaVersion: 99"),
    baseline.replace(/(\x60\x60\x60mtn-data-gzip\r?\n)[A-Za-z0-9+/=]/, "$1!")]) {
    assert.equal(assessExternalVersion(baseline, document, text).kind, "blocked");
    assert.equal(assessExternalVersion(text, document, baseline).kind, "blocked");
  }
});
