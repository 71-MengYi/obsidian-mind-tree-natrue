import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TEXT_IMPORT_RULE,
  classifyDirectTextPaste,
  createTextPastePayload,
  parseTextImport
} from "../src/services/text-import";
import { readStructuredBranchFromClipboardEvent } from "../src/services/clipboard";
import { MAX_MIND_TREE_DEPTH, MAX_MIND_TREE_NODES, MAX_TEXT_IMPORT_BYTES } from "../src/input-limits";

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

test("heading import supports nested ordered and unordered Markdown lists", () => {
  const payload = parseTextImport([
    "- Before headings",
    "  1. Nested before",
    "# Project",
    "- First task",
    "  1) Ordered child",
    "    * Deep mixed child",
    "+ Second task",
    "Project body",
    "  - List after body",
    "## Details",
    "1. Detail task",
    "   - [[notes/Linked|Linked note]]"
  ].join("\n"), "headings");

  assert.ok(payload);
  const [beforeId, projectId] = payload.rootIds ?? [];
  assert.equal(payload.nodes[beforeId!]?.title, "Before headings");
  assert.equal(payload.nodes[payload.nodes[beforeId!]?.childIds[0] ?? ""]?.title, "Nested before");
  assert.equal(payload.nodes[projectId!]?.title, "Project");

  const [firstId, secondId, bodyId, afterBodyId, detailsId] = payload.nodes[projectId!]?.childIds ?? [];
  assert.equal(payload.nodes[firstId!]?.title, "First task");
  assert.equal(payload.nodes[secondId!]?.title, "Second task");
  assert.equal(payload.nodes[bodyId!]?.title, "Project body");
  assert.equal(payload.nodes[afterBodyId!]?.title, "List after body");
  assert.equal(payload.nodes[detailsId!]?.title, "Details");

  const orderedId = payload.nodes[firstId!]?.childIds[0]!;
  const deepId = payload.nodes[orderedId]?.childIds[0]!;
  assert.equal(payload.nodes[orderedId]?.title, "Ordered child");
  assert.equal(payload.nodes[deepId]?.title, "Deep mixed child");

  const detailId = payload.nodes[detailsId!]?.childIds[0]!;
  const linkedId = payload.nodes[detailId]?.childIds[0]!;
  assert.equal(payload.nodes[linkedId]?.title, "Linked note");
  assert.equal(payload.nodes[linkedId]?.resource, undefined);
  assert.deepEqual(payload.linkTargets?.[linkedId], {
    type: "file", linkPath: "notes/Linked", fallbackTitle: "[[notes/Linked|Linked note]]"
  });
});

test("the import dialog's first rule is the default", () => {
  assert.equal(DEFAULT_TEXT_IMPORT_RULE, "list");
});

test("both import rules combine pending vault links with normalized web resources", () => {
  const list = parseTextImport("- [[notes/Plan|Plan]]\n  - https://example.com", "list");
  const headings = parseTextImport("# [Manual](assets/manual.pdf)\n[Site](https://example.org)", "headings");

  assert.ok(list && headings);
  assert.equal(list.nodes[list.rootId]?.title, "Plan");
  assert.equal(list.nodes[list.rootId]?.resource, undefined);
  assert.deepEqual(list.linkTargets?.[list.rootId], {
    type: "file", linkPath: "notes/Plan", fallbackTitle: "[[notes/Plan|Plan]]"
  });
  const listUrlId = list.nodes[list.rootId]!.childIds[0]!;
  assert.deepEqual(list.nodes[listUrlId]?.resource, { type: "url", url: "https://example.com/" });
  assert.equal(headings.nodes[headings.rootId]?.title, "Manual");
  assert.equal(headings.nodes[headings.rootId]?.resource, undefined);
  assert.deepEqual(headings.linkTargets?.[headings.rootId], {
    type: "file", linkPath: "assets/manual.pdf", fallbackTitle: "[Manual](assets/manual.pdf)"
  });
  const headingUrlId = headings.nodes[headings.rootId]!.childIds[0]!;
  assert.deepEqual(headings.nodes[headingUrlId]?.resource, { type: "url", url: "https://example.org/" });
});

test("direct text paste normalizes only the outer whitespace before parsing a line", () => {
  assert.deepEqual(classifyDirectTextPaste("  "), { kind: "empty" });
  assert.deepEqual(classifyDirectTextPaste("  One topic  "), { kind: "nodes", nodes: [{ title: "One topic" }] });
  assert.deepEqual(classifyDirectTextPaste("\n\t  One topic  \r\n\r\n"), {
    kind: "nodes", nodes: [{ title: "One topic" }]
  });
  assert.deepEqual(classifyDirectTextPaste("https://example.com/docs"), {
    kind: "nodes",
    nodes: [{ title: "https://example.com/docs", linkTarget: { type: "url", url: "https://example.com/docs" } }]
  });
  assert.deepEqual(classifyDirectTextPaste(" \t\r\nhttps://example.com/docs\r\n\t "), {
    kind: "nodes",
    nodes: [{ title: "https://example.com/docs", linkTarget: { type: "url", url: "https://example.com/docs" } }]
  });
  assert.deepEqual(classifyDirectTextPaste("See https://example.com"), {
    kind: "nodes",
    nodes: [{ title: "See", linkTarget: { type: "url", url: "https://example.com/" } }]
  });
  assert.deepEqual(classifyDirectTextPaste("javascript:alert(1)"), {
    kind: "nodes", nodes: [{ title: "javascript:alert(1)" }]
  });
});

