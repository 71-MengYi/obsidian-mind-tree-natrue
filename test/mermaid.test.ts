import test from "node:test";
import assert from "node:assert/strict";
import { addNode, createEmptyDocument, DEFAULT_NODE_TITLE } from "../src/domain/tree";
import { mindmapLabel, renderBranchMermaid } from "../src/format/mermaid";

test("a branch renders as an indented Mermaid mindmap inside a fenced block", () => {
  const document = createEmptyDocument("Project");
  const first = addNode(document, document.rootId, "First");
  addNode(document, first.id, "Deep child");
  addNode(document, document.rootId, "Second");

  assert.equal(renderBranchMermaid(document, document.rootId), [
    "```mermaid",
    "mindmap",
    '  n0["Project"]',
    '    n1["First"]',
    '      n2["Deep child"]',
    '    n3["Second"]',
    "```"
  ].join("\n"));
});

test("a sub-branch keeps its own node as the Mermaid root", () => {
  const document = createEmptyDocument("Project");
  const branch = addNode(document, document.rootId, "Branch");
  addNode(document, branch.id, "Leaf");

  const mermaid = renderBranchMermaid(document, branch.id);
  assert.ok(mermaid.startsWith("```mermaid\nmindmap\n"));
  assert.ok(!mermaid.includes("Project"));
  assert.equal(mermaid.indexOf('n1["Leaf"]') > mermaid.indexOf('n0["Branch"]'), true);
});

test("labels keep ordinary text, including Markdown, as plain words", () => {
  const document = createEmptyDocument("Root");
  addNode(document, document.rootId, "**Bold** and `code`");
  addNode(document, document.rootId, "Line one\nline two");

  const mermaid = renderBranchMermaid(document, document.rootId);
  assert.ok(mermaid.includes('["Bold and code"]'));
  assert.ok(mermaid.includes('["Line one line two"]'));
});

test("a synced file name stays literal instead of being read as Markdown", () => {
  const document = createEmptyDocument("Root");
  const synced = addNode(document, document.rootId, "**literal** name.md");
  synced.resource = { type: "file", resourceId: "resource", pathHint: "**literal** name.md", fileKind: "note" };
  synced.titleSync = "bidirectional";

  assert.ok(renderBranchMermaid(document, document.rootId).includes('["**literal** name.md"]'));
});

test("labels pick the shape that needs no rewriting and keep unsafe text out of the diagram", () => {
  const document = createEmptyDocument("Root");
  addNode(document, document.rootId, 'He said "hi"');
  addNode(document, document.rootId, 'Quote "and" brackets [1]');
  addNode(document, document.rootId, "   ");

  const mermaid = renderBranchMermaid(document, document.rootId);
  // A double quote cannot appear inside a quoted label; the rounded form keeps it.
  assert.ok(mermaid.includes('(He said "hi")'));
  // With brackets present the rounded form is unavailable, so the quote is the
  // only character that is substituted.
  assert.ok(mermaid.includes('["Quote \'and\' brackets [1]"]'));
  assert.ok(mermaid.includes(`["${DEFAULT_NODE_TITLE}"]`));
});

test("dangling and cyclic child ids cannot hang or repeat the copied block", () => {
  const document = createEmptyDocument("Root");
  const child = addNode(document, document.rootId, "Child");
  child.childIds.push("missing");
  // Hand-edited data may point a child back at its ancestor.
  child.childIds.push(document.rootId);

  const mermaid = renderBranchMermaid(document, document.rootId);
  assert.equal(mermaid.split("Child").length - 1, 1);
  assert.ok(!mermaid.includes("missing"));
  assert.equal(renderBranchMermaid(document, "missing"), "");
});

test("the label helper reports only the shape that carries a title", () => {
  assert.equal(mindmapLabel({ title: "Plain" }, true), '["Plain"]');
  assert.equal(mindmapLabel({ title: 'A "quote" in (brackets)' }, true), '["A \'quote\' in (brackets)"]');
});
