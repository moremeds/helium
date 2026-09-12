import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "../packages/core/lib/index.js";
import { runCampaign } from "./runtime-campaign.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (value) => hash(canonicalJson(value));
const json = (value) => canonicalJson(value) + "\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-campaign-test-"));
  const refsDir = join(root, "refs");
  mkdirSync(refsDir);
  const ref = (name) => {
    const bytes = Buffer.from(`frozen ${name}\n`);
    writeFileSync(join(refsDir, name), bytes);
    return hash(bytes);
  };
  const payload = (perStock) => ({
    schemaVersion: "ow-runtime-v1", tenant: "option-wizard", phase: "premarket",
    config: { news: { global: 4, perStock, stocks: 5 } },
  });
  const champion = payload(2);
  const candidate = payload(3);
  writeFileSync(join(root, "champion.json"), json(champion));
  writeFileSync(join(root, "candidate.json"), json(candidate));

  const cases = ["case-a", "case-b"].map((caseId, index) => {
    const inputDir = join(root, `${caseId}-input`);
    mkdirSync(inputDir);
    const raw = canonicalJson({ tool: "ow_test", args: { caseId }, at: `2026-09-1${index}T00:00:00.000Z`,
      raw: `result-${caseId}`, rawSha256: hash(`result-${caseId}`), rawBytes: Buffer.byteLength(`result-${caseId}`) });
    const name = "0001.json.gz";
    writeFileSync(join(inputDir, name), gzipSync(raw));
    const inputWorldHash = contentHash([[name, hash(raw)]]);
    const asOf = `2026-09-1${index}T00:00:00.000Z`;
    writeFileSync(join(root, `${caseId}-capture.json`), json({
      status: "COMPLETE", tenant: "option-wizard", phase: "premarket", replayAsOf: asOf, inputWorldHash,
    }));
    return { caseId, clusterId: `cluster-${index}`, eventManifestHash: hash(`events-${caseId}`),
      inputWorldHash, inputDir, capture: join(root, `${caseId}-capture.json`), asOf };
  });

  const registration = {
    schemaVersion: "runtime-comparison-registration-v1", status: "REGISTERED",
    experimentId: "m2-test", comparisonMode: "CONFIRMATION_2V3",
    champion: { configVersionId: "cfg-2", configHash: contentHash(champion) },
    candidate: { configVersionId: "cfg-3", configHash: contentHash(candidate) },
    changedPaths: ["/config/news/perStock"], engineSha: "engine-test",
    engineArtifactHash: hash("engine-artifacts"), baseManifestHashes: {},
    replay: { mode: "SNAPSHOT_PIPELINE",
      inputCorpusHash: contentHash(cases.map(({ caseId, inputWorldHash }) => ({ caseId, inputWorldHash }))),
      ledgerSnapshotHash: ref("ledger"), calendarHash: ref("calendar"),
      worldCompletenessReceipt: ref("complete") },
    evaluation: {
      evaluatorHash: ref("evaluator"), qualificationHash: ref("qualification"),
      promotionPolicyHash: ref("promotion"), primaryMetric: "coverage.final",
      minimumPracticalEffect: 0.1, alpha: 0.05, independentClusterCount: 2, replicatesPerCase: 1,
      decisionFamilyId: "family-m2", holdoutCohortId: "holdout-m2", holdoutLineageHash: ref("lineage"),
      criticalErrorsMaximum: 0, claimsSupportedNonInferiorityMargin: 0.05,
      reliabilityNonInferiorityMargin: 0.05, decisionRule: "paired-cluster-lower-bound-min-effect",
      intervalImplementation: { method: "paired-cluster-bootstrap-v1", seed: 7, replicates: 100 },
      clusterDefinition: "one independent cluster per case", sampleSizeRationale: "offline executor check",
      aaCalibrationEvidence: ref("aa"), armOrderRandomizationPlan: ref("order"),
      failureAndRetryRule: "NO_RETRY_CONTINUE_KNOWN_FAILURES",
      treatmentSlices: { definedBeforeGeneration: true,
        withThirdEligibleRowCaseIds: ["case-a"], withoutThirdEligibleRowCaseIds: ["case-b"] },
      manualReview: { requiredReviewerIdentity: "manual-reviewer", requiredRubricHash: ref("rubric") },
      manualEvidenceValidityReviewRef: ref("validity"), holdoutExposureRecordRef: ref("exposure"),
      unresolvedCriticalDisagreement: "INCONCLUSIVE",
    },
    confirmationCohort: { cases: cases.map(({ caseId, clusterId, eventManifestHash, inputWorldHash }) =>
      ({ caseId, clusterId, eventManifestHash, inputWorldHash })) },
    resourcePolicy: { measured: ["requests", "latencyMs"], perTrialTokenLimit: null,
      perTrialCallLimit: 2, timeoutSeconds: 1, totalTokenLimit: null, totalCallLimit: 8,
      costIncreaseLimit: null, latencyIncreaseLimit: null, aggregationRule: "all-attempts-summed" },
    actualModelIdentityPlan: { requestedModelId: "swe-2-high", acceptedGrade: "ROUTE_ONLY",
      providerId: "devin-subscription" },
    targetDeployment: { tenant: "option-wizard", phase: "premarket", environment: "test", kind: "product" },
    executionContext: { environment: "evaluation", stateNamespace: "m2-test", deliveryMode: "disabled" },
    deliveryWave: "M2", activationMode: "MANUAL_REVIEW_ONLY",
  };
  writeFileSync(join(root, "registration.json"), json(registration));
  const execution = {
    schemaVersion: "runtime-campaign-execution-v1", comparisonRegistration: "registration.json",
    referencesDir: "refs", configPayloads: { champion: "champion.json", candidate: "candidate.json" },
    limits: { maxRequests: 2, timeoutMs: 1000, maxRequestBytes: 4096 },
    admin: { pointerApproval: "test-pointer-approval", initializeApproval: null },
    cases: cases.map(({ caseId, inputDir, capture, asOf }) => ({ caseId, inputDir, capture, asOf })),
    order: [
      { caseId: "case-a", arm: "champion", replicate: 1 },
      { caseId: "case-a", arm: "candidate", replicate: 1 },
      { caseId: "case-b", arm: "champion", replicate: 1 },
      { caseId: "case-b", arm: "candidate", replicate: 1 },
    ],
  };
  const executionPath = join(root, "execution.json");
  writeFileSync(executionPath, json(execution));
  return { root, registration, execution, executionPath, cases, champion, candidate };
}

