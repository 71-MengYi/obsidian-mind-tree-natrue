import test from "node:test";
import assert from "node:assert/strict";
import { addNode, cloneDocument, createEmptyDocument } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile, mindTreeMachineDataFingerprint } from "../src/format/document";
import { acceptSettingsWrite, markSettingsEdited, mergeTreeSettings, TREE_SETTING_KEYS } from "../src/document-settings-state";
import { assessExternalVersion } from "../src/services/document-conflict";
import { DocumentSession } from "../src/services/document-session";

const parse = (source: string) => parseMindTreeFile(source).document;
const remove = (source: string, key: string) => source.replace(new RegExp(`^${key}:.*\\n`, "m"), "");

test("deleting each setting is metadata only and neither node saves nor reopen fill it back", () => {
  const base = serializeMindTreeFile(createEmptyDocument("Tree", "flat", "left", "square", "root", "straight"));
  for (const key of TREE_SETTING_KEYS) {
    const local = parse(base);
    const added = addNode(local, local.rootId, "Unsaved local node");
    const external = remove(base, key);
    const assessment = assessExternalVersion(base, local, external);
    assert.equal(assessment.kind, "unchanged", key);
    if (assessment.kind !== "unchanged") continue;
    assert.ok(assessment.document.nodes[added.id]);
    const saved = serializeMindTreeFile(assessment.document, external);
    assert.doesNotMatch(saved, new RegExp(`^${key}:`, "m"));
    assert.doesNotMatch(serializeMindTreeFile(parse(saved), saved), new RegExp(`^${key}:`, "m"));
  }
});

test("missing fields can be explicitly set to their default, then undo restores absence", () => {
  const source = remove(serializeMindTreeFile(createEmptyDocument("Tree")), "theme");
  const original = parse(source);
  const history = new DocumentSession();
  history.load(source);
  const selected = history.execute(original, (draft) => markSettingsEdited(draft, ["theme"]));
  const saved = serializeMindTreeFile(selected, source);
  assert.match(saved, /^theme: vibrant$/m);
  const acknowledged = acceptSettingsWrite(selected, selected, parse(saved), parse(saved)).document;
  const undone = history.undo(acknowledged)!;
  const undoSource = serializeMindTreeFile(undone, saved);
  assert.doesNotMatch(undoSource, /^theme:/m);
  const undoAck = acceptSettingsWrite(undone, undone, parse(undoSource), parse(undoSource)).document;
  const redone = history.redo(undoAck)!;
  assert.match(serializeMindTreeFile(redone, undoSource), /^theme: vibrant$/m);
});

test("local property edits merge by field, while a same-field disk change or deletion wins", () => {
  const base = serializeMindTreeFile(createEmptyDocument("Tree"));
  for (const external of [base.replace("theme: vibrant", "theme: ocean"), remove(base, "theme")]) {
    const local = parse(base);
    local.settings.theme = "flat";
    local.settings.layoutMode = "left";
    markSettingsEdited(local, ["theme", "layoutMode"]);
    const result = mergeTreeSettings(local, parse(base), parse(external));
    const saved = serializeMindTreeFile(result.document, external);
    assert.equal(parse(saved).settings.layoutMode, "left");
    assert.equal(parse(saved).settings.theme, parse(external).settings.theme);
    if (!/^theme:/m.test(external)) assert.doesNotMatch(saved, /^theme:/m);
    assert.equal(serializeMindTreeFile(local, external), saved);
  }
});

test("external properties are rebased into undo/redo without restoring deleted values", () => {
  const source = serializeMindTreeFile(createEmptyDocument("Tree", "flat"));
  const history = new DocumentSession();
  history.load(source);
  const original = parse(source);
  const modified = history.execute(original, (draft) => { addNode(draft, draft.rootId, "Local"); });
  const external = parse(remove(source, "theme"));
  const accepted = mergeTreeSettings(modified, original, external);
  history.rebaseSettings(external, accepted.changedSettings);
  const undo = history.undo(accepted.document)!;
  const redo = history.redo(undo)!;
  for (const doc of [undo, redo]) assert.doesNotMatch(serializeMindTreeFile(doc, remove(source, "theme")), /^theme:/m);
  assert.equal(Object.keys(undo.nodes).length, 1);
  assert.equal(Object.keys(redo.nodes).length, 2);
});

test("write acknowledgments retain property edits made during I/O but accept synced fields", () => {
  const base = serializeMindTreeFile(createEmptyDocument("Tree"));
  const attempted = parse(base);
  attempted.settings.theme = "flat";
  markSettingsEdited(attempted, ["theme"]);
  const output = serializeMindTreeFile(attempted, base);
  const current = cloneDocument(attempted);
  current.settings.theme = "ocean";
  markSettingsEdited(current, ["theme"]);
  const ack = acceptSettingsWrite(current, attempted, parse(output), parse(output));
  assert.equal(ack.document.settings.theme, "ocean");
  assert.match(serializeMindTreeFile(ack.document, output), /^theme: ocean$/m);
  const external = remove(output, "theme");
  const raced = acceptSettingsWrite(current, attempted, parse(output), parse(external));
  assert.equal(raced.document.settings.theme, "vibrant");
  assert.doesNotMatch(serializeMindTreeFile(raced.document, external), /^theme:/m);
});

test("runtime YAML bookkeeping never enters machine JSON or its fingerprint", () => {
  const original = parse(serializeMindTreeFile(createEmptyDocument("Tree")));
  const edited = cloneDocument(original);
  edited.settings.theme = "flat";
  markSettingsEdited(edited, ["theme"]);
  assert.equal(mindTreeMachineDataFingerprint(edited), mindTreeMachineDataFingerprint(original));
  assert.equal(Object.keys(edited).some((key) => /pending|raw|normalized/.test(key)), false);
});

test("unowned YAML keys named version/revision/checksum survive node writes", () => {
  const source = serializeMindTreeFile(createEmptyDocument("Tree"))
    .replace("schemaVersion: 2", "schemaVersion: 2\nversion: plugin-version\nrevision: 7\nchecksum: other-plugin");
  const doc = parse(source);
  addNode(doc, doc.rootId, "Local");
  const saved = serializeMindTreeFile(doc, source);
  assert.match(saved, /^version: plugin-version$/m);
  assert.match(saved, /^revision: 7$/m);
  assert.match(saved, /^checksum: other-plugin$/m);
});
