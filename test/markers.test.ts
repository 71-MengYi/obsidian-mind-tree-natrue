import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import {
  classifyFileSubtype,
  getIconNodeMarkers,
  getVisibleNodeMarkers,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker,
  MAX_CUSTOM_NODE_MARKER_VALUE_LENGTH,
  normalizeNodeMarkers,
  removeNodeMarker,
  renderNodeMarkerSuffix,
  setNodeMarker
} from "../src/domain/markers";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { renderOutline } from "../src/format/outline";
import { renderBranchSvg } from "../src/services/export";
import {
  getNodeBoxSize,
  getNodeHorizontalInsets,
  getNodeSize,
  NODE_HORIZONTAL_INSETS,
  NODE_HORIZONTAL_PADDING,
  wrapNodeTitle
} from "../src/ui/layout";
import { getNodeMarkerGeometry } from "../src/ui/resource-badges";

test("recognizes Excalidraw only from official Frontmatter values", () => {
  assert.equal(classifyFileSubtype({ "excalidraw-plugin": "raw" }), "excalidraw");
  assert.equal(classifyFileSubtype({ "excalidraw-plugin": "parsed" }), "excalidraw");
  assert.equal(classifyFileSubtype({ "excalidraw-plugin": true }), undefined);
  assert.equal(classifyFileSubtype({ "excalidraw-plugin": "other" }), undefined);
  assert.equal(classifyFileSubtype(undefined), undefined);
});

test("marker categories coexist and each category is replaced or removed independently", () => {
  const document = createEmptyDocument("Markers");
  const node = addNode(document, document.rootId, "Task");

  setNodeMarker(node, { type: "progress", value: "todo" });
  setNodeMarker(node, { type: "priority", value: "red" });
  setNodeMarker(node, { type: "highlight", value: "#75ACA6" });
  setNodeMarker(node, { type: "progress", value: "done" });

  assert.deepEqual(node.markers, [
    { type: "progress", value: "done" },
    { type: "priority", value: "red" },
    { type: "highlight", value: "#75ACA6" }
  ]);
  assert.equal(getNodeMarkerGeometry(node).width, 40);
  removeNodeMarker(node, "priority");
  assert.deepEqual(node.markers, [
    { type: "progress", value: "done" },
    { type: "highlight", value: "#75ACA6" }
  ]);
  assert.equal(getNodeMarkerGeometry(node).width, 20);
});

test("markers round-trip in compressed JSON and appear after the outline label", () => {
  const document = createEmptyDocument("Markers");
  const node = addNode(document, document.rootId, "Task");
  node.resource = { type: "file", resourceId: "task-id", pathHint: "notes/Task.md", fileKind: "note" };
  setNodeMarker(node, { type: "progress", value: "inprogress" });
  setNodeMarker(node, { type: "priority", value: "blue" });
  setNodeMarker(node, { type: "highlight", value: "#E0CA9D" });

  assert.equal(
    renderNodeMarkerSuffix(node),
    "〔progress:inprogress〕 〔priority:blue〕 〔highlight:#E0CA9D〕"
  );
  assert.ok(renderOutline(document).includes(
    "[[notes/Task|Task]] 〔progress:inprogress〕 〔priority:blue〕 〔highlight:#E0CA9D〕"
  ));
  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  assert.deepEqual(parsed.document.nodes[node.id]?.markers, node.markers);
  const svg = renderBranchSvg(document, document.rootId);
  assert.match(svg, /fill="#E0CA9D"/);
  assert.match(svg, />◐<\/text>/);
  assert.match(svg, />⚑<\/text>/);
});

test("marker normalization rejects invalid values and keeps one value per category", () => {
  // Custom emoji and tags are accepted as plain values: the live settings
  // registry decides whether they render, so a disabled marker survives a
  // round-trip instead of being silently deleted from the document.
  assert.deepEqual(normalizeNodeMarkers([
    { type: "progress", value: "todo" },
    { type: "progress", value: "done" },
    { type: "priority", value: "urgent" },
    { type: "highlight", value: "#f37b6a" },
    { type: "emoji", value: "🔥" }
  ]), [
    { type: "progress", value: "done" },
    { type: "highlight", value: "#F37B6A" },
    { type: "emoji", value: "🔥" }
  ]);
  assert.deepEqual(normalizeNodeMarkers([
    { type: "tag", value: "绘图" },
    { type: "tag", value: "思维树" },
    { type: "emoji", value: "" },
    { type: "emoji", value: 7 },
    { type: "highlight", value: "not-a-color" }
  ]), [
    { type: "tag", value: "思维树" }
  ]);
});

