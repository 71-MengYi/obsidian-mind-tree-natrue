import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { parse as parseYaml } from "yaml";
import { addNode, createEmptyDocument, renameNode } from "../src/domain/tree";
import {
  DATA_END,
  DATA_NOTICE,
  DATA_START,
  MindTreeFormatError,
  createMindTreeFile,
  parseMindTreeFile,
  serializeMindTreeFile
} from "../src/format/document";
import { CURRENT_MIND_TREE_SCHEMA_VERSION } from "../src/format/migrations";
import { OUTLINE_END } from "../src/format/outline";
import { normalizeConnectionStyle, normalizeNodeShape } from "../src/document-settings";

test("round-trips YAML document settings outside the compressed data section", () => {
  const document = createEmptyDocument("Project");
  document.settings.layoutMode = "radial";
  document.settings.recursiveScan = true;
  document.settings.collectionMode = "root";
  document.settings.theme = "midnight";
  document.settings.connectionStyle = "orthogonal-dashed";
  document.settings.nodeShape = "borderless";
  document.unknownFields = { viewport: { x: 12, y: 34, zoom: 2 } };
  const note = addNode(document, document.rootId, "Requirements");
  note.resource = {
    type: "file",
    resourceId: "018f1f15-6314-78f8-9756-aa1e3f28e63f",
    pathHint: "notes/Requirements.md",
    fileKind: "note",
    fileSubtype: "excalidraw"
  };
  const serialized = serializeMindTreeFile(document);

  const yamlText = /^---\n([\s\S]*?)\n---/.exec(serialized)?.[1];
  assert.ok(yamlText);
  const frontmatter = parseYaml(yamlText) as Record<string, unknown>;
  assert.equal(frontmatter["documentId"], undefined);
  assert.equal(frontmatter["schemaVersion"], CURRENT_MIND_TREE_SCHEMA_VERSION);
  assert.equal(frontmatter["layoutMode"], document.settings.layoutMode);
  assert.equal(frontmatter["recursiveScan"], document.settings.recursiveScan);
  assert.equal(frontmatter["collectionMode"], document.settings.collectionMode);
  assert.equal(frontmatter["theme"], document.settings.theme);
  assert.equal(frontmatter["connectionStyle"], document.settings.connectionStyle);
  assert.equal(frontmatter["nodeShape"], document.settings.nodeShape);
  assert.equal(frontmatter["mindTree"], undefined);
  assert.equal(frontmatter["mind-tree-nature"], undefined);
  assert.equal(frontmatter["payload"], undefined);
  assert.ok(serialized.indexOf(OUTLINE_END) < serialized.indexOf(DATA_NOTICE));
  assert.ok(serialized.indexOf(DATA_NOTICE) < serialized.indexOf(DATA_START));
  assert.ok(serialized.indexOf(DATA_START) < serialized.indexOf(DATA_END));
  assert.match(serialized, /```mtn-data-gzip\n[A-Za-z0-9+/=\n]+\n```/);
  assert.doesNotMatch(serialized, /"nodes"\s*:/);
  const encoded = /```mtn-data-gzip\n([A-Za-z0-9+/=\n]+)\n```/.exec(serialized)?.[1];
  assert.ok(encoded);
  const machineData = JSON.parse(strFromU8(gunzipSync(Buffer.from(encoded.replace(/\s+/g, ""), "base64")))) as Record<string, unknown>;
  assert.equal(machineData["settings"], undefined);
  assert.equal(machineData["viewport"], undefined);
  assert.equal(machineData["documentId"], undefined);

  const parsed = parseMindTreeFile(serialized);
  assert.equal(parsed.document.title, document.title);
  const parsedResource = parsed.document.nodes[note.id]?.resource;
  assert.equal(parsedResource?.type, "file");
  if (parsedResource?.type === "file") {
    assert.equal(parsedResource.fileSubtype, "excalidraw");
    assert.equal(parsedResource.fileKind, "note");
  }
  assert.equal(parsed.document.nodes[note.id]?.titleSync, "bidirectional");
  assert.equal(parsed.document.settings.layoutMode, "radial");
  assert.equal(parsed.document.settings.recursiveScan, true);
  assert.equal(parsed.document.settings.collectionMode, "root");
  assert.equal(parsed.document.settings.theme, "midnight");
  assert.equal(parsed.document.settings.connectionStyle, "orthogonal-dashed");
  assert.equal(parsed.document.settings.nodeShape, "borderless");
  assert.equal(parsed.document.documentId, undefined);
});

