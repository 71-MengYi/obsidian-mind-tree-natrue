import test from "node:test";
import assert from "node:assert/strict";
import {
  BRANCH_REFERENCE_LANGUAGE,
  createBranchReference,
  parseBranchReference,
  parseBranchReferenceBlock,
  renderBranchReferenceBlock,
  serializeBranchReference
} from "../src/domain/branch-reference";
import { MAX_BRANCH_REFERENCE_BYTES } from "../src/input-limits";

test("a branch reference round-trips through its single-line JSON block", () => {
  const reference = createBranchReference("tree-id", "node-id", "Notes/项目.mtn.md");
  assert.equal(serializeBranchReference(reference), '{"tree":"tree-id","node":"node-id","path":"Notes/项目.mtn.md"}');
  const block = renderBranchReferenceBlock(reference);
  assert.equal(block, [
    `\`\`\`${BRANCH_REFERENCE_LANGUAGE}`,
    '{"tree":"tree-id","node":"node-id","path":"Notes/项目.mtn.md"}',
    "```"
  ].join("\n"));
  // Obsidian hands the fence body to the code-block processor, while clipboard
  // text is the complete block: both entry points must agree.
  assert.deepEqual(parseBranchReference(block.split("\n").slice(1, -1).join("\n")), reference);
  assert.deepEqual(parseBranchReferenceBlock(block), reference);
  assert.deepEqual(parseBranchReferenceBlock(`\r\n  ${block}\r\n`), reference);
  assert.deepEqual(parseBranchReferenceBlock("```mind-tree-ref\n{\"tree\":\"tree-id\",\"node\":\"node-id\",\"path\":\"Notes/项目.mtn.md\"}\n```"), reference);
});

test("the path hint is optional and the identity is required", () => {
  const reference = createBranchReference("tree-id", "node-id");
  assert.deepEqual(reference, { documentId: "tree-id", nodeId: "node-id" });
  assert.deepEqual(parseBranchReference('{"tree":"tree-id","node":"node-id"}'), reference);
  assert.equal(serializeBranchReference(reference), '{"tree":"tree-id","node":"node-id"}');
  assert.throws(() => createBranchReference("", "node-id"), /tree identity/);
  assert.throws(() => createBranchReference("tree-id", ""), /node id/);
});

test("malformed references collapse to undefined instead of throwing", () => {
  const invalid = [
    "",
    "   ",
    "{}",
    "{",
    "null",
    "[]",
    '"tree-id"',
    '{"tree":"tree-id"}',
    '{"node":"node-id"}',
    '{"tree":"","node":"node-id"}',
    '{"tree":"   ","node":"node-id"}',
    '{"tree":"tree-id","node":"node-id"} trailing',
    '{"tree":1,"node":2}',
    '{"tree":{},"node":[]}',
    '{"tree":{"documentId":"tree-id"},"node":"node-id"}',
    '{"tree":"tree-id","node":"' + "n".repeat(129) + '"}',
    '{"tree":"' + "t".repeat(513) + '","node":"node-id"}',
    "a".repeat(MAX_BRANCH_REFERENCE_BYTES + 1)
  ];
  for (const source of invalid) {
    assert.equal(parseBranchReference(source), undefined, source.slice(0, 40));
  }
});

test("an over-long path hint is dropped instead of rejecting the reference", () => {
  const parsed = parseBranchReference(`{"tree":"tree-id","node":"node-id","path":"${"p".repeat(1025)}"}`);
  assert.deepEqual(parsed, { documentId: "tree-id", nodeId: "node-id" });
  assert.deepEqual(parseBranchReference(`{"tree":"tree-id","node":"node-id","path":"ok.mtn.md"}`),
    { documentId: "tree-id", nodeId: "node-id", pathHint: "ok.mtn.md" });
});

test("only a complete reference block is recognized as clipboard content", () => {
  const block = renderBranchReferenceBlock(createBranchReference("tree-id", "node-id", "a.mtn.md"));
  const rejected = [
    `prose\n${block}`,
    `${block}\nprose`,
    `${block}\n${block}`,
    "```mind-tree-ref\n{\"tree\":\"tree-id\",\"node\":\"node-id\"}\n",
    "~~~mind-tree-ref\n{\"tree\":\"tree-id\",\"node\":\"node-id\"}\n~~~",
    "```mind-tree-ref\nnot json\n```",
    "```mind-tree-ref\n{}\n```",
    "```md\n{\"tree\":\"tree-id\",\"node\":\"node-id\"}\n```"
  ];
  for (const text of rejected) {
    assert.equal(parseBranchReferenceBlock(text), undefined, text.slice(0, 40));
  }
});
