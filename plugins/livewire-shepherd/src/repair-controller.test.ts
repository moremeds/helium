import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostconditionSample } from "@helium/core/operations/action.js";
import {
  OperationsEventSchema,
  type OperationsEvent,
} from "@helium/core/operations/events.js";
import { ActionLeaseController, ActionLeaseTable } from "@helium/core/operations/lease.js";
import {
  emptyOperationsState,
  reduceOperations,
  type OperationsState,
} from "@helium/core/operations/reducer.js";
import {
  CertifiedActionRunner,
  FileComponentActionLocks,
  type OperationsStorePort,
} from "dsh-plugin-ops-agent";
import { describe, expect, it } from "vitest";
import type { WorkUnitProjection } from "./reducer.js";
import {
  ShepherdRepairController,
  repairManifestFilename,
} from "./repair-controller.js";
import { createWorkUnit } from "./work-unit.js";

const NOW = new Date("2026-08-31T22:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}` as const;
const securityId = "sec_00000000000000000000000000000001";
const component = {
  version: 1 as const,
  id: "livewire",
  kind: "data-pipeline",
  mutationOwner: {
    owner: "opsd" as const,
    competingLabels: [],
    changedAt: NOW.toISOString(),
    changeRef: "artifact://ownership/livewire",
  },
};
const check = {
  id: "livewire-repair-verified",
  kind: "business" as const,
  probe: { probeId: "livewire.repair-verify.v1", args: {} },
  expect: { dimension: "repair", operator: "eq" as const, value: true },
  onUnavailable: "unknown" as const,
  timeoutMs: 5_000,
  owner: "ops",
};

class MemoryStore implements OperationsStorePort {
  readonly events: OperationsEvent[] = [];
  #state: OperationsState = emptyOperationsState();

  append(raw: unknown): OperationsEvent {
    const event = OperationsEventSchema.parse(raw);
    this.#state = reduceOperations([event], this.#state);
    this.events.push(event);
    return event;
  }

  state(): OperationsState { return this.#state; }
  replay(): OperationsEvent[] { return [...this.events]; }
}

function fixture(options: { beforeGate?: (manifestPath: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "helium-shepherd-repair-controller-"));
  const readyDir = join(root, "ready");
  mkdirSync(readyDir, { recursive: true, mode: 0o700 });
  const unit = createWorkUnit({
    kind: "security-interval",
    securityId,
    symbol: "AAPL",
    symbolValidFrom: "2000-01-01T00:00:00Z",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    layer: "bronze",
  });
  const manifestPath = join(readyDir, repairManifestFilename(unit.scopeHash));
  const manifest = {
    version: 1,
    operationId: "repair-aapl-20260831",
    workUnitId: unit.workUnitId,
    scopeHash: unit.scopeHash,
    dataLakeRoot: "/Volumes/DATA_LAKE/livewire/data-lake",
    layer: "bronze",
    securityId,
    symbol: "AAPL",
    symbolValidFrom: "2000-01-01T00:00:00Z",
    symbolValidTo: null,
    identityAsOf: "2026-08-31T00:00:00Z",
    securityMasterRevision: 1,
    securityMasterSha256: "b".repeat(64),
    sessionPolicy: "XNYS-close-and-early-close-v2",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    priorArtifacts: [{
      path: "bronze/asset_class=equity/symbol=AAPL/1d.parquet",
      sha256: "c".repeat(64),
    }],
    sourceEvidence: [{ ref: "artifact://livewire/raw/patch", sha256: "d".repeat(64) }],
    maxRows: 10,
    maxBytes: 1_000_000,
    expiresAt: "2026-09-01T23:00:00Z",
    operation: "daily-merge",
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  chmodSync(manifestPath, 0o600);
  const manifestHash = `sha256:${createHash("sha256").update(readFileSync(manifestPath)).digest("hex")}` as const;
  const manifestEvidence = {
    ref: `artifact://sha256/${manifestHash.slice("sha256:".length)}`,
    hash: manifestHash,
  };
  const projection: WorkUnitProjection = {
    unit,
    discoveredAt: NOW.toISOString(),
    state: "REPAIR_READY",
    revision: 1,
    evidence: { [manifestEvidence.ref]: manifestEvidence },
    claims: {},
    attempts: {},
    verificationPassed: false,
    repairVerificationPassed: false,
    coverage: {},
  };
  const store = new MemoryStore();
  let requestArgv: string[] | undefined;
  let spawned = false;
  const runner = new CertifiedActionRunner({
    store,
    now: () => NOW,
    nextId: (() => { let id = 0; return (prefix) => `${prefix}-${++id}`; })(),
    sampleChecks: async () => [sample("fail")],
    sampleGrace: async () => ({ verdict: "pass", samples: [sample("pass")] }),
    controllerProbe: {
      async check() {
        return { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/clear" };
      },
    },
    leases: new ActionLeaseController(new ActionLeaseTable(), {
      controllerId: "repair-controller-test",
      ttlMs: 60_000,
      now: () => NOW,
    }),
    componentLocks: new FileComponentActionLocks({
      dir: join(root, "locks"),
      bootId: "boot-test",
    }),
    createExecutor: () => ({
      async run(request, _signal, gate) {
        requestArgv = [...request.argv];
        options.beforeGate?.(request.argv[1]!);
        const admitted = await gate?.();
        if (admitted?.admitted !== true) throw new Error("fixture gate refused");
        spawned = true;
        return {
          actionId: request.actionId,
          executorId: request.executorId,
          argv: request.argv,
          exit: { code: 0, signal: null },
          timedOut: false,
          outputTail: "ok",
          outputBytes: 2,
          outputDigest: `sha256:${"e".repeat(64)}`,
          startedAt: NOW.toISOString(),
          finishedAt: NOW.toISOString(),
        };
      },
    }),
  });
  const controller = new ShepherdRepairController({
    readyDir,
    runner,
    component,
    sop: {
      id: "livewire-daily-repair",
      digest,
      executorId: "livewire-repair-transaction",
      graceMs: 0,
      postconditions: [check],
    },
    now: () => NOW,
    verifyEvidence(evidence) {
      if (evidence.ref !== `artifact://sha256/${evidence.hash.slice("sha256:".length)}`) {
        throw new Error("fixture durable evidence mismatch");
      }
    },
    hooksFor: ({ actionId, incidentId }) => ({
      ensureProposed() {
        store.append({
          v: 1,
          id: "proposed-1",
          at: NOW.toISOString(),
          type: "action-proposed",
          actionId,
          incidentId,
          componentId: component.id,
          sopId: "livewire-daily-repair",
          sopVersion: 1,
          sopDigest: digest,
        });
      },
      ensureAuthorized() {
        store.append({
          v: 1,
          id: "authorized-1",
          at: NOW.toISOString(),
          type: "action-authorized",
          actionId,
          authority: "auto",
        });
      },
      recordTerminal(outcome, samples) {
        store.append({
          v: 1,
          id: "terminal-1",
          at: NOW.toISOString(),
          type: "action-verified",
          actionId,
          outcome,
          postconditionRefs: samples.map((row) => row.checkId),
          postconditionSamples: samples,
          recoveryEvidence: {
            ref: `artifact://recovery/${actionId}`,
            sha256: "f".repeat(64),
            schema: "helium.ops.recovery-evidence/v1",
            assertionId: `recovery-${actionId}`,
          },
        });
      },
    }),
  });
  return {
    controller,
    manifest,
    manifestPath,
    projection,
    store,
    requestArgv: () => requestArgv,
    spawned: () => spawned,
  };
}

function sample(state: "pass" | "fail"): PostconditionSample {
  return {
    checkId: check.id,
    state,
    observedAt: NOW.toISOString(),
    evidenceRefs: [`artifact://check/${state}`],
  };
}

describe("ShepherdRepairController", () => {
  it("derives the only argv from an evidence-bound ready manifest and uses the shared runner", async () => {
    const h = fixture();

    const result = await h.controller.run(h.projection);

    expect(result).toMatchObject({ disposition: "execute", outcome: "succeeded" });
    expect(result.scopeId).toBe(`${h.projection.unit.workUnitId}:${h.projection.unit.scopeHash}`);
    expect(h.requestArgv()).toEqual(["--manifest", result.manifest.path]);
    expect(h.spawned()).toBe(true);
    expect(h.store.events.map((event) => event.type)).toEqual([
      "action-proposed",
      "action-authorized",
      "action-intent-recorded",
      "action-receipt-recorded",
      "action-verified",
    ]);
    expect(h.store.events.find((event) => event.type === "action-intent-recorded")).toMatchObject({
      scopeId: result.scopeId,
      inputArtifacts: [{
        ref: result.manifest.evidence.ref,
        sha256: result.manifest.hash.slice("sha256:".length),
      }],
      argv: ["--manifest", result.manifest.path],
    });
  });

  it("rejects a manifest absent from durable evidence or mismatched to the work-unit scope", async () => {
    const missing = fixture();
    missing.projection.evidence = {};
    await expect(missing.controller.run(missing.projection)).rejects.toThrow(/durable evidence/);

    const mismatched = fixture();
    writeFileSync(mismatched.manifestPath, JSON.stringify({ ...mismatched.manifest, symbol: "MSFT" }));
    const hash = `sha256:${createHash("sha256").update(readFileSync(mismatched.manifestPath)).digest("hex")}` as const;
    mismatched.projection.evidence = {
      changed: { ref: `artifact://sha256/${hash.slice(7)}`, hash },
    };
    await expect(mismatched.controller.run(mismatched.projection)).rejects.toThrow(/exact work-unit scope/);
  });

  it("re-hashes at the final execution gate and records no intent if bytes change", async () => {
    const h = fixture({
      beforeGate: (path) => writeFileSync(path, `${readFileSync(path, "utf8")}\n`),
    });

    await expect(h.controller.run(h.projection)).rejects.toThrow(/durable evidence|execution boundary/);

    expect(h.spawned()).toBe(false);
    expect(h.store.events).toEqual([]);
  });

  it("refuses a work unit that has not reached REPAIR_READY", async () => {
    const h = fixture();
    h.projection.state = "ADJUDICATING";
    await expect(h.controller.run(h.projection)).rejects.toThrow(/not repair-ready/);
    expect(h.requestArgv()).toBeUndefined();
  });

  it("refuses a ready manifest readable by other host users", async () => {
    const h = fixture();
    chmodSync(h.manifestPath, 0o644);
    await expect(h.controller.run(h.projection)).rejects.toThrow(/private regular file/);
    expect(h.spawned()).toBe(false);
  });
});
