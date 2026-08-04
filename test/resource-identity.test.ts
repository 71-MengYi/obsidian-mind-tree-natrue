import test from "node:test";
import assert from "node:assert/strict";
import { decideDocumentIdentityWrite, decideDuplicateIdentity } from "../src/services/resource-identity";

test("a unique unlinked or linked tree keeps its current identity state", () => {
  assert.deepEqual(decideDuplicateIdentity("Math.mtn.md", undefined, false, ["Math.mtn.md"]), { action: "keep" });
});

test("a copied tree is reassigned when a historical owner is known", () => {
  assert.deepEqual(decideDuplicateIdentity(
    "数学/信号处理/信号处理.mtn.md",
    "数学/数学.mtn.md",
    true,
    ["数学/数学.mtn.md", "数学/信号处理/信号处理.mtn.md"]
  ), { action: "reassign" });
  assert.deepEqual(decideDuplicateIdentity(
    "数学/数学.mtn.md",
    "数学/数学.mtn.md",
    true,
    ["数学/数学.mtn.md", "数学/信号处理/信号处理.mtn.md"]
  ), { action: "keep" });
});

test("ambiguous duplicate identities are rejected with every conflicting path", () => {
  assert.deepEqual(decideDuplicateIdentity(
    "B.mtn.md",
    "A.mtn.md",
    false,
    ["B.mtn.md", "A.mtn.md", "B.mtn.md"]
  ), { action: "reject", paths: ["A.mtn.md", "B.mtn.md"] });
});

test("concurrent first-link writes keep the first persisted identity", () => {
  assert.deepEqual(decideDocumentIdentityWrite(undefined, "first"), {
    documentId: "first",
    write: true
  });
  assert.deepEqual(decideDocumentIdentityWrite("first", "second"), {
    documentId: "first",
    write: false
  });
});

test("duplicate repair replaces only the identity it inspected", () => {
  assert.deepEqual(decideDocumentIdentityWrite("copied", "replacement", "copied"), {
    documentId: "replacement",
    write: true
  });
  assert.deepEqual(decideDocumentIdentityWrite("other-winner", "replacement", "copied"), {
    documentId: "other-winner",
    write: false
  });
});