test("visible markers widen the node without shrinking or rewrapping its title", () => {
  const document = createEmptyDocument("Markers");
  const title = "A long title whose text area reaches the configured wrapping width";
  const node = addNode(document, document.rootId, title);
  const baseInsets = getNodeHorizontalInsets(node);
  const baseSize = getNodeSize(1, title, 160, baseInsets);
  const baseLines = wrapNodeTitle(title, 1, baseSize.width - baseInsets);

  setNodeMarker(node, { type: "progress", value: "inprogress" });
  setNodeMarker(node, { type: "priority", value: "yellow" });
  const markedInsets = getNodeHorizontalInsets(node);
  const markedSize = getNodeSize(1, title, 160, markedInsets);
  const markedLines = wrapNodeTitle(title, 1, markedSize.width - markedInsets);

  assert.equal(markedInsets - baseInsets, 40);
  assert.equal(markedSize.width - baseSize.width, 40);
  assert.equal(markedSize.height, baseSize.height);
  assert.deepEqual(markedLines, baseLines);
});

test("plain and linked nodes reserve only compact padding and real control widths", () => {
  const document = createEmptyDocument("Insets");
  const node = addNode(document, document.rootId, "12");
  assert.equal(getNodeHorizontalInsets(node), 10);
  const plainWidth = getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width;
  assert.ok(plainWidth < 96);

  node.resource = { type: "file", resourceId: "note-id", pathHint: "Note.md", fileKind: "note" };
  node.titleSync = "bidirectional";
  assert.equal(getNodeHorizontalInsets(node), 32);
  assert.equal(getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width - plainWidth, 22);
  node.titleSync = "off";
  assert.equal(getNodeHorizontalInsets(node), 54);
  assert.equal(getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width - plainWidth, 44);

  setNodeMarker(node, { type: "progress", value: "todo" });
  assert.equal(getNodeHorizontalInsets(node), 74);
  assert.equal(getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width - plainWidth, 64);
});

test("linked mind-tree files derive a text badge with marker-style layout behavior", () => {
  const document = createEmptyDocument("Markers");
  const title = "Linked planning tree";
  const node = addNode(document, document.rootId, title);
  const baseInsets = getNodeHorizontalInsets(node);
  const baseSize = getNodeSize(1, title, 160, baseInsets);

  node.resource = {
    type: "file",
    resourceId: "linked-document-id",
    pathHint: "trees/Planning.mtn.md",
    fileKind: "note"
  };
  node.titleSync = "bidirectional";
  const linkedInsets = getNodeHorizontalInsets(node);
  const linkedSize = getNodeSize(1, title, 160, linkedInsets);

  assert.equal(hasMindTreeResourceMarker(node), true);
  assert.equal(getNodeMarkerGeometry(node).width, 38);
  assert.equal(linkedInsets - baseInsets, 60);
  assert.equal(linkedSize.width - baseSize.width, 60);
  assert.equal(renderNodeMarkerSuffix(node), "〔mind-tree〕");
  assert.ok(renderOutline(document).includes("[[trees/Planning.mtn|Linked planning tree]] 〔mind-tree〕"));
  assert.match(renderBranchSvg(document, document.rootId), /class="mtn-mind-tree-marker"/);
  assert.match(renderBranchSvg(document, document.rootId), />思维树<\/text>/);
});

test("linked Excalidraw files derive a drawing badge and readable outline suffix", () => {
  const document = createEmptyDocument("Markers");
  const node = addNode(document, document.rootId, "Architecture sketch");
  node.resource = {
    type: "file",
    resourceId: "drawing-id",
    pathHint: "drawings/Architecture.md",
    fileKind: "note",
    fileSubtype: "excalidraw"
  };
  node.titleSync = "bidirectional";

  assert.equal(hasExcalidrawResourceMarker(node), true);
  assert.equal(getNodeMarkerGeometry(node).width, 26);
  assert.equal(renderNodeMarkerSuffix(node), "〔excalidraw〕");
  assert.ok(renderOutline(document).includes(
    "[[drawings/Architecture|Architecture sketch]] 〔excalidraw〕"
  ));
  const svg = renderBranchSvg(document, document.rootId);
  assert.match(svg, /class="mtn-excalidraw-marker"/);
  assert.match(svg, /fill="#7d4fbe" stroke="none"/);
  assert.match(svg, /fill="#ffffff">绘图<\/text>/);
  assert.match(svg, />绘图<\/text>/);

  const branchSvg = renderBranchSvg(document, node.id);
  const nodeX = Number(/<g class="mtn-depth-1"[^>]*><rect x="([^"]+)"/.exec(branchSvg)?.[1]);
  const textX = Number(/<tspan x="([^"]+)"/.exec(branchSvg)?.[1]);
  const badgeX = Number(/class="mtn-excalidraw-marker"><rect x="([^"]+)"/.exec(branchSvg)?.[1]);
  const box = getNodeBoxSize(1, node.title, 240, node);
  assert.equal(textX, nodeX + NODE_HORIZONTAL_PADDING);
  assert.equal(
    badgeX,
    nodeX + NODE_HORIZONTAL_PADDING + (box.contentWidth - NODE_HORIZONTAL_INSETS) + 2
  );

  delete node.resource.fileSubtype;
  node.resource.pathHint = "drawings/Suffix-only.excalidraw.md";
  assert.equal(hasExcalidrawResourceMarker(node), false);
  assert.equal(renderNodeMarkerSuffix(node), "");
});

