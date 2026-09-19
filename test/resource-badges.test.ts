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

test("normalizes badge rules and rejects malformed or oversized values", () => {
  assert.equal(normalizeFileBadgeExtension(" .Tar.GZ "), "tar.gz");
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

  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.pdf", fileKind: "attachment" };
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
