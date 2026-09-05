import { describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import { buildSettler } from "../tools/index.js";

const open: Commitment = {
  id: "fake-1",
  runId: "run-0",
  tenant: "fake-tenant",
  issuedAt: "2026-09-04T00:00:00Z",
  deployment: "test",
  variant: "live",
  payload: { answer: 42 },
};

describe("fake-tenant settler", () => {
  const settler = buildSettler({
    stateRoot: "/state",
    env: {},
    variant: "live",
  });

  it("settles every outstanding commitment with a constant score", async () => {
    const receipts = await settler.settle(
      [open],
      new Date("2026-09-05T00:00:00Z"),
    );
    expect(receipts).toEqual([
      {
        commitmentId: "fake-1",
        runId: "",
        settledAt: "2026-09-05T00:00:00.000Z",
        status: "settled",
        scores: { fakeScore: 1 },
      },
    ]);
  });

  it("settles nothing when nothing is outstanding", async () => {
    expect(await settler.settle([], new Date())).toEqual([]);
  });
});
