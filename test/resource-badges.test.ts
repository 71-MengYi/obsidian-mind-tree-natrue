import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { renderOutline } from "../src/format/outline";
import { renderBranchSvg } from "../src/services/export";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";
import {
  createResourceBadgePresentation,
  deriveFileBadgeExtension,
  fileBadgeExtensionCandidates,
  getNodeMarkerGeometry,
  normalizeFileBadgeAlias,
  normalizeFileBadgeExtension,
  resolveResourceBadges,
  type FileBadgeRules,
  type ResourceBadgeMeasurer
} from "../src/ui/resource-badges";

const emptyRules: FileBadgeRules = {
  ignoredFileBadgeExtensions: [],
  fileExtensionBadgeAliases: {}
};
const labels = { mindTree: "思维树", drawing: "绘图" };

test("derives complete non-Markdown suffixes after removing current and legacy resource IDs", () => {
  assert.equal(deriveFileBadgeExtension("files/report@Ab123.PDF"), "pdf");
  assert.equal(deriveFileBadgeExtension("files/archive.tar@Ab123.gz"), "tar.gz");
  assert.equal(deriveFileBadgeExtension("files/report.v2.pdf"), "v2.pdf");
  assert.equal(deriveFileBadgeExtension("files/image~mtn-0123456789.PNG"), "png");
  assert.equal(deriveFileBadgeExtension("files/.config.json"), "json");
  assert.equal(deriveFileBadgeExtension("files/.gitignore"), undefined);
  assert.equal(deriveFileBadgeExtension("files/README"), undefined);
  assert.deepEqual(fileBadgeExtensionCandidates("TAR.GZ"), ["tar.gz", "gz"]);
});

test("automatic suffix parsing stops at invalid whole segments without losing valid trailing extensions", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["files/资料.chapter_one.pdf", "pdf"],
    ["files/资料.chapter_one.tar.gz", "tar.gz"],
    ["files/report.v2.pdf", "v2.pdf"],
    ["files/report.final-version.pdf", "pdf"],
    ["files/report.c++.pdf", "pdf"],
    ["files/report.第1章.pdf", "pdf"],
    ["files/report.chapter one.pdf", "pdf"],
    ["files/report.other.chapter_one.V2.PDF", "v2.pdf"],
    ["files/report..pdf", "pdf"],
    ["files/archive.tar..gz", "gz"],
    ["files/archive.7z", "7z"],
    ["files/archive.001", "001"],
    ["files/archive.PaRt3.X7", "part3.x7"],
    ["files/archive.chapter_one.tar@Ab123.gz", "tar.gz"],
    ["files/archive.chapter_one.tar%Ab123.gz", "tar.gz"],
    ["files/archive.chapter_one.tar~mtn-0123456789.gz", "tar.gz"],
    ["files\\archive.chapter_one.tar@Ab123.GZ", "tar.gz"]
  ];
  for (const [path, expected] of cases) assert.equal(deriveFileBadgeExtension(path), expected, path);
});

test("invalid final suffixes are never trimmed, partially extracted or skipped", () => {
  for (const suffix of ["p_df", "p-df", "p+df", "p df", "中文", "pdf_", "pdf ", " pdf", "pdf\n", "pdf\t", "ＰＤＦ", ""]) {
    const path = `files/report.tar.${suffix}`;
    assert.equal(deriveFileBadgeExtension(path), undefined, JSON.stringify(path));
  }
});

test("automatic suffix parsing never includes stems and retains hidden-file and length boundaries", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["report.pdf", "pdf"],
    ["files.pdf/report", undefined],
    ["files/.gitignore", undefined],
    ["files/.config.json", "json"],
    ["files/.config.chapter_one.tar.gz", "tar.gz"],
    ["files/README", undefined],
    ["files/report.", undefined],
    ["files/report..", undefined],
    [`files/report.${"a".repeat(64)}`, "a".repeat(64)],
    [`files/report.${"a".repeat(65)}`, undefined],
    [`files/report.${"a".repeat(60)}.pdf`, `${"a".repeat(60)}.pdf`],
    [`files/report.${"a".repeat(61)}.pdf`, undefined],
    [`files/report.${"a".repeat(65)}_notes.pdf`, "pdf"]
  ];
  for (const [path, expected] of cases) assert.equal(deriveFileBadgeExtension(path), expected, path);
});