function harness(f, outcomes) {
  let current = "cfg-2";
  let revision = 1;
  let evalIndex = 0;
  const inspections = new Map();
  const calls = [];
  const payloads = { "cfg-2": f.champion, "cfg-3": f.candidate };
  const hashes = { "cfg-2": f.registration.champion.configHash, "cfg-3": f.registration.candidate.configHash };
  const control = {
    async resolve(scope) {
      calls.push({ kind: "resolve", current });
      return { scope, configVersionId: current, configHash: hashes[current], deploymentRevision: revision,
        configurationApprovalId: "test", resolvedPayload: payloads[current], resolvedAt: new Date().toISOString(),
        metadata: {}, effectiveSnapshotHash: "unused-by-campaign-pointer" };
    },
    async inspectAttempt(id) { calls.push({ kind: "inspect", id }); return inspections.get(id); },
  };
  const spawn = async ({ argv, env }) => {
    if (argv.some((part) => part.endsWith("/admin.js"))) {
      const request = JSON.parse(readFileSync(argv.at(-1), "utf8"));
      calls.push({ kind: "admin", request });
      current = request.input.versionId;
      revision += 1;
      return { code: 0, signal: null, timedOut: false, wallMs: 1,
        stdout: Buffer.from(json({ versionId: current, revision })), stderr: Buffer.alloc(0) };
    }
    const outcome = outcomes[evalIndex++];
    calls.push({ kind: "evaluate", env, argv });
    const trialId = f.execution.order[evalIndex - 1];
    const id = `attempt-${evalIndex}`;
    const stateDir = join(env.TMPDIR, `helium-runtime-pilot-${evalIndex}`);
    mkdirSync(stateDir, { recursive: true });
    const caseSpec = f.cases.find(({ caseId }) => caseId === trialId.caseId);
    const snapshotBase = { scope: f.registration.targetDeployment, configVersionId: current,
      configHash: hashes[current], deploymentRevision: revision, configurationApprovalId: "test",
      resolvedPayload: payloads[current], resolvedAt: new Date().toISOString(),
      metadata: { engineSha: f.registration.engineSha, engineArtifactHash: f.registration.engineArtifactHash,
        inputWorldHash: caseSpec.inputWorldHash, deliveryMode: "disabled", executionEnvironment: "evaluation",
        actualModelIdentity: { grade: "ROUTE_ONLY", provider: "devin-subscription", requestedModel: "swe-2-high",
          policyHash: contentHash(f.execution.limits), captureManifestHash: hash(readFileSync(caseSpec.capture)),
          limits: f.execution.limits } } };
    const snapshot = { ...snapshotBase, effectiveSnapshotHash: contentHash(snapshotBase) };
    writeFileSync(join(stateDir, "snapshot.json"), json(snapshot));
    if (outcome === "FAILED") {
      mkdirSync(join(stateDir, "runs", id), { recursive: true });
      writeFileSync(join(stateDir, "failure.json"), json({ error: "known" }));
    } else if (outcome === "MALFORMED") {
      mkdirSync(join(stateDir, "runs", id), { recursive: true });
      writeFileSync(join(stateDir, "failure.json"), Buffer.from("{\"error\":\"partial\"}\ntrailing"));
    } else {
      writeFileSync(join(stateDir, "result.json"), json({ outcome: "completed", runId: id }));
    }
    inspections.set(id, { id, scope: f.registration.targetDeployment, snapshot, status: outcome,
      evidence: { inference: { requestCount: outcome === "UNKNOWN" ? 2 : 1,
        invocationUnit: "ACP_INVOCATION", inputTokens: 11, outputTokens: 7,
        knownInputTokens: 11, knownOutputTokens: 7, reportedModelLabels: ["Summarizer"], unknown: outcome === "UNKNOWN" } } });
    return { code: outcome === "FAILED" ? 1 : 0, signal: null, timedOut: false, wallMs: 25,
      stdout: Buffer.from("stdout\u0000after"), stderr: Buffer.from("stderr\ntrailing") };
  };
  return { control, spawn, calls };
}

