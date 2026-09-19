import test from "node:test";
import assert from "node:assert/strict";
import { addNode, cloneDocument, createEmptyDocument } from "../src/domain/tree";
import { serializeMindTreeFile } from "../src/format/document";
import {
  createManagedMindTreeSnapshot,
  externalMergeWouldReplaceLocal,
  mergeMindTreeExternalChange,
  rebaseMindTreeDocument,
  sameManagedMindTreeSnapshot
} from "../src/services/document-conflict";
import { DocumentSession } from "../src/services/document-session";

test("generated text, prose, unknown Frontmatter and Base64 wrapping do not conflict", () => {
  const document = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(document);
  const externalText = baseline
    .replace("schemaVersion: 2", "schemaVersion: 2\nexternalProperty: retained")
    .replace("# Root", "# Renamed by another plugin\n\nExternal prose")
    .replace("- Root", "- Disposable outline text");

  const result = mergeMindTreeExternalChange(baseline, document, externalText);
  assert.equal(result.kind, "merged");
  if (result.kind !== "merged") return;
  assert.equal(
    sameManagedMindTreeSnapshot(
      createManagedMindTreeSnapshot(baseline),
      createManagedMindTreeSnapshot(externalText)
    ),
    true
  );
  const saved = serializeMindTreeFile(result.document, externalText);
  assert.match(saved, /externalProperty: retained/);
  assert.match(saved, /External prose/);

  const rewrapped = baseline.replace(
    /(```mtn-data-gzip\r?\n)([A-Za-z0-9+/=\r\n]+?)(\r?\n```)/,
    (_whole, opening: string, payload: string, closing: string) =>
      `${opening}${payload.replace(/\s+/g, "").replace(/.{1,37}/g, "$&\n").trimEnd()}${closing}`
  );
  assert.equal(
    sameManagedMindTreeSnapshot(
      createManagedMindTreeSnapshot(baseline),
      createManagedMindTreeSnapshot(rewrapped)
    ),
    true
  );
});

test("external managed replacement is distinguished from an already-identical result", () => {
  const baselineDocument = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(baselineDocument);
  const external = cloneDocument(baselineDocument);
  addNode(external, external.rootId, "Remote");
  const result = mergeMindTreeExternalChange(
    baseline,
    baselineDocument,
    serializeMindTreeFile(external, baseline)
  );
  assert.equal(result.kind, "merged");
  if (result.kind !== "merged") return;

  assert.equal(externalMergeWouldReplaceLocal(result, baselineDocument), true);
  assert.equal(externalMergeWouldReplaceLocal(result, external), false);
});

test("an external generated heading update does not conflict with a local filename-title sync", () => {
  const baselineDocument = createEmptyDocument("Old name");
  const baseline = serializeMindTreeFile(baselineDocument);
  const local = cloneDocument(baselineDocument);
  local.title = "New name";
  local.nodes[local.rootId]!.title = "New name";
  const externalHeading = baseline.replace("# Old name", "# New name");

  const result = mergeMindTreeExternalChange(baseline, local, externalHeading);
  assert.equal(result.kind, "merged");
  if (result.kind !== "merged") return;
  assert.equal(result.document.title, "New name");
  assert.match(serializeMindTreeFile(result.document, externalHeading), /# New name/);
});

test("a supported schema normalization is validation, not a content conflict", () => {
  const document = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(document);
  const supportedOlderHeader = baseline.replace("schemaVersion: 2", "schemaVersion: 1");
  assert.equal(mergeMindTreeExternalChange(baseline, document, supportedOlderHeader).kind, "merged");
});

test("machine data uses a three-way merge and conflicts only on divergent edits", () => {
  const baselineDocument = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(baselineDocument);
  const local = cloneDocument(baselineDocument);
  addNode(local, local.rootId, "Local");

  const externalOnly = cloneDocument(baselineDocument);
  addNode(externalOnly, externalOnly.rootId, "External");
  const externalSource = serializeMindTreeFile(externalOnly, baseline);
  assert.equal(mergeMindTreeExternalChange(baseline, baselineDocument, externalSource).kind, "merged");

  const divergent = mergeMindTreeExternalChange(baseline, local, externalSource);
  assert.equal(divergent.kind, "conflict");
  if (divergent.kind === "conflict") {
    assert.ok(divergent.reasons.some((reason) => reason.kind === "machine-data"));
  }

  const sameSource = serializeMindTreeFile(local, baseline);
  const same = mergeMindTreeExternalChange(baseline, local, sameSource);
  assert.equal(same.kind, "merged");
});

test("six YAML settings merge independently and same-field divergence conflicts", () => {
  const baselineDocument = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(baselineDocument);
  const local = cloneDocument(baselineDocument);
  local.settings.layoutMode = "tree";
  const external = cloneDocument(baselineDocument);
  external.settings.theme = "ocean";

  const merged = mergeMindTreeExternalChange(
    baseline,
    local,
    serializeMindTreeFile(external, baseline)
  );
  assert.equal(merged.kind, "merged");
  if (merged.kind === "merged") {
    assert.equal(merged.document.settings.layoutMode, "tree");
    assert.equal(merged.document.settings.theme, "ocean");
  }

  const conflictingExternal = cloneDocument(baselineDocument);
  conflictingExternal.settings.layoutMode = "left";
  const conflict = mergeMindTreeExternalChange(
    baseline,
    local,
    serializeMindTreeFile(conflictingExternal, baseline)
  );
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") {
    assert.ok(conflict.reasons.some((reason) =>
      reason.kind === "document-setting" && reason.property === "layoutMode"));
  }
});

