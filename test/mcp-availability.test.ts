import test from "node:test";
import assert from "node:assert/strict";
import { isMcpSupported } from "../src/services/mcp/availability";

test("a desktop platform supports the local MCP endpoint", () => {
  assert.equal(isMcpSupported({ isDesktop: true }), true);
});

test("the mobile runtime is refused", () => {
  assert.equal(isMcpSupported({ isDesktop: false }), false);
});

test("the predicate is stateless and does not touch its argument", () => {
  const facts = { isDesktop: true };
  const before = { ...facts };
  for (let round = 0; round < 3; round += 1) assert.equal(isMcpSupported(facts), true);
  assert.deepEqual(facts, before);

  // Only the desktop flag matters; extra platform facts must not flip the answer.
  const noisyFacts = { isDesktop: true, isMobile: false, isDesktopApp: false };
  assert.equal(isMcpSupported(noisyFacts), true);
});

