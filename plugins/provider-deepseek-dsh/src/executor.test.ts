import { describe, expect, it } from "vitest";
import {
  CapabilityCatalog,
  conformanceAtFloor,
  type Executor,
  type ExecutionTargetId,
} from "@helium/core";
import { deepseekDshCatalog } from "./catalog.js";
import { registerCertifiedDeepSeekTargets } from "./executor.js";

class TestExecutorRegistry {
  readonly values = new Map<string, Executor>();
  get(id: ExecutionTargetId) { return this.values.get(String(id)); }
  register(executor: Executor) {
    this.values.set(String(executor.targetId), executor);
    return () => void this.values.delete(String(executor.targetId));
  }
}

describe("registerCertifiedDeepSeekTargets", () => {
  it("keeps uncertified and disabled variants out of routing", () => {
    const capabilities = new CapabilityCatalog();
    const executors = new TestExecutorRegistry();
    const registered = registerCertifiedDeepSeekTargets({
      certification: {
        certificationVersion: "deepseek-fixture-v1",
        catalogSnapshotHash: deepseekDshCatalog.snapshotHash,
        recordedAt: "2026-08-30T00:00:00.000Z",
        source: "fixture",
        targets: [{ targetRef: "deepseek-v4-flash", variants: ["high"] }],
      },
      capabilityCatalog: capabilities,
      executorRegistry: executors,
      conformanceFor: conformanceAtFloor,
      targetProfile: {
        capabilities: ["analysis.general"],
        operations: {},
        supports: { structuredOutput: true, toolIsolation: true, mutations: false },
      },
      boundary: {
        run: async () => ({ text: "ok", usage: {}, providerMetadata: {} }),
      },
    });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.native).toMatchObject({
      model: "deepseek-v4-flash",
      effort: "high",
      quotaDomain: "deepseek-api-key",
    });
  });
});
