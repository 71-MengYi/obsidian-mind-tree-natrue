import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "fflate";
import { normalizeBranchClipboardPayload } from "../src/domain/clipboard-payload";
import { createEmptyDocument, validateDocument } from "../src/domain/tree";
import { boundedGunzip } from "../src/format/document";
import {
  MAX_DECOMPRESSED_MIND_TREE_BYTES,
  MAX_MIND_TREE_DEPTH,
  MAX_MIND_TREE_NODES,
  assertJsonContainerDepth
} from "../src/input-limits";
import { readClipboardEventContent } from "../src/services/clipboard";
import type { BranchClipboardPayload, MindTreeNode } from "../src/types";

function clipboardNode(id: string, childIds: string[] = []): MindTreeNode {
  return { id, title: id, childIds, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

test("streaming gunzip rejects a compact payload as soon as output crosses 50 MiB", () => {
  const expanded = new Uint8Array(MAX_DECOMPRESSED_MIND_TREE_BYTES + 1);
  const compressed = gzipSync(expanded, { level: 9 });
  assert.ok(compressed.byteLength < expanded.byteLength / 100);
  assert.throws(() => boundedGunzip(compressed), /50 MB safety limit/i);
});

test("document validation enforces 10,000 nodes and 256 actual levels", () => {
  const tooMany = createEmptyDocument("Root");
  for (let index = 1; index < MAX_MIND_TREE_NODES + 1; index += 1) {
    const id = `detached-${index}`;
    tooMany.nodes[id] = clipboardNode(id);
  }
  assert.match(validateDocument(tooMany).issues[0]?.code ?? "", /node-count/);

  const deep = createEmptyDocument("Root");
  let parent = deep.rootId;
  for (let depth = 1; depth < MAX_MIND_TREE_DEPTH; depth += 1) {
    const id = `depth-${depth}`;
    deep.nodes[id] = clipboardNode(id);
    deep.nodes[parent]!.childIds = [id];
    parent = id;
  }
  assert.equal(validateDocument(deep).valid, true);
  const excessive = "depth-256";
  deep.nodes[excessive] = clipboardNode(excessive);
  deep.nodes[parent]!.childIds = [excessive];
  assert.equal(validateDocument(deep).issues.some((issue) => issue.code === "tree-depth"), true);
});

test("structured clipboard validation rejects cycles, multiple parents and special keys", () => {
  const cycle: BranchClipboardPayload = {
    sourceDocumentId: "source",
    rootId: "a",
    nodes: { a: clipboardNode("a", ["b"]), b: clipboardNode("b", ["a"]) }
  };
  assert.throws(() => normalizeBranchClipboardPayload(cycle), /cycle|root cannot be a child/i);

  const shared: BranchClipboardPayload = {
    sourceDocumentId: "source",
    rootId: "a",
    nodes: {
      a: clipboardNode("a", ["b", "c"]),
      b: clipboardNode("b", ["d"]),
      c: clipboardNode("c", ["d"]),
      d: clipboardNode("d")
    }
  };
  assert.throws(() => normalizeBranchClipboardPayload(shared), /multiple parents/i);
  const unsafe = JSON.parse('{"nodes":{"__proto__":{"id":"__proto__","title":"x","childIds":[]}},"rootId":"__proto__"}') as unknown;
  assert.throws(() => normalizeBranchClipboardPayload(unsafe), /unsafe object key/i);
});

test("generic JSON nesting is iterative and bounded", () => {
  let value: unknown = "leaf";
  for (let depth = 0; depth <= 256; depth += 1) value = { child: value };
  assert.throws(() => assertJsonContainerDepth(value), /nesting exceeds/i);
});

test("invalid custom clipboard data degrades to its plain-text representation", () => {
  const unsafeJson = '{"nodes":{"constructor":{}},"rootId":"constructor"}';
  const event = {
    clipboardData: {
      getData(type: string): string {
        return type === "application/x-mind-tree-nature+json" ? unsafeJson : "plain fallback";
      }
    }
  } as ClipboardEvent;
  assert.deepEqual(readClipboardEventContent(event), { kind: "text", text: "plain fallback" });
});