test("new files receive the supplied global default theme as a YAML setting", () => {
  const source = createMindTreeFile("Ocean plan", "ocean");
  assert.match(source, /^---\nschemaVersion: 2\nlayoutMode: balanced\nrecursiveScan: false\ncollectionMode: ask\ntheme: ocean\nconnectionStyle: theme\nnodeShape: rounded\n---/);
  assert.doesNotMatch(source, /\ndocumentId:/);
  assert.equal(parseMindTreeFile(source).document.settings.theme, "ocean");
});

test("neutral elevation themes parse and serialize as ordinary YAML theme values", () => {
  for (const theme of ["flat", "minimal", "floating"] as const) {
    const source = createMindTreeFile(`${theme} plan`, theme);
    assert.match(source, new RegExp(`\\ntheme: ${theme}\\n`));
    const parsed = parseMindTreeFile(source);
    assert.equal(parsed.document.settings.theme, theme);
    assert.match(serializeMindTreeFile(parsed.document), new RegExp(`\\ntheme: ${theme}\\n`));
  }
});

test("new files receive the supplied global default layout as a YAML setting", () => {
  const source = createMindTreeFile("Tree plan", "vibrant", "tree");
  assert.match(source, /^---\nschemaVersion: 2\nlayoutMode: tree\nrecursiveScan: false\ncollectionMode: ask\ntheme: vibrant\nconnectionStyle: theme\nnodeShape: rounded\n---/);
  assert.equal(parseMindTreeFile(source).document.settings.layoutMode, "tree");
});

test("a linked schema-v2 tree persists its optional documentId", () => {
  const document = createEmptyDocument("Linked tree");
  document.documentId = "018f1f15-3be0-7b0b-8fc8-688a48a0f542";
  const source = serializeMindTreeFile(document);
  assert.match(source, /^---\ndocumentId: 018f1f15-3be0-7b0b-8fc8-688a48a0f542\nschemaVersion: 2\n/);
  assert.equal(parseMindTreeFile(source).document.documentId, document.documentId);
});

test("new files receive the supplied global default node shape as a YAML setting", () => {
  const source = createMindTreeFile("Borderless plan", "vibrant", "balanced", "borderless");
  assert.match(source, /\nnodeShape: borderless\n/);
  assert.equal(parseMindTreeFile(source).document.settings.nodeShape, "borderless");
});

test("removed capsule and sketch settings fall back to rounded without a schema migration", () => {
  for (const removedShape of ["capsule", "sketch"]) {
    const legacy = createMindTreeFile("Old shape").replace("nodeShape: rounded", `nodeShape: ${removedShape}`);
    const parsed = parseMindTreeFile(legacy, { defaultNodeShape: "rounded" });
    assert.equal(parsed.migratedFromSchemaVersion, undefined);
    assert.equal(parsed.defaultedDocumentSettings, true);
    assert.equal(parsed.document.settings.nodeShape, "rounded");
    assert.match(serializeMindTreeFile(parsed.document, legacy), /\nnodeShape: rounded\n/);
    assert.equal(normalizeNodeShape(removedShape), "rounded");
  }
});

test("invalid connection styles use the global default without a schema migration", () => {
  const invalid = createMindTreeFile("Invalid line")
    .replace("connectionStyle: theme", "connectionStyle: unsupported");
  const parsed = parseMindTreeFile(invalid, { defaultConnectionStyle: "smooth-dashed" });

  assert.equal(parsed.migratedFromSchemaVersion, undefined);
  assert.equal(parsed.defaultedDocumentSettings, true);
  assert.equal(parsed.document.settings.connectionStyle, "smooth-dashed");
  assert.match(serializeMindTreeFile(parsed.document, invalid), /\nconnectionStyle: smooth-dashed\n/);
  assert.equal(normalizeConnectionStyle("unsupported", "orthogonal"), "orthogonal");
});

test("new files receive the supplied global default collection strategy as a YAML setting", () => {
  const source = createMindTreeFile("Quiet tree", "vibrant", "balanced", "rounded", "off");
  assert.match(source, /\ncollectionMode: off\n/);
  assert.equal(parseMindTreeFile(source).document.settings.collectionMode, "off");
});

test("new files receive the supplied global default connection style as a YAML setting", () => {
  const source = createMindTreeFile(
    "Straight plan",
    "vibrant",
    "balanced",
    "rounded",
    "ask",
    "straight"
  );
  assert.match(source, /\nconnectionStyle: straight\n/);
  assert.equal(parseMindTreeFile(source).document.settings.connectionStyle, "straight");
});

