import test from "node:test";
import assert from "node:assert/strict";
import {
  clearNodeNumbering,
  computeNodeNumbering,
  formatNodeNumberLabel,
  NODE_NUMBERING_FORMATS,
  normalizeNodeNumbering,
  numberedNodeTitle,
  setNodeNumbering,
  toAlphabeticNumeral,
  toChineseNumeral,
  toRomanNumeral
} from "../src/domain/node-numbering";
import { normalizeRuntimeNode } from "../src/domain/runtime-node";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { renderOutline } from "../src/format/outline";
import { layoutTree } from "../src/render/layout";
import type { MindTreeDocument, MindTreeNode } from "../src/types";

const NOW = "2026-01-01T00:00:00.000Z";

function node(id: string, title: string, childIds: string[] = []): MindTreeNode {
  return { id, title, childIds, createdAt: NOW, updatedAt: NOW };
}

function createDocument(nodes: MindTreeNode[], rootId = "root"): MindTreeDocument {
  const map: Record<string, MindTreeNode> = {};
  for (const item of nodes) map[item.id] = item;
  return {
    settings: {
      layoutMode: "right",
      recursiveScan: false,
      collectionMode: "off",
      theme: "vibrant",
      connectionStyle: "theme",
      nodeShape: "rounded"
    },
    title: "Numbering",
    rootId,
    nodes: map,
    createdAt: NOW,
    updatedAt: NOW
  };
}

/** root -> a, b; a -> a1, a2 */
function numberedDocument(): MindTreeDocument {
  return createDocument([
    node("root", "Root", ["a", "b"]),
    node("a", "A", ["a1", "a2"]),
    node("b", "B"),
    node("a1", "A1"),
    node("a2", "A2")
  ]);
}

test("every numbering style renders the documented sample", () => {
  assert.equal(formatNodeNumberLabel("decimal", [1]), "1. ");
  assert.equal(formatNodeNumberLabel("decimal", [1, 2]), "1.2 ");
  assert.equal(formatNodeNumberLabel("decimal", [1, 1, 1]), "1.1.1 ");
  assert.equal(formatNodeNumberLabel("chinese", [1]), "一、");
  assert.equal(formatNodeNumberLabel("chinese", [1, 2]), "（二）");
  assert.equal(formatNodeNumberLabel("chinese", [1, 2, 3]), "（3）");
  assert.equal(formatNodeNumberLabel("chinese", [1, 2, 3, 4]), "4 ");
  assert.equal(formatNodeNumberLabel("chinese", [1, 2, 3, 4, 5]), "1.2.3.4.5 ");
  assert.equal(formatNodeNumberLabel("lowerRoman", [4]), "iv. ");
  assert.equal(formatNodeNumberLabel("upperRoman", [4]), "IV. ");
  assert.equal(formatNodeNumberLabel("upperAlpha", [3]), "C. ");
  assert.equal(formatNodeNumberLabel("lowerAlpha", [3]), "c. ");
});

test("format helpers cover Chinese, Roman and spreadsheet letters", () => {
  assert.equal(toChineseNumeral(10), "十");
  assert.equal(toChineseNumeral(12), "十二");
  assert.equal(toChineseNumeral(99), "九十九");
  assert.equal(toRomanNumeral(1994), "MCMXCIV");
  assert.equal(toAlphabeticNumeral(1), "A");
  assert.equal(toAlphabeticNumeral(27), "AA");
});

test("a level configuration numbers only the direct children", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "decimal", scope: "level", start: "restart" };
  const labels = computeNodeNumbering(document);
  assert.equal(labels.get("a"), "1. ");
  assert.equal(labels.get("b"), "2. ");
  assert.equal(labels.has("a1"), false);
});

test("a descendant configuration numbers the whole subtree by path", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "decimal", scope: "descendants", start: "restart" };
  const labels = computeNodeNumbering(document);
  assert.equal(labels.get("a"), "1. ");
  assert.equal(labels.get("b"), "2. ");
  assert.equal(labels.get("a1"), "1.1 ");
  assert.equal(labels.get("a2"), "1.2 ");
});

test("continue appends to the ancestor path, restart starts a new sequence", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "decimal", scope: "descendants", start: "restart" };
  document.nodes["a"]!.numbering = { format: "decimal", scope: "level", start: "continue" };
  assert.equal(computeNodeNumbering(document).get("a1"), "1.1 ");
  document.nodes["a"]!.numbering = { format: "decimal", scope: "level", start: "restart" };
  assert.equal(computeNodeNumbering(document).get("a1"), "1. ");
});

