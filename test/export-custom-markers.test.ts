import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import { setNodeMarker } from "../src/domain/markers";
import type { CustomMarkerDefinition } from "../src/domain/custom-markers";
import { renderOutline } from "../src/format/outline";
import { serializeMindTreeFile } from "../src/format/document";
import { renderBranchSvg } from "../src/services/export";
import type { MindTreeDocument, MindTreeNode } from "../src/types";
import { getNodeBoxSize, NODE_HORIZONTAL_INSETS, NODE_HORIZONTAL_PADDING } from "../src/ui/layout";
import { getNodeResourceControls } from "../src/ui/resource-controls";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";
import {
  createResourceBadgePresentation,
  getNodeMarkerGeometry,
  MANUAL_MARKER_SIZE,
  NODE_MARKER_GAP,
  type FileBadgeRules,
  type ResourceBadgeMeasurer,
  type ResourceBadgePresentation
} from "../src/ui/resource-badges";

const WRAP_WIDTH = 240;
const emptyBadgeRules: FileBadgeRules = { ignoredFileBadgeExtensions: [], fileExtensionBadgeAliases: {} };
const badgeLabels = { mindTree: "思维树", drawing: "绘图" };

function createPresentation(
  customMarkers: readonly CustomMarkerDefinition[],
  measurer?: ResourceBadgeMeasurer
): ResourceBadgePresentation {
  return createResourceBadgePresentation({ ...emptyBadgeRules, customMarkers }, badgeLabels, measurer);
}

function exportBranchSvg(document: MindTreeDocument, presentation: ResourceBadgePresentation): string {
  return renderBranchSvg(
    document, document.rootId, WRAP_WIDTH, "right", "theme", "vibrant", "rounded", "level",
    undefined, fallbackNodeTextMeasurer, presentation
  );
}

/** Top-left x of the depth-1 node box; export offsets every position by 36px. */
function depthOneX(svg: string): number {
  const value = /<g class="mtn-depth-1"[^>]*><rect x="([^"]+)"/.exec(svg)?.[1];
  assert.ok(value !== undefined, "the depth-1 node box must be exported");
  return Number(value);
}

/** Resolved width of the depth-1 node box, including the marker column. */
function depthOneWidth(svg: string): number {
  const value = /<g class="mtn-depth-1"[^>]*><rect x="[^"]+" y="[^"]+" width="([^"]+)"/.exec(svg)?.[1];
  assert.ok(value !== undefined, "the depth-1 node box must be exported");
  return Number(value);
}

/** Title anchor of the depth-1 node, read from its first wrapped line. */
function depthOneTitleX(svg: string): number {
  const value = /<g class="mtn-depth-1"[^>]*>[\s\S]*?<tspan x="([^"]+)"/.exec(svg)?.[1];
  assert.ok(value !== undefined, "the depth-1 title must be exported");
  return Number(value);
}

/** The marker column ends where the trailing file-control column begins. */
function markerColumnEnd(node: MindTreeNode, boxX: number, presentation: ResourceBadgePresentation): number {
  const box = getNodeBoxSize(1, node.title, WRAP_WIDTH, node, fallbackNodeTextMeasurer, presentation);
  return boxX + box.width - NODE_HORIZONTAL_PADDING - getNodeResourceControls(node).width;
}

/**
 * Left edge of the canvas marker column. The renderer sets
 * `--mtn-node-title-width` to `contentWidth - NODE_HORIZONTAL_INSETS` and the
 * grid places the marker track right after it, so the column starts here.
 */
function markerColumnLeft(node: MindTreeNode, boxX: number, presentation: ResourceBadgePresentation): number {
  const box = getNodeBoxSize(1, node.title, WRAP_WIDTH, node, fallbackNodeTextMeasurer, presentation);
  return boxX + NODE_HORIZONTAL_PADDING + (box.contentWidth - NODE_HORIZONTAL_INSETS);
}

/**
 * Left edge of the first marker box: the canvas marker column adds its own 2px
 * `padding-left`, which the export folds into `markerStartX`.
 */
