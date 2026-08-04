import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import {
  classifyFileSubtype,
  getNodeMarkerDisplayWidth,
  hasExcalidrawResourceMarker,
  hasMindTreeResourceMarker,
  normalizeNodeMarkers,
  removeNodeMarker,
  renderNodeMarkerSuffix,
  setNodeMarker
} from "../src/domain/markers";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { renderOutline } from "../src/format/outline";
import { renderBranchSvg } from "../src/services/export";
import { getNodeHorizontalInsets, getNodeSize, wrapNodeTitle } from "../src/ui/layout";

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
  assert.equal(getNodeMarkerDisplayWidth(node), 40);
  removeNodeMarker(node, "priority");
  assert.deepEqual(node.markers, [
    { type: "progress", value: "done" },
    { type: "highlight", value: "#75ACA6" }
  ]);
  assert.equal(getNodeMarkerDisplayWidth(node), 20);
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
  assert.deepEqual(normalizeNodeMarkers([
    { type: "progress", value: "todo" },
    { type: "progress", value: "done" },
    { type: "priority", value: "urgent" },
    { type: "highlight", value: "#f37b6a" },
    { type: "emoji", value: "🔥" }
  ]), [
    { type: "progress", value: "done" },
    { type: "highlight", value: "#F37B6A" }
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
  assert.equal(getNodeHorizontalInsets(node), 4);
  const plainWidth = getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width;
  assert.ok(plainWidth < 96);

  node.resource = { type: "file", resourceId: "note-id", pathHint: "Note.md", fileKind: "note" };
  node.titleSync = "bidirectional";
  assert.equal(getNodeHorizontalInsets(node), 26);
  assert.equal(getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width - plainWidth, 22);
  node.titleSync = "off";
  assert.equal(getNodeHorizontalInsets(node), 48);
  assert.equal(getNodeSize(1, node.title, 160, getNodeHorizontalInsets(node)).width - plainWidth, 44);

  setNodeMarker(node, { type: "progress", value: "todo" });
  assert.equal(getNodeHorizontalInsets(node), 68);
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
  assert.equal(getNodeMarkerDisplayWidth(node), 48);
  assert.equal(linkedInsets - baseInsets, 70);
  assert.equal(linkedSize.width - baseSize.width, 70);
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
  assert.equal(getNodeMarkerDisplayWidth(node), 48);
  assert.equal(renderNodeMarkerSuffix(node), "〔excalidraw〕");
  assert.ok(renderOutline(document).includes(
    "[[drawings/Architecture|Architecture sketch]] 〔excalidraw〕"
  ));
  const svg = renderBranchSvg(document, document.rootId);
  assert.match(svg, /class="mtn-excalidraw-marker"/);
  assert.match(svg, /fill="#7d4fbe" stroke="none"/);
  assert.match(svg, /fill="#ffffff">绘图<\/text>/);
  assert.match(svg, />绘图<\/text>/);

  delete node.resource.fileSubtype;
  node.resource.pathHint = "drawings/Suffix-only.excalidraw.md";
  assert.equal(hasExcalidrawResourceMarker(node), false);
  assert.equal(renderNodeMarkerSuffix(node), "");
});
