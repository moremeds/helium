// End-to-end command check with synthetic bytes only. Requires `pnpm build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "../packages/core/lib/index.js";
import { measureRuntimeCoverage } from "../plugins/option-wizard/lib/eval/runtime-coverage.js";

const H = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (value) => H(canonicalJson(value));
const json = (value) => JSON.stringify(value);

test("paired comparison command binds evidence, preserves originals, refuses overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-comparison-command-"));
  const trialsDir = join(dir, "trials");
  const refsDir = join(dir, "refs");
  mkdirSync(trialsDir);
  mkdirSync(refsDir);

  const refHash = (name) => { writeFileSync(join(refsDir, `${name}.json`), `synthetic ${name}`); return H(`synthetic ${name}`); };
  const rubricHash = refHash("rubric");
  const eventsOf = (caseId) => [{ id: `${caseId}-ev`, evidenceRefs: [`${caseId}-src`] }];
  const payload = (perStock) => ({ tenant: "option-wizard", phase: "premarket", config: { news: { perStock } } });
  const armHash = { champion: contentHash(payload(2)), candidate: contentHash(payload(3)) };
  const worlds = { "case-1": "world-a", "case-2": "world-b" };
  const reviewer = { identity: "synthetic reviewer", rubricHash };

  const writeTrial = (caseId, arm, coverage, thirdRow) => {
    const label = `${caseId}-${arm}`;
    const td = join(trialsDir, label);
    mkdirSync(td);
    const events = eventsOf(caseId);
    const article = coverage === 1 ? "synthetic final line" : "empty";
    const review = { completed: true, finalArtifactHash: H(article), reviewer,
      reviews: events.map((event) => ({ eventId: event.id, verdict: coverage === 1 ? "addressed" : "not-addressed",
        finalSpanRefs: coverage === 1 ? ["final:1"] : [], sourceRefs: event.evidenceRefs, criticalErrors: 0, adjudication: "resolved" })) };
    const measurement = { mode: "MANUAL_REVIEW_DIAGNOSTIC", eventManifestHash: H(json(events)), reviewHash: H(json(review)),
      finalArtifactHash: H(article), measurement: measureRuntimeCoverage({ ...review, events }) };
    const snapshotBase = { scope: { tenant: "option-wizard", phase: "premarket", kind: "product", environment: "test" },
      configVersionId: `cfg-${arm}`, configHash: armHash[arm], deploymentRevision: 1,
      configurationApprovalId: "synthetic", resolvedPayload: payload(arm === "champion" ? 2 : 3),
      resolvedAt: "2026-09-12T00:00:00.000Z",
      metadata: { engineSha: "synthetic-engine", engineArtifactHash: H("engine"), inputWorldHash: H(worlds[caseId]),
        deliveryMode: "disabled", executionEnvironment: "evaluation" } };
    const snapshot = { ...snapshotBase, effectiveSnapshotHash: contentHash(snapshotBase) };
    const result = { outcome: "completed", runId: label };
    const claims = { schemaVersion: "runtime-comparison-claims-v1", reviewer, reviewed: 4, supported: 4 };
    const manifest = { schemaVersion: "runtime-comparison-trial-v1", trialId: label, caseId, arm, replicate: 1,
      configVersionId: `cfg-${arm}`, configHash: armHash[arm],
      model: { requestedId: "synthetic-model", reportedId: "synthetic-model" },
      snapshotSha256: H(json(snapshot)), outcomeFile: "result.json", outcomeSha256: H(json(result)),
      claimsEvidenceSha256: H(json(claims)), observedThirdRow: thirdRow,
      attempts: [{ attemptId: `${label}-a1`, status: "SUCCEEDED", requests: 2, tokens: 900, latencyMs: 1000, costUsd: null, usageUnknown: false }] };
    writeFileSync(join(td, "trial.json"), json(manifest));
    writeFileSync(join(td, "events.json"), json(events));
    writeFileSync(join(td, "review.json"), json(review));
    writeFileSync(join(td, "measurement.json"), json(measurement));
    writeFileSync(join(td, "snapshot.json"), json(snapshot));
    writeFileSync(join(td, "result.json"), json(result));
    writeFileSync(join(td, "claims.json"), json(claims));
    writeFileSync(join(td, "final.txt"), article);
  };
  writeTrial("case-1", "champion", 0, false);
  writeTrial("case-1", "candidate", 1, true);
  writeTrial("case-2", "champion", 0, false);
  writeTrial("case-2", "candidate", 1, false);

  const registration = {
    schemaVersion: "runtime-comparison-registration-v1", status: "REGISTERED",
    experimentId: "synthetic-e2e", comparisonMode: "CONFIRMATION_2V3",
    champion: { configVersionId: "cfg-champion", configHash: armHash.champion },
    candidate: { configVersionId: "cfg-candidate", configHash: armHash.candidate },
    changedPaths: ["/config/news/perStock"],
    engineSha: "synthetic-engine", engineArtifactHash: H("engine"), baseManifestHashes: {},
    replay: { mode: "SNAPSHOT_PIPELINE",
      inputCorpusHash: contentHash([{ caseId: "case-1", inputWorldHash: H("world-a") }, { caseId: "case-2", inputWorldHash: H("world-b") }]),
      ledgerSnapshotHash: refHash("ledger"), calendarHash: refHash("calendar"), worldCompletenessReceipt: refHash("receipt") },
    evaluation: {
      evaluatorHash: refHash("evaluator"), qualificationHash: refHash("qualification"), promotionPolicyHash: refHash("policy"),
      primaryMetric: "coverage.final", minimumPracticalEffect: 0.2, alpha: 0.05,
      independentClusterCount: 2, replicatesPerCase: 1,
      decisionFamilyId: "family-synthetic", holdoutCohortId: "cohort-synthetic", holdoutLineageHash: refHash("lineage"),
      criticalErrorsMaximum: 0, claimsSupportedNonInferiorityMargin: 0.05, reliabilityNonInferiorityMargin: 0.05,
      decisionRule: "paired-cluster-lower-bound-min-effect",
      intervalImplementation: { method: "paired-cluster-bootstrap-v1", seed: 7, replicates: 100 },
      clusterDefinition: "synthetic clusters", sampleSizeRationale: "synthetic mechanism check",
      aaCalibrationEvidence: refHash("aa"), armOrderRandomizationPlan: refHash("order"),
      failureAndRetryRule: "synthetic", unresolvedCriticalDisagreement: "INCONCLUSIVE",
      treatmentSlices: { definedBeforeGeneration: true, withThirdEligibleRowCaseIds: ["case-1"], withoutThirdEligibleRowCaseIds: ["case-2"] },
      manualReview: { requiredReviewerIdentity: reviewer.identity, requiredRubricHash: rubricHash },
      manualEvidenceValidityReviewRef: refHash("validity"), holdoutExposureRecordRef: refHash("exposure"),
    },
    confirmationCohort: { cases: [
      { caseId: "case-1", clusterId: "cluster-1", eventManifestHash: H(json(eventsOf("case-1"))), inputWorldHash: H("world-a") },
      { caseId: "case-2", clusterId: "cluster-2", eventManifestHash: H(json(eventsOf("case-2"))), inputWorldHash: H("world-b") },
    ] },
    resourcePolicy: { measured: ["requests", "tokens", "latencyMs"], perTrialTokenLimit: null, perTrialCallLimit: 5,
      timeoutSeconds: 60, totalTokenLimit: null, totalCallLimit: 100, costIncreaseLimit: null, latencyIncreaseLimit: 1,
      aggregationRule: "all-attempts-summed" },
    actualModelIdentityPlan: { requestedModelId: "synthetic-model" },
    targetDeployment: { tenant: "option-wizard", phase: "premarket", environment: "test", kind: "product" },
    executionContext: { environment: "evaluation", stateNamespace: "synthetic", deliveryMode: "disabled" },
    deliveryWave: "M2", activationMode: "MANUAL_REVIEW_ONLY",
  };
  writeFileSync(join(dir, "registration.json"), json(registration));

  const script = new URL("./runtime-comparison.mjs", import.meta.url).pathname;
  const run = (out) => spawnSync(process.execPath, [script, join(dir, "registration.json"), trialsDir, refsDir, out], { encoding: "utf8" });
  const outDir = join(dir, "out");
  const first = run(outDir);
  assert.equal(first.status, 0, first.stderr);
  const comparison = JSON.parse(readFileSync(join(outDir, "comparison.json"), "utf8"));
  assert.equal(comparison.decision, "REVIEW_READY");
  assert.equal(comparison.primary.estimate.meanDiff, 1);
  assert.ok(readFileSync(join(outDir, "registration.json"), "utf8").length > 0);
  assert.ok(readFileSync(join(outDir, "inputs/case-1-champion/snapshot.json"), "utf8").length > 0);
  assert.ok(JSON.parse(readFileSync(join(outDir, "provenance.json"), "utf8")).inputs.length > 0);

  assert.notEqual(run(outDir).status, 0); // existing output is never overwritten
  const before = readFileSync(join(outDir, "comparison.json"), "utf8");

  writeFileSync(join(trialsDir, "case-1-candidate/review.json"), json({ tampered: true }));
  const second = run(join(dir, "out2"));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "out2/comparison.json"), "utf8")).decision, "NOT_COMPARABLE");
  assert.equal(readFileSync(join(outDir, "comparison.json"), "utf8"), before);
});
