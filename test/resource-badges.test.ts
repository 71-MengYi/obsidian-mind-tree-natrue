import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import type { CustomMarkerDefinition } from "../src/domain/custom-markers";
import { renderOutline } from "../src/format/outline";
import { renderBranchSvg } from "../src/services/export";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";
import { layoutTree } from "../src/ui/layout";
import {
  createResourceBadgePresentation,
  deriveFileBadgeExtension,
  fallbackResourceBadgeMeasurer,
  fileBadgeExtensionCandidates,
  getNodeMarkerGeometry,
  MANUAL_MARKER_SIZE,
  NODE_MARKER_GAP,
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

test("Markdown without an alias has no extension badge and special types keep dedicated badges", () => {
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

test("Markdown aliases are opt-in and accept normalized md rule keys", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "笔记");
  node.resource = { type: "file", resourceId: "note", pathHint: "notes/笔记.MD", fileKind: "note" };
  const originalDocument = structuredClone(document);
  for (const key of ["md", ".MD", " .mD "]) {
    const rules = { ...emptyRules, fileExtensionBadgeAliases: { [key]: "笔记" } };
    const expected = [{ kind: "extension", label: "笔记" }];
    assert.deepEqual(resolveResourceBadges(node, rules, labels), expected);
    assert.deepEqual(createResourceBadgePresentation(rules, labels).resolve(node), expected);
  }
  for (const rules of [emptyRules, { ...emptyRules, fileExtensionBadgeAliases: { pdf: "附件", md: "   " } }]) {
    assert.deepEqual(resolveResourceBadges(node, rules, labels), []);
    assert.deepEqual(createResourceBadgePresentation(rules, labels).resolve(node), []);
  }
  assert.deepEqual(document, originalDocument, "Badge rules must not change the note's identity or classification");
});

test("compound Markdown aliases prefer the full suffix before falling back to md", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "笔记");
  node.resource = { type: "file", resourceId: "plugin-note", pathHint: "notes/笔记.Plugin.MD", fileKind: "note" };
  assert.equal(deriveFileBadgeExtension(node.resource.pathHint), "plugin.md");
  assert.deepEqual(fileBadgeExtensionCandidates("PLUGIN.MD"), ["plugin.md", "md"]);
  const cases: ReadonlyArray<readonly [FileBadgeRules, string | undefined]> = [
    [{ ...emptyRules, fileExtensionBadgeAliases: { ".PLUGIN.md": "插件文件", md: "笔记" } }, "插件文件"],
    [{ ...emptyRules, fileExtensionBadgeAliases: { md: "笔记" } }, "笔记"],
    [{ ...emptyRules, fileExtensionBadgeAliases: { "plugin.md": "插件文件" } }, "插件文件"],
    [{ ...emptyRules, fileExtensionBadgeAliases: { plugin: "不匹配" } }, undefined],
    [emptyRules, undefined]
  ];
  for (const [rules, alias] of cases) {
    const expected = alias === undefined ? [] : [{ kind: "extension", label: alias }];
    assert.deepEqual(resolveResourceBadges(node, rules, labels), expected);
    assert.deepEqual(createResourceBadgePresentation(rules, labels).resolve(node), expected);
  }
});

test("Markdown ignore rules take precedence over both full and final-suffix aliases", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Linked");
  node.resource = { type: "file", resourceId: "note", pathHint: "notes/Linked.plugin.md", fileKind: "note" };
  for (const ignored of [".MD", ".Plugin.MD"]) {
    const rules: FileBadgeRules = {
      ignoredFileBadgeExtensions: [ignored],
      fileExtensionBadgeAliases: { "plugin.md": "插件文件", md: "笔记" }
    };
    assert.deepEqual(resolveResourceBadges(node, rules, labels), []);
    assert.deepEqual(createResourceBadgePresentation(rules, labels).resolve(node), []);
  }
  node.resource.pathHint = "notes/Linked.md";
  assert.deepEqual(resolveResourceBadges(node, {
    ignoredFileBadgeExtensions: [".MD"], fileExtensionBadgeAliases: { md: "笔记" }
  }, labels), []);
});

test("dedicated mind-tree and drawing badges override Markdown aliases and ignore rules", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Linked");
  const rules: FileBadgeRules = {
    ignoredFileBadgeExtensions: ["md", "mtn.md", "excalidraw.md"],
    fileExtensionBadgeAliases: { md: "笔记", "mtn.md": "自定义导图", "excalidraw.md": "自定义绘图" }
  };
  const presentation = createResourceBadgePresentation(rules, labels);
  node.resource = { type: "file", resourceId: "tree", pathHint: "trees/Linked.mtn.md", fileKind: "note" };
  assert.deepEqual(resolveResourceBadges(node, rules, labels), [{ kind: "mind-tree", label: "思维树" }]);
  assert.deepEqual(presentation.resolve(node), [{ kind: "mind-tree", label: "思维树" }]);
  node.resource.fileSubtype = "excalidraw";
  for (const path of ["drawings/Linked.md", "drawings/Linked.excalidraw.md"]) {
    node.resource.pathHint = path;
    assert.deepEqual(resolveResourceBadges(node, rules, labels), [{ kind: "excalidraw", label: "绘图" }]);
    assert.deepEqual(presentation.resolve(node), [{ kind: "excalidraw", label: "绘图" }]);
  }
});