test("migrates the unversioned v1 baseline through the central migration factory", () => {
  const current = createMindTreeFile("Migrated tree", "vibrant", "balanced", "rounded");
  const v1 = current
    .replace(/^schemaVersion:.*\n/m, "")
    .replace(/^nodeShape:.*\n/m, "")
    .replace(/^collectionMode:.*\n/m, "")
    .replace(/^connectionStyle:.*\n/m, "");
  const parsed = parseMindTreeFile(v1, {
    defaultNodeShape: "borderless",
    defaultCollectionMode: "root",
    defaultConnectionStyle: "orthogonal"
  });

  assert.equal(parsed.migratedFromSchemaVersion, 1);
  assert.equal(parsed.defaultedDocumentSettings, true);
  assert.equal(parsed.document.settings.nodeShape, "borderless");
  assert.equal(parsed.document.settings.collectionMode, "root");
  assert.equal(parsed.document.settings.connectionStyle, "orthogonal");
  const upgraded = serializeMindTreeFile(parsed.document, v1);
  assert.match(upgraded, /\nschemaVersion: 2\n/);
  assert.match(upgraded, /\nnodeShape: borderless\n/);
  assert.match(upgraded, /\ncollectionMode: root\n/);
  assert.match(upgraded, /\nconnectionStyle: orthogonal\n/);
});

test("fills a missing collection strategy without invoking a version migration", () => {
  const currentWithoutCollection = createMindTreeFile("Collected tree")
    .replace(/^collectionMode:.*\n/m, "");
  const parsed = parseMindTreeFile(currentWithoutCollection, { defaultCollectionMode: "collect" });

  assert.equal(parsed.migratedFromSchemaVersion, undefined);
  assert.equal(parsed.defaultedDocumentSettings, true);
  assert.equal(parsed.document.settings.collectionMode, "collect");
});

test("rejects schemas older than v1 or newer than the current migration factory", () => {
  const current = createMindTreeFile("Versioned tree");
  assert.throws(
    () => parseMindTreeFile(current.replace("schemaVersion: 2", "schemaVersion: 0")),
    /earliest supported v1/i
  );
  assert.throws(
    () => parseMindTreeFile(current.replace("schemaVersion: 2", "schemaVersion: 99")),
    /newer than supported v2/i
  );
});

test("preserves an explicit per-node filename synchronization opt-out", () => {
  const document = createEmptyDocument("Project");
  const note = addNode(document, document.rootId, "Independent name");
  note.resource = {
    type: "file",
    resourceId: "018f1f15-6314-78f8-9756-aa1e3f28e63f",
    pathHint: "notes/File name.md",
    fileKind: "note"
  };
  note.titleSync = "off";
  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  assert.equal(parsed.document.nodes[note.id]?.titleSync, "off");
});

