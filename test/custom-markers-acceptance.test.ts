import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { setNodeMarker } from "../src/domain/markers";
import { customMarkerDefinitionsByKind, type CustomMarkerDefinition } from "../src/domain/custom-markers";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { renderOutline } from "../src/format/outline";
import { normalizePluginData } from "../src/plugin-data";
import { renderBranchSvg } from "../src/services/export";
import {
  createResourceBadgePresentation,
  getNodeMarkerGeometry,
  MANUAL_MARKER_SIZE,
  NODE_MARKER_GAP
} from "../src/ui/resource-badges";
import { NODE_HORIZONTAL_PADDING } from "../src/ui/layout";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";

/**
 * End-to-end acceptance for user-managed markers, exercised through the same
 * public entry points the plugin uses: `data.json` normalization, the render
 * profile the view builds, the Markdown outline, and the SVG export.
 *
 * It deliberately avoids the live DOM so it can run in the shared node:test
 * process, and it asserts the invariants that unit tests cannot see: one
 * ordered registry drives palette order, node geometry, outline and export.
 */

const SETTINGS_WITH_MARKERS = {
  settings: {
    customMarkers: [
      { id: "e-fire", kind: "emoji", value: "🔥" },
      { id: "t-drawing", kind: "tag", value: "绘图" },
      { id: "e-rocket", kind: "emoji", value: "🚀" },
      { id: "t-tree", kind: "tag", value: "思维树" }
    ]
  }
};

const BADGE_LABELS = { mindTree: "思维树", drawing: "绘图" };

function loadedDefinitions(): CustomMarkerDefinition[] {
  return normalizePluginData(SETTINGS_WITH_MARKERS).settings.customMarkers;
}

function presentationWith(definitions: readonly CustomMarkerDefinition[]) {
  return createResourceBadgePresentation(
    { ignoredFileBadgeExtensions: [], fileExtensionBadgeAliases: {}, customMarkers: definitions },
    BADGE_LABELS
  );
}

test("a data.json custom marker list keeps its order, kinds and ids after loading", () => {
  assert.deepEqual(loadedDefinitions(), [
    { id: "e-fire", kind: "emoji", value: "🔥" },
    { id: "t-drawing", kind: "tag", value: "绘图" },
    { id: "e-rocket", kind: "emoji", value: "🚀" },
    { id: "t-tree", kind: "tag", value: "思维树" }
  ]);
  const definitions = loadedDefinitions();
  // The palette groups by kind without reordering either group internally.
  assert.deepEqual(customMarkerDefinitionsByKind(definitions, "emoji").map((item) => item.value), ["🔥", "🚀"]);
  assert.deepEqual(customMarkerDefinitionsByKind(definitions, "tag").map((item) => item.value), ["绘图", "思维树"]);
});

test("one node can carry an emoji, a text tag and file badges at the same time", () => {
  const document = createEmptyDocument("Acceptance");
  const node = addNode(document, document.rootId, "Topic");
  node.resource = { type: "file", resourceId: "note-id", pathHint: "notes/Topic.md", fileKind: "note" };
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });
  setNodeMarker(node, { type: "progress", value: "inprogress" });

  const presentation = presentationWith(loadedDefinitions());
  const geometry = getNodeMarkerGeometry(node, presentation);
  // Built-in icons are not part of `markers`; custom markers precede resource badges.
  assert.deepEqual(geometry.markers.map((item) => `${item.kind}:${item.label}`), ["emoji:🔥", "tag:绘图"]);
  assert.deepEqual(geometry.resourceBadges, []);

  const widths = geometry.markers.map((item) => presentation.measure(item).width);
  const itemCount = 1 + geometry.markers.length;
  assert.equal(
    geometry.width,
    NODE_MARKER_GAP + MANUAL_MARKER_SIZE + widths.reduce((sum, width) => sum + width, 0)
      + (itemCount - 1) * NODE_MARKER_GAP
  );
  // The tag is the tallest item only when its measured box is taller than the icons.
  assert.ok(geometry.height >= MANUAL_MARKER_SIZE);

  // The same registry drives the palette order the popover renders.
  assert.deepEqual(
    customMarkerDefinitionsByKind(loadedDefinitions(), "emoji").map((item) => item.id),
    ["e-fire", "e-rocket"]
  );
});