test("Markdown aliases add only measured badge width and never modify persisted data", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Linked");
  node.resource = { type: "file", resourceId: "note", pathHint: "notes/Linked.plugin.md", fileKind: "note" };
  const originalDocument = structuredClone(document);
  const originalOutline = renderOutline(document);
  const measurer: ResourceBadgeMeasurer = { measure: () => ({ width: 28, height: 16 }) };
  const hidden = createResourceBadgePresentation(emptyRules, labels, measurer);
  const visible = createResourceBadgePresentation({
    ...emptyRules, fileExtensionBadgeAliases: { "plugin.md": "插件文件" }
  }, labels, measurer);
  const position = (presentation: ReturnType<typeof createResourceBadgePresentation>) =>
    layoutTree(document, document.rootId, true, 240, "right", "level", fallbackNodeTextMeasurer, presentation)
      .nodes.find((position) => position.id === node.id)!;
  const before = position(hidden);
  const after = position(visible);
  assert.equal(after.width - before.width, 30, "The measured badge and its 2px gap are the only added space");
  assert.equal(after.contentWidth, before.contentWidth, "The title's text region stays unchanged");
  assert.equal(after.height, before.height);
  assert.equal(after.x, before.x, "Badge width must not shift the title anchor");
  assert.deepEqual(position(hidden), before, "Removing the alias immediately restores compact geometry");
  const svg = renderBranchSvg(
    document, document.rootId, 240, "right", "theme", "vibrant", "rounded", "level",
    undefined, fallbackNodeTextMeasurer, visible
  );
  assert.match(svg, /class="mtn-extension-marker"/);
  assert.match(svg, />插件文件<\/text>/);
  assert.deepEqual(document, originalDocument);
  assert.equal(renderOutline(document), originalOutline);
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
    markers: [], resourceBadges: [], width: 0, height: 0
  });

  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.chapter_one.pdf", fileKind: "attachment" };
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    markers: [{ kind: "extension", label: "PDF" }],
    resourceBadges: [{ kind: "extension", label: "PDF" }],
    width: 25,
    height: 16
  });
  node.markers = [{ type: "progress", value: "todo" }];
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    markers: [{ kind: "extension", label: "PDF" }],
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

function customMarkerRules(
  customMarkers: readonly CustomMarkerDefinition[]
): FileBadgeRules & { readonly customMarkers: readonly CustomMarkerDefinition[] } {
  return { ignoredFileBadgeExtensions: [], fileExtensionBadgeAliases: {}, customMarkers };
}

/** Emoji keep the real fallback box; text and file badges use stub widths. */
const customMarkerMeasurer: ResourceBadgeMeasurer = {
  measure: (badge) => badge.kind === "tag"
    ? { width: 44, height: 16 }
    : badge.kind === "extension"
      ? { width: 23, height: 16 }
      : fallbackResourceBadgeMeasurer.measure(badge)
};

test("registered custom markers render before derived resource badges in measured geometry", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "File");
  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.pdf", fileKind: "attachment" };
  node.markers = [
    { type: "progress", value: "todo" },
    { type: "emoji", value: "🔥" },
    { type: "tag", value: "绘图" }
  ];
  const presentation = createResourceBadgePresentation(customMarkerRules([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "绘图" }
  ]), labels, customMarkerMeasurer);

  assert.deepEqual(presentation.resolveCustomMarkerDisplays(node), [
    { kind: "emoji", value: "🔥", id: "mtn-emoji-1" },
    { kind: "tag", value: "绘图", id: "mtn-tag-1" }
  ]);
  const geometry = getNodeMarkerGeometry(node, presentation);
  assert.deepEqual(geometry.markers, [
    { kind: "emoji", label: "🔥", id: "mtn-emoji-1" },
    { kind: "tag", label: "绘图", id: "mtn-tag-1" },
    { kind: "extension", label: "PDF" }
  ]);
  assert.deepEqual(geometry.resourceBadges, [{ kind: "extension", label: "PDF" }]);

  const itemCount = 1 + 2 + 1;
  assert.equal(
    geometry.width,
    NODE_MARKER_GAP
      + 1 * MANUAL_MARKER_SIZE
      + (MANUAL_MARKER_SIZE + 44 + 23)
      + (itemCount - 1) * NODE_MARKER_GAP
  );
  assert.equal(geometry.width, 111);
  assert.equal(geometry.height, MANUAL_MARKER_SIZE);
});

