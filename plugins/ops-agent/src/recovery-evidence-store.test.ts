import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}): RecoveryEvidence {
  return {
    assertionId: "recovery-act-1",
    componentId: "runtime",
    incidentId: "inc-1",
    observations: [artifacts.observation],
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
      evidenceRef: "artifact://controller/1",
    },
    lease: { leaseId: "lease-1", operationId: "op-1" },
    intent: {
      actionId: "act-1",
      argv: [],
      baseline: { capturedAt: NOW, allPassing: false, sampleCount: 1 },
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
      evidenceRefs: ["artifact://check/1"],
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
  const artifacts = {
    receipt: store.persistArtifact("receipt", { output: "bounded" }),
    observation: store.persistArtifact("observation", { state: "failed" }),
    incident: store.persistArtifact("incident", { state: "open" }),
  };
  return { artifacts, bundle: fixture(artifacts) };
}

describe("FileRecoveryEvidenceStore", () => {
  it("publishes a schema-valid hashed bundle before verifying its terminal event", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-recovery-evidence-"));
    const store = new FileRecoveryEvidenceStore(dir);
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
    const store = new FileRecoveryEvidenceStore(dir);
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
  });

  it("rejects missing nested artifacts and terminal fields that disagree with the bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-recovery-nested-"));
    const store = new FileRecoveryEvidenceStore(dir);
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
  });
});
