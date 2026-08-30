import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  type Executor,
  type ExecutionTargetId,
  type ConformanceRecord,
} from "@helium/core";
import { codexSubscriptionCatalog } from "./catalog.js";
import { registerCertifiedCodexTargets } from "./executor.js";

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
  list() { return [...this.values.values()]; }
}

describe("registerCertifiedCodexTargets", () => {
  it("publishes one stable opaque target per certified native variant", () => {
    const capabilities = new CapabilityCatalog();
    const executors = new TestExecutorRegistry();
    const registered = registerCertifiedCodexTargets({
      certification: {
        certificationVersion: "codex-fixture-v1",
        catalogSnapshotHash: codexSubscriptionCatalog.snapshotHash,
        recordedAt: "2026-08-30T00:00:00.000Z",
        source: "fixture",
        targets: [
          { targetRef: "gpt-5.6-sol", variants: ["high", "xhigh"] },
          { targetRef: "gpt-5.6-luna", variants: ["medium"] },
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
    expect(registered.map((entry) => entry.profile.targetId)).toEqual([
      expect.stringMatching(/^target-[a-f0-9]+$/),
      expect.stringMatching(/^target-[a-f0-9]+$/),
      expect.stringMatching(/^target-[a-f0-9]+$/),
    ]);
    expect(new Set(registered.map((entry) => entry.profile.targetId)).size).toBe(3);
    expect(registered.map((entry) => entry.native.effort)).toEqual([
      "high",
      "xhigh",
      "medium",
    ]);
    registered.dispose();
    expect(capabilities.list()).toEqual([]);
    expect(executors.list()).toEqual([]);
  });

  it("validates the entire certification before changing either registry", () => {
    const capabilities = new CapabilityCatalog();
    const executors = new TestExecutorRegistry();
    expect(() =>
      registerCertifiedCodexTargets({
        certification: {
          certificationVersion: "codex-bad-fixture-v1",
          catalogSnapshotHash: codexSubscriptionCatalog.snapshotHash,
          recordedAt: "2026-08-30T00:00:00.000Z",
          source: "fixture",
          targets: [
            { targetRef: "gpt-5.6-sol", variants: ["high"] },
            { targetRef: "gpt-5.3-codex-spark", variants: ["high"] },
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
          throw new Error("not invoked");
        },
      }),
    ).toThrow(/not enabled/i);
    expect(capabilities.list()).toEqual([]);
    expect(executors.list()).toEqual([]);
  });
});
