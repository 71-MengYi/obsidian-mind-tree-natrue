import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldHandleMindTreePaste,
  shouldHandleMindTreeStaleKey
} from "../src/ui/document-event-routing";

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

test("a rendered tree claims Tab from an editor of a tab that is no longer painted", () => {
  assert.equal(shouldHandleMindTreeStaleKey({
    viewVisible: true,
    targetOutsideEditable: true,
    targetVisible: false
  }), true);
});

test("a visible editor keeps its own keys even when the tree is rendered", () => {
  assert.equal(shouldHandleMindTreeStaleKey({
    viewVisible: true,
    targetOutsideEditable: true,
    targetVisible: true
  }), false);
});

test("a hidden tree never reaches into another leaf's editor", () => {
  assert.equal(shouldHandleMindTreeStaleKey({
    viewVisible: false,
    targetOutsideEditable: true,
    targetVisible: false
  }), false);
});

test("visible modals, menus, and non-editable host surfaces keep Tab", () => {
  assert.equal(shouldHandleMindTreeStaleKey({
    viewVisible: true,
    targetOutsideEditable: true,
    targetVisible: false,
    nativeSurfaceVisible: true
  }), false);
  // A sidebar row or the workspace body is not a text surface: Tab keeps its
  // ordinary focus navigation there.
  assert.equal(shouldHandleMindTreeStaleKey({
    viewVisible: true,
    targetOutsideEditable: false,
    targetVisible: false
  }), false);
});
