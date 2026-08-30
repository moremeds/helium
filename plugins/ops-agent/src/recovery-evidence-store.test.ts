import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OperationsEvent, RecoveryEvidence } from "@helium/core";
import { describe, expect, it } from "vitest";
import { FileRecoveryEvidenceStore } from "./recovery-evidence-store.js";

const NOW = "2026-08-30T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function fixture(artifacts: {
  receipt: { ref: string; sha256: string };
  observation: { ref: string; sha256: string };
  incident: { ref: string; sha256: string };
  raw: Array<{ ref: string; sha256: string }>;
}): RecoveryEvidence {
  return {
    assertionId: "recovery-act-1",
    componentId: "runtime",
    incidentId: "inc-1",
    observations: [artifacts.observation],
    rawArtifacts: artifacts.raw,
    incidentSnapshot: artifacts.incident,
    sopId: "repair",
    sopVersion: 1,
    sopDigest: digest,
    authorityManifestEntry: { sopId: "repair", version: 1, digest, authority: "auto" },
    authority: "auto",
    eligibility: { eligible: true, reasons: [] },
    mutationOwner: {
      owner: "opsd",
      competingLabels: [],
      changedAt: NOW,
      changeRef: "artifact://owner/1",
    },
    controllerProbe: {
      result: "clear",
      observedLabels: [],
      evidenceRef: "artifact://ops/raw/controller.json",
    },
    lease: { leaseId: "lease-1", operationId: "op-1" },
    baseline: {
      capturedAt: NOW,
      allPassing: false,
      samples: [{
        checkId: "ready",
        state: "fail",
        observedAt: NOW,
        evidenceRefs: ["artifact://ops/raw/baseline.json"],
      }],
    },
    intent: {
      actionId: "act-1",
      argv: [],
    },
    receipt: {
      exitCode: 0,
      timedOut: false,
      outputDigest: digest,
      evidence: artifacts.receipt,
    },
    postconditionSamples: [{
      checkId: "ready",
      state: "pass",
      observedAt: NOW,
      evidenceRefs: ["artifact://ops/raw/postcondition.json"],
    }],
    outcome: "succeeded",
    attribution: "automatic",
    verifier: { identity: "opsd", version: "1", decision: "pass" },
    replayRef: "eventlog://operations/action/act-1",
    status: "PROVEN",
    limitation: "",
  };
}

function persistFixture(store: FileRecoveryEvidenceStore) {
  const raw = store.hashArtifacts([
    "artifact://ops/raw/observation.json",
    "artifact://ops/raw/controller.json",
    "artifact://ops/raw/baseline.json",
    "artifact://ops/raw/postcondition.json",
  ]);
  const artifacts = {
    receipt: store.persistArtifact("receipt", { output: "bounded" }),
    observation: store.persistArtifact("observation", {
      version: 1,
      id: "obs-1",
      componentId: "runtime",
      probeId: "fixture.v1",
      observedAt: NOW,
      expiresAt: "2026-08-30T00:01:00.000Z",
      state: "failed",
      dimension: "readiness",
      evidenceRefs: ["artifact://ops/raw/observation.json"],
      parserVersion: "fixture/1",
    }),
    incident: store.persistArtifact("incident", { state: "open" }),
    raw,
  };
  return { artifacts, bundle: fixture(artifacts) };
}

function sourceBackedStore(dir: string) {
  const sources = new Map<string, string>();
  const store = new FileRecoveryEvidenceStore(dir, {
    readSourceArtifact: (ref) => sources.get(ref) ?? JSON.stringify({ ref }),
  });
  return { store, sources };
}

