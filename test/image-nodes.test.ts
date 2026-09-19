import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRuntimeNode } from "../src/domain/runtime-node";
import { addNode, createEmptyDocument } from "../src/domain/tree";
import {
  clipboardImageFileName,
  readClipboardEventContent
} from "../src/services/clipboard";
import { renderBranchSvg, type ExportImageAsset } from "../src/services/export";
import {
  fitImageToDefault,
  persistedImageSize,
  resizeImageFromWidth
} from "../src/ui/image-nodes";
import { getNodeBoxSize } from "../src/ui/layout";
import { fallbackResourceBadgePresentation } from "../src/ui/resource-badges";
import { fallbackNodeTextMeasurer } from "../src/ui/text-measurer";

test("image nodes fit the compact default box without enlarging small files", () => {
  assert.deepEqual(fitImageToDefault(400, 300), { width: 180, height: 135 });
  assert.deepEqual(fitImageToDefault(40, 30), { width: 40, height: 30 });
  assert.deepEqual(fitImageToDefault(100, 400), { width: 34, height: 135 });
});

test("manual image resizing preserves ratio and clamps its horizontal range", () => {
  assert.deepEqual(resizeImageFromWidth(20, 4 / 3), { width: 60, height: 45 });
  assert.deepEqual(resizeImageFromWidth(320, 4 / 3), { width: 320, height: 240 });
  assert.deepEqual(resizeImageFromWidth(900, 4 / 3), { width: 600, height: 450 });
});

test("runtime node style accepts only a complete safe image display box", () => {
  const complete = normalizeRuntimeNode("image", {
    title: "Image",
    childIds: [],
    style: { background: "#fff", imageWidth: 120, imageHeight: 90 }
  });
  assert.deepEqual(persistedImageSize(complete), { width: 120, height: 90 });

  const partial = normalizeRuntimeNode("partial", {
    title: "Image",
    childIds: [],
    style: { background: "#fff", imageWidth: 120 }
  });
  assert.deepEqual(partial.style, { background: "#fff" });
});

test("image geometry adds a body above the compact caption", () => {
  const document = createEmptyDocument("Root");
  const node = addNode(document, document.rootId, "A");
  node.resource = { type: "file", resourceId: "image", pathHint: "A@Ab123.png", fileKind: "image" };
  node.titleSync = "bidirectional";
  node.style = { imageWidth: 120, imageHeight: 90 };
  const box = getNodeBoxSize(1, node.title, 240, node);

  assert.equal(box.image?.width, 120);
  assert.equal(box.image?.height, 90);
  assert.equal(box.width, 130);
  assert.equal(box.height, 118);
});

test("clipboard images win over accompanying plain text and retain useful names", () => {
  const file = {
    name: "diagram.png",
    type: "image/png",
    size: 12,
    lastModified: 1
  } as File;
  const content = readClipboardEventContent({
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => file }],
      files: [file],
      getData: (type: string) => type === "text/plain" ? "https://example.com/image.png" : ""
    }
  } as unknown as ClipboardEvent);

  assert.equal(content.kind, "images");
  if (content.kind === "images") {
    assert.equal(content.images.length, 1);
    assert.equal(content.images[0]?.name, "diagram.png");
  }
  assert.equal(
    clipboardImageFileName("", "image/jpeg", 0, new Date(2026, 8, 4, 10, 11, 12)),
    "Pasted image 20260904-101112.jpg"
  );
});

test("SVG rendering embeds prepared image data above the caption", () => {
  const document = createEmptyDocument("Root");
  const node = addNode(document, document.rootId, "Diagram");
  node.resource = { type: "file", resourceId: "image", pathHint: "Diagram@Ab123.png", fileKind: "image" };
  node.titleSync = "bidirectional";
  const asset: ExportImageAsset = {
    dataUrl: "data:image/png;base64,AA==",
    naturalWidth: 400,
    naturalHeight: 300,
    width: 180,
    height: 135
  };
  const svg = renderBranchSvg(
    document,
    document.rootId,
    240,
    "right",
    "theme",
    "vibrant",
    "rounded",
    "level",
    undefined,
    fallbackNodeTextMeasurer,
    fallbackResourceBadgePresentation,
    new Map([[node.id, asset]])
  );

  assert.match(svg, /<image class="mtn-node-image"/u);
  assert.match(svg, /href="data:image\/png;base64,AA=="/u);
  assert.match(svg, />Diagram<\/tspan>/u);
});