test("document identity is protected independently from machine data", () => {
  const baselineDocument = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(baselineDocument);
  const local = cloneDocument(baselineDocument);
  local.documentId = "local-id";
  const external = cloneDocument(baselineDocument);
  external.documentId = "external-id";

  const conflict = mergeMindTreeExternalChange(
    baseline,
    local,
    serializeMindTreeFile(external, baseline)
  );
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") {
    assert.ok(conflict.reasons.some((reason) => reason.kind === "document-id"));
  }

  const adopted = mergeMindTreeExternalChange(
    baseline,
    baselineDocument,
    serializeMindTreeFile(external, baseline)
  );
  assert.equal(adopted.kind, "merged");
  if (adopted.kind === "merged") assert.equal(adopted.document.documentId, "external-id");

  const established = cloneDocument(baselineDocument);
  established.documentId = "established-id";
  const establishedSource = serializeMindTreeFile(established, baseline);
  const replaced = cloneDocument(established);
  replaced.documentId = "unexpected-id";
  const dangerousReplacement = mergeMindTreeExternalChange(
    establishedSource,
    established,
    serializeMindTreeFile(replaced, establishedSource)
  );
  assert.equal(dangerousReplacement.kind, "conflict");
  if (dangerousReplacement.kind === "conflict") {
    assert.ok(dangerousReplacement.reasons.some((reason) => reason.kind === "document-id"));
  }
});

test("invalid schema or compressed data blocks automatic overwrite", () => {
  const document = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(document);
  const future = baseline.replace("schemaVersion: 2", "schemaVersion: 99");
  const damaged = baseline.replace(
    /(```mtn-data-gzip\r?\n)[A-Za-z0-9+/=]/,
    "$1!"
  );

  for (const source of [future, damaged]) {
    const result = mergeMindTreeExternalChange(baseline, document, source);
    assert.equal(result.kind, "conflict");
    if (result.kind === "conflict") {
      assert.ok(result.reasons.some((reason) => reason.kind === "invalid-external"));
    }
  }
});

test("history rebase keeps local setting undo while retaining accepted external machine data", () => {
  const baselineDocument = createEmptyDocument("Root");
  const baseline = serializeMindTreeFile(baselineDocument);
  const session = new DocumentSession();
  session.load(baseline);
  const local = session.execute(baselineDocument, (draft) => { draft.settings.layoutMode = "tree"; });
  const external = cloneDocument(baselineDocument);
  const externalNode = addNode(external, external.rootId, "External");
  const result = mergeMindTreeExternalChange(baseline, local, serializeMindTreeFile(external, baseline));
  assert.equal(result.kind, "merged");
  if (result.kind !== "merged") return;

  session.rebaseHistory((snapshot) => rebaseMindTreeDocument(snapshot, result.rebase));
  const undone = session.undo(result.document);
  assert.ok(undone?.nodes[externalNode.id]);
  assert.equal(undone?.settings.layoutMode, "balanced");
});
