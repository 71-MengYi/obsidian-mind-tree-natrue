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
import { markSettingsEdited, TREE_SETTING_KEYS } from "../src/document-settings-state";

test("round-trips YAML document settings outside the compressed data section", () => {
  const document = createEmptyDocument("Project");
  document.settings.layoutMode = "radial";
  document.settings.recursiveScan = true;
  document.settings.collectionMode = "root";
  document.settings.theme = "midnight";
  document.settings.connectionStyle = "orthogonal-dashed";
  document.settings.nodeShape = "borderless";
  // Settings reach the file only as explicit per-tree choices.
  markSettingsEdited(document, TREE_SETTING_KEYS);
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

test("new files write no setting property and inherit the global default theme", () => {
  const source = createMindTreeFile("Ocean plan");
  assert.match(source, /^---\nschemaVersion: 2\n---/);
  assert.doesNotMatch(source, /\n(?:layoutMode|recursiveScan|collectionMode|theme|connectionStyle|nodeShape):/);
  assert.doesNotMatch(source, /\ndocumentId:/);
  assert.equal(parseMindTreeFile(source, { defaultTheme: "ocean" }).document.settings.theme, "ocean");
  assert.equal(parseMindTreeFile(source).document.settings.theme, "vibrant");
});

test("neutral elevation themes stay global until the tree chooses one explicitly", () => {
  for (const theme of ["flat", "minimal", "floating"] as const) {
    const source = createMindTreeFile(`${theme} plan`);
    assert.doesNotMatch(source, /^theme:/m);
    const parsed = parseMindTreeFile(source, { defaultTheme: theme });
    assert.equal(parsed.document.settings.theme, theme);
    markSettingsEdited(parsed.document, ["theme"]);
    assert.match(serializeMindTreeFile(parsed.document, source), new RegExp(`^theme: ${theme}$`, "m"));
  }
});

test("new files write no layout property and inherit the global default layout", () => {
  const source = createMindTreeFile("Tree plan");
  assert.doesNotMatch(source, /^layoutMode:/m);
  assert.equal(parseMindTreeFile(source, { defaultLayoutMode: "tree" }).document.settings.layoutMode, "tree");
  assert.equal(parseMindTreeFile(source).document.settings.layoutMode, "balanced");
});

test("a new tree keeps every setting absent across node edits and reopen", () => {
  const globals = { defaultTheme: "ocean", defaultLayoutMode: "tree" } as const;
  const created = createMindTreeFile("Fresh tree");
  const parsed = parseMindTreeFile(created, globals).document;
  assert.equal(parsed.settings.theme, "ocean");
  addNode(parsed, parsed.rootId, "First child");
  const saved = serializeMindTreeFile(parsed, created);

  assert.match(saved, /- First child/);
  assert.doesNotMatch(saved, /^(?:layoutMode|recursiveScan|collectionMode|theme|connectionStyle|nodeShape):/m);
  assert.equal(parseMindTreeFile(saved, globals).document.settings.theme, "ocean");
  assert.equal(parseMindTreeFile(saved, globals).document.settings.layoutMode, "tree");
});

test("an explicit per-tree choice pins that property while unset ones follow the globals", () => {
  const created = createMindTreeFile("Pinned tree");
  const chosen = parseMindTreeFile(created, { defaultTheme: "ocean" }).document;
  markSettingsEdited(chosen, ["theme"]);
  const saved = serializeMindTreeFile(chosen, created);

  assert.match(saved, /^theme: ocean$/m);
  const later = parseMindTreeFile(saved, { defaultTheme: "midnight", defaultLayoutMode: "radial" }).document;
  assert.equal(later.settings.theme, "ocean");
  assert.equal(later.settings.layoutMode, "radial");
});

test("a linked schema-v2 tree persists its optional documentId", () => {
  const document = createEmptyDocument("Linked tree");
  document.documentId = "018f1f15-3be0-7b0b-8fc8-688a48a0f542";
  const source = serializeMindTreeFile(document);
  assert.match(source, /^---\ndocumentId: 018f1f15-3be0-7b0b-8fc8-688a48a0f542\nschemaVersion: 2\n/);
  assert.equal(parseMindTreeFile(source).document.documentId, document.documentId);
});

test("new files write no node shape property and inherit the global default shape", () => {
  const source = createMindTreeFile("Borderless plan");
  assert.doesNotMatch(source, /^nodeShape:/m);
  assert.equal(parseMindTreeFile(source, { defaultNodeShape: "borderless" }).document.settings.nodeShape, "borderless");
  assert.equal(parseMindTreeFile(source).document.settings.nodeShape, "rounded");
});

test("removed capsule and sketch settings fall back to rounded without a schema migration", () => {
  for (const removedShape of ["capsule", "sketch"]) {
    const legacy = createMindTreeFile("Old shape")
      .replace("schemaVersion: 2", `schemaVersion: 2\nnodeShape: ${removedShape}`);
    const parsed = parseMindTreeFile(legacy, { defaultNodeShape: "rounded" });
    assert.equal(parsed.migratedFromSchemaVersion, undefined);
    assert.equal(parsed.defaultedDocumentSettings, true);
    assert.equal(parsed.document.settings.nodeShape, "rounded");
    assert.match(serializeMindTreeFile(parsed.document, legacy), new RegExp(`\\nnodeShape: ${removedShape}\\n`));
    assert.equal(normalizeNodeShape(removedShape), "rounded");
  }
});

test("invalid connection styles use the global default without a schema migration", () => {
  const invalid = createMindTreeFile("Invalid line")
    .replace("schemaVersion: 2", "schemaVersion: 2\nconnectionStyle: unsupported");
  const parsed = parseMindTreeFile(invalid, { defaultConnectionStyle: "smooth-dashed" });

  assert.equal(parsed.migratedFromSchemaVersion, undefined);
  assert.equal(parsed.defaultedDocumentSettings, true);
  assert.equal(parsed.document.settings.connectionStyle, "smooth-dashed");
  assert.match(serializeMindTreeFile(parsed.document, invalid), /\nconnectionStyle: unsupported\n/);
  assert.equal(normalizeConnectionStyle("unsupported", "orthogonal"), "orthogonal");
});

test("new files write no collection strategy and inherit the global default strategy", () => {
  const source = createMindTreeFile("Quiet tree");
  assert.doesNotMatch(source, /^collectionMode:/m);
  assert.equal(parseMindTreeFile(source, { defaultCollectionMode: "off" }).document.settings.collectionMode, "off");
  assert.equal(parseMindTreeFile(source).document.settings.collectionMode, "ask");
});

test("new files write no connection style and inherit the global default style", () => {
  const source = createMindTreeFile("Straight plan");
  assert.doesNotMatch(source, /^connectionStyle:/m);
  assert.equal(parseMindTreeFile(source, { defaultConnectionStyle: "straight" }).document.settings.connectionStyle, "straight");
  assert.equal(parseMindTreeFile(source).document.settings.connectionStyle, "theme");
});

test("migrates the unversioned v1 baseline through the central migration factory", () => {
  // v1 predates the "no settings by default" rule, so its file carried the
  // properties it had; only some of them are known to the current catalog.
  const versioned = createEmptyDocument("Migrated tree");
  markSettingsEdited(versioned, TREE_SETTING_KEYS);
  const v1 = serializeMindTreeFile(versioned)
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
  assert.doesNotMatch(upgraded, /\n(?:nodeShape|collectionMode|connectionStyle):/);
});

test("fills a missing collection strategy without invoking a version migration", () => {
  const currentWithoutCollection = createMindTreeFile("Collected tree");
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

test("fills missing current YAML properties from supplied defaults while keeping present ones", () => {
  const current = createMindTreeFile("Defaults")
    .replace("schemaVersion: 2", "schemaVersion: 2\ntheme: midnight");
  const parsed = parseMindTreeFile(current, {
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
    theme: "midnight",
    connectionStyle: "smooth-dashed",
    nodeShape: "borderless"
  });
  // Missing properties stay absent: a save must not fill them back in.
  assert.doesNotMatch(serializeMindTreeFile(parsed.document, current), /^(?:layoutMode|collectionMode|nodeShape):/m);
  assert.match(serializeMindTreeFile(parsed.document, current), /^theme: midnight$/m);
});

test("rejects removed legacy file formats", () => {
  const document = createEmptyDocument("Legacy");
  const legacyDocumentId = "legacy-document-id";
  const codeBlock = `# Legacy\n\n\`\`\`mtn-data\n${JSON.stringify(document)}\n\`\`\`\n`;
  const frontmatterPayload = `---\nmind-tree-nature:\n  documentId: ${legacyDocumentId}\n  rootId: ${document.rootId}\n  nodes: {}\n---\n`;
  const current = serializeMindTreeFile(document);
  const nestedDocumentSettings = current
    .replace(
      /^schemaVersion: 2\n/m,
      "schemaVersion: 2\nmindTree:\n  layoutMode: balanced\n  recursiveScan: false\n  collectionMode: ask\n  theme: vibrant\n  connectionStyle: theme\n  nodeShape: rounded\n"
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
