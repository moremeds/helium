import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTargetCycle } from "./opsd-cycle-after.mjs";

const target = "/releases/v1";
const row = (at, releaseRef = target, observationCount = 1) => JSON.stringify({
  record: { type: "controller-cycle-recorded", at, releaseRef, observationCount },
});

test("accepts only a target cycle strictly after the flip and not in the future", () => {
  const now = Date.parse("2026-08-30T00:10:00.000Z");
  const since = Date.parse("2026-08-30T00:00:00.000Z") / 1000;
  assert.equal(hasTargetCycle(row("2026-08-30T00:05:00.000Z"), since, target, now), true);
  assert.equal(hasTargetCycle(row("2026-08-30T01:00:00.000Z"), since, target, now), false);
  assert.equal(hasTargetCycle(row("2026-08-29T23:59:59.000Z"), since, target, now), false);
  assert.equal(hasTargetCycle(row("2026-08-30T00:05:00.000Z", "/releases/old"), since, target, now), false);
  assert.equal(hasTargetCycle(row("2026-08-30T00:05:00.000Z", target, 0), since, target, now), false);
});