function firstMarkerX(node: MindTreeNode, boxX: number, presentation: ResourceBadgePresentation): number {
  return markerColumnLeft(node, boxX, presentation) + NODE_MARKER_GAP;
}

test("custom emoji renders as an escaped 15px glyph centered in the fixed 18px marker box", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "emoji", value: "🔥<b>&" });
  const presentation = createPresentation([{ id: "mtn-emoji-1", kind: "emoji", value: "🔥<b>&" }]);

  const svg = exportBranchSvg(document, presentation);
  const emoji = /<text x="([^"]+)" y="[^"]+" font-size="15" text-anchor="middle"[^>]*>([^<]*)<\/text>/.exec(svg);
  assert.ok(emoji, "the emoji must be exported as centered text");
  assert.equal(emoji[2], "🔥&lt;b&gt;&amp;", "emoji values must be XML-escaped");
  assert.doesNotMatch(svg, /<b>/, "raw markup from a marker value must never reach the SVG");

  // The glyph is centered inside the reserved square, so it cannot drift into
  // the title or past the node's right inner padding.
  const columnEnd = markerColumnEnd(node, depthOneX(svg), presentation);
  const columnStart = firstMarkerX(node, depthOneX(svg), presentation);
  const geometry = getNodeMarkerGeometry(node, presentation);
  assert.equal(Number(emoji[1]), columnStart + MANUAL_MARKER_SIZE / 2);
  assert.equal(Number(emoji[1]), columnEnd - MANUAL_MARKER_SIZE / 2);
  assert.equal(
    Number(emoji[1]) + MANUAL_MARKER_SIZE / 2,
    columnStart - NODE_MARKER_GAP + geometry.width,
    "the single marker must end on the reserved column edge"
  );
  assert.equal(geometry.width, NODE_MARKER_GAP + MANUAL_MARKER_SIZE);

  // Emoji inherit the node's body color, exactly like the canvas span.
  const emojiFill = /fill="([^"]+)"/.exec(emoji[0])?.[1];
  const titleFill = /<g class="mtn-depth-1"[^>]*>[\s\S]*?<text text-anchor="start"[^>]*fill="([^"]+)"/.exec(svg)?.[1];
  assert.ok(emojiFill !== undefined && titleFill !== undefined);
  assert.equal(emojiFill, titleFill);
});

test("a built-in icon and a custom emoji keep one NODE_MARKER_GAP between their boxes", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "progress", value: "todo" });
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  const presentation = createPresentation([{ id: "mtn-emoji-1", kind: "emoji", value: "🔥" }]);
  // 2px column padding + 18px icon + 2px flex gap + 18px emoji.
  const geometry = getNodeMarkerGeometry(node, presentation);
  assert.equal(geometry.width, NODE_MARKER_GAP + MANUAL_MARKER_SIZE * 2 + NODE_MARKER_GAP);

  const svg = exportBranchSvg(document, presentation);
  const iconCenter = Number(/<text x="([^"]+)"[^>]*>○<\/text>/.exec(svg)?.[1]);
  const emojiCenter = Number(/<text x="([^"]+)" y="[^"]+" font-size="15" text-anchor="middle"[^>]*>🔥<\/text>/.exec(svg)?.[1]);
  const columnStart = firstMarkerX(node, depthOneX(svg), presentation);

  assert.equal(iconCenter, columnStart + MANUAL_MARKER_SIZE / 2);
  // `.mtn-node-markers` declares flex `gap: 2px`, so adjacent 18px boxes are
  // `width + gap` apart. Placing them `width` apart would leave the last 2px of
  // the reserved column empty and break the right-edge identity below.
  assert.equal(emojiCenter - iconCenter, MANUAL_MARKER_SIZE + NODE_MARKER_GAP);
  assert.equal(
    emojiCenter - MANUAL_MARKER_SIZE / 2 - (iconCenter + MANUAL_MARKER_SIZE / 2),
    NODE_MARKER_GAP,
    "the icon and the emoji must never overlap"
  );
  assert.equal(
    emojiCenter + MANUAL_MARKER_SIZE / 2,
    columnStart - NODE_MARKER_GAP + geometry.width,
    "the last box must end on the reserved column edge"
  );
});

