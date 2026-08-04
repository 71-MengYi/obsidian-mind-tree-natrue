import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { addNode, createEmptyDocument, findParentId, getDepth } from "../src/domain/tree";
import { parseMindTreeFile, serializeMindTreeFile } from "../src/format/document";
import { layoutTree } from "../src/ui/layout";

test("a 1,000-node document parses, indexes, lays out, and serializes within two seconds", () => {
  const document = createEmptyDocument("Performance root");
  const parents = [document.rootId];
  for (let index = 1; index < 1_000; index += 1) {
    const parentId = parents[Math.floor((index - 1) / 8)] ?? document.rootId;
    parents.push(addNode(document, parentId, `Topic ${index}`).id);
  }
  const source = serializeMindTreeFile(document);

  const started = performance.now();
  const parsed = parseMindTreeFile(source).document;
  const lastId = parents.at(-1)!;
  assert.ok(findParentId(parsed, lastId));
  assert.ok(Number.isFinite(getDepth(parsed, lastId)));
  const layout = layoutTree(parsed, parsed.rootId, true, 240, "balanced", "level");
  const roundTrip = serializeMindTreeFile(parsed, source);
  const elapsed = performance.now() - started;

  assert.equal(layout.nodes.length, 1_000);
  assert.ok(roundTrip.length > 0);
  assert.ok(elapsed < 2_000, `1,000-node baseline took ${elapsed.toFixed(1)} ms`);
});