test("direct paste and both import rules share all link types, split order and fallback text", () => {
  for (const source of [
    "学习 https://example.com", "[学习](https://example.com)",
    "https://example.com 学习", "https://example.com",
    "https://example.com https://other.example.com", "[[笔记|别名]]",
    "[附件](files/manual.pdf)", "[[笔记]] https://example.com", "ftp://example.com",
    "说明 [[notes/A|甲]] [官网](https://example.com)", "![[images/a.png]]",
    "[带括号](<files/A (B).pdf>)", "[[A]] [[A]]", "https://a.example https://a.example"
  ]) {
    const direct = classifyDirectTextPaste(source);
    assert.equal(direct.kind, "nodes");
    if (direct.kind !== "nodes") throw new Error("Expected a single-line forest");
    const pasted = createTextPastePayload(direct.nodes)!;
    for (const rule of ["list", "headings"] as const) {
      const prefix = rule === "list" ? "- " : "# ";
      const imported = parseTextImport(prefix + source, rule)!;
      for (const payload of [pasted, imported]) {
        assert.deepEqual((payload.rootIds ?? []).map((id) => ({
          title: payload.nodes[id]!.title,
          ...(payload.linkTargets?.[id] ? { linkTarget: payload.linkTargets[id] } : {})
        })), direct.nodes, rule + ": " + source);
        for (const id of payload.rootIds ?? []) {
          const link = payload.linkTargets?.[id];
          assert.deepEqual(payload.nodes[id]?.resource,
            link?.type === "url" ? { type: "url", url: link.url } : undefined);
        }
      }
    }
  }
});

test("split list siblings retain order and only the first node owns deeper items", () => {
  for (const prefix of ["", "说明 "]) {
    const payload = parseTextImport([
      "- " + prefix + "[[A]] [B](B.md)",
      "  - Child",
      "    - Grandchild",
      "- Next"
    ].join("\n"), "list")!;
    const roots = payload.rootIds!;
    assert.deepEqual(roots.map((id) => payload.nodes[id]!.title),
      prefix ? ["说明", "A", "B", "Next"] : ["A", "B", "Next"]);
    const child = payload.nodes[roots[0]!]!.childIds[0]!;
    assert.equal(payload.nodes[child]!.title, "Child");
    assert.equal(payload.nodes[payload.nodes[child]!.childIds[0]!]!.title, "Grandchild");
    assert.ok(roots.slice(1).every((id) => payload.nodes[id]!.childIds.length === 0));
  }
});

test("split headings anchor lists and deeper headings to the first generated node", () => {
  const payload = parseTextImport([
    "- [[BeforeA]] [[BeforeB]]", "  - Before child",
    "# 说明 [[A]] [[B]]",
    "- [[C]] https://example.com",
    "  - List child",
    "## [[D]] [[E]]",
    "### Deeper",
    "# Next"
  ].join("\n"), "headings")!;
  const [beforeA, beforeB, prose, a, b, next] = payload.rootIds!;
  assert.deepEqual(payload.rootIds!.map((id) => payload.nodes[id]!.title),
    ["BeforeA", "BeforeB", "说明", "A", "B", "Next"]);
  assert.equal(payload.nodes[payload.nodes[beforeA!]!.childIds[0]!]!.title, "Before child");
  for (const id of [beforeB, a, b, next]) assert.deepEqual(payload.nodes[id!]!.childIds, []);
  const [c, url, d, e] = payload.nodes[prose!]!.childIds;
  assert.equal(payload.nodes[c!]!.title, "C");
  assert.equal(payload.nodes[payload.nodes[c!]!.childIds[0]!]!.title, "List child");
  assert.equal(payload.nodes[url!]!.resource?.type, "url");
  assert.equal(payload.nodes[d!]!.title, "D");
  assert.equal(payload.nodes[payload.nodes[d!]!.childIds[0]!]!.title, "Deeper");
  assert.deepEqual(payload.nodes[e!]!.childIds, []);
});

test("single-line paste recognizes links without removing literal list or ATX prefixes", () => {
  for (const source of ["- Plain", "1. Plain", "# Plain", "- [[A|Alias]]", "# [Alias](A.md)"]) {
    const direct = classifyDirectTextPaste(source);
    assert.equal(direct.kind, "nodes");
    if (direct.kind !== "nodes") continue;
    assert.equal(direct.nodes.length, 1);
    assert.equal(direct.nodes[0]?.title, source.replace("[[A|Alias]]", "Alias").replace("[Alias](A.md)", "Alias"));
  }
});

test("expanded link forests enforce node, depth and input-size limits", () => {
  const boundary = Array.from({ length: MAX_MIND_TREE_NODES }, () => "[[A]]").join(" ");
  const direct = classifyDirectTextPaste(boundary);
  assert.equal(direct.kind, "nodes");
  if (direct.kind === "nodes") assert.equal(Object.keys(createTextPastePayload(direct.nodes)!.nodes).length, MAX_MIND_TREE_NODES);
  for (const rule of ["list", "headings"] as const) {
    assert.throws(() => parseTextImport(boundary + " [[A]]", rule), /10000 nodes/);
  }
  const oversized = classifyDirectTextPaste(boundary + " [[A]]");
  if (oversized.kind === "nodes") assert.throws(() => createTextPastePayload(oversized.nodes), /10000 nodes/);
  assert.throws(() => parseTextImport(
    Array.from({ length: MAX_MIND_TREE_DEPTH + 1 }, (_, depth) => " ".repeat(depth) + "- [[A]] [[B]]").join("\n"),
    "list"
  ), /256 levels/);
  assert.throws(() => classifyDirectTextPaste("x".repeat(MAX_TEXT_IMPORT_BYTES + 1)), /10 MiB/);
  assert.throws(() => parseTextImport("x".repeat(MAX_TEXT_IMPORT_BYTES + 1), "list"), /10 MiB/);
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