test("icon, emoji and tag positions follow the reserved marker column exactly", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "progress", value: "todo" });
  setNodeMarker(node, { type: "priority", value: "red" });
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "重要" });
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "tag"
      ? { width: 30, height: 16 }
      : { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE }
  };
  const presentation = createPresentation([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "重要" }
  ], measurer);

  const svg = exportBranchSvg(document, presentation);
  const columnStart = firstMarkerX(node, depthOneX(svg), presentation);
  const geometry = getNodeMarkerGeometry(node, presentation);
  const progressCenter = Number(/<text x="([^"]+)"[^>]*>○<\/text>/.exec(svg)?.[1]);
  const priorityCenter = Number(/<text x="([^"]+)"[^>]*>⚑<\/text>/.exec(svg)?.[1]);
  const emojiCenter = Number(/<text x="([^"]+)" y="[^"]+" font-size="15" text-anchor="middle"[^>]*>🔥<\/text>/.exec(svg)?.[1]);
  const tagX = Number(/class="mtn-tag-marker"><rect x="([^"]+)"/.exec(svg)?.[1]);

  // One cursor over the ordered widths must reproduce every start, exactly like
  // `getNodeMarkerGeometry` computes the column width.
  const starts: number[] = [];
  let cursor = columnStart;
  for (const [index, width] of [MANUAL_MARKER_SIZE, MANUAL_MARKER_SIZE, MANUAL_MARKER_SIZE, 30].entries()) {
    if (index > 0) cursor += NODE_MARKER_GAP;
    starts.push(cursor);
    cursor += width;
  }
  assert.deepEqual(starts, [
    columnStart,
    columnStart + MANUAL_MARKER_SIZE + NODE_MARKER_GAP,
    columnStart + 2 * (MANUAL_MARKER_SIZE + NODE_MARKER_GAP),
    columnStart + 3 * (MANUAL_MARKER_SIZE + NODE_MARKER_GAP)
  ]);
  assert.equal(progressCenter, starts[0]! + MANUAL_MARKER_SIZE / 2);
  assert.equal(priorityCenter, starts[1]! + MANUAL_MARKER_SIZE / 2, "adjacent icons stay one gap apart");
  assert.equal(emojiCenter, starts[2]! + MANUAL_MARKER_SIZE / 2);
  assert.equal(tagX, starts[3]!);
  assert.equal(cursor, columnStart - NODE_MARKER_GAP + geometry.width, "all four items must fill the reserved column");
});

test("exported marker boxes match the CSS/DOM model of the marker column", () => {
  // Positions below come from the canvas box model, not from the export cursor:
  // the renderer publishes `--mtn-node-title-width` and `--mtn-node-marker-width`
  // from these same values, and `.mtn-node-markers` adds `padding-left: 2px`
  // plus a flex `gap: 2px` between boxes.
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  node.resource = { type: "file", resourceId: "report", pathHint: "files/Task.pdf", fileKind: "attachment" };
  setNodeMarker(node, { type: "progress", value: "todo" });
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "重要" });
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "tag"
      ? { width: 30, height: 16 }
      : badge.kind === "emoji" ? { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE } : { width: 24, height: 16 }
  };
  const presentation = createPresentation([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "重要" }
  ], measurer);

  const svg = exportBranchSvg(document, presentation);
  const geometry = getNodeMarkerGeometry(node, presentation);
  const columnLeft = markerColumnLeft(node, depthOneX(svg), presentation);
  const widths = [MANUAL_MARKER_SIZE, MANUAL_MARKER_SIZE, 30, 24];
  const domLefts: number[] = [];
  let left = columnLeft + NODE_MARKER_GAP;
  for (const [index, width] of widths.entries()) {
    if (index > 0) left += NODE_MARKER_GAP;
    domLefts.push(left);
    left += width;
  }
  assert.equal(
    domLefts[3]! + widths[3]!,
    columnLeft + geometry.width,
    "the DOM model must fill the reserved column exactly"
  );

  const iconCenter = Number(/<text x="([^"]+)"[^>]*>○<\/text>/.exec(svg)?.[1]);
  const emojiCenter = Number(/<text x="([^"]+)" y="[^"]+" font-size="15" text-anchor="middle"[^>]*>🔥<\/text>/.exec(svg)?.[1]);
  const tagX = Number(/class="mtn-tag-marker"><rect x="([^"]+)"/.exec(svg)?.[1]);
  const badgeX = Number(/class="mtn-extension-marker"><rect x="([^"]+)"/.exec(svg)?.[1]);
  assert.equal(iconCenter, domLefts[0]! + MANUAL_MARKER_SIZE / 2);
  assert.equal(emojiCenter, domLefts[1]! + MANUAL_MARKER_SIZE / 2);
  assert.equal(tagX, domLefts[2]!);
  assert.equal(badgeX, domLefts[3]!);
});