test("removing a definition hides the marker but never rewrites the document", () => {
  const document = createEmptyDocument("Acceptance");
  const node = addNode(document, document.rootId, "Topic");
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });
  const stored = JSON.stringify(node.markers);

  const withoutEmoji = presentationWith(loadedDefinitions().filter((item) => item.kind !== "emoji"));
  assert.deepEqual(
    withoutEmoji.resolveCustomMarkerDisplays(node).map((item) => item.value),
    ["绘图"]
  );
  const geometry = getNodeMarkerGeometry(node, withoutEmoji);
  const tagWidth = withoutEmoji.measure({ kind: "tag", label: "绘图" }).width;
  assert.equal(geometry.width, NODE_MARKER_GAP + tagWidth);
  assert.equal(JSON.stringify(node.markers), stored, "Resolution is read-only");

  // Re-adding the same value restores the marker without touching the node.
  const restored = presentationWith(loadedDefinitions());
  assert.deepEqual(restored.resolveCustomMarkerDisplays(node).map((item) => item.value), ["🔥", "绘图"]);
});

test("custom markers round-trip through .mtn.md and reach the outline suffix in palette order", () => {
  const document = createEmptyDocument("Acceptance");
  const node = addNode(document, document.rootId, "Topic");
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });

  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  assert.deepEqual(parsed.document.nodes[node.id]?.markers, [
    { type: "emoji", value: "🔥" },
    { type: "tag", value: "绘图" }
  ]);
  assert.ok(renderOutline(parsed.document).includes("- Topic 〔emoji:🔥〕 〔tag:绘图〕"));
  // Settings never leak into the file: the payload only references values.
  assert.doesNotMatch(serializeMindTreeFile(document), /mtn-emoji|e-fire|customMarkers/);
});

test("SVG export lays custom markers out as one reserved column", () => {
  const document = createEmptyDocument("Acceptance");
  const node = addNode(document, document.rootId, "Topic");
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });
  const presentation = presentationWith(loadedDefinitions());
  const svg = renderBranchSvg(
    document, document.rootId, 240, "right", "theme", "vibrant", "rounded", "level",
    { canvas: "#F7F3E8", root: "#7C3AED", rootText: "#FFFFFF", levelOne: "#4A4A4A",
      levelOneText: "#FFFFFF", descendant: "#E2E0DB", descendantText: "#2F2F2F" },
    fallbackNodeTextMeasurer,
    presentation
  );

  // The emoji glyph is centered inside its fixed 18px box, so the box spans
  // center ± 9; the tag box must follow it after exactly one NODE_MARKER_GAP.
  const emojiCenter = Number(/<text x="([\d.]+)"[^>]*>🔥<\/text>/.exec(svg)?.[1]);
  assert.ok(Number.isFinite(emojiCenter), "emoji glyph is missing from the export");
  const emojiLeft = emojiCenter - MANUAL_MARKER_SIZE / 2;

  const tagWidth = presentation.measure({ kind: "tag", label: "绘图" }).width;
  const tagBlock = svg.slice(svg.indexOf('class="mtn-tag-marker"'));
  const tagX = Number(/<rect x="([\d.]+)"/.exec(tagBlock)?.[1]);
  const tagRenderedWidth = Number(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(tagBlock)?.[1]);
  assert.equal(tagX, emojiLeft + MANUAL_MARKER_SIZE + NODE_MARKER_GAP);
  assert.equal(tagRenderedWidth, tagWidth, "The exported box uses the measured tag width");

  // The rendered column span equals what layout reserved for it, so markers can
  // never overlap the title or the next node on the canvas.
  const geometry = getNodeMarkerGeometry(node, presentation);
  const span = tagX + tagRenderedWidth - emojiLeft;
  assert.equal(span, geometry.width - NODE_MARKER_GAP);
  assert.match(svg, />绘图<\/text>/);
});
