import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { markSettingsEdited } from "../src/document-settings-state";
import {
  DATA_END,
  DATA_NOTICE,
  DATA_START,
  MindTreeFormatError,
  createMindTreeFile,
  parseMindTreeFile,
  serializeMindTreeFile
} from "../src/format/document";
import { OUTLINE_END, OUTLINE_START } from "../src/format/outline";

/** The compressed payload plus markers, with the header stripped off. */
function payloadOf(source: string): string {
  return source.slice(source.indexOf(DATA_NOTICE));
}

function countOf(source: string, needle: string): number {
  return (source.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

test("a payload without any Frontmatter opens instead of failing as damaged", () => {
  const canonical = createMindTreeFile("Headerless");
  const source = payloadOf(canonical);
  const parsed = parseMindTreeFile(source);

  assert.equal(parsed.headerStatus, "missing");
  assert.equal(parsed.document.title, "Headerless");
  assert.equal(parsed.migratedFromSchemaVersion, 1);
  const saved = serializeMindTreeFile(parsed.document, source);
  assert.match(saved, /^---\nschemaVersion: 2\n---\n\n/);
  assert.equal(parseMindTreeFile(saved).document.title, "Headerless");
});

test("blank lines before the Frontmatter do not hide it or the payload", () => {
  const canonical = createMindTreeFile("Indented header");
  const source = `\n\n${canonical}`;
  const parsed = parseMindTreeFile(source);

  assert.equal(parsed.headerStatus, "ok");
  assert.equal(parsed.document.title, "Indented header");
  const saved = serializeMindTreeFile(parsed.document, source);
  assert.ok(saved.startsWith("\n\n---\n"), "the blank preamble is preserved");
  assert.equal(parseMindTreeFile(saved).headerStatus, "ok");
});

test("an unparseable header keeps its exact bytes while the payload stays editable", () => {
  const canonical = createMindTreeFile("Damaged header");
  const header = "---\nkey: [1, 2\n---\n";
  const source = header + canonical.slice(canonical.indexOf("\n\n") + 2);
  const parsed = parseMindTreeFile(source);

  assert.equal(parsed.headerStatus, "unreadable");
  // Settings and identity are unavailable, so only runtime defaults apply.
  assert.equal(parsed.document.settings.theme, "vibrant");
  assert.equal(parsed.document.documentId, undefined);
  const saved = serializeMindTreeFile(parsed.document, source);
  assert.ok(saved.startsWith(header), "an unreadable header is never rebuilt");
  assert.equal(saved.slice(0, header.length), header);
  assert.ok(saved.includes("Damaged header"));
});

test("a non-mapping header is unreadable rather than fatal", () => {
  const canonical = createMindTreeFile("Scalar header");
  const source = `---\njust a scalar\n---\n${canonical.slice(canonical.indexOf("\n\n") + 2)}`;
  assert.equal(parseMindTreeFile(source).headerStatus, "unreadable");
  assert.equal(parseMindTreeFile(source).document.title, "Scalar header");
});

test("a gzip fence whose comment markers were lost is still located and repaired", () => {
  const canonical = createMindTreeFile("Marker damage");
  const source = canonical
    .replace(`${DATA_START}\n`, "")
    .replace(`\n${DATA_END}`, "");
  const parsed = parseMindTreeFile(source);

  assert.equal(parsed.headerStatus, "ok");
  assert.equal(parsed.document.title, "Marker damage");
  const saved = serializeMindTreeFile(parsed.document, source);
  assert.equal(countOf(saved, DATA_START), 1);
  assert.equal(countOf(saved, DATA_END), 1);
  assert.equal(countOf(saved, DATA_NOTICE), 1);
  assert.equal(parseMindTreeFile(saved).document.title, "Marker damage");
});

test("a missing outline marker pair is recreated once and never accumulates", () => {
  const canonical = createMindTreeFile("Lost outline");
  const withoutOutline = canonical
    .replace(`${OUTLINE_START}\n`, "")
    .replace(`\n${OUTLINE_END}`, "");
  const parsed = parseMindTreeFile(withoutOutline);
  let saved = serializeMindTreeFile(parsed.document, withoutOutline);

  for (let pass = 0; pass < 3; pass += 1) {
    const reparsed = parseMindTreeFile(saved);
    saved = serializeMindTreeFile(reparsed.document, saved);
  }
  assert.equal(countOf(saved, OUTLINE_START), 1);
  assert.equal(countOf(saved, OUTLINE_END), 1);
  assert.equal(countOf(saved, DATA_START), 1);
  assert.equal(countOf(saved, DATA_NOTICE), 1);
  assert.match(saved, /^---\nschemaVersion: 2\n---\n\n# Lost outline\n/);
});

test("two payload sections are refused instead of guessed", () => {
  const canonical = createMindTreeFile("Two payloads");
  const doubled = `${canonical}\n${payloadOf(createMindTreeFile("Other"))}`;

  assert.throws(() => parseMindTreeFile(doubled), /more than one mind tree compressed data section/i);
  const document = parseMindTreeFile(canonical).document;
  assert.throws(() => serializeMindTreeFile(document, doubled), MindTreeFormatError);
});

test("an unclosed fence never swallows the following well-formed section", () => {
  const canonical = createMindTreeFile("Unclosed");
  const damaged = canonical.replace(`\n\`\`\`\n${DATA_END}\n`, `\n${DATA_NOTICE}\n`) + `\n${payloadOf(canonical)}`;
  // The first fence has no closing line before the second section begins, so it
  // is skipped and the single complete section stays readable.
  const parsed = parseMindTreeFile(damaged);
  assert.equal(parsed.document.title, "Unclosed");
  const saved = serializeMindTreeFile(parsed.document, damaged);
  assert.equal(countOf(saved, DATA_NOTICE), 1);
  assert.equal(countOf(saved, DATA_END), 1);
  assert.equal(parseMindTreeFile(saved).document.title, "Unclosed");
});

test("prose after the payload section survives a save", () => {
  const canonical = createMindTreeFile("Trailing prose");
  const source = `${canonical}\nKeep this note.\n`;
  const parsed = parseMindTreeFile(source);
  const saved = serializeMindTreeFile(parsed.document, source);

  assert.ok(saved.includes("Keep this note."));
  assert.equal(countOf(saved, DATA_END), 1);
  assert.equal(parseMindTreeFile(saved).document.title, "Trailing prose");
});

test("a corrupt payload stays fatal", () => {
  const canonical = createMindTreeFile("Corrupt");
  const corrupted = canonical.replace(/(\n```mtn-data-gzip\r?\n)[A-Za-z0-9+/=]/, "$1!");
  assert.throws(() => parseMindTreeFile(corrupted), /cannot be decoded/i);
});

test("an empty document still round-trips through the region writer", () => {
  const document = createEmptyDocument("Round trip");
  const first = serializeMindTreeFile(document);
  const second = serializeMindTreeFile(parseMindTreeFile(first).document, first);
  assert.equal(second, first);
});

test("comments, blank lines and unowned YAML survive a node save byte for byte", () => {
  const canonical = createMindTreeFile("Commented");
  const source = canonical.replace("schemaVersion: 2",
    "schemaVersion: 2 # keep this comment\n# a whole comment line\ntags:\n  - planning");
  const parsed = parseMindTreeFile(source);
  const document = parsed.document;
  addNode(document, document.rootId, "New child");
  const saved = serializeMindTreeFile(document, source);

  assert.ok(saved.includes("# keep this comment"));
  assert.ok(saved.includes("# a whole comment line"));
  assert.ok(saved.includes("tags:\n  - planning"));
  assert.ok(saved.indexOf("schemaVersion: 2 # keep this comment") < saved.indexOf("tags:"));
  assert.ok(saved.includes("- New child"));
  assert.equal(parseMindTreeFile(saved).document.nodes[document.rootId]!.childIds.length, 1);
});

test("changing one owned property touches only that value", () => {
  const canonical = createMindTreeFile("Minimal diff");
  const source = canonical.replace("schemaVersion: 2", "schemaVersion: 2\ntheme: midnight # chosen by hand");
  const document = parseMindTreeFile(source, { defaultTheme: "midnight" }).document;
  document.settings.theme = "vibrant";
  markSettingsEdited(document, ["theme"]);
  const saved = serializeMindTreeFile(document, source);

  assert.match(saved, /^theme: vibrant # chosen by hand$/m);
  assert.ok(saved.includes("schemaVersion: 2\n"));
});

test("an identity is inserted without reordering the existing header", () => {
  const source = createMindTreeFile("Identity");
  const document = parseMindTreeFile(source).document;
  document.documentId = "018f1f15-3be0-7b0b-8fc8-688a48a0f542";
  const saved = serializeMindTreeFile(document, source);

  assert.match(saved, /^---\nschemaVersion: 2\ndocumentId: 018f1f15-3be0-7b0b-8fc8-688a48a0f542\n---\n/);
  assert.equal(parseMindTreeFile(saved).document.documentId, document.documentId);
});

test("a save with no document change returns identical bytes", () => {
  const canonical = createMindTreeFile("Stable");
  const source = canonical.replace("schemaVersion: 2", "schemaVersion: 2 # note");
  const parsed = parseMindTreeFile(source);
  assert.equal(serializeMindTreeFile(parsed.document, source), source);
});