test("text tags use their measured badge box and fill the reserved marker column", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "tag", value: "R&D" });
  const measurer: ResourceBadgeMeasurer = { measure: () => ({ width: 47, height: 16 }) };
  const presentation = createPresentation([{ id: "mtn-tag-1", kind: "tag", value: "R&D" }], measurer);

  assert.equal(getNodeMarkerGeometry(node, presentation).width, NODE_MARKER_GAP + 47);
  const svg = exportBranchSvg(document, presentation);
  const tag = /<g class="mtn-tag-marker"><rect x="([^"]+)" y="[^"]+" width="([^"]+)" height="([^"]+)" rx="([^"]+)" fill="([^"]+)" stroke="([^"]+)"\/><text[^>]*font-size="10" font-weight="600"[^>]*>R&amp;D<\/text><\/g>/.exec(svg);
  assert.ok(tag, "the tag must reuse the measured file-badge frame and escape its label");
  assert.equal(Number(tag[2]), 47, "the tag box must use the measured width, not a fixed square");
  assert.equal(Number(tag[3]), 16);
  assert.equal(Number(tag[4]), 5, "tags are rounded by 5px");
  assert.equal(tag[6], "none", "tags have no border");
  // Layout reserved exactly this width, so the rendered tag must end on the
  // node's inner right edge instead of overflowing or leaving a gap.
  assert.equal(Number(tag[1]) + 47, markerColumnEnd(node, depthOneX(svg), presentation));
});

test("custom markers are drawn before derived resource badges in marker order", () => {
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  node.resource = { type: "file", resourceId: "report", pathHint: "files/Task.pdf", fileKind: "attachment" };
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "重要" });
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "tag"
      ? { width: 30, height: 16 }
      : badge.kind === "emoji"
        ? { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE }
        : { width: 24, height: 16 }
  };
  const presentation = createPresentation([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "重要" }
  ], measurer);

  // The canvas DOM resolves custom items first, then derived badges.
  assert.deepEqual(
    getNodeMarkerGeometry(node, presentation).markers.map((item) => item.kind),
    ["emoji", "tag", "extension"]
  );
  assert.equal(
    getNodeMarkerGeometry(node, presentation).width,
    NODE_MARKER_GAP + MANUAL_MARKER_SIZE + 30 + 24 + 2 * NODE_MARKER_GAP
  );

  const svg = exportBranchSvg(document, presentation);
  const emojiIndex = svg.indexOf(">🔥</text>");
  const tagIndex = svg.indexOf('class="mtn-tag-marker"');
  const extensionIndex = svg.indexOf('class="mtn-extension-marker"');
  assert.ok(emojiIndex > 0, "the emoji must be exported");
  assert.ok(emojiIndex < tagIndex && tagIndex < extensionIndex, "export order must follow the marker order");

  const emojiCenter = Number(/<text x="([^"]+)" y="[^"]+" font-size="15" text-anchor="middle"[^>]*>🔥<\/text>/.exec(svg)?.[1]);
  const tagX = Number(/class="mtn-tag-marker"><rect x="([^"]+)"/.exec(svg)?.[1]);
  const extensionX = Number(/class="mtn-extension-marker"><rect x="([^"]+)"/.exec(svg)?.[1]);
  const emojiLeft = emojiCenter - MANUAL_MARKER_SIZE / 2;
  assert.equal(tagX, emojiLeft + MANUAL_MARKER_SIZE + NODE_MARKER_GAP);
  assert.equal(extensionX, tagX + 30 + NODE_MARKER_GAP);
  assert.equal(extensionX + 24, markerColumnEnd(node, depthOneX(svg), presentation));

  // `.is-tag` and `.is-extension` resolve the same hover surface in styles.css.
  const tagFill = /class="mtn-tag-marker"><rect[^>]*fill="([^"]+)"/.exec(svg)?.[1];
  const extensionFill = /class="mtn-extension-marker"><rect[^>]*fill="([^"]+)"/.exec(svg)?.[1];
  assert.ok(tagFill !== undefined && extensionFill !== undefined);
  assert.equal(tagFill, extensionFill);
});

