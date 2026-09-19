import test from "node:test";
import assert from "node:assert/strict";
import {
  findSameNameRecoveryPaths,
  isRecoveryReminderContextCurrent,
  recoveryRootPathForFile
} from "../src/services/recovery-reminder";

test("same-name recovery detection is limited to the current tree directory", () => {
  const current = "Math/Signals.mtn.md";
  const older = "Math/_Mind Tree Recovery/20260831-235959-999/Signals.mtn.md";
  const newer = "Math/_Mind Tree Recovery/20260901-120000-001/Signals.mtn.md";
  const matches = findSameNameRecoveryPaths(current, [
    older,
    newer,
    "Math/_Mind Tree Recovery/20260901-120000-001/Other.mtn.md",
    "Physics/_Mind Tree Recovery/20260901-120000-001/Signals.mtn.md",
    "Math/Other Recovery/20260901-120000-001/Signals.mtn.md",
    "Math/_Mind Tree Recovery/not-a-timestamp/Signals.mtn.md",
    "Math/_Mind Tree Recovery/20260901-120000-001/nested/Signals.mtn.md",
    "Math/_Mind Tree Recovery/20260901-120000-001/Signals-2.mtn.md"
  ]);

  assert.deepEqual(matches, [newer, older]);
});

test("root trees and Windows separators normalize without broadening exact names", () => {
  assert.equal(recoveryRootPathForFile("Root.mtn.md"), "_Mind Tree Recovery");
  assert.deepEqual(findSameNameRecoveryPaths("Notes\\Root.mtn.md", [
    "Notes\\_Mind Tree Recovery\\20260901-120000-001\\Root.mtn.md",
    "Notes/_Mind Tree Recovery/20260901-120000-001/root.mtn.md"
  ]), ["Notes/_Mind Tree Recovery/20260901-120000-001/Root.mtn.md"]);
});

test("opening a recovery copy never starts a recursive reminder lookup", () => {
  const recovery = "Math/_Mind Tree Recovery/20260901-120000-001/Signals.mtn.md";
  assert.equal(recoveryRootPathForFile(recovery), undefined);
  assert.deepEqual(findSameNameRecoveryPaths(recovery, [
    "Math/_Mind Tree Recovery/20260901-120000-001/_Mind Tree Recovery/20260901-120000-002/Signals.mtn.md"
  ]), []);
});

test("a delayed reminder is cancelled after either path or session changes", () => {
  const captured = { filePath: "Math/Signals.mtn.md", sessionToken: "session-a" };
  assert.equal(isRecoveryReminderContextCurrent(captured, "Math/Signals.mtn.md", "session-a"), true);
  assert.equal(isRecoveryReminderContextCurrent(captured, "Math/Other.mtn.md", "session-a"), false);
  assert.equal(isRecoveryReminderContextCurrent(captured, "Math/Signals.mtn.md", "session-b"), false);
});

test("moving or deleting the last recovery makes the next lookup empty", () => {
  const current = "Math/Signals.mtn.md";
  assert.deepEqual(findSameNameRecoveryPaths(current, []), []);
  assert.deepEqual(findSameNameRecoveryPaths(current, [
    "Archive/_Mind Tree Recovery/20260901-120000-001/Signals.mtn.md"
  ]), []);
});
