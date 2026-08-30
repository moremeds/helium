import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  type ConformanceRecord,
  type Executor,
  type ExecutionTargetId,
} from "@helium/core";
import { claudeSubscriptionCatalog } from "./catalog.js";
import { registerCertifiedClaudeTargets } from "./executor.js";

const processProof = (targetId: ExecutionTargetId): ConformanceRecord => ({
  targetId,
  provenClass: "process",
  basis: "execution-boundary-conformance",
  recordedAt: "2026-08-30T00:00:00.000Z",
});

class TestExecutorRegistry {
  readonly values = new Map<string, Executor>();
  get(id: ExecutionTargetId) { return this.values.get(String(id)); }
  register(executor: Executor) {
    this.values.set(String(executor.targetId), executor);
    return () => void this.values.delete(String(executor.targetId));
  }
}

describe("registerCertifiedClaudeTargets", () => {
  it("creates one no-effort Haiku target and no orchestration target", () => {
    const capabilities = new CapabilityCatalog();
    const executors = new TestExecutorRegistry();
    const registered = registerCertifiedClaudeTargets({
      certification: {
        certificationVersion: "claude-historical-fixture-v1",
        catalogSnapshotHash: claudeSubscriptionCatalog.snapshotHash,
        recordedAt: "2026-08-25T00:00:00.000Z",
        source: "historical-fixture",
        targets: [
          { targetRef: "claude-haiku-4-5-20251001", variants: [null] },
          { targetRef: "claude-sonnet-5", variants: ["high"] },
        ],
      },
      capabilityCatalog: capabilities,
      executorRegistry: executors,
      conformanceFor: processProof,
      targetProfile: {
        capabilities: ["analysis.general"],
        operations: {},
        supports: { structuredOutput: true, toolIsolation: true, mutations: true },
      },
      invoke: async () => {
        throw new Error("not invoked by registration test");
      },
    });
    expect(registered.map((entry) => entry.native.effort)).toEqual([undefined, "high"]);
    expect(registered.some((entry) => entry.native.executionMode !== undefined)).toBe(false);
  });
});