test("runs exact registered order, keeps failures, and stops after UNKNOWN", async () => {
  const f = fixture();
  const h = harness(f, ["FAILED", "UNKNOWN"]);
  const outputDir = join(f.root, "out");
  const summary = await runCampaign({ executionPath: f.executionPath, adminConnectionPath: "admin.json",
    runnerConnectionPath: "runner.json", outputDir }, { control: h.control, spawn: h.spawn });

  assert.equal(summary.status, "STOPPED");
  assert.equal(summary.stop.reason, "UNKNOWN_ATTEMPT", JSON.stringify(summary.stop));
  assert.deepEqual(summary.counts, { registered: 4, dispatched: 2, succeeded: 0,
    knownFailures: 1, unknown: 1, undispatched: 2 });
  assert.equal(summary.budget.heldOrSpentCalls, 3);
  assert.equal(summary.budget.heldOrSpentMs, 1025);
  assert.equal(h.calls.filter(({ kind }) => kind === "evaluate").length, 2);
  assert.equal(h.calls.filter(({ kind }) => kind === "admin").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(outputDir, "trials/case-a--champion--r1/policy.json"), "utf8")),
    { maxRequests: 2, timeoutMs: 1000, maxRequestBytes: 4096 });
  assert.deepEqual(readFileSync(join(outputDir, "trials/case-a--champion--r1/stdout")), Buffer.from("stdout\u0000after"));
  assert.deepEqual(JSON.parse(readFileSync(join(outputDir, "trials/case-a--champion--r1/state/failure.json"), "utf8")),
    { error: "known" });
  assert.equal(JSON.parse(readFileSync(join(outputDir, "trials/case-a--champion--r1/trial.json"), "utf8")).observedThirdRow, null);
  assert.equal(JSON.parse(readFileSync(join(outputDir, "trials/case-a--champion--r1/usage.json"), "utf8")).attempts[0].tokens, 18);
  assert.equal(JSON.parse(readFileSync(join(outputDir, "trials/case-a--champion--r1/trial.json"), "utf8")).model.reportedId, null);
  assert.ok(readFileSync(join(outputDir, "registration.json")).equals(readFileSync(join(f.root, "registration.json"))));
  const events = readFileSync(join(outputDir, "progress.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const prepared = events.find(({ event, trialId }) => event === "prepared" && trialId === "case-a--candidate--r1");
  const switched = events.find(({ event, trialId }) => event === "switch-intent" && trialId === "case-a--candidate--r1");
  assert.ok(prepared.seq < switched.seq);
  assert.ok(h.calls.every(({ kind, env }) => kind !== "evaluate" || env.PGPASSWORD === undefined));
  await assert.rejects(() => runCampaign({ executionPath: f.executionPath, adminConnectionPath: "admin.json",
    runnerConnectionPath: "runner.json", outputDir }, { control: h.control, spawn: h.spawn }), /refusing to overwrite/);
});

