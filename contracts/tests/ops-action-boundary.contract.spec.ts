import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceLedger,
  HANDOFF_STEPS,
  ROLLBACK_STEPS,
  RecoveryEvidenceSchema,
  ActionLeaseTable,
  OperationsStore,
  RecoveryBudget,
  applyHandoffStep,
  applyRollbackStep,
  enabledCount,
  manifestSigningPayload,
  resolveAuthority,
  reconcileOnStartup,
  sequenceStates,
  verifyAction,
  type OperationsEvent,
} from "@helium/core";
import {
  ApprovalLedger,
  ScriptRegistry,
  approvalSigningPayload,
  checkMountIdentity,
} from "dsh-plugin-ops-agent";
import { describe, expect, it } from "vitest";

const digest = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-30T00:00:00.000Z");
const postconditionSample = {
  checkId: "ready",
  state: "pass" as const,
  observedAt: NOW.toISOString(),
  evidenceRefs: ["artifact://check/ready"],
};
const verificationCheck = {
  id: "ready",
  kind: "business" as const,
  probe: { probeId: "fixture.ready.v1", args: {} },
  expect: { dimension: "readiness", operator: "eq" as const, value: true },
  onUnavailable: "unknown" as const,
  timeoutMs: 5_000,
  owner: "ops",
};
const terminalEvidence = {
  ref: "artifact://ops/evidence/recovery.json",
  sha256: "d".repeat(64),
  schema: "helium.ops.recovery-evidence/v1" as const,
  assertionId: "recovery-act-1",
};

