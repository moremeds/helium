import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@helium/core";
import { ScriptExecutor, ScriptRegistry } from "dsh-plugin-ops-agent";
import { describe, expect, it } from "vitest";
import { LivewireBridge, LivewireReceiptSchema } from "./bridge.js";
import { createWorkUnit } from "./work-unit.js";

const unit = createWorkUnit({
  kind: "market-partition",
  provider: "massive",
  assetClass: "equity",
  marketDate: "2026-08-28",
  timeframe: "1m",
  layer: "bronze",
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    operationKind: "probe",
    operationId: "probe-1",
    workUnitId: unit.workUnitId,
    outcome: "completed",
    stateHint: "VERIFIED",
    scopeHash: unit.scopeHash,
    evidence: [{ ref: "artifact://logical/bars", sha256: "a".repeat(64) }],
    changedPaths: [],
    summary: { rows: 10 },
    ...overrides,
  };
}

describe("LivewireReceiptSchema", () => {
  it("rejects extra fields and contradictory outcome/state combinations", () => {
    expect(LivewireReceiptSchema.safeParse(receipt({ extra: true })).success).toBe(false);
    expect(LivewireReceiptSchema.safeParse(receipt({ outcome: "failed", stateHint: "VERIFIED" })).success).toBe(false);
    expect(LivewireReceiptSchema.safeParse(receipt({ outcome: "temporary-unavailable", stateHint: "QUARANTINED" })).success).toBe(false);
    expect(LivewireReceiptSchema.safeParse(receipt({ outcome: "completed", stateHint: "UNRESOLVED" })).success).toBe(false);
    expect(LivewireReceiptSchema.safeParse(receipt({ evidence: [] })).success).toBe(false);
  });
});

describe("LivewireBridge", () => {
  it("accepts exit 75 only with a typed AWAITING_USER receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-livewire-wait-"));
    const artifacts = new ContentAddressedArtifactStore(join(root, "artifacts"), { sync: () => {} });
    const output = JSON.stringify(receipt({
      outcome: "temporary-unavailable",
      stateHint: "AWAITING_USER",
      evidence: [],
    }));
    const body = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)}); process.exitCode = 75;\n`;
    const script = join(root, "probe");
    writeFileSync(script, body, { mode: 0o700 });
    chmodSync(script, 0o700);
    const registry = ScriptRegistry.load([{
      executorId: "livewire-probe",
      path: script,
      identity: { kind: "sha256", value: createHash("sha256").update(body).digest("hex") },
      argvSchema: { id: "probe-v1", params: [] },
      cwd: root,
      environmentProfile: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }]);
    const bridge = new LivewireBridge({
      registry,
      executor: new ScriptExecutor(registry),
      artifacts,
      changedPathRoots: [join(root, "data")],
    });

    const result = await bridge.probe({
      executorId: "livewire-probe",
      operationId: "probe-1",
      workUnit: unit,
      argv: [],
      signal: new AbortController().signal,
    });

    expect(result.execution.exit.code).toBe(75);
    expect(result.outcome).toBe("temporary-unavailable");
    expect(result.stateHint).toBe("AWAITING_USER");
  });

  it("persists exact stdout before parsing and binds the receipt to the work unit", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-livewire-bridge-"));
    const artifacts = new ContentAddressedArtifactStore(join(root, "artifacts"), { sync: () => {} });
    const evidence = artifacts.put("bars evidence");
    const output = JSON.stringify(receipt({ evidence: [{ ref: "artifact://logical/bars", sha256: evidence.hash.slice(7) }] }));
    const script = join(root, "probe");
    writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o700 });
    chmodSync(script, 0o700);
    const registry = ScriptRegistry.load([{
      executorId: "livewire-probe",
      path: script,
      identity: { kind: "sha256", value: createHash("sha256").update(`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`).digest("hex") },
      argvSchema: { id: "probe-v1", params: [] },
      cwd: root,
      environmentProfile: {},
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }]);
    const bridge = new LivewireBridge({
      registry,
      executor: new ScriptExecutor(registry),
      artifacts,
      changedPathRoots: [join(root, "data")],
    });
    const result = await bridge.probe({
      executorId: "livewire-probe",
      operationId: "probe-1",
      workUnit: unit,
      argv: [],
      signal: new AbortController().signal,
    });
    expect(result.receipt.workUnitId).toBe(unit.workUnitId);
    expect(artifacts.read(result.stdout.ref).toString()).toBe(output);
    expect(result.execution.outputDigest).toBe(result.stdout.hash);
  });

  it("rejects extra stdout, a changed identity, any read-only change, and missing evidence bytes", async () => {
    const base = receipt();
    expect(() => LivewireBridge.validateReceipt(`${JSON.stringify(base)}\nnoise`, unit, "probe-1", ["/tmp"])).toThrow();
    expect(() => LivewireBridge.validateReceipt(JSON.stringify({ ...base, workUnitId: "lws-00000000000000000000000000000000" }), unit, "probe-1", ["/tmp"])).toThrow(/work unit/i);
    expect(() => LivewireBridge.validateReceipt(JSON.stringify({ ...base, changedPaths: ["relative"] }), unit, "probe-1", ["/tmp"])).toThrow(/absolute/i);
    expect(() => LivewireBridge.validateReceipt(JSON.stringify({ ...base, changedPaths: ["/outside/file"] }), unit, "probe-1", ["/tmp"])).toThrow(/outside/i);
    expect(() => LivewireBridge.validateReceipt(JSON.stringify({ ...base, changedPaths: ["/tmp/file"] }), unit, "probe-1", ["/tmp"])).toThrow(/read-only/i);
    const parsed = LivewireBridge.validateReceipt(JSON.stringify(base), unit, "probe-1", ["/tmp"]);
    const empty = new ContentAddressedArtifactStore(mkdtempSync(join(tmpdir(), "helium-livewire-missing-evidence-")));
    expect(() => LivewireBridge.verifyEvidence(parsed, empty)).toThrow();
  });
});