test("rejects missing, duplicate, and unsupported execution inventory before side effects", async () => {
  for (const mutate of [
    (x) => { x.order.pop(); },
    (x) => { x.order[1] = x.order[0]; },
    (x) => { x.limits.maxOutputTokens = 99; },
  ]) {
    const f = fixture();
    mutate(f.execution);
    writeFileSync(f.executionPath, json(f.execution));
    const h = harness(f, []);
    const summary = await runCampaign({ executionPath: f.executionPath, adminConnectionPath: "admin.json",
      runnerConnectionPath: "runner.json", outputDir: join(f.root, "invalid-out") },
    { control: h.control, spawn: h.spawn });
    assert.equal(summary.status, "INVALID");
    assert.equal(h.calls.length, 0);
  }
});

test("retains malformed admin stdout and stops before model dispatch", async () => {
  const f = fixture();
  f.execution.order = [f.execution.order[1], f.execution.order[0], ...f.execution.order.slice(2)];
  writeFileSync(f.executionPath, json(f.execution));
  const h = harness(f, []);
  h.spawn = async ({ argv }) => {
    assert.ok(argv.some((part) => part.endsWith("/admin.js")));
    return { code: 0, signal: null, timedOut: false, wallMs: 1,
      stdout: Buffer.from('{"versionId":"cfg-3","revision":2}\ntrailing'), stderr: Buffer.from("admin-stderr") };
  };
  const outputDir = join(f.root, "out");
  const summary = await runCampaign({ executionPath: f.executionPath, adminConnectionPath: "admin.json",
    runnerConnectionPath: "runner.json", outputDir }, { control: h.control, spawn: h.spawn });
  assert.equal(summary.status, "STOPPED");
  assert.equal(summary.stop.reason, "AMBIGUOUS");
  assert.equal(readFileSync(join(outputDir, "trials/case-a--candidate--r1/admin-request-stdout"), "utf8"),
    '{"versionId":"cfg-3","revision":2}\ntrailing');
  assert.equal(h.calls.filter(({ kind }) => kind === "evaluate").length, 0);
});

test("retains malformed outcome bytes before reporting the stop", async () => {
  const f = fixture();
  const h = harness(f, ["MALFORMED"]);
  const outputDir = join(f.root, "out");
  const summary = await runCampaign({ executionPath: f.executionPath, adminConnectionPath: "admin.json",
    runnerConnectionPath: "runner.json", outputDir }, { control: h.control, spawn: h.spawn });
  assert.equal(summary.status, "STOPPED");
  assert.equal(summary.stop.reason, "AMBIGUOUS");
  assert.equal(readFileSync(join(outputDir, "trials/case-a--champion--r1/state/failure.json"), "utf8"),
    "{\"error\":\"partial\"}\ntrailing");
  assert.deepEqual(readFileSync(join(outputDir, "trials/case-a--champion--r1/stderr")), Buffer.from("stderr\ntrailing"));
});