test("normalizes badge rules and rejects malformed or oversized values", () => {
  assert.equal(normalizeFileBadgeExtension(" .Tar.GZ "), "tar.gz");
  // Rule validation remains broader than automatic extraction; do not silently
  // discard a user's existing ignore/alias keys when this parser is tightened.
  assert.equal(normalizeFileBadgeExtension(" .Chapter_One.PDF "), "chapter_one.pdf");
  assert.equal(normalizeFileBadgeExtension("c++"), "c++");
  assert.equal(normalizeFileBadgeExtension("final-version.pdf"), "final-version.pdf");
  assert.equal(normalizeFileBadgeExtension("tar..gz"), undefined);
  assert.equal(normalizeFileBadgeExtension("pdf/zip"), undefined);
  assert.equal(normalizeFileBadgeExtension("__proto__"), undefined);
  assert.equal(normalizeFileBadgeExtension("a".repeat(65)), undefined);
  assert.equal(normalizeFileBadgeAlias("  Document  "), "Document");
  assert.equal(normalizeFileBadgeAlias("   "), undefined);
  assert.equal(normalizeFileBadgeAlias("绘".repeat(33)), undefined);
});

test("uses full-suffix aliases first and lets any matching ignore rule win", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Report");
  node.resource = {
    type: "file", resourceId: "report", pathHint: "reports/report.v2@Ab123.pdf", fileKind: "attachment"
  };

  assert.deepEqual(resolveResourceBadges(node, emptyRules, labels), [
    { kind: "extension", label: "V2.PDF" }
  ]);
  assert.deepEqual(resolveResourceBadges(node, {
    ignoredFileBadgeExtensions: [],
    fileExtensionBadgeAliases: { pdf: "Portable", "v2.pdf": "Report v2" }
  }, labels), [{ kind: "extension", label: "Report v2" }]);
  assert.deepEqual(resolveResourceBadges(node, {
    ignoredFileBadgeExtensions: [".PDF"],
    fileExtensionBadgeAliases: { "v2.pdf": "Report v2" }
  }, labels), []);
});

test("shortened suffixes share ignore and alias precedence without mutating saved rules", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Archive");
  node.resource = {
    type: "file", resourceId: "archive", pathHint: "files/archive.chapter_one.tar@Ab123.gz", fileKind: "attachment"
  };
  const rules: FileBadgeRules = {
    ignoredFileBadgeExtensions: ["chapter_one.tar.gz"],
    fileExtensionBadgeAliases: { "chapter_one.tar.gz": "Old rule", "tar.gz": "Archive", gz: "Gzip" }
  };
  const originalRules = structuredClone(rules);
  const originalDocument = structuredClone(document);
  assert.deepEqual(resolveResourceBadges(node, emptyRules, labels), [{ kind: "extension", label: "TAR.GZ" }]);
  assert.deepEqual(resolveResourceBadges(node, rules, labels), [{ kind: "extension", label: "Archive" }]);
  assert.deepEqual(createResourceBadgePresentation(rules, labels).resolve(node), [{ kind: "extension", label: "Archive" }]);
  assert.deepEqual(resolveResourceBadges(node, {
    ...rules, fileExtensionBadgeAliases: { gz: "Gzip" }
  }, labels), [{ kind: "extension", label: "Gzip" }]);
  for (const ignored of [".GZ", ".TAR.GZ"]) {
    const ignoredRules = { ...rules, ignoredFileBadgeExtensions: [ignored] };
    assert.deepEqual(resolveResourceBadges(node, ignoredRules, labels), []);
    assert.deepEqual(createResourceBadgePresentation(ignoredRules, labels).resolve(node), []);
  }
  assert.deepEqual(rules, originalRules);
  assert.deepEqual(document, originalDocument);
});