test("custom markers widen only the marker column and never rewrap the title", () => {
  const document = createEmptyDocument("Export");
  const title = "A long title that reaches the configured wrapping width and keeps its lines";
  const node = addNode(document, document.rootId, title);
  const plain = exportBranchSvg(document, createPresentation([]));

  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "重要" });
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "emoji"
      ? { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE }
      : { width: 30, height: 16 }
  };
  const presentation = createPresentation([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "重要" }
  ], measurer);
  const marked = exportBranchSvg(document, presentation);

  const lines = (svg: string) => [...svg.matchAll(/<tspan x="[^"]+" y="[^"]+">([^<]*)<\/tspan>/g)].map((match) => match[1]);
  assert.deepEqual(lines(marked), lines(plain), "markers must never rewrap a title");
  assert.equal(
    depthOneTitleX(marked) - depthOneX(marked),
    depthOneTitleX(plain) - depthOneX(plain),
    "the title anchor must not move"
  );
  assert.equal(
    depthOneWidth(marked) - depthOneWidth(plain),
    getNodeMarkerGeometry(node, presentation).width,
    "only the reserved marker column may grow"
  );
});

test("custom markers stay in the outline suffix while export remains read-only", () => {
  // Custom emoji and tags are persisted node data, so `renderNodeMarkerSuffix`
  // deliberately mirrors them into the Markdown outline just like the built-in
  // categories. Export must neither duplicate that suffix nor mutate anything.
  const document = createEmptyDocument("Export");
  const node = addNode(document, document.rootId, "Task");
  setNodeMarker(node, { type: "emoji", value: "🔥" });
  setNodeMarker(node, { type: "tag", value: "重要" });
  const measurer: ResourceBadgeMeasurer = {
    measure: (badge) => badge.kind === "emoji"
      ? { width: MANUAL_MARKER_SIZE, height: MANUAL_MARKER_SIZE }
      : { width: 30, height: 16 }
  };
  const presentation = createPresentation([
    { id: "mtn-emoji-1", kind: "emoji", value: "🔥" },
    { id: "mtn-tag-1", kind: "tag", value: "重要" }
  ], measurer);

  const outlineBefore = renderOutline(document);
  assert.match(outlineBefore, /〔emoji:🔥〕/, "the suffix mechanism must publish the emoji category");
  assert.match(outlineBefore, /〔tag:重要〕/, "the suffix mechanism must publish the tag category");
  const snapshot = structuredClone(document);

  const svg = exportBranchSvg(document, presentation);
  assert.match(svg, />🔥<\/text>/);
  assert.match(svg, /class="mtn-tag-marker"/);
  assert.equal(renderOutline(document), outlineBefore, "export must not write markers into the outline");
  assert.deepEqual(document, snapshot, "export must not mutate persisted node data");
  assert.equal(node.title, "Task", "a custom marker must never enter the node title");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(serializeMindTreeFile(document))?.[1] ?? "";
  assert.doesNotMatch(frontmatter, /🔥|emoji|tag/u, "custom markers must never enter the YAML frontmatter");
});
