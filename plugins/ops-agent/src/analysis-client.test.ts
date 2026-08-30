import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsStore } from "@helium/core";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOpsAnalysisClient } from "./analysis-client.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DurableOpsAnalysisClient", () => {
  it("restores the quota backoff after a process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-analysis-client-"));
    roots.push(root);
    const store = OperationsStore.open(root, { sync: () => {} });
    let at = Date.parse("2026-08-30T00:00:00.000Z");
    let calls = 0;
    const options = {
      analysisId: "fixture-analysis",
      store,
      now: () => new Date(at),
      baseBackoffMs: 60_000,
      delegate: {
        async publish() {
          calls += 1;
          throw new Error("quota exhausted");
        },
      },
    };

    await new DurableOpsAnalysisClient(options).publish({});
    await new DurableOpsAnalysisClient(options).publish({});
    expect(calls).toBe(1);
    expect(store.state().analysis).toHaveLength(1);

    at += 60_000;
    await new DurableOpsAnalysisClient(options).publish({});
    expect(calls).toBe(2);
    expect(store.state().analysis.at(-1)).toMatchObject({
      status: "unavailable",
      consecutiveFailures: 2,
      retryAt: "2026-08-30T00:03:00.000Z",
    });
  });
});