test("a single text tag reserves its measured box instead of a fixed icon square", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Tagged");
  node.markers = [{ type: "tag", value: "绘图" }];
  const definitions = [{ id: "mtn-tag-1", kind: "tag" as const, value: "绘图" }];

  const stub = createResourceBadgePresentation(customMarkerRules(definitions), labels, {
    measure: () => ({ width: 99, height: 30 })
  });
  assert.deepEqual(getNodeMarkerGeometry(node, stub), {
    markers: [{ kind: "tag", label: "绘图", id: "mtn-tag-1" }],
    resourceBadges: [],
    width: NODE_MARKER_GAP + 99,
    height: 30
  });

  // The headless fallback measures CJK text at 10px per code point plus padding.
  const fallback = createResourceBadgePresentation(customMarkerRules(definitions), labels);
  assert.equal(getNodeMarkerGeometry(node, fallback).width, NODE_MARKER_GAP + 24);
  assert.equal(getNodeMarkerGeometry(node, fallback).height, 16);
});

test("custom emoji keep the fixed square box that measures 18 by 18", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Emoji");
  node.markers = [{ type: "emoji", value: "🔥" }];
  const presentation = createResourceBadgePresentation(customMarkerRules([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" }
  ]), labels, customMarkerMeasurer);

  assert.deepEqual(presentation.measure({ kind: "emoji", label: "🔥", id: "mtn-emoji-1" }), {
    width: MANUAL_MARKER_SIZE,
    height: MANUAL_MARKER_SIZE
  });
  assert.deepEqual(getNodeMarkerGeometry(node, presentation), {
    markers: [{ kind: "emoji", label: "🔥", id: "mtn-emoji-1" }],
    resourceBadges: [],
    width: NODE_MARKER_GAP + MANUAL_MARKER_SIZE,
    height: MANUAL_MARKER_SIZE
  });
});

test("custom markers missing from the registry render nothing and never rewrite the node", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "Tagged");
  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.pdf", fileKind: "attachment" };
  node.markers = [{ type: "tag", value: "绘图" }];
  const original = structuredClone(document);

  const noRegistry = createResourceBadgePresentation(customMarkerRules([]), labels, customMarkerMeasurer);
  const otherValue = createResourceBadgePresentation(customMarkerRules([
    { id: "mtn-tag-2", kind: "tag", value: "草稿" }
  ]), labels, customMarkerMeasurer);

  for (const presentation of [noRegistry, otherValue]) {
    assert.deepEqual(presentation.resolveCustomMarkerDisplays(node), []);
    const geometry = getNodeMarkerGeometry(node, presentation);
    assert.deepEqual(geometry.markers, [{ kind: "extension", label: "PDF" }]);
    assert.equal(geometry.width, NODE_MARKER_GAP + 23);
    assert.equal(geometry.height, 16);
  }
  assert.deepEqual(node.markers, [{ type: "tag", value: "绘图" }]);
  assert.deepEqual(document, original);

  const restored = createResourceBadgePresentation(customMarkerRules([
    { id: "mtn-tag-1", kind: "tag", value: "绘图" }
  ]), labels, customMarkerMeasurer);
  assert.deepEqual(restored.resolveCustomMarkerDisplays(node), [
    { kind: "tag", value: "绘图", id: "mtn-tag-1" }
  ]);
  assert.deepEqual(getNodeMarkerGeometry(node, restored).markers, [
    { kind: "tag", label: "绘图", id: "mtn-tag-1" },
    { kind: "extension", label: "PDF" }
  ]);
  assert.deepEqual(document, original);
});

test("an empty custom marker registry keeps the previous marker geometry unchanged", () => {
  const document = createEmptyDocument("Badges");
  const node = addNode(document, document.rootId, "File");
  node.resource = { type: "file", resourceId: "pdf", pathHint: "files/File.pdf", fileKind: "attachment" };
  node.markers = [
    { type: "progress", value: "todo" },
    { type: "priority", value: "blue" },
    { type: "highlight", value: "#75ACA6" }
  ];
  const original = structuredClone(document);
  const legacyRules = createResourceBadgePresentation(emptyRules, labels, customMarkerMeasurer);
  const emptyRegistry = createResourceBadgePresentation(customMarkerRules([]), labels, customMarkerMeasurer);

  assert.deepEqual(getNodeMarkerGeometry(node, legacyRules), {
    markers: [{ kind: "extension", label: "PDF" }],
    resourceBadges: [{ kind: "extension", label: "PDF" }],
    width: 65,
    height: 18
  });
  assert.deepEqual(getNodeMarkerGeometry(node, emptyRegistry), getNodeMarkerGeometry(node, legacyRules));
  assert.deepEqual(document, original);
});
