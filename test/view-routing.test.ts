import test from "node:test";
import assert from "node:assert/strict";
import { MIND_TREE_VIEW_TYPE, isMindTreePath, routeMindTreeViewState } from "../src/view-routing";

test("routes .mtn.md markdown requests before the Markdown view is created", () => {
  const requested = {
    type: "markdown",
    state: { file: "projects/Plan.mtn.md", mode: "source" },
    active: true
  };
  const routed = routeMindTreeViewState(requested);
  assert.equal(routed.type, MIND_TREE_VIEW_TYPE);
  assert.deepEqual(routed.state, requested.state);
  assert.equal(routed.active, true);
});

test("does not reroute ordinary Markdown files or explicit custom view states", () => {
  const markdown = { type: "markdown", state: { file: "projects/Plan.md" } };
  const custom = { type: MIND_TREE_VIEW_TYPE, state: { file: "projects/Plan.mtn.md" } };
  assert.equal(routeMindTreeViewState(markdown), markdown);
  assert.equal(routeMindTreeViewState(custom), custom);
});

test("classifies mind-tree suffixes the same way on every platform and casing", () => {
  // The vault index already accepted these before the router did; keeping one
  // classifier prevents a tree from being indexed without ever opening as a tree.
  for (const path of [
    "projects/Plan.mtn.md",
    "projects/Plan.MTN.MD",
    "projects/Plan.Mtn.Md",
    "projects\\Plan.mtn.md"
  ]) {
    assert.equal(isMindTreePath(path), true, path);
  }
  for (const path of ["projects/Plan.md", "projects/Plan.mtn.md.bak", "notes/Plan.mtn"]) {
    assert.equal(isMindTreePath(path), false, path);
  }
});
