/**
 * Synthetic mechanism checks only: every byte below is fabricated for the
 * test, reads no market data, calls no model, and proves nothing about real
 * report quality or calibration.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@helium/core";
import { analyzeComparison, type ComparisonTrialInput } from "../eval/runtime-comparison.js";
import { measureRuntimeCoverage } from "../eval/runtime-coverage.js";

const H = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (value: unknown) => H(canonicalJson(value));

// Multi-date cohort: each case binds its own input world; the corpus hash is
// the hash of the ordered case/world manifest.
const CASES = [
  { caseId: "case-1", clusterId: "cluster-1", world: "world-2026-09-08" },
  { caseId: "case-2", clusterId: "cluster-1", world: "world-2026-09-09" },
  { caseId: "case-3", clusterId: "cluster-2", world: "world-2026-09-10" },
  { caseId: "case-4", clusterId: "cluster-2", world: "world-2026-09-11" },
];
const EVENTS = (caseId: string) => [
  { id: `${caseId}-ev1`, evidenceRefs: [`${caseId}-src1`] },
  { id: `${caseId}-ev2`, evidenceRefs: [`${caseId}-src2`] },
];
const PAYLOAD = (perStock: number) => ({ tenant: "option-wizard", phase: "premarket", config: { news: { perStock } } });
const ARM_HASH = { champion: contentHash(PAYLOAD(2)), candidate: contentHash(PAYLOAD(3)) };
const REVIEWER = { identity: "synthetic-independent-reviewer", rubricHash: H("synthetic-rubric") };

const ARTIFACT_REFS = ["evaluator", "qualification", "policy", "lineage", "rubric", "world-receipt",
  "ledger", "calendar", "exposure", "validity", "aa", "arm-order"];
const REFS = ARTIFACT_REFS.map((name) => ({ name: `${name}.json`, sha256: H(`synthetic-${name}`) }));
const refHash = (name: string) => REFS.find((ref) => ref.name === `${name}.json`)!.sha256;

function registration(overrides: Record<string, unknown> = {}) {
  const evaluation = {
    evaluatorHash: refHash("evaluator"), qualificationHash: refHash("qualification"),
    promotionPolicyHash: refHash("policy"), primaryMetric: "coverage.final",
    minimumPracticalEffect: 0.1, alpha: 0.05, independentClusterCount: 2, replicatesPerCase: 2,
    // Identifiers are IDs, not byte-bindable artifacts.
    decisionFamilyId: "family-m2-premarket", holdoutCohortId: "cohort-confirmation-2026-09",
    holdoutLineageHash: refHash("lineage"), criticalErrorsMaximum: 0,
    claimsSupportedNonInferiorityMargin: 0.05, reliabilityNonInferiorityMargin: 0.05,
    decisionRule: "paired-cluster-lower-bound-min-effect",
    intervalImplementation: { method: "paired-cluster-bootstrap-v1", seed: 42, replicates: 200 },
    clusterDefinition: "synthetic independent clusters", sampleSizeRationale: "synthetic mechanism check",
    aaCalibrationEvidence: refHash("aa"), armOrderRandomizationPlan: refHash("arm-order"),
    failureAndRetryRule: "synthetic: failed generation scores zero and is never retried",
    treatmentSlices: { definedBeforeGeneration: true,
      withThirdEligibleRowCaseIds: ["case-1", "case-3"], withoutThirdEligibleRowCaseIds: ["case-2", "case-4"] },
    manualReview: { requiredReviewerIdentity: REVIEWER.identity, requiredRubricHash: REVIEWER.rubricHash },
    manualEvidenceValidityReviewRef: refHash("validity"), holdoutExposureRecordRef: refHash("exposure"),
    unresolvedCriticalDisagreement: "INCONCLUSIVE",
  };
  return {
    schemaVersion: "runtime-comparison-registration-v1", status: "REGISTERED",
    experimentId: "synthetic-2v3", comparisonMode: "CONFIRMATION_2V3",
    champion: { configVersionId: "cfg-champion", configHash: ARM_HASH.champion },
    candidate: { configVersionId: "cfg-candidate", configHash: ARM_HASH.candidate },
    changedPaths: ["/config/news/perStock"],
    engineSha: "synthetic-engine", engineArtifactHash: H("synthetic-engine-artifact"),
    baseManifestHashes: { tenant: H("tenant"), team: H("team") },
    replay: { mode: "SNAPSHOT_PIPELINE",
      inputCorpusHash: contentHash(CASES.map((entry) => ({ caseId: entry.caseId, inputWorldHash: H(entry.world) }))),
      ledgerSnapshotHash: refHash("ledger"), calendarHash: refHash("calendar"), worldCompletenessReceipt: refHash("world-receipt") },
    evaluation,
    confirmationCohort: { cases: CASES.map((entry) => ({ caseId: entry.caseId, clusterId: entry.clusterId,
      eventManifestHash: H(JSON.stringify(EVENTS(entry.caseId))), inputWorldHash: H(entry.world) })) },
    // Subscription-style basis: requests and time are measured and enforceable; tokens are
    // measured and reported without a hard cap; USD is not measured and must not be limited.
    resourcePolicy: { measured: ["requests", "tokens", "latencyMs"],
      perTrialTokenLimit: null, perTrialCallLimit: 10, timeoutSeconds: 120,
      totalTokenLimit: null, totalCallLimit: 500, costIncreaseLimit: null, latencyIncreaseLimit: 1,
      aggregationRule: "all-attempts-summed" },
    actualModelIdentityPlan: { requestedModelId: "synthetic-model" },
    targetDeployment: { tenant: "option-wizard", phase: "premarket", environment: "test", kind: "product" },
    executionContext: { environment: "evaluation", stateNamespace: "synthetic-ns", deliveryMode: "disabled" },
    deliveryWave: "M2", activationMode: "MANUAL_REVIEW_ONLY",
    ...overrides,
  };
}

function snapshot(arm: "champion" | "candidate", world: string) {
  const unsigned = {
    scope: { tenant: "option-wizard", phase: "premarket", kind: "product", environment: "test" },
    configVersionId: `cfg-${arm}`, configHash: ARM_HASH[arm],
    deploymentRevision: 7, configurationApprovalId: "synthetic-approval",
    resolvedPayload: PAYLOAD(arm === "champion" ? 2 : 3), resolvedAt: "2026-09-12T00:00:00.000Z",
    metadata: { engineSha: "synthetic-engine", engineArtifactHash: H("synthetic-engine-artifact"),
      inputWorldHash: H(world), deliveryMode: "disabled", executionEnvironment: "evaluation",
      actualModelIdentity: "synthetic-model" },
  };
  return { ...unsigned, effectiveSnapshotHash: contentHash(unsigned) };
}

function trial(caseId: string, arm: "champion" | "candidate", replicate: number,
               options: { coverage?: number; failed?: boolean; usageUnknown?: boolean; requests?: number;
                          claims?: boolean; observedThirdRow?: boolean | null } = {}): ComparisonTrialInput {
  const { coverage = 1, failed = false, usageUnknown = false, requests = 3, claims = true } = options;
  const cohortCase = CASES.find((entry) => entry.caseId === caseId)!;
  const label = `trial-${caseId}-${arm}-${replicate}`;
  const events = EVENTS(caseId);
  const eventsBytes = JSON.stringify(events);
  const snapshotObj = snapshot(arm, cohortCase.world);
  const snapshotBytes = JSON.stringify(snapshotObj);
  const article = coverage >= 1 ? "line one\nline two" : "line one\nsecond line";
  const addressed = Math.round(coverage * events.length);
  const review = failed
    ? { completed: false, finalArtifactHash: null, reviewer: null, reviews: [] }
    : { completed: true, finalArtifactHash: H(article), reviewer: REVIEWER,
        reviews: events.map((event, index) => ({
          eventId: event.id, verdict: index < addressed ? "addressed" : "not-addressed",
          finalSpanRefs: index < addressed ? [`final:${index + 1}`] : [], sourceRefs: event.evidenceRefs,
          criticalErrors: 0, adjudication: "resolved" })) };
  const reviewBytes = JSON.stringify(review);
  const measurement = { mode: "MANUAL_REVIEW_DIAGNOSTIC", eventManifestHash: H(eventsBytes),
    reviewHash: H(reviewBytes), finalArtifactHash: failed ? null : H(article),
    measurement: measureRuntimeCoverage({ ...review, events }) };
  const outcomeObj = failed ? { stateRoot: "synthetic", error: "synthetic failure" } : { outcome: "completed", runId: label };
  const outcomeBytes = JSON.stringify(outcomeObj);
  const claimsObj = claims ? { schemaVersion: "runtime-comparison-claims-v1", reviewer: REVIEWER, reviewed: 10, supported: 10 } : null;
  const claimsBytes = claimsObj === null ? null : JSON.stringify(claimsObj);
  const manifest = {
    schemaVersion: "runtime-comparison-trial-v1", trialId: label, caseId, arm, replicate,
    configVersionId: `cfg-${arm}`, configHash: ARM_HASH[arm],
    model: { requestedId: "synthetic-model", reportedId: "synthetic-model" },
    snapshotSha256: H(snapshotBytes),
    outcomeFile: failed ? "failure.json" : "result.json", outcomeSha256: H(outcomeBytes),
    claimsEvidenceSha256: claimsBytes === null ? null : H(claimsBytes),
    observedThirdRow: options.observedThirdRow ?? (arm === "candidate" && ["case-1", "case-3"].includes(caseId)),
    attempts: [{ attemptId: `${label}-a1`, status: "SUCCEEDED", requests, tokens: 1200,
      latencyMs: 5000, costUsd: null, usageUnknown }],
  };
  return {
    label, trial: manifest, trialSha256: H(JSON.stringify(manifest)),
    events, eventsSha256: H(eventsBytes),
    review, reviewSha256: H(reviewBytes),
    measurement, measurementSha256: H(JSON.stringify(measurement)),
    snapshot: snapshotObj, snapshotSha256: H(snapshotBytes),
    outcome: outcomeObj, outcomeSha256: H(outcomeBytes), outcomeFile: failed ? "failure.json" : "result.json",
    claims: claimsObj, claimsSha256: claimsBytes === null ? null : H(claimsBytes),
    finalSha256: failed ? null : H(article), finalLines: failed ? null : article.split("\n"),
    inputErrors: [],
  };
}

function cohort(coverage: { champion: number; candidate: number }, opts = {}) {
  return CASES.flatMap((entry) => [1, 2].flatMap((replicate) =>
    (["champion", "candidate"] as const).map((arm) => trial(entry.caseId, arm, replicate, { coverage: coverage[arm], ...opts }))));
}

const analyze = (trials: ComparisonTrialInput[], reg = registration(), refs = REFS) =>
  analyzeComparison({ registration: reg, registrationSha256: H(JSON.stringify(reg)), refs, trials });

describe("runtime paired comparison (synthetic mechanism evidence only)", () => {
  it("reaches REVIEW_READY with distinct per-case worlds and an unmeasured-USD basis", () => {
    const result = analyze(cohort({ champion: 0.5, candidate: 1 }));
    expect(result.decision).toBe("REVIEW_READY");
    expect(result.primary.estimate.meanDiff).toBe(0.5);
    expect(result.arms.candidate.usage.costUsd).toBeNull(); // unmeasured, reported, never faked
    expect(result.slices.withThirdEligibleRow.cases).toBe(2);
    expect(result.provenance.files.length).toBeGreaterThan(0);
  });

  it("returns NO_CHANGE when the paired interval does not clear the registered effect", () => {
    const result = analyze(cohort({ champion: 0.5, candidate: 0.5 }));
    expect(result.decision).toBe("NO_CHANGE");
  });

  it("caps A/A diagnostics: identical config can never reach REVIEW_READY", () => {
    const reg = registration({ comparisonMode: "AA_DIAGNOSTIC", changedPaths: [],
      candidate: { configVersionId: "cfg-champion", configHash: ARM_HASH.champion } });
    const trials = CASES.flatMap((entry) => [1, 2].flatMap((replicate) => [
      trial(entry.caseId, "champion", replicate, { coverage: 0.5 }),
      { ...trial(entry.caseId, "champion", replicate, { coverage: 1 }),
        trial: { ...trial(entry.caseId, "champion", replicate).trial as object, arm: "candidate", trialId: `trial-${entry.caseId}-candidate-${replicate}` },
        label: `trial-${entry.caseId}-candidate-${replicate}` },
    ]));
    const result = analyze(trials, reg);
    expect(result.decision).not.toBe("REVIEW_READY");
    expect(result.decision).not.toBe("INVALID");
    expect((result.reasons as string[]).join(" ")).toMatch(/diagnostic/);
  });

  it("counts failed generation as zero coverage and a reliability failure", () => {
    const trials = CASES.flatMap((entry) => [1, 2].flatMap((replicate) => [
      trial(entry.caseId, "champion", replicate, { coverage: 1 }),
      trial(entry.caseId, "candidate", replicate, { failed: true }),
    ]));
    const result = analyze(trials);
    expect(result.decision).toBe("REJECT");
    expect(result.arms.candidate.generationFailed).toBe(8);
  });

  it("keeps a missing or unresolved measurement unknown, never zero or tie", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    const dropped = trials.filter((entry) => entry.label !== "trial-case-4-candidate-2");
    expect(analyze(dropped).decision).toBe("INCONCLUSIVE");
    const unresolved = trials.map((entry) => entry.label === "trial-case-4-candidate-2"
      ? { ...entry, review: null, reviewSha256: null, measurement: null, measurementSha256: null } : entry);
    expect(analyze(unresolved).decision).toBe("INCONCLUSIVE");
  });

  it("rejects duplicate, extra and unregistered trials as INVALID", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    const dup = { ...trials[0]!, trial: { ...trials[0]!.trial as Record<string, unknown>, trialId: "dup" }, label: "dup" };
    expect(analyze([...trials, dup]).decision).toBe("INVALID");
    const extra = { ...trials[0]!, label: "extra",
      trial: { ...trials[0]!.trial as Record<string, unknown>, trialId: "extra", caseId: "unregistered" } };
    expect(analyze([...trials, extra]).decision).toBe("INVALID");
  });

  it("stays INCONCLUSIVE when fewer than the registered clusters are paired", () => {
    const reg = registration();
    reg.evaluation.independentClusterCount = 3;
    const result = analyze(cohort({ champion: 0.5, candidate: 1 }), reg);
    expect(result.decision).toBe("INVALID");
    const trials = cohort({ champion: 0.5, candidate: 1 })
      .filter((entry) => !entry.label.includes("case-3") && !entry.label.includes("case-4"));
    expect(analyze(trials).decision).toBe("INCONCLUSIVE");
  });

  it("refuses tampered review bytes and a case-bound world mismatch", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    const tampered = trials.map((entry) => entry.label === "trial-case-1-candidate-1"
      ? { ...entry, reviewSha256: H("tampered") } : entry);
    expect(analyze(tampered).decision).toBe("NOT_COMPARABLE");
    const wrongWorld = trials.map((entry) => entry.label === "trial-case-1-candidate-1"
      ? { ...entry, snapshot: { ...entry.snapshot as Record<string, unknown>,
          metadata: { ...(entry.snapshot as Record<string, unknown>).metadata as Record<string, unknown>, inputWorldHash: H("other-world") } } }
      : entry);
    expect(analyze(wrongWorld).decision).toBe("NOT_COMPARABLE");
  });

  it("rejects a corpus hash that does not match the ordered case/world manifest", () => {
    const reg = registration();
    reg.replay.inputCorpusHash = H("not-the-manifest");
    expect(analyze(cohort({ champion: 0.5, candidate: 1 }), reg).decision).toBe("INVALID");
  });

  it("stays INCONCLUSIVE when completeness, ledger or calendar artifacts are not supplied", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    const withoutLedger = REFS.filter((ref) => ref.name !== "ledger.json");
    expect(analyze(trials, registration(), withoutLedger).decision).toBe("INCONCLUSIVE");
    const reg = registration();
    reg.replay.worldCompletenessReceipt = null;
    expect(analyze(trials, reg).decision).toBe("INCONCLUSIVE");
  });

  it("requires recorded treatment exposure consistent with the registered slice", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    const unrecorded = trials.map((entry) => entry.label === "trial-case-1-candidate-1"
      ? { ...entry, trial: { ...entry.trial as Record<string, unknown>, observedThirdRow: null } } : entry);
    expect(analyze(unrecorded).decision).toBe("INCONCLUSIVE");
    const contradicted = trials.map((entry) => entry.label === "trial-case-1-candidate-1"
      ? { ...entry, trial: { ...entry.trial as Record<string, unknown>, observedThirdRow: false } } : entry);
    expect(analyze(contradicted).decision).toBe("NOT_COMPARABLE");
  });

  it("rejects a registered resource-limit violation on an enforceable dimension", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 }, { requests: 99 });
    expect(analyze(trials).decision).toBe("REJECT");
  });

  it("rejects a registration that limits an unmeasured dimension", () => {
    const reg = registration();
    reg.resourcePolicy.costIncreaseLimit = 1; // costUsd is not in the measured basis
    expect(analyze(cohort({ champion: 0.5, candidate: 1 }), reg).decision).toBe("INVALID");
  });

  it("stays INCONCLUSIVE when confirmation evidence or measured usage accounting is missing", () => {
    const trials = cohort({ champion: 0.5, candidate: 1 });
    expect(analyze(trials, registration(), []).decision).toBe("INCONCLUSIVE");
    const unknownUsage = cohort({ champion: 0.5, candidate: 1 }, { usageUnknown: true });
    expect(analyze(unknownUsage).decision).toBe("INCONCLUSIVE");
    const noClaims = cohort({ champion: 0.5, candidate: 1 }, { claims: false });
    expect(analyze(noClaims).decision).toBe("INCONCLUSIVE");
  });

  it("reproduces the same seeded interval deterministically", () => {
    const first = analyze(cohort({ champion: 0.5, candidate: 0.75 }));
    const second = analyze(cohort({ champion: 0.5, candidate: 0.75 }));
    expect(first.primary.estimate).toEqual(second.primary.estimate);
  });
});
