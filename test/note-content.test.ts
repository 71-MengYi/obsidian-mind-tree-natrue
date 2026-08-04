import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNewNoteBody,
  normalizeNewNoteDefaultContent
} from "../src/services/note-content";

test("ordinary notes use configured Markdown verbatim without an implicit title", () => {
  const markdown = "  - 保留缩进\n\n正文末尾  \n";
  assert.equal(buildNewNoteBody(markdown), markdown);
  assert.equal(buildNewNoteBody(""), "");
});

test("invalid persisted default-note content falls back to empty", () => {
  assert.equal(normalizeNewNoteDefaultContent(undefined), "");
  assert.equal(normalizeNewNoteDefaultContent({ content: "unexpected" }), "");
  assert.equal(normalizeNewNoteDefaultContent("\n  Markdown\n"), "\n  Markdown\n");
});
