import test from "node:test";
import assert from "node:assert/strict";
import {
  appendNonMarkdownResourceId,
  buildLinkedResourcePath,
  classifyFile,
  createShortResourceId,
  extractNonMarkdownResourceId,
  linkedFileTitle,
  stripNonMarkdownResourceId
} from "../src/format/resource-id";

test("adds, extracts, and hides non-Markdown resource IDs", () => {
  assert.equal(
    appendNonMarkdownResourceId("notes/architecture.md", "A9b2Z"),
    "notes/architecture.md"
  );
  const atPath = appendNonMarkdownResourceId("assets/architecture.png", "A9b2Z");
  const percentPath = appendNonMarkdownResourceId("assets/architecture.png", "k3L0x", "%");
  assert.equal(atPath, "assets/architecture@A9b2Z.png");
  assert.equal(percentPath, "assets/architecture%k3L0x.png");
  assert.equal(extractNonMarkdownResourceId(atPath), "A9b2Z");
  assert.equal(extractNonMarkdownResourceId(percentPath), "k3L0x");
  assert.equal(stripNonMarkdownResourceId("architecture@A9b2Z.png"), "architecture.png");
  assert.equal(stripNonMarkdownResourceId("architecture%k3L0x.png"), "architecture.png");
});

test("generates five-character mixed-case alphanumeric IDs and classifies resources", () => {
  assert.match(createShortResourceId(), /^[A-Za-z0-9]{5}$/);
  assert.equal(classifyFile("note.md"), "note");
  assert.equal(classifyFile("image.WEBP"), "image");
  assert.equal(classifyFile("book.pdf"), "attachment");
});

test("builds synchronized file paths while preserving extensions and resource IDs", () => {
  assert.equal(
    buildLinkedResourcePath("notes/Old title.md", "New title", "unused"),
    "notes/New title.md"
  );
  assert.equal(
    buildLinkedResourcePath("assets/old~mtn-4fz7k2m9qd.png", "New image", "4fz7k2m9qd"),
    "assets/New image~mtn-4fz7k2m9qd.png"
  );
  assert.equal(
    buildLinkedResourcePath("assets/old@A9b2Z.png", "New image", "A9b2Z", "%"),
    "assets/New image@A9b2Z.png"
  );
  assert.equal(
    buildLinkedResourcePath("assets/unmanaged.png", "New image", "k3L0x", "%"),
    "assets/New image%k3L0x.png"
  );
  assert.equal(
    buildLinkedResourcePath("trees/Old map.mtn.md", "New map", "document-id"),
    "trees/New map.mtn.md"
  );
  assert.equal(linkedFileTitle("trees/New map.mtn.md"), "New map");
  assert.equal(linkedFileTitle("assets/New image@A9b2Z.png"), "New image");
  assert.equal(linkedFileTitle("assets/Old image~mtn-4fz7k2m9qd.png"), "Old image");
});

test("continues to parse and strip legacy ten-character resource IDs", () => {
  const legacy = "assets/archive~mtn-4fz7k2m9qd.zip";
  assert.equal(extractNonMarkdownResourceId(legacy), "4fz7k2m9qd");
  assert.equal(stripNonMarkdownResourceId(legacy), "assets/archive.zip");
});
