import test from "node:test";
import assert from "node:assert/strict";
import { shouldHandleMindTreePaste } from "../src/ui/paste-routing";

test("only the active mind-tree view captures document paste", () => {
  assert.equal(shouldHandleMindTreePaste({
    viewActive: false,
    targetInView: true,
    targetEditable: false,
    targetVisible: true
  }), false);
  assert.equal(shouldHandleMindTreePaste({
    viewActive: true,
    targetInView: true,
    targetEditable: false,
    targetVisible: true
  }), true);
});

test("visible editors keep native paste while hidden stale editors do not", () => {
  assert.equal(shouldHandleMindTreePaste({
    viewActive: true,
    targetInView: true,
    targetEditable: true,
    targetVisible: true
  }), false);
  assert.equal(shouldHandleMindTreePaste({
    viewActive: true,
    targetInView: false,
    targetEditable: true,
    targetVisible: true
  }), false);
  assert.equal(shouldHandleMindTreePaste({
    viewActive: true,
    targetInView: false,
    targetEditable: true,
    targetVisible: false
  }), true);
});

test("visible modal, menu, and code-editor surfaces always retain native paste", () => {
  assert.equal(shouldHandleMindTreePaste({
    viewActive: true,
    targetInView: false,
    targetEditable: false,
    targetVisible: true,
    nativePasteSurfaceVisible: true
  }), false);
});