test("continue without an ancestor numbering behaves like restart", () => {
  const document = numberedDocument();
  document.nodes["a"]!.numbering = { format: "decimal", scope: "level", start: "continue" };
  assert.equal(computeNodeNumbering(document).get("a1"), "1. ");
  assert.equal(computeNodeNumbering(document).get("a2"), "2. ");
});

test("single-level styles restart at every depth", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "lowerRoman", scope: "descendants", start: "restart" };
  const labels = computeNodeNumbering(document);
  assert.equal(labels.get("a"), "i. ");
  assert.equal(labels.get("b"), "ii. ");
  assert.equal(labels.get("a1"), "i. ");
});

test("removing a level or the whole branch deletes the stored configuration", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "decimal", scope: "descendants", start: "restart" };
  document.nodes["a"]!.numbering = { format: "decimal", scope: "level", start: "restart" };
  clearNodeNumbering(document, "root", "level");
  assert.equal(document.nodes["root"]!.numbering, undefined);
  assert.notEqual(document.nodes["a"]!.numbering, undefined);
  document.nodes["a"]!.numbering = { format: "decimal", scope: "level", start: "restart" };
  clearNodeNumbering(document, "root", "all");
  assert.equal(document.nodes["a"]!.numbering, undefined);
  assert.equal(computeNodeNumbering(document).size, 0);
});

test("setNodeNumbering stores exactly the requested configuration", () => {
  const target = node("x", "X");
  setNodeNumbering(target, "chinese", "descendants", "continue");
  assert.deepEqual(target.numbering, { format: "chinese", scope: "descendants", start: "continue" });
});

test("numbered titles concatenate the derived label without touching the title", () => {
  const target = node("x", "Title");
  const labels = new Map([["x", "1. "]]);
  assert.equal(numberedNodeTitle(target, labels), "1. Title");
  assert.equal(numberedNodeTitle(target, new Map()), "Title");
  assert.equal(target.title, "Title");
});

test("persisted configuration is normalized and survives a file round trip", () => {
  assert.deepEqual(
    normalizeNodeNumbering({ format: "upperRoman", scope: "descendants", start: "restart" }),
    { format: "upperRoman", scope: "descendants", start: "restart" }
  );
  assert.equal(normalizeNodeNumbering({ format: "klingon", scope: "level", start: "restart" }), undefined);
  assert.equal(normalizeNodeNumbering({ format: "decimal", scope: "tree", start: "restart" }), undefined);
  assert.equal(normalizeNodeNumbering("1."), undefined);

  const restored = normalizeRuntimeNode("a", {
    title: "A",
    childIds: [],
    numbering: { format: "chinese", scope: "level", start: "continue" }
  });
  assert.deepEqual(restored.numbering, { format: "chinese", scope: "level", start: "continue" });

  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "upperAlpha", scope: "descendants", start: "restart" };
  const parsed = parseMindTreeFile(serializeMindTreeFile(document)).document;
  assert.deepEqual(parsed.nodes["root"]!.numbering, { format: "upperAlpha", scope: "descendants", start: "restart" });
});

test("the generated outline carries the label before the node text", () => {
  const document = numberedDocument();
  document.nodes["root"]!.numbering = { format: "decimal", scope: "descendants", start: "restart" };
  const outline = renderOutline(document);
  assert.match(outline, /^- Root$/m);
  assert.match(outline, /^  - 1\. A$/m);
  assert.match(outline, /^    - 1\.1 A1$/m);
});

test("the canvas layout measures the numbered title, so the node grows", () => {
  const plain = numberedDocument();
  const numbered = numberedDocument();
  numbered.nodes["root"]!.numbering = { format: "decimal", scope: "descendants", start: "restart" };
  const plainLayout = layoutTree(plain);
  const numberedLayout = layoutTree(numbered);
  const widthOf = (layout: ReturnType<typeof layoutTree>, id: string): number =>
    layout.nodes.find((position) => position.id === id)?.width ?? 0;
  assert.ok(widthOf(numberedLayout, "a1") > widthOf(plainLayout, "a1"));
});

test("the menu order lists six styles with the hierarchical pair first", () => {
  assert.deepEqual([...NODE_NUMBERING_FORMATS], [
    "decimal",
    "chinese",
    "lowerRoman",
    "upperRoman",
    "upperAlpha",
    "lowerAlpha"
  ]);
});