describe("FileRecoveryEvidenceStore", () => {
  it("publishes a schema-valid hashed bundle before verifying its terminal event", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-recovery-evidence-"));
    const { store } = sourceBackedStore(dir);
    const { bundle } = persistFixture(store);
    const ref = store.persistBundle(bundle);
    const event = {
      v: 1,
      id: "terminal-1",
      at: NOW,
      type: "action-verified",
      actionId: "act-1",
      outcome: "succeeded",
      attribution: "automatic",
      postconditionRefs: ["ready"],
      postconditionSamples: bundle.postconditionSamples,
      recoveryEvidence: ref,
    } satisfies OperationsEvent;
    expect(() => store.verifyEvent(event)).not.toThrow();
    expect(ref).toMatchObject({
      schema: "helium.ops.recovery-evidence/v1",
      assertionId: "recovery-act-1",
    });
  });

  it("rejects missing and hash-mismatched evidence during replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-recovery-tamper-"));
    const { store } = sourceBackedStore(dir);
    const { bundle } = persistFixture(store);
    const ref = store.persistBundle(bundle);
    const path = join(dir, basename(ref.ref));
    const original = readFileSync(path, "utf8");
    const event = {
      v: 1, id: "terminal-1", at: NOW, type: "action-verified",
      actionId: "act-1", outcome: "succeeded", attribution: "automatic", postconditionRefs: ["ready"],
      postconditionSamples: bundle.postconditionSamples,
      recoveryEvidence: ref,
    } satisfies OperationsEvent;

    writeFileSync(path, `${original} `, { mode: 0o600 });
    expect(() => store.verifyHistory([event])).toThrow(/hash mismatch/);
    expect(() => store.persistBundle({ ...bundle, observations: [] })).toThrow();
    expect(() => store.persistBundle({
      ...bundle,
      outcome: "failed",
      status: "PROVEN",
      verifier: { ...bundle.verifier, decision: "pass" },
    } as RecoveryEvidence)).toThrow(/failed outcome requires FAILED status/);
  });

  it("rejects missing nested artifacts and terminal fields that disagree with the bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-recovery-nested-"));
    const { store, sources } = sourceBackedStore(dir);
    const { artifacts, bundle } = persistFixture(store);
    const ref = store.persistBundle(bundle);
    const event = {
      v: 1, id: "terminal-1", at: NOW, type: "action-verified",
      actionId: "act-1", outcome: "succeeded", attribution: "automatic",
      postconditionRefs: ["ready"],
      postconditionSamples: bundle.postconditionSamples,
      recoveryEvidence: ref,
    } satisfies OperationsEvent;

    expect(() => store.verifyEvent({
      ...event,
      postconditionSamples: [{ ...event.postconditionSamples[0]!, state: "fail" }],
    })).toThrow(/postcondition samples mismatch/);
    const receiptPath = join(dir, basename(artifacts.receipt.ref));
    chmodSync(receiptPath, 0o644);
    expect(() => store.verifyEvent(event)).toThrow(/owner-only/);
    chmodSync(receiptPath, 0o600);
    rmSync(receiptPath);
    expect(() => store.verifyEvent(event)).toThrow(/missing recovery evidence artifact/);

    const restored = store.persistArtifact("receipt", { output: "bounded" });
    expect(restored.ref).toBe(artifacts.receipt.ref);
    sources.set("artifact://ops/raw/controller.json", "tampered");
    expect(() => store.verifyEvent(event)).toThrow(/raw evidence hash mismatch/);
  });

  it("replays production raw artifacts by exact path and hash", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "helium-recovery-raw-"));
    const rawDir = join(stateDir, "raw");
    mkdirSync(rawDir, { mode: 0o700 });
    for (const name of ["observation.json", "controller.json", "baseline.json", "postcondition.json"]) {
      writeFileSync(join(rawDir, name), `${name}\n`, { mode: 0o600 });
    }
    const store = new FileRecoveryEvidenceStore(join(stateDir, "evidence"));
    const { bundle } = persistFixture(store);
    const ref = store.persistBundle(bundle);
    const event = {
      v: 1, id: "terminal-raw", at: NOW, type: "action-verified",
      actionId: "act-1", outcome: "succeeded", attribution: "automatic",
      postconditionRefs: ["ready"], postconditionSamples: bundle.postconditionSamples,
      recoveryEvidence: ref,
    } satisfies OperationsEvent;
    expect(() => store.verifyEvent(event)).not.toThrow();
    writeFileSync(join(rawDir, "controller.json"), "tampered\n", { mode: 0o600 });
    expect(() => store.verifyEvent(event)).toThrow(/raw evidence hash mismatch/);
  });

  it("keeps derived authority provenance without treating it as a raw file", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "helium-recovery-authority-"));
    const rawDir = join(stateDir, "raw");
    mkdirSync(rawDir, { mode: 0o700 });
    for (const name of ["observation.json", "controller.json", "baseline.json", "postcondition.json"]) {
      writeFileSync(join(rawDir, name), `${name}\n`, { mode: 0o600 });
    }
    const store = new FileRecoveryEvidenceStore(join(stateDir, "evidence"));
    const raw = store.hashArtifacts([
      "artifact://ops/raw/observation.json",
      "artifact://ops/authority/colima-reconnect",
      "artifact://ops/raw/controller.json",
      "artifact://ops/raw/baseline.json",
      "artifact://ops/raw/postcondition.json",
    ]);
    expect(raw.map((artifact) => artifact.ref)).not.toContain(
      "artifact://ops/authority/colima-reconnect",
    );
    const artifacts = {
      receipt: store.persistArtifact("receipt", { output: "bounded" }),
      observation: store.persistArtifact("observation", {
        version: 1,
        id: "obs-authority-1",
        componentId: "runtime",
        probeId: "ops.authority-manifest.v1",
        observedAt: NOW,
        expiresAt: "2026-08-30T01:00:00.000Z",
        state: "degraded",
        dimension: "controller",
        evidenceRefs: [
          "artifact://ops/raw/observation.json",
          "artifact://ops/authority/colima-reconnect",
        ],
        parserVersion: "authority-manifest/1",
      }),
      incident: store.persistArtifact("incident", { state: "open" }),
      raw,
    };
    const bundle = fixture(artifacts);
    const ref = store.persistBundle(bundle);
    const event = {
      v: 1, id: "terminal-authority", at: NOW, type: "action-verified",
      actionId: "act-1", outcome: "succeeded", attribution: "automatic",
      postconditionRefs: ["ready"], postconditionSamples: bundle.postconditionSamples,
      recoveryEvidence: ref,
    } satisfies OperationsEvent;
    expect(() => store.verifyEvent(event)).not.toThrow();
  });
});
