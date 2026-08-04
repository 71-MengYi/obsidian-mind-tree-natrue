import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDirectTextPaste,
  parseTextImport
} from "../src/services/text-import";
import { readStructuredBranchFromClipboardEvent } from "../src/services/clipboard";

test("list import mixes bullets, ordered markers, and indented plain lines", () => {
  const payload = parseTextImport([
    "- Roadmap",
    "  Plain child",
    "    1. Ordered grandchild",
    "2) Notes",
    "\t* Tab-indented child"
  ].join("\n"), "list");

  assert.ok(payload);
  assert.equal(payload.rootIds?.length, 2);
  const [roadmapId, notesId] = payload.rootIds ?? [];
  assert.equal(payload.nodes[roadmapId!]?.title, "Roadmap");
  assert.equal(payload.nodes[notesId!]?.title, "Notes");
  const plainId = payload.nodes[roadmapId!]?.childIds[0];
  assert.equal(payload.nodes[plainId!]?.title, "Plain child");
  assert.equal(
    payload.nodes[payload.nodes[plainId!]?.childIds[0] ?? ""]?.title,
    "Ordered grandchild"
  );
  assert.equal(payload.nodes[payload.nodes[notesId!]?.childIds[0] ?? ""]?.title, "Tab-indented child");
});

test("heading import nests jumps and makes body lines direct heading children", () => {
  const payload = parseTextImport([
    "Prelude",
    "# Project",
    "Project body",
    "### Deep jump",
    "Deep body",
    "## Back to level two",
    "Level two body",
    "# Second root",
    "Second body"
  ].join("\n"), "headings");

  assert.ok(payload);
  const [preludeId, projectId, secondId] = payload.rootIds ?? [];
  assert.equal(payload.nodes[preludeId!]?.title, "Prelude");
  assert.equal(payload.nodes[projectId!]?.title, "Project");
  assert.equal(payload.nodes[secondId!]?.title, "Second root");
  const [projectBodyId, deepId, levelTwoId] = payload.nodes[projectId!]?.childIds ?? [];
  assert.equal(payload.nodes[projectBodyId!]?.title, "Project body");
  assert.equal(payload.nodes[deepId!]?.title, "Deep jump");
  assert.equal(payload.nodes[payload.nodes[deepId!]?.childIds[0] ?? ""]?.title, "Deep body");
  assert.equal(payload.nodes[levelTwoId!]?.title, "Back to level two");
  assert.equal(payload.nodes[payload.nodes[levelTwoId!]?.childIds[0] ?? ""]?.title, "Level two body");
  assert.equal(payload.nodes[payload.nodes[secondId!]?.childIds[0] ?? ""]?.title, "Second body");
});

test("both import rules retain file and web link targets", () => {
  const list = parseTextImport("- [[notes/Plan|Plan]]\n  - https://example.com", "list");
  const headings = parseTextImport("# [Manual](assets/manual.pdf)\n[Site](https://example.org)", "headings");

  assert.ok(list && headings);
  assert.deepEqual(list.linkTargets?.[list.rootId], { type: "file", linkPath: "notes/Plan" });
  const listUrlId = list.nodes[list.rootId]!.childIds[0]!;
  assert.deepEqual(list.nodes[listUrlId]?.resource, { type: "url", url: "https://example.com/" });
  assert.deepEqual(headings.linkTargets?.[headings.rootId], { type: "file", linkPath: "assets/manual.pdf" });
  const headingUrlId = headings.nodes[headings.rootId]!.childIds[0]!;
  assert.deepEqual(headings.nodes[headingUrlId]?.resource, { type: "url", url: "https://example.org/" });
});

test("direct text paste handles only one plain line or one complete HTTP URL", () => {
  assert.deepEqual(classifyDirectTextPaste("  "), { kind: "empty" });
  assert.deepEqual(classifyDirectTextPaste("  One topic  "), { kind: "text", title: "One topic" });
  assert.deepEqual(classifyDirectTextPaste("\n\t  One topic  \r\n\r\n"), {
    kind: "text",
    title: "One topic"
  });
  assert.deepEqual(classifyDirectTextPaste("https://example.com/docs"), {
    kind: "url",
    title: "https://example.com/docs",
    url: "https://example.com/docs"
  });
  assert.deepEqual(classifyDirectTextPaste(" \t\r\nhttps://example.com/docs\r\n\t "), {
    kind: "url",
    title: "https://example.com/docs",
    url: "https://example.com/docs"
  });
  assert.deepEqual(classifyDirectTextPaste("See https://example.com"), {
    kind: "text",
    title: "See https://example.com"
  });
  assert.deepEqual(classifyDirectTextPaste("javascript:alert(1)"), {
    kind: "text",
    title: "javascript:alert(1)"
  });
});

test("external multiline text is routed to import and never treated as structured paste", () => {
  assert.deepEqual(classifyDirectTextPaste("\n- Parent\n  - Child\n"), {
    kind: "multiline",
    text: "- Parent\n  - Child"
  });
  assert.equal(readStructuredBranchFromClipboardEvent({
    clipboardData: {
      getData: (type: string) => type === "text/plain" ? "- Parent\n  - Child" : ""
    }
  } as ClipboardEvent), undefined);
});

test("direct paste trims only the outer edge and preserves internal indentation", () => {
  assert.deepEqual(classifyDirectTextPaste(" \r\n  Parent\r\n    Child  \r\n "), {
    kind: "multiline",
    text: "Parent\n    Child"
  });
  assert.deepEqual(classifyDirectTextPaste(" \t\r\n\t "), { kind: "empty" });
});

test("empty imports do not produce a mutable branch payload", () => {
  assert.equal(parseTextImport("\n \n", "list"), undefined);
  assert.equal(parseTextImport("\n \n", "headings"), undefined);
});