test("ordinary Markdown has no extension badge and special Markdown types keep only dedicated badges", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Linked");
  node.resource = { type: "file", resourceId: "note", pathHint: "notes/Linked.md", fileKind: "note" };
  assert.deepEqual(resolveResourceBadges(node, emptyRules, labels), []);

  node.resource.pathHint = "trees/Linked.mtn.md";
  assert.deepEqual(resolveResourceBadges(node, emptyRules, labels), [
    { kind: "mind-tree", label: "思维树" }
  ]);

  node.resource.pathHint = "drawings/Linked.md";
  node.resource.fileSubtype = "excalidraw";
  assert.deepEqual(resolveResourceBadges(node, emptyRules, labels), [
    { kind: "excalidraw", label: "绘图" }
  ]);
});

test("marker geometry uses measured badge boxes and adds gaps only for visible items", () => {
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "extension"
      ? { width: 23, height: 16 }
      : { width: 31, height: 18 }
  };
  const presentation = createResourceBadgePresentation(emptyRules, labels, measurer);
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "File");
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    resourceBadges: [], width: 0, height: 0
  });

  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.chapter_one.pdf", fileKind: "attachment" };
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    resourceBadges: [{ kind: "extension", label: "PDF" }],
    width: 25,
    height: 16
  });
  node.markers = [{ type: "progress", value: "todo" }];
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    resourceBadges: [{ kind: "extension", label: "PDF" }],
    width: 45,
    height: 18
  });
});

test("SVG export uses the same derived alias without adding it to the Markdown outline", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Archive");
  node.resource = {
    type: "file", resourceId: "archive", pathHint: "files/archive.tar@Ab123.gz", fileKind: "attachment"
  };
  const presentation = createResourceBadgePresentation({
    ignoredFileBadgeExtensions: [],
    fileExtensionBadgeAliases: { "tar.gz": "Bundle" }
  }, labels, { measure: () => ({ width: 40, height: 16 }) });
  const svg = renderBranchSvg(
    document, document.rootId, 240, "right", "theme", "vibrant", "rounded", "level",
    undefined, fallbackNodeTextMeasurer, presentation
  );
  assert.match(svg, /class="mtn-extension-marker"/);
  assert.match(svg, />Bundle<\/text>/);
  assert.doesNotMatch(renderOutline(document), /Bundle|extension/);
});

test("layout and export retain the same badge geometry after excluding filename segments", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Archive");
  node.resource = {
    type: "file", resourceId: "archive", pathHint: "files/archive.tar@Ab123.gz", fileKind: "attachment"
  };
  const presentation = createResourceBadgePresentation(emptyRules, labels, {
    measure: (badge) => ({ width: badge.label.length * 6 + 4, height: 16 })
  });
  const exportSvg = () => renderBranchSvg(
    document, document.rootId, 240, "right", "theme", "vibrant", "rounded", "level",
    undefined, fallbackNodeTextMeasurer, presentation
  );
  const originalGeometry = getNodeMarkerGeometry(node, presentation);
  const originalSvg = exportSvg();
  node.resource.pathHint = "files/archive.chapter_one.tar@Ab123.gz";
  const originalDocument = structuredClone(document);
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), originalGeometry);
  const svg = exportSvg();
  assert.equal(svg, originalSvg, "Node boxes, paths and labels must use the same shortened suffix");
  assert.match(svg, />TAR\.GZ<\/text>/);
  assert.doesNotMatch(svg, /CHAPTER_ONE/);
  assert.deepEqual(document, originalDocument, "Derived badges must not modify persisted node data");
});