test("updates the generated H1 when the filename-derived root title changes", () => {
  const document = createEmptyDocument("Old name");
  const original = serializeMindTreeFile(document);
  renameNode(document, document.rootId, "Renamed tree");
  const renamed = serializeMindTreeFile(document, original);

  assert.match(renamed, /\n# Renamed tree\n/);
  assert.doesNotMatch(renamed, /\n# Old name\n/);
});

test("preserves unrelated frontmatter and Markdown outside generated sections", () => {
  const document = createEmptyDocument("Project");
  const first = serializeMindTreeFile(document);
  const customized = first
    .replace("schemaVersion: 2", "schemaVersion: 2\ntags:\n  - planning")
    .replace("# Project", "Owner notes stay here.\n\n# Project");
  addNode(document, document.rootId, "New child");
  const saved = serializeMindTreeFile(document, customized);
  assert.match(saved, /^---\nschemaVersion: 2\n/);
  assert.doesNotMatch(saved, /\ndocumentId:/);
  assert.match(saved, /tags:\n\s+- planning/);
  assert.match(saved, /Owner notes stay here\./);
  assert.match(saved, /- New child/);
  assert.equal((saved.match(new RegExp(DATA_NOTICE, "g")) ?? []).length, 1);
  assert.equal((saved.match(new RegExp(DATA_START, "g")) ?? []).length, 1);
});

test("fills missing current YAML properties from supplied defaults", () => {
  const current = createMindTreeFile("Defaults");
  const missingSettings = current
    .replace(/^layoutMode:.*\n/m, "")
    .replace(/^recursiveScan:.*\n/m, "")
    .replace(/^collectionMode:.*\n/m, "")
    .replace(/^theme:.*\n/m, "")
    .replace(/^connectionStyle:.*\n/m, "")
    .replace(/^nodeShape:.*\n/m, "");
  const parsed = parseMindTreeFile(missingSettings, {
    defaultLayoutMode: "left",
    defaultTheme: "ocean",
    defaultNodeShape: "borderless",
    defaultCollectionMode: "off",
    defaultConnectionStyle: "smooth-dashed"
  });

  assert.equal(parsed.defaultedDocumentSettings, true);
  assert.deepEqual(parsed.document.settings, {
    layoutMode: "left",
    recursiveScan: false,
    collectionMode: "off",
    theme: "ocean",
    connectionStyle: "smooth-dashed",
    nodeShape: "borderless"
  });
});

test("rejects removed legacy file formats", () => {
  const document = createEmptyDocument("Legacy");
  const legacyDocumentId = "legacy-document-id";
  const codeBlock = `# Legacy\n\n\`\`\`mtn-data\n${JSON.stringify(document)}\n\`\`\`\n`;
  const frontmatterPayload = `---\nmind-tree-nature:\n  documentId: ${legacyDocumentId}\n  rootId: ${document.rootId}\n  nodes: {}\n---\n`;
  const current = serializeMindTreeFile(document);
  const nestedDocumentSettings = current
    .replace(
      /^layoutMode:.*\nrecursiveScan:.*\ncollectionMode:.*\ntheme:.*\nconnectionStyle:.*\nnodeShape:.*\n/m,
      "mindTree:\n  layoutMode: balanced\n  recursiveScan: false\n  collectionMode: ask\n  theme: vibrant\n  connectionStyle: theme\n  nodeShape: rounded\n"
    );
  assert.throws(() => parseMindTreeFile(codeBlock), /compressed data section/i);
  assert.throws(() => parseMindTreeFile(frontmatterPayload), /compressed data section/i);
  assert.throws(() => parseMindTreeFile(nestedDocumentSettings), /nested mind tree settings are no longer supported/i);
});

test("refuses missing, corrupted, or structurally invalid machine data", () => {
  assert.throws(() => parseMindTreeFile("# Plain note\n"), MindTreeFormatError);
  const missingData = "---\ndocumentId: doc\n---\n\n# No data\n";
  assert.throws(() => parseMindTreeFile(missingData), /compressed data section/i);
  const corrupted = `---\ndocumentId: doc\nlayoutMode: balanced\nrecursiveScan: false\ntheme: vibrant\n---\n\n${DATA_START}\n\`\`\`mtn-data-gzip\nbm90LWd6aXA=\n\`\`\`\n${DATA_END}\n`;
  assert.throws(() => parseMindTreeFile(corrupted), /cannot be decoded/i);
  const invalidPayload = Buffer.from(gzipSync(strToU8(JSON.stringify({
    title: "Broken",
    rootId: "absent",
    nodes: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  })))).toString("base64");
  const invalid = `---\ndocumentId: doc\nlayoutMode: balanced\nrecursiveScan: false\ntheme: vibrant\n---\n\n${DATA_START}\n\`\`\`mtn-data-gzip\n${invalidPayload}\n\`\`\`\n${DATA_END}\n`;
  assert.throws(() => parseMindTreeFile(invalid), /structural validation/i);
});

test("rejects executable URL protocols in compressed data", () => {
  const document = createEmptyDocument("Unsafe URL");
  const node = addNode(document, document.rootId, "Bad link");
  node.resource = { type: "url", url: "javascript:alert(1)" };
  const unsafe = serializeMindTreeFile(document);
  assert.throws(() => parseMindTreeFile(unsafe), /only support http and https/i);
});

test("moves unreachable nodes into compressed recovery data instead of dropping them", () => {
  const document = createEmptyDocument("Recovery");
  const orphan = addNode(document, document.rootId, "Orphan");
  document.nodes[document.rootId]!.childIds = [];
  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  assert.equal(parsed.document.nodes[orphan.id], undefined);
  const recovery = parsed.document.unknownFields?.["recovery"] as { unreachableNodes?: Record<string, unknown> };
  assert.ok(recovery.unreachableNodes?.[orphan.id]);

  const reparsed = parseMindTreeFile(serializeMindTreeFile(parsed.document));
  const savedRecovery = reparsed.document.unknownFields?.["recovery"] as { unreachableNodes?: Record<string, unknown> };
  assert.ok(savedRecovery.unreachableNodes?.[orphan.id]);
});