test("custom emoji and tag categories stay independent from built-in marker categories", () => {
  const document = createEmptyDocument("Markers");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "progress", value: "todo" });
  setNodeMarker(node, { type: "priority", value: "red" });
  setNodeMarker(node, { type: "highlight", value: "#75ACA6" });
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });

  assert.deepEqual(node.markers, [
    { type: "progress", value: "todo" },
    { type: "priority", value: "red" },
    { type: "highlight", value: "#75ACA6" },
    { type: "emoji", value: "🔥" },
    { type: "tag", value: "绘图" }
  ]);
  // Only progress and priority reserve the fixed 18px icon box.
  assert.deepEqual(getIconNodeMarkers(node), [
    { type: "progress", value: "todo" },
    { type: "priority", value: "red" }
  ]);
  assert.deepEqual(getVisibleNodeMarkers(node).map((marker) => marker.type), [
    "progress", "priority", "emoji", "tag"
  ]);

  setNodeMarker(node, { type: "emoji", value: "🎨" });
  assert.deepEqual(node.markers.map((marker) => `${marker.type}:${marker.value}`), [
    "progress:todo", "priority:red", "highlight:#75ACA6", "emoji:🎨", "tag:绘图"
  ]);
  removeNodeMarker(node, "emoji");
  assert.deepEqual(node.markers.map((marker) => marker.type), [
    "progress", "priority", "highlight", "tag"
  ]);
  removeNodeMarker(node, "tag");
  assert.deepEqual(node.markers.map((marker) => marker.type), ["progress", "priority", "highlight"]);
});

test("custom emoji and tag markers render neutral suffixes and survive compressed JSON", () => {
  const document = createEmptyDocument("Markers");
  const node = addNode(document, document.rootId, "任务");
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "绘图" });

  assert.equal(renderNodeMarkerSuffix(node), "〔emoji:🔥〕 〔tag:绘图〕");
  assert.ok(renderOutline(document).includes("〔emoji:🔥〕 〔tag:绘图〕"));

  const parsed = parseMindTreeFile(serializeMindTreeFile(document));
  const restored = parsed.document.nodes[node.id];
  assert.deepEqual(restored?.markers, [
    { type: "emoji", value: "🔥" },
    { type: "tag", value: "绘图" }
  ]);
  assert.equal(renderNodeMarkerSuffix(restored!), "〔emoji:🔥〕 〔tag:绘图〕");
});

test("custom marker normalization bounds the payload value and cleans invisible characters", () => {
  const longest = "绘".repeat(MAX_CUSTOM_NODE_MARKER_VALUE_LENGTH);
  assert.deepEqual(normalizeNodeMarkers([{ type: "tag", value: longest }]), [
    { type: "tag", value: longest }
  ]);
  assert.deepEqual(normalizeNodeMarkers([
    { type: "tag", value: `${longest}绘` }
  ]), []);

  assert.deepEqual(normalizeNodeMarkers([
    { type: "emoji", value: " 🔥\u200B " },
    { type: "tag", value: "\u200B" }
  ]), [{ type: "emoji", value: "🔥" }]);

  // The document keeps values beyond the settings-registry caps so a marker the
  // user later re-enables still has something to render.
  const seventeenEmoji = "🔥".repeat(17);
  assert.deepEqual(normalizeNodeMarkers([{ type: "emoji", value: seventeenEmoji }]), [
    { type: "emoji", value: seventeenEmoji }
  ]);

  assert.deepEqual(normalizeNodeMarkers([
    { type: "emoji", value: "🔥" },
    { type: "emoji", value: "🎨" }
  ]), [{ type: "emoji", value: "🎨" }]);

  // Custom categories always sort after the built-in palette entries.
  assert.deepEqual(normalizeNodeMarkers([
    { type: "tag", value: "绘图" },
    { type: "emoji", value: "🔥" },
    { type: "priority", value: "red" },
    { type: "progress", value: "todo" },
    { type: "highlight", value: "#f37b6a" }
  ]).map((marker) => marker.type), ["progress", "priority", "highlight", "emoji", "tag"]);
});