describe("mutation action boundary", () => {
  it("allows at most one of two racing controllers to hold a component lease", () => {
    const table = new ActionLeaseTable();
    const key = { componentId: "runtime", incidentId: "inc-1", sopId: "restart", sopDigest: digest, attempt: 1 };
    const results = ["a", "b"].map((id) => table.acquire({
      key,
      leaseId: `lease-${id}`,
      operationId: `operation-${id}`,
      now: NOW,
      ttlMs: 60_000,
    }));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("keeps every prefix of ownership handoff and rollback at one or zero controllers", () => {
    const handoff = sequenceStates(
      { externalEnabled: true, opsdEnabled: false },
      HANDOFF_STEPS,
      applyHandoffStep,
    );
    const rollback = sequenceStates(
      { externalEnabled: false, opsdEnabled: true },
      ROLLBACK_STEPS,
      applyRollbackStep,
    );
    for (const state of [...handoff, ...rollback]) expect(enabledCount(state)).toBeLessThanOrEqual(1);
    expect(handoff.at(-1)).toEqual({ externalEnabled: false, opsdEnabled: true });
    expect(rollback.at(-1)).toEqual({ externalEnabled: true, opsdEnabled: false });
  });

  it("refuses an executable changed after approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-contract-script-"));
    const path = join(dir, "repair.mjs");
    writeFileSync(path, "#!/usr/bin/env node\n", { mode: 0o700 });
    chmodSync(path, 0o700);
    const identity = createHash("sha256").update(readFileSync(path)).digest("hex");
    const registry = ScriptRegistry.load([{
      executorId: "repair", path, identity: { kind: "sha256", value: identity },
      argvSchema: { id: "repair-argv", params: [] }, cwd: dir,
      environmentProfile: { PATH: "/usr/bin:/bin" }, timeoutMs: 1_000, maxOutputBytes: 1_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }]);
    writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o700 });
    expect(registry.verifyIdentity(registry.get("repair")!)).toMatchObject({ ok: false, reason: "script-drift" });
  });

  it("treats exit zero with failed postconditions as failed and nonzero with passing as uncertain", () => {
    const base = { baseline: { allPassing: false, samples: [] }, intentRecorded: true, operatorConfirmed: false };
    expect(verifyAction({ ...base, receipt: { exitCode: 0, timedOut: false }, postconditions: "fail" })).toMatchObject({
      outcome: "failed", automationCredit: false,
    });
    expect(verifyAction({ ...base, receipt: { exitCode: 1, timedOut: false }, postconditions: "pass" })).toMatchObject({
      outcome: "uncertain", automationCredit: false,
    });
  });

  it("records an already-passing baseline as not-needed with no automation credit", () => {
    expect(verifyAction({
      baseline: { allPassing: true, samples: [] }, intentRecorded: false,
      postconditions: "pass", operatorConfirmed: true,
    })).toMatchObject({ outcome: "not-needed", attribution: "operator", automationCredit: false });
  });

  it("replays every crash point from the durable log without a blind retry", () => {
    const at = (minute: number) => `2026-08-30T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const sequence: OperationsEvent[] = [
      { v: 1, id: "event-1", at: at(1), type: "action-proposed", actionId: "act-1", incidentId: "inc-1", componentId: "runtime", sopId: "repair", sopVersion: 1, sopDigest: digest },
      { v: 1, id: "event-2", at: at(2), type: "action-authorized", actionId: "act-1", authority: "auto" },
      { v: 1, id: "event-3", at: at(3), type: "action-intent-recorded", actionId: "act-1", leaseId: "lease-1", operationId: "op-1", argv: [], baseline: { capturedAt: at(3), samples: [{ ...postconditionSample, state: "fail", observedAt: at(3) }], allPassing: false }, controllerProbe: { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/1" }, eligibility: { eligible: true, reasons: [] }, mutationOwner: { owner: "opsd", competingLabels: [], changedAt: at(3), changeRef: "artifact://ownership/1" }, dependencyIds: ["host"], verificationPolicy: { postconditions: [verificationCheck], graceMs: 0 } },
      { v: 1, id: "event-4", at: at(4), type: "action-receipt-recorded", actionId: "act-1", exitCode: 0, timedOut: false, outputDigest: digest, outputTail: "ok", outputBytes: 2, startedAt: at(4), finishedAt: at(4) },
      { v: 1, id: "event-5", at: at(5), type: "action-verified", actionId: "act-1", outcome: "succeeded", postconditionRefs: ["ready"], postconditionSamples: [postconditionSample], recoveryEvidence: terminalEvidence },
    ];

    for (let prefix = 0; prefix <= sequence.length; prefix += 1) {
      const dir = mkdtempSync(join(tmpdir(), `helium-contract-crash-${prefix}-`));
      const store = OperationsStore.open(dir, { sync: () => {} });
      for (const event of sequence.slice(0, prefix)) store.append(event);
      const reopened = OperationsStore.open(dir, { sync: () => {} });
      expect(reopened.replay()).toHaveLength(prefix);
      const decisions = reconcileOnRestart(reopened);
      expect(decisions.every((decision) => decision.rerun === false)).toBe(true);
      if (prefix < sequence.length) {
        expect(reopened.state().actions["act-1"]?.state).not.toBe("succeeded");
      }
    }
  });

  it("uses absolute time across a timezone rollback for cooldown", () => {
    const budget = new RecoveryBudget({
      maxAttemptsPerIncident: 10,
      maxRunsPerWindow: 10,
      windowMs: 86_400_000,
      cooldownMs: 3_600_000,
    });
    const result = budget.check({
      incidentId: "inc-1",
      sopId: "repair",
      history: [{
        incidentId: "inc-1",
        sopId: "repair",
        at: "2026-11-01T01:30:00-04:00",
        outcome: "failed",
      }],
      // Wall time reads 01:15 again, but this instant is 45 minutes later.
      now: new Date("2026-11-01T01:15:00-05:00"),
    });
    expect(result).toEqual({ ok: false, reason: "cooldown" });
  });

  it("refuses a wrong DATA_LAKE mount identity", () => {
    expect(checkMountIdentity(
      [{ device: "/dev/disk-wrong", mount: "/Volumes/DATA_LAKE", totalBytes: 1, usedBytes: 0, availableBytes: 1, usedPercent: 0 }],
      [{ device: "/dev/disk-expected", mount: "/Volumes/DATA_LAKE" }],
    )[0]).toMatchObject({ ok: false, reason: "device-mismatch" });
  });

  it("has no command surface for prompt-injected shell or restart requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-contract-argv-"));
    const path = join(dir, "repair");
    writeFileSync(path, "", { mode: 0o700 });
    const registry = ScriptRegistry.load([{
      executorId: "repair", path,
      identity: { kind: "sha256", value: createHash("sha256").update("").digest("hex") },
      argvSchema: { id: "repair-argv", params: [{ flag: "--target", valuePattern: "[A-Za-z0-9_-]+", required: true }] },
      cwd: dir, environmentProfile: {}, timeoutMs: 1_000, maxOutputBytes: 1_000,
      expectedOwnerUid: process.getuid?.() ?? 0,
    }]);
    expect(() => registry.validateArgv(registry.get("repair")!, ["--target", "$(rm -rf /)"])).toThrow();
    expect(() => ScriptRegistry.load([{ ...registry.get("repair"), command: "docker restart" }])).toThrow();
  });
});

describe("signed authority and evidence boundary", () => {
  it("downgrades an unsigned approve-to-auto edit and a manifest signed by an untrusted key", () => {
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const entry = { sopId: "repair", version: 1, digest, authority: "auto" as const };
    const hostile = { entries: [entry], signature: sign(null, manifestSigningPayload([entry]), attacker.privateKey).toString("base64") };
    expect(resolveAuthority({ id: "repair", version: 1, digest, authority: "auto" }, hostile, trusted.publicKey)).toEqual({
      authority: "observe", reason: "manifest-signature-invalid",
    });
    const approvedEntry = { ...entry, authority: "approve" as const };
    const approvedManifest = {
      entries: [approvedEntry],
      signature: sign(null, manifestSigningPayload([approvedEntry]), trusted.privateKey).toString("base64"),
    };
    expect(resolveAuthority({ id: "repair", version: 1, digest, authority: "auto" }, approvedManifest, trusted.publicKey)).toMatchObject({
      authority: "observe", reason: "manifest-authority-escalation",
    });
  });

  it("requires a signature even from the same uid and refuses nonce replay", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const ledger = new ApprovalLedger({ trustedKey: publicKey, now: () => NOW });
    const unsigned = {
      kind: "approval" as const, operatorId: "operator-1", nonce: "nonce-contract-1",
      issuedAt: "2026-08-29T23:59:00.000Z",
      approval: { incidentId: "inc-1", sopId: "repair", sopVersion: 1, sopDigest: digest, expiresAt: "2026-08-30T00:10:00.000Z" },
    };
    expect(() => ledger.accept({ ...unsigned, signature: "same-uid" })).toThrow(/signature/);
    const envelope = { ...unsigned, signature: sign(null, approvalSigningPayload(unsigned), privateKey).toString("base64") };
    expect(ledger.accept(envelope).operatorId).toBe("operator-1");
    expect(() => ledger.accept(envelope)).toThrow(/replay/);
  });

  it("refuses incomplete recovery evidence and a false automatic success", () => {
    const base = recoveryBundle();
    const { receipt: _receipt, ...missing } = base;
    expect(() => RecoveryEvidenceSchema.parse(missing)).toThrow();
    expect(() => RecoveryEvidenceSchema.parse({
      ...base,
      baseline: { ...base.baseline, allPassing: true },
    })).toThrow(/failing postcondition/);
  });

  it("cannot overwrite a failed automatic outcome with a later healthy observation", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-contract-terminal-"));
    const store = OperationsStore.open(dir, { sync: () => {} });
    const events: OperationsEvent[] = [
      { v: 1, id: "terminal-1", at: NOW.toISOString(), type: "action-proposed", actionId: "act-1", incidentId: "inc-1", componentId: "runtime", sopId: "repair", sopVersion: 1, sopDigest: digest },
      { v: 1, id: "terminal-2", at: NOW.toISOString(), type: "action-authorized", actionId: "act-1", authority: "auto" },
      { v: 1, id: "terminal-3", at: NOW.toISOString(), type: "action-intent-recorded", actionId: "act-1", leaseId: "lease-1", operationId: "op-1", argv: [], baseline: { capturedAt: NOW.toISOString(), samples: [{ ...postconditionSample, state: "fail" }], allPassing: false }, controllerProbe: { result: "clear", observedLabels: [], evidenceRef: "artifact://controller/1" }, eligibility: { eligible: true, reasons: [] }, mutationOwner: { owner: "opsd", competingLabels: [], changedAt: NOW.toISOString(), changeRef: "artifact://ownership/1" }, dependencyIds: [], verificationPolicy: { postconditions: [verificationCheck], graceMs: 0 } },
      { v: 1, id: "terminal-4", at: NOW.toISOString(), type: "action-receipt-recorded", actionId: "act-1", exitCode: 0, timedOut: false, outputDigest: digest, outputTail: "ok", outputBytes: 2, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() },
      { v: 1, id: "terminal-5", at: NOW.toISOString(), type: "action-verified", actionId: "act-1", outcome: "failed", postconditionRefs: ["ready"], postconditionSamples: [{ ...postconditionSample, state: "fail" }], recoveryEvidence: terminalEvidence },
      { v: 1, id: "terminal-6", at: NOW.toISOString(), type: "observation-recorded", observation: {
        version: 1, id: "healthy-later", componentId: "runtime", probeId: "runtime.ready.v1",
        observedAt: NOW.toISOString(), expiresAt: "2026-08-30T00:05:00.000Z", state: "ok",
        dimension: "readiness", evidenceRefs: ["artifact://healthy/later"], parserVersion: "fixture/1",
      } },
    ];
    for (const event of events) store.append(event);
    expect(store.state().actions["act-1"]?.state).toBe("failed");
    expect(() => store.append({
      v: 1, id: "terminal-7", at: NOW.toISOString(), type: "action-verified",
      actionId: "act-1", outcome: "succeeded", postconditionRefs: ["ready"],
      postconditionSamples: [postconditionSample], recoveryEvidence: terminalEvidence,
    })).toThrow(/already terminal/);
    expect(store.state().actions["act-1"]?.state).toBe("failed");
  });

  it.each(["PARTIAL", "FAILED", "BLOCKED"] as const)(
    "refuses a reporter-only promotion from %s to PROVEN",
    (status) => {
      const ledger = new EvidenceLedger();
      const candidate = genericEvidence(status);
      ledger.accept(candidate, NOW);
      expect(() => ledger.accept({ ...candidate, status: "PROVEN" }, NOW)).toThrow(/new verifier decision/);
    },
  );
});

function recoveryBundle() {
  const hash = "b".repeat(64);
  return {
    assertionId: "recovery-1", componentId: "runtime", incidentId: "inc-1",
    observations: [{ ref: "artifact://obs/1", sha256: hash }],
    rawArtifacts: [
      { ref: "artifact://controller/1", sha256: hash },
      { ref: "artifact://check/baseline", sha256: hash },
      { ref: "artifact://check/ready", sha256: hash },
    ],
    incidentSnapshot: { ref: "artifact://incident/1", sha256: hash },
    sopId: "repair", sopVersion: 1, sopDigest: digest,
    authorityManifestEntry: { sopId: "repair", version: 1, digest, authority: "auto" as const },
    authority: "auto" as const, eligibility: { eligible: true, reasons: [] },
    mutationOwner: { owner: "opsd" as const, competingLabels: [], changedAt: NOW.toISOString(), changeRef: "artifact://owner/1" },
    controllerProbe: { result: "clear" as const, observedLabels: [], evidenceRef: "artifact://controller/1" },
    lease: { leaseId: "lease-1", operationId: "op-1" },
    baseline: { capturedAt: NOW.toISOString(), allPassing: false, samples: [{ checkId: "ready", state: "fail" as const, observedAt: NOW.toISOString(), evidenceRefs: ["artifact://check/baseline"] }] },
    intent: { actionId: "act-1", argv: [] },
    receipt: {
      exitCode: 0,
      timedOut: false,
      outputDigest: digest,
      evidence: { ref: "artifact://receipt/1", sha256: hash },
    },
    postconditionSamples: [{
      checkId: "ready",
      state: "pass" as const,
      observedAt: NOW.toISOString(),
      evidenceRefs: ["artifact://check/ready"],
    }],
    outcome: "succeeded" as const, attribution: "automatic" as const,
    verifier: { identity: "contract", version: "1", decision: "pass" as const },
    replayRef: "artifact://replay/1", status: "PROVEN" as const, limitation: "offline fixture",
  };
}

function genericEvidence(status: "PARTIAL" | "FAILED" | "BLOCKED") {
  return {
    assertionId: "claim-1", assertion: "claim", acceptanceBound: "bound",
    assertionClass: "contract", evidencePolicyVersion: "1", requiredStages: ["raw"] as const,
    stages: { raw: [{ ref: "artifact://raw/1", sha256: "c".repeat(64) }] },
    verifier: { identity: "reporter", version: "1", decision: "pass" as const, decidedAt: NOW.toISOString() },
    freshness: { recordedAt: NOW.toISOString() }, status, limitation: "not proven",
  };
}

function reconcileOnRestart(store: OperationsStore) {
  const actions = Object.values(store.state().actions);
  if (actions.length === 0) return [];
  return reconcileOnStartup({ actions, evidence: {} });
}
