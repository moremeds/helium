#!/usr/bin/env node
// Sequential registered-trial executor for the M2 runtime comparison.
//
// One `runtime-evaluate` subprocess per trial on a fresh private TMPDIR, an
// explicit admin pointer switch before each arm change, worst-case call/time
// reservation before every dispatch, and a terminal stop on UNKNOWN,
// ambiguous acknowledgement, malformed outcome or resource exhaustion. It
// writes evidence only: it never scores, never retries, never resumes a
// campaign, never activates production and never delivers anything.
//
//   node scripts/runtime-campaign.mjs <execution.json> <admin-conn.json> <runner-conn.json> <new-output-dir>
//
// The byte-bound comparison registration is the sole source of experiment
// identities, cases, repeats, qualification and resource rules. execution.json
// adds only paths, registered order, transport settings and test-admin approval.
// The two connection files are separate credentials: the admin file is handed
// only to the admin entry subprocess; the runner file is used for read/inspect
// control calls and handed to `runtime-evaluate`. Neither file's contents are
// copied into an environment or provider/tool surface.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, writeSync, fsyncSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, parseStrictJson } from "../packages/core/lib/index.js";
import { RuntimeControl } from "../plugins/runtime-control/lib/index.js";
import { loadSnapshotRecordings } from "../packages/cli/lib/replay-strict.js";
import { renderText } from "../plugins/option-wizard/lib/render/text.js";
import { parseRuntimeConfig } from "../plugins/option-wizard/lib/runtime/index.js";
import { parseComparisonRegistration } from "../plugins/option-wizard/lib/eval/runtime-comparison.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_JS = join(REPO_ROOT, "packages/cli/lib/cli.js");
const ADMIN_JS = join(REPO_ROOT, "plugins/runtime-control/lib/admin.js");
const PILOT_PREFIX = "helium-runtime-pilot-";
const ADMIN_TIMEOUT_MS = 30_000;
const SHA = /^[a-f0-9]{64}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256Text = (text) => sha256Bytes(Buffer.from(text, "utf8"));
const contentHash = (value) => sha256Text(canonicalJson(value));
const writeOnce = (path, data) => {
  const fd = openSync(path, "wx");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
};
const subprocessEnv = (extra = {}) => Object.fromEntries([
  "HOME", "PATH", "TMPDIR", "TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE",
  "USER", "LOGNAME", "SHELL", "__CF_USER_TEXT_ENCODING", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]).concat(Object.entries(extra)));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function strictKeys(value, allowed, at) {
  if (!isRecord(value)) throw new Error(`${at} must be a plain object`);
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${at}.${key} is unknown`);
  }
}
function required(value, key, at) {
  if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} is required`);
  return value[key];
}
function textOf(value, at) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a nonempty string`);
  return value;
}
function intOf(value, at, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${at} must be an integer >= ${min}`);
  return value;
}
/**
 * Bind the small execution-only document to one strict, immutable comparison
 * registration. Everything knowable without the database is checked here.
 */
function parseCampaign(value, executionDir) {
  strictKeys(value, ["schemaVersion", "comparisonRegistration", "referencesDir", "configPayloads",
    "limits", "admin", "cases", "order"], "execution");
  if (required(value, "schemaVersion", "execution") !== "runtime-campaign-execution-v1")
    throw new Error("execution.schemaVersion must be runtime-campaign-execution-v1");

  const comparisonPath = resolve(executionDir,
    textOf(required(value, "comparisonRegistration", "execution"), "execution.comparisonRegistration"));
  const comparisonBytes = readFileSync(comparisonPath);
  const comparison = parseComparisonRegistration(parseStrictJson(comparisonBytes.toString("utf8")));
  const comparisonSha256 = sha256Bytes(comparisonBytes);
  const scope = comparison.targetDeployment;
  if (scope === null || scope === undefined || scope.kind !== "product" || scope.environment !== "test")
    throw new Error("comparison targetDeployment must name the test product scope");
  if (comparison.executionContext.environment !== "evaluation" || comparison.executionContext.deliveryMode !== "disabled")
    throw new Error("comparison executionContext must disable delivery in evaluation");
  if (comparison.actualModelIdentityPlan.acceptedGrade !== "ROUTE_ONLY" ||
      comparison.actualModelIdentityPlan.providerId !== "devin-subscription")
    throw new Error("campaign requires the registered Devin ROUTE_ONLY route");
  if (scope.tenant !== "option-wizard" || scope.phase !== "premarket")
    throw new Error("M2 campaign is scoped to option-wizard/premarket");
  const cohort = comparison.confirmationCohort.cases;
  if (contentHash(cohort.map(({ caseId, inputWorldHash }) => ({ caseId, inputWorldHash }))) !==
      comparison.replay.inputCorpusHash)
    throw new Error("comparison input corpus hash does not bind its ordered cohort worlds");
  if (new Set(cohort.map(({ clusterId }) => clusterId)).size !== comparison.evaluation.independentClusterCount)
    throw new Error("comparison cluster count does not match its cohort mapping");
  const slices = comparison.evaluation.treatmentSlices;
  const sliced = [...slices.withThirdEligibleRowCaseIds, ...slices.withoutThirdEligibleRowCaseIds];
  if (new Set(sliced).size !== sliced.length || canonicalJson([...sliced].sort()) !==
      canonicalJson(cohort.map(({ caseId }) => caseId).sort()))
    throw new Error("comparison treatment slices must partition the exact cohort");

  const limits = required(value, "limits", "execution");
  strictKeys(limits, ["maxRequests", "timeoutMs", "maxRequestBytes"], "execution.limits");
  for (const key of ["maxRequests", "timeoutMs", "maxRequestBytes"])
    intOf(limits[key], `execution.limits.${key}`);
  const policy = comparison.resourcePolicy;
  if (!policy.measured.includes("requests") || !policy.measured.includes("latencyMs") ||
      policy.perTrialCallLimit === null || policy.timeoutSeconds === null || policy.totalCallLimit === null)
    throw new Error("comparison must register finite measured request and time limits");
  if (limits.maxRequests !== policy.perTrialCallLimit || limits.timeoutMs !== policy.timeoutSeconds * 1000)
    throw new Error("execution limits must equal the frozen comparison request/time limits");

  const admin = required(value, "admin", "execution");
  strictKeys(admin, ["pointerApproval", "initializeApproval"], "execution.admin");
  const pointerApproval = textOf(admin.pointerApproval, "execution.admin.pointerApproval");
  const initializeApproval = admin.initializeApproval === null ? null :
    textOf(admin.initializeApproval, "execution.admin.initializeApproval");

  const payloadPaths = required(value, "configPayloads", "execution");
  strictKeys(payloadPaths, ["champion", "candidate"], "execution.configPayloads");
  const arms = {};
  for (const arm of ["champion", "candidate"]) {
    const bytes = readFileSync(resolve(executionDir, textOf(payloadPaths[arm], `configPayloads.${arm}`)));
    const payload = parseRuntimeConfig(parseStrictJson(bytes.toString("utf8")));
    if (contentHash(payload) !== comparison[arm].configHash)
      throw new Error(`${arm} payload does not match the frozen comparison config hash`);
    if (payload.tenant !== scope.tenant || payload.phase !== scope.phase)
      throw new Error(`${arm} payload is outside the registered tenant/phase`);
    arms[arm] = { ...comparison[arm], resolvedPayload: payload };
  }
  if (comparison.comparisonMode === "AA_DIAGNOSTIC") {
    if (comparison.changedPaths.length !== 0 || comparison.champion.configHash !== comparison.candidate.configHash ||
        comparison.champion.configVersionId !== comparison.candidate.configVersionId)
      throw new Error("A/A registration must bind identical configurations and no changed path");
  } else if (comparison.changedPaths.length !== 1 ||
      comparison.changedPaths[0] !== "/config/news/perStock" ||
      comparison.champion.configHash === comparison.candidate.configHash ||
      comparison.champion.configVersionId === comparison.candidate.configVersionId ||
      arms.champion.resolvedPayload.config.news.perStock !== 2 ||
      arms.candidate.resolvedPayload.config.news.perStock !== 3) {
    throw new Error("confirmation must bind only option-wizard perStock 2 versus 3");
  }

  const rawCases = required(value, "cases", "execution");
  if (!Array.isArray(rawCases) || rawCases.length === 0)
    throw new Error("execution.cases must be a nonempty array");
  const cases = new Map();
  const worlds = new Set();
  for (const raw of rawCases) {
    strictKeys(raw, ["caseId", "inputDir", "capture", "asOf"], "cases[]");
    const caseId = textOf(raw.caseId, "cases[].caseId");
    if (!LABEL.test(caseId)) throw new Error(`cases[].caseId ${caseId} must be label-safe`);
    if (cases.has(caseId)) throw new Error(`duplicate caseId ${caseId}`);
    const registered = comparison.confirmationCohort.cases.find((entry) => entry.caseId === caseId);
    if (registered === undefined) throw new Error(`execution case ${caseId} is not in the comparison cohort`);
    const asOf = textOf(raw.asOf, `cases.${caseId}.asOf`);
    if (!Number.isFinite(Date.parse(asOf))) throw new Error(`cases.${caseId}.asOf is not a valid instant`);
    const inputWorldHash = registered.inputWorldHash;
    if (worlds.has(inputWorldHash)) throw new Error(`cases.${caseId} reuses another case's input world`);
    worlds.add(inputWorldHash);
    cases.set(caseId, {
      caseId,
      inputDir: resolve(executionDir, textOf(raw.inputDir, `cases.${caseId}.inputDir`)),
      capture: resolve(executionDir, textOf(raw.capture, `cases.${caseId}.capture`)),
      asOf, inputWorldHash,
    });
  }
  const registeredCaseIds = comparison.confirmationCohort.cases.map((entry) => entry.caseId).sort();
  if (canonicalJson([...cases.keys()].sort()) !== canonicalJson(registeredCaseIds))
    throw new Error("execution cases must exactly match the frozen comparison cohort");

  const rawTrials = required(value, "order", "execution");
  if (!Array.isArray(rawTrials) || rawTrials.length === 0)
    throw new Error("execution.order must be a nonempty ordered array");
  const trials = [];
  const seenKeys = new Set();
  for (const raw of rawTrials) {
    strictKeys(raw, ["caseId", "arm", "replicate"], "order[]");
    if (!cases.has(raw.caseId)) throw new Error(`order references unregistered case ${raw.caseId}`);
    if (raw.arm !== "champion" && raw.arm !== "candidate")
      throw new Error("order arm must be champion or candidate");
    const replicate = intOf(raw.replicate, `order.${raw.caseId}.${raw.arm}.replicate`);
    const trialId = `${raw.caseId}--${raw.arm}--r${replicate}`;
    const key = `${raw.caseId} ${raw.arm} ${replicate}`;
    if (seenKeys.has(key)) throw new Error(`duplicate trial for ${key}`);
    seenKeys.add(key);
    trials.push({ trialId, caseId: raw.caseId, arm: raw.arm, replicate });
  }

  const expected = [];
  for (const { caseId } of comparison.confirmationCohort.cases)
    for (const arm of ["champion", "candidate"])
      for (let replicate = 1; replicate <= comparison.evaluation.replicatesPerCase; replicate += 1)
        expected.push(`${caseId} ${arm} ${replicate}`);
  if (seenKeys.size !== expected.length || expected.some((key) => !seenKeys.has(key)))
    throw new Error("execution order must contain the exact case x arm x contiguous replicate inventory");
  if (policy.totalCallLimit < expected.length * policy.perTrialCallLimit)
    throw new Error("frozen total call limit cannot reserve the exact registered inventory");

  const refsDir = resolve(executionDir,
    textOf(required(value, "referencesDir", "execution"), "execution.referencesDir"));
  const refEntries = readdirSync(refsDir, { withFileTypes: true });
  if (refEntries.some((entry) => !entry.isFile()))
    throw new Error("referencesDir may contain regular files only");
  const supplied = new Set(refEntries.map((entry) => sha256Bytes(readFileSync(join(refsDir, entry.name)))));
  if (comparison.comparisonMode === "CONFIRMATION_2V3") {
    const ev = comparison.evaluation;
    if (ev.decisionFamilyId === null || ev.holdoutCohortId === null)
      throw new Error("confirmation lacks decision-family or holdout-cohort eligibility");
    if (ev.claimsSupportedNonInferiorityMargin === null || ev.reliabilityNonInferiorityMargin === null)
      throw new Error("confirmation lacks frozen noninferiority rules");
    const hashes = [ev.evaluatorHash, ev.qualificationHash, ev.promotionPolicyHash, ev.holdoutLineageHash,
      comparison.replay.worldCompletenessReceipt, comparison.replay.ledgerSnapshotHash,
      comparison.replay.calendarHash, ev.manualReview.requiredRubricHash, ev.holdoutExposureRecordRef,
      ev.manualEvidenceValidityReviewRef, ev.aaCalibrationEvidence, ev.armOrderRandomizationPlan];
    if (hashes.some((hash) => hash === null || !SHA.test(hash)))
      throw new Error("confirmation lacks frozen byte-bound qualification, calibration, lineage or eligibility references");
    if (hashes.some((hash) => !supplied.has(hash)))
      throw new Error("confirmation reference bytes do not satisfy every frozen comparison hash");
  }

  let onKnownGenerationFailure;
  if (comparison.evaluation.failureAndRetryRule === "NO_RETRY_CONTINUE_KNOWN_FAILURES")
    onKnownGenerationFailure = "continue";
  else if (comparison.evaluation.failureAndRetryRule === "NO_RETRY_STOP_ON_KNOWN_FAILURE")
    onKnownGenerationFailure = "stop";
  else throw new Error("failureAndRetryRule must be an executable no-retry campaign rule");

  return {
    campaignId: comparison.experimentId, kind: comparison.comparisonMode, scope, arms,
    execution: { provider: comparison.actualModelIdentityPlan.providerId,
      requestedModel: comparison.actualModelIdentityPlan.requestedModelId, limits },
    budget: { callUnit: "ACP_INVOCATION", timeUnit: "trial-wall-clock-ms",
      perTrialCalls: policy.perTrialCallLimit, perTrialMs: limits.timeoutMs,
      totalCalls: policy.totalCallLimit, totalMs: trials.length * limits.timeoutMs },
    continuationPolicy: { onKnownGenerationFailure }, pointerApproval, initializeApproval,
    cases: [...cases.values()], caseById: cases, trials,
    comparison, comparisonSha256, refsDir,
  };
}

/** The real subprocess edge: raw stdout/stderr stay as bytes until close. */
function spawnSubprocess({ argv, env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, timedOut, wallMs: Date.now() - started,
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

class CampaignHalt extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

export async function runCampaign(options, deps = {}) {
  const spawnEdge = deps.spawn ?? spawnSubprocess;
  const outputDir = options.outputDir;
  if (existsSync(outputDir))
    throw new Error(`output path already exists: ${outputDir}; refusing to overwrite evidence`);
  const executionBytes = readFileSync(options.executionPath);
  const executionSha256 = sha256Bytes(executionBytes);
  mkdirSync(outputDir, { recursive: true });
  writeOnce(join(outputDir, "execution.json"), executionBytes);
  const progressFd = openSync(join(outputDir, "progress.jsonl"), "w");
  let seq = 0;
  const progress = (event) => {
    writeSync(progressFd, canonicalJson({ seq: ++seq, at: new Date().toISOString(), ...event }) + "\n");
    fsyncSync(progressFd);
  };

  const campaignRunId = `campaign-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const ledger = { calls: 0, ms: 0 }; // settled consumption; reservations are per dispatch
  const records = [];
  const counts = { dispatched: 0, succeeded: 0, knownFailures: 0, unknown: 0 };
  let status = "COMPLETED";
  let stop = null;

  const finish = (registration) => {
    const summary = {
      schemaVersion: "runtime-campaign-summary-v1",
      campaignId: registration?.campaignId ?? null,
      kind: registration?.kind ?? null,
      campaignRunId, executionSha256,
      registrationSha256: registration?.comparisonSha256 ?? null,
      startedAt, finishedAt: new Date().toISOString(),
      status, stop,
      scope: registration?.scope ?? null,
      budget: registration === null ? null : {
        callUnit: registration.budget.callUnit, timeUnit: registration.budget.timeUnit,
        perTrialCalls: registration.budget.perTrialCalls, perTrialMs: registration.budget.perTrialMs,
        totalCalls: registration.budget.totalCalls, totalMs: registration.budget.totalMs,
        heldOrSpentCalls: ledger.calls, heldOrSpentMs: ledger.ms,
      },
      counts: { registered: registration?.trials.length ?? 0, ...counts,
        undispatched: (registration?.trials.length ?? 0) - counts.dispatched },
      trials: records,
      // Explicit absence: the independent reviewer supplies these later.
      notProduced: [
        "events.json", "review.json", "measurement.json", "claims.json",
        "any coverage or quality score",
      ],
      notes: [
        "Model identity stays ROUTE_ONLY: the bound route travels in snapshot.metadata.actualModelIdentity; ACP wire labels remain in inspection.json and trial.json reportedId stays null.",
        "usage.json is the operator-normalized session record bound by trial.json.usageEvidenceSha256; latencyMs is executor-measured trial wall-clock, not provider-internal latency.",
        "observedThirdRow is null: no existing artifact records third-row exposure, and this executor does not infer it.",
      ],
      credentials: "admin credentials stayed in the admin subprocess; runner credentials stayed in runtime-control composition; neither connection object entered provider/tool environments",
      engineShasObserved: [...new Set(records.flatMap((record) => record.engineSha === undefined ? [] : [record.engineSha]))],
    };
    writeOnce(join(outputDir, "summary.json"), canonicalJson(summary) + "\n");
    fsyncSync(progressFd);
    closeSync(progressFd);
    return summary;
  };
  const halt = (reason, detail, trialId) => {
    status = "STOPPED";
    stop = { reason, detail, ...(trialId === undefined ? {} : { trialId }) };
    progress({ event: "stop", reason, detail, ...(trialId === undefined ? {} : { trialId }) });
  };

  progress({ event: "start", executionSha256, campaignRunId });
  let registration;
  try {
    const executionValue = parseStrictJson(executionBytes.toString("utf8"));
    if (isRecord(executionValue) && typeof executionValue.comparisonRegistration === "string") {
      const bytes = readFileSync(resolve(dirname(resolve(options.executionPath)), executionValue.comparisonRegistration));
      writeOnce(join(outputDir, "registration.json"), bytes);
    }
    registration = parseCampaign(executionValue, dirname(resolve(options.executionPath)));
  } catch (error) {
    status = "INVALID";
    stop = { reason: "INVALID_REGISTRATION", detail: error instanceof Error ? error.message : String(error) };
    progress({ event: "invalid", detail: stop.detail });
    return finish(null);
  }
  const { scope, budget, execution, continuationPolicy } = registration;

  // World/capture validation: every case's frozen input must hash to the
  // registered world and its capture record must be COMPLETE and bound to the
  // exact tenant, phase and replay clock — all before the first side effect.
  const caseEvidence = new Map();
  try {
    for (const entry of registration.cases) {
      if (!existsSync(entry.inputDir)) throw new Error(`cases.${entry.caseId}.inputDir does not exist`);
      const inputHash = loadSnapshotRecordings(entry.inputDir).inputHash;
      if (inputHash !== entry.inputWorldHash)
        throw new Error(`cases.${entry.caseId} frozen input changed since registration (${inputHash})`);
      const captureBytes = readFileSync(entry.capture);
      const capture = parseStrictJson(captureBytes.toString("utf8"));
      if (capture?.status !== "COMPLETE" || capture.tenant !== scope.tenant || capture.phase !== scope.phase ||
          capture.replayAsOf !== entry.asOf || capture.inputWorldHash !== entry.inputWorldHash)
        throw new Error(`cases.${entry.caseId} capture is not COMPLETE and bound to this tenant, phase, clock and world`);
      caseEvidence.set(entry.caseId, { captureSha256: sha256Bytes(captureBytes), inputHash });
    }
    if (!existsSync(CLI_JS)) throw new Error("packages/cli/lib/cli.js is missing; run pnpm build first");
    if (!existsSync(ADMIN_JS)) throw new Error("plugins/runtime-control/lib/admin.js is missing; run pnpm build first");
    if (deps.spawn === undefined &&
        !existsSync(join(REPO_ROOT, "plugins", `provider-${execution.provider}`, "lib", "evaluation.js")))
      throw new Error(`provider-${execution.provider} has no controlled evaluation adapter`);
  } catch (error) {
    status = "INVALID";
    stop = { reason: "INVALID_INPUT", detail: error instanceof Error ? error.message : String(error) };
    progress({ event: "invalid", detail: stop.detail });
    return finish(registration);
  }
  progress({ event: "validated", campaignId: registration.campaignId, kind: registration.kind,
    trials: registration.trials.length,
    projectedCalls: registration.trials.length * budget.perTrialCalls,
    projectedMs: registration.trials.length * budget.perTrialMs,
    cases: registration.cases.map((entry) => ({ caseId: entry.caseId, inputWorldHash: entry.inputWorldHash })),
    arms: { champion: registration.arms.champion.configVersionId, candidate: registration.arms.candidate.configVersionId } });
  cpSync(registration.refsDir, join(outputDir, "refs"), { recursive: true });

  const control = deps.control ??
    new RuntimeControl(parseStrictJson(readFileSync(options.runnerConnectionPath, "utf8")));

  const adminRequest = async (request, dir, name) => {
    const requestPath = join(dir, `${name}.json`);
    writeOnce(requestPath, canonicalJson(request) + "\n");
    const result = await spawnEdge({
      argv: [process.execPath, ADMIN_JS, options.adminConnectionPath, requestPath],
      env: { PATH: process.env.PATH }, timeoutMs: ADMIN_TIMEOUT_MS,
    });
    writeOnce(join(dir, `${name}-stdout`), result.stdout);
    writeOnce(join(dir, `${name}-stderr`), result.stderr);
    writeOnce(join(dir, `${name}-process.json`), canonicalJson({
      argv: [process.execPath, ADMIN_JS, options.adminConnectionPath, requestPath],
      code: result.code, signal: result.signal, timedOut: result.timedOut, wallMs: result.wallMs,
    }) + "\n");
    if (result.timedOut || result.code !== 0)
      throw new CampaignHalt("POINTER_SWITCH_FAILED",
        `admin ${request.action} exited ${result.code ?? result.signal}; stderr preserved in ${name}-stderr`);
    let parsed;
    try { parsed = JSON.parse(result.stdout.toString("utf8")); }
    catch { throw new CampaignHalt("AMBIGUOUS", `admin ${request.action} returned no parseable result`); }
    return parsed;
  };

  const resolvePointer = async () => {
    try { return await control.resolve(scope); }
    catch (error) {
      throw new CampaignHalt("AMBIGUOUS_DB",
        `deployment pointer could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Preflight: the test deployment must exist. A missing one is initialized to
  // the champion only when the registration explicitly carries that approval.
  try {
    let pointer;
    try {
      pointer = await control.resolve(scope);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (!/RC_MISSING_DEPLOYMENT/.test(messageText)) throw error;
      if (registration.initializeApproval === null)
        throw new CampaignHalt("DEPLOYMENT_NOT_READY",
          "no test deployment exists for this scope and the registration does not authorize initialization");
      progress({ event: "initialize-intent", versionId: registration.arms.champion.configVersionId });
      await adminRequest(
        { action: "initialize", input: { scope, versionId: registration.arms.champion.configVersionId,
          expectedRevision: 0, operationId: `${campaignRunId}:initialize`,
          approval: registration.initializeApproval } },
        outputDir, "initialize-request");
      pointer = await resolvePointer();
      if (pointer.configVersionId !== registration.arms.champion.configVersionId || pointer.deploymentRevision !== 1)
        throw new CampaignHalt("AMBIGUOUS", "initialization did not land the champion pointer at revision 1");
      progress({ event: "initialized", versionId: pointer.configVersionId, revision: 1 });
    }
    progress({ event: "pointer-preflight", configVersionId: pointer.configVersionId, revision: pointer.deploymentRevision });
  } catch (error) {
    if (error instanceof CampaignHalt) halt(error.reason, error.detail);
    else halt("AMBIGUOUS_DB", error instanceof Error ? error.message : String(error));
    return finish(registration);
  }

  for (const trial of registration.trials) {
    const { trialId, arm: armName, replicate } = trial;
    const caseSpec = registration.caseById.get(trial.caseId);
    const arm = registration.arms[armName];
    const armVersionId = arm.configVersionId;

    // Worst-case reservation is checked BEFORE this trial's first mutation.
    if (ledger.calls + budget.perTrialCalls > budget.totalCalls ||
        ledger.ms + budget.perTrialMs > budget.totalMs) {
      halt("RESOURCE_EXHAUSTED", `trial ${trialId} needs ${budget.perTrialCalls} calls/` +
        `${budget.perTrialMs}ms over settled ${ledger.calls}/${ledger.ms} of ${budget.totalCalls}/${budget.totalMs}`, trialId);
      break;
    }

    const trialDir = join(outputDir, "trials", trialId);
    const runTmp = join(trialDir, "run-tmp");
    mkdirSync(runTmp, { recursive: true });
    const record = { trialId, caseId: trial.caseId, arm: armName, replicate };
    records.push(record);
    const evidence = caseEvidence.get(trial.caseId);
    ledger.calls += budget.perTrialCalls;
    ledger.ms += budget.perTrialMs;
    progress({ event: "reserve", trialId, caseId: trial.caseId, arm: armName, replicate,
      calls: budget.perTrialCalls, ms: budget.perTrialMs,
      heldOrSpent: { calls: ledger.calls, ms: ledger.ms } });

    // The exact policy bytes the subprocess will be pointed at.
    writeOnce(join(trialDir, "policy.json"), canonicalJson(execution.limits) + "\n");
    const policySha256 = sha256Text(canonicalJson(execution.limits));
    cpSync(caseSpec.inputDir, join(trialDir, "inputs"), { recursive: true });
    copyFileSync(caseSpec.capture, join(trialDir, "capture.json"));
    writeOnce(join(trialDir, "prepared.json"), canonicalJson({
      registrationSha256: registration.comparisonSha256, executionSha256,
      trialId, caseId: trial.caseId, arm: armName, replicate,
      inputWorldHash: caseSpec.inputWorldHash, captureSha256: evidence.captureSha256,
      policySha256, requiredConfigVersionId: armVersionId,
      reserved: { calls: budget.perTrialCalls, ms: budget.perTrialMs },
    }) + "\n");
    progress({ event: "prepared", trialId, registrationSha256: registration.comparisonSha256,
      executionSha256, inputWorldHash: caseSpec.inputWorldHash, policySha256 });

    try {
      // Explicit pointer check/switch through the admin entry. An admin
      // subprocess reads the admin connection itself; this process never does.
      const before = await resolvePointer();
      if (before.configVersionId !== armVersionId) {
        const expectedRevision = before.deploymentRevision;
        writeOnce(join(trialDir, "pointer.json"), canonicalJson({
          required: armVersionId, resolved: { configVersionId: before.configVersionId,
            deploymentRevision: expectedRevision }, action: "activate" }) + "\n");
        progress({ event: "switch-intent", trialId, from: before.configVersionId, to: armVersionId,
          expectedRevision });
        const switched = await adminRequest(
          { action: "activate", input: { scope, versionId: armVersionId, expectedRevision,
            operationId: `${campaignRunId}:${trialId}:activate`, approval: registration.pointerApproval } },
          trialDir, "admin-request");
        if (switched?.versionId !== armVersionId || switched?.revision !== expectedRevision + 1)
          throw new CampaignHalt("AMBIGUOUS",
            `admin activate returned ${canonicalJson(switched)} for expected ${armVersionId}@${expectedRevision + 1}`);
        const after = await resolvePointer();
        if (after.configVersionId !== armVersionId || after.deploymentRevision !== expectedRevision + 1)
          throw new CampaignHalt("AMBIGUOUS", "pointer re-resolution disagrees with the admin result");
        progress({ event: "switched", trialId, versionId: armVersionId, revision: after.deploymentRevision });
      } else {
        writeOnce(join(trialDir, "pointer.json"), canonicalJson({
          required: armVersionId, resolved: { configVersionId: before.configVersionId,
            deploymentRevision: before.deploymentRevision }, action: "verified" }) + "\n");
        progress({ event: "pointer-verified", trialId, versionId: armVersionId, revision: before.deploymentRevision });
      }

      // Exact registration, inputs, policy and intent are durable BEFORE the
      // model side effect is dispatched.
      writeOnce(join(trialDir, "dispatch.json"), canonicalJson({
        trialId, caseId: trial.caseId, arm: armName, replicate, campaignRunId,
        command: "runtime-evaluate", tenant: scope.tenant, phase: scope.phase,
        inputWorldHash: caseSpec.inputWorldHash, captureSha256: evidence.captureSha256,
        policySha256, asOf: caseSpec.asOf, provider: execution.provider,
        requestedModel: execution.requestedModel, requiredConfigVersionId: armVersionId,
        reserved: { calls: budget.perTrialCalls, ms: budget.perTrialMs },
      }) + "\n");
      progress({ event: "dispatch", trialId, inputWorldHash: caseSpec.inputWorldHash,
        reserved: { calls: budget.perTrialCalls, ms: budget.perTrialMs } });
      counts.dispatched += 1;

      const result = await spawnEdge({
        argv: [process.execPath, CLI_JS, "runtime-evaluate", scope.tenant,
          "--connection", options.runnerConnectionPath, "--input", caseSpec.inputDir,
          "--capture", caseSpec.capture, "--as-of", caseSpec.asOf, "--phase", scope.phase,
          "--provider", execution.provider, "--model", execution.requestedModel,
          "--policy", join(trialDir, "policy.json")],
        env: subprocessEnv({ TMPDIR: runTmp }),
        timeoutMs: budget.perTrialMs,
      });
      writeOnce(join(trialDir, "stdout"), result.stdout);
      writeOnce(join(trialDir, "stderr"), result.stderr);
      writeOnce(join(trialDir, "process.json"), canonicalJson({
        argv: [process.execPath, CLI_JS, "runtime-evaluate", scope.tenant,
          "--connection", options.runnerConnectionPath, "--input", caseSpec.inputDir,
          "--capture", caseSpec.capture, "--as-of", caseSpec.asOf, "--phase", scope.phase,
          "--provider", execution.provider, "--model", execution.requestedModel,
          "--policy", join(trialDir, "policy.json")],
        code: result.code, signal: result.signal, timedOut: result.timedOut, wallMs: result.wallMs,
      }) + "\n");
      record.code = result.code; record.signal = result.signal;
      record.timedOut = result.timedOut; record.wallMs = result.wallMs;
      progress({ event: "closed", trialId, code: result.code, signal: result.signal,
        timedOut: result.timedOut, wallMs: result.wallMs });

      // The pilot's stateRoot is discovered, never parsed out of an error
      // string: exactly one pilot namespace must exist under this trial's
      // private TMPDIR, and every file in it is preserved in place.
      const namespaces = readdirSync(runTmp, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PILOT_PREFIX));
      if (namespaces.length !== 1)
        throw new CampaignHalt("MALFORMED_OUTCOME",
          `expected exactly one ${PILOT_PREFIX}* namespace, found ${namespaces.length}`);
      renameSync(join(runTmp, namespaces[0].name), join(trialDir, "state"));
      const stateDir = join(trialDir, "state");
      record.stateDir = "state";

      const hasResult = existsSync(join(stateDir, "result.json"));
      const hasFailure = existsSync(join(stateDir, "failure.json"));
      if (hasResult === hasFailure)
        throw new CampaignHalt("MALFORMED_OUTCOME",
          `state carries ${hasResult ? "both" : "neither"} result.json and failure.json`);
      const outcomeFile = hasResult ? "result.json" : "failure.json";
      const outcomeBytes = readFileSync(join(stateDir, outcomeFile));
      const snapshotBytes = readFileSync(join(stateDir, "snapshot.json"));
      writeOnce(join(trialDir, outcomeFile), outcomeBytes);
      writeOnce(join(trialDir, "snapshot.json"), snapshotBytes);
      const outcome = parseStrictJson(outcomeBytes.toString("utf8"));
      const snapshot = parseStrictJson(snapshotBytes.toString("utf8"));

      // Self-integrity and identity binding: the snapshot that ran must be the
      // registered arm payload over the registered world, with delivery
      // disabled inside the evaluation environment.
      const { effectiveSnapshotHash, ...unsignedSnapshot } = snapshot;
      if (typeof effectiveSnapshotHash !== "string" || contentHash(unsignedSnapshot) !== effectiveSnapshotHash)
        throw new CampaignHalt("MALFORMED_OUTCOME", "snapshot fails its own integrity hash");
      if (contentHash(snapshot.resolvedPayload) !== snapshot.configHash)
        throw new CampaignHalt("MALFORMED_OUTCOME", "snapshot resolvedPayload does not hash to configHash");
      if (snapshot.configVersionId !== armVersionId || snapshot.configHash !== arm.configHash)
        throw new CampaignHalt("AMBIGUOUS", "the run bound a config other than the registered arm");
      if (snapshot.metadata?.inputWorldHash !== caseSpec.inputWorldHash)
        throw new CampaignHalt("AMBIGUOUS", "the run bound an input world other than the registered case");
      if (snapshot.metadata?.deliveryMode !== "disabled" || snapshot.metadata?.executionEnvironment !== "evaluation")
        throw new CampaignHalt("AMBIGUOUS", "the run was not produced in the disabled-delivery evaluation context");
      if (snapshot.metadata?.engineSha !== registration.comparison.engineSha ||
          snapshot.metadata?.engineArtifactHash !== registration.comparison.engineArtifactHash)
        throw new CampaignHalt("AMBIGUOUS", "the run engine identity differs from the frozen comparison registration");
      const expectedRoute = { grade: "ROUTE_ONLY", provider: execution.provider,
        requestedModel: execution.requestedModel, policyHash: policySha256,
        captureManifestHash: evidence.captureSha256, limits: execution.limits };
      if (canonicalJson(snapshot.metadata?.actualModelIdentity) !== canonicalJson(expectedRoute))
        throw new CampaignHalt("AMBIGUOUS", "the run route identity differs from the frozen policy and capture");
      if (snapshot.scope?.tenant !== scope.tenant || snapshot.scope?.phase !== scope.phase ||
          snapshot.scope?.kind !== scope.kind || snapshot.scope?.environment !== scope.environment)
        throw new CampaignHalt("AMBIGUOUS", "the run scope differs from the registered target");
      record.engineSha = snapshot.metadata?.engineSha;

      // attemptId: the run's own durable records, not an exception string.
      const evidenceDir = join(stateDir, "evidence");
      const evidenceFiles = existsSync(evidenceDir)
        ? readdirSync(evidenceDir).filter((name) => name.endsWith(".json")) : [];
      if (evidenceFiles.length > 1)
        throw new CampaignHalt("AMBIGUOUS", `one run produced ${evidenceFiles.length} evidence documents`);
      let evidenceDoc = null;
      if (evidenceFiles.length === 1) {
        const evidenceBytes = readFileSync(join(evidenceDir, evidenceFiles[0]));
        writeOnce(join(trialDir, "evidence.json"), evidenceBytes);
        evidenceDoc = parseStrictJson(evidenceBytes.toString("utf8"));
      }
      const runDirs = existsSync(join(stateDir, "runs"))
        ? readdirSync(join(stateDir, "runs"), { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
      let attemptId = null;
      if (hasResult) {
        if (typeof outcome.runId !== "string" || outcome.runId === "")
          throw new CampaignHalt("MALFORMED_OUTCOME", "result.json carries no runId");
        attemptId = outcome.runId;
      } else if (evidenceDoc?.run?.runId !== undefined) {
        attemptId = evidenceDoc.run.runId;
      } else if (runDirs.length === 1) {
        attemptId = runDirs[0].name;
      }
      if (attemptId === null)
        throw new CampaignHalt("AMBIGUOUS_DB",
          "the run failed before its attempt id reached any durable record; the DB acknowledgement cannot be named");
      if (evidenceDoc?.run?.runId !== undefined && evidenceDoc.run.runId !== attemptId)
        throw new CampaignHalt("AMBIGUOUS", "evidence document runId disagrees with the outcome runId");
      if (runDirs.length > 1)
        throw new CampaignHalt("AMBIGUOUS", `one run produced ${runDirs.length} run directories`);
      if (runDirs.length === 1 && runDirs[0].name !== attemptId)
        throw new CampaignHalt("AMBIGUOUS", "run directory name disagrees with the outcome runId");
      record.attemptId = attemptId;

      let attempt;
      try { attempt = await control.inspectAttempt(attemptId); }
      catch (error) {
        throw new CampaignHalt("AMBIGUOUS_DB",
          `attempt ${attemptId} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
      }
      writeOnce(join(trialDir, "inspection.json"), canonicalJson(attempt) + "\n");
      record.dbStatus = attempt.status;
      if (!isRecord(attempt) || attempt.id !== attemptId || !isRecord(attempt.scope) ||
          canonicalJson(attempt.scope) !== canonicalJson(scope) ||
          attempt.snapshot?.configVersionId !== armVersionId)
        throw new CampaignHalt("AMBIGUOUS", "the DB attempt does not bind this trial's scope and arm");
      if (!["SUCCEEDED", "FAILED", "UNKNOWN", "DISPATCHED"].includes(attempt.status))
        throw new CampaignHalt("MALFORMED_OUTCOME", `attempt has unsupported status ${String(attempt.status)}`);

      // Operator-normalized session usage, from the attempt's own evidence.
      const inference = attempt.evidence?.inference;
      let requests = null; let tokens = null; let usageUnknown = true;
      if (isRecord(inference)) {
        requests = Number.isSafeInteger(inference.requestCount) && inference.requestCount >= 0
          ? inference.requestCount : null;
        tokens = Number.isSafeInteger(inference.inputTokens) && inference.inputTokens >= 0 &&
                 Number.isSafeInteger(inference.outputTokens) && inference.outputTokens >= 0
          ? inference.inputTokens + inference.outputTokens : null;
        usageUnknown = inference.unknown !== false || requests === null;
      } else if (attempt.evidence?.modelCalls === 0) {
        requests = 0; tokens = 0; usageUnknown = false;
      }
      if (attempt.status === "UNKNOWN" || result.timedOut) usageUnknown = true;
      if (isRecord(inference) && inference.invocationUnit !== "ACP_INVOCATION")
        usageUnknown = true;
      if (requests !== null && requests > budget.perTrialCalls) usageUnknown = true;
      // ACP's wire label (for example "Summarizer") is not a serving revision.
      // The raw inspection retains it; comparison metadata must stay unknown.
      const reportedId = null;
      const attempts = [{ attemptId, status: attempt.status, requests, tokens,
        latencyMs: Math.max(0, Math.round(result.wallMs)), costUsd: null, usageUnknown }];
      record.requests = requests; record.usageUnknown = usageUnknown;

      // The comparison's trial manifest is written only when a bound outcome
      // file and a named attempt exist; anything less stays as raw artifacts
      // plus a stop record — never a schema-shaped guess.
      const manifestWritable = attempt.status === "SUCCEEDED" || attempt.status === "FAILED" || attempt.status === "UNKNOWN";
      if (manifestWritable) {
        // final.txt: the recorded evidence view rendered through the same pure
        // renderer the delivery path used — derived, never regenerated.
        if (hasResult && outcome.outcome === "completed" && evidenceDoc?.view !== undefined) {
          try {
            const finalBytes = Buffer.from(renderText(evidenceDoc.view), "utf8");
            writeOnce(join(trialDir, "final.txt"), finalBytes);
            writeOnce(join(trialDir, "final.derivation.json"), canonicalJson({
              method: "derived-from-recorded-view",
              renderer: "plugins/option-wizard/lib/render/text.js#renderText",
              evidenceFile: `state/evidence/${evidenceFiles[0]}`,
              viewSha256: sha256Text(canonicalJson(evidenceDoc.view)),
              finalSha256: sha256Bytes(finalBytes),
              note: "text part recomputed from the recorded BriefView by the same pure function that produced it; the article was not regenerated",
            }) + "\n");
            record.finalTxt = true;
          } catch (error) {
            record.finalTxt = false;
            progress({ event: "final-derivation-failed", trialId,
              detail: error instanceof Error ? error.message : String(error) });
          }
        } else record.finalTxt = false;

        const usageBytes = Buffer.from(canonicalJson({
          schemaVersion: "runtime-comparison-usage-v1", attempts }) + "\n", "utf8");
        writeOnce(join(trialDir, "usage.json"), usageBytes);
        writeOnce(join(trialDir, "trial.json"), canonicalJson({
          schemaVersion: "runtime-comparison-trial-v1",
          trialId, caseId: trial.caseId, arm: armName, replicate,
          configVersionId: armVersionId, configHash: arm.configHash,
          model: { requestedId: execution.requestedModel, reportedId },
          snapshotSha256: sha256Bytes(snapshotBytes),
          outcomeFile, outcomeSha256: sha256Bytes(outcomeBytes),
          claimsEvidenceSha256: null,
          usageEvidenceSha256: sha256Bytes(usageBytes),
          // No existing artifact records third-row exposure and this executor
          // does not infer it; a null here is inconclusive downstream, not false.
          observedThirdRow: null,
          attempts,
        }) + "\n");
      }

      // Release only measured unused capacity. UNKNOWN/DISPATCHED keeps the
      // full reservation because the external work cannot be proved settled.
      if (requests !== null && !usageUnknown)
        ledger.calls -= budget.perTrialCalls - requests;
      if (!result.timedOut && (attempt.status === "SUCCEEDED" || attempt.status === "FAILED"))
        ledger.ms -= budget.perTrialMs - Math.min(budget.perTrialMs, Math.max(0, Math.round(result.wallMs)));
      progress({ event: "settled", trialId, dbStatus: attempt.status, requests,
        usageUnknown, wallMs: record.wallMs,
        heldOrSpent: { calls: ledger.calls, ms: ledger.ms } });

      if (result.timedOut) {
        writeOnce(join(trialDir, "stop.json"), canonicalJson({ reason: "RESOURCE_EXHAUSTED",
          detail: "trial exceeded its registered wall bound and was killed" }) + "\n");
        halt("RESOURCE_EXHAUSTED", `trial ${trialId} exceeded the per-trial wall bound ${budget.perTrialMs}ms`, trialId);
        break;
      }
      if (attempt.status === "DISPATCHED") {
        writeOnce(join(trialDir, "stop.json"), canonicalJson({ reason: "AMBIGUOUS_DB",
          detail: "attempt remains DISPATCHED: the finalize acknowledgement was never confirmed" }) + "\n");
        halt("AMBIGUOUS_DB", `attempt ${attemptId} remains DISPATCHED; no terminal acknowledgement was confirmed`, trialId);
        break;
      }
      if (attempt.status === "UNKNOWN") {
        writeOnce(join(trialDir, "stop.json"), canonicalJson({ reason: "UNKNOWN_ATTEMPT",
          detail: "attempt finalized UNKNOWN; its reservation stays held and no further pointer change is made" }) + "\n");
        counts.unknown += 1;
        halt("UNKNOWN_ATTEMPT", `attempt ${attemptId} finalized UNKNOWN`, trialId);
        break;
      }
      if (attempt.status === "SUCCEEDED") {
        if (result.code !== 0 || !hasResult || outcome.outcome !== "completed")
          throw new CampaignHalt("AMBIGUOUS", "a SUCCEEDED attempt does not match a completed result.json");
        counts.succeeded += 1;
        record.outcome = "completed";
      } else { // FAILED: a known generation failure stays in the denominator.
        if (!hasFailure)
          throw new CampaignHalt("AMBIGUOUS", "a FAILED attempt does not match failure.json");
        counts.knownFailures += 1;
        record.outcome = "failed";
        const stopOnFailure = continuationPolicy.onKnownGenerationFailure === "stop";
        if (stopOnFailure) {
          writeOnce(join(trialDir, "stop.json"), canonicalJson({ reason: "KNOWN_FAILURE_LIMIT",
            detail: "preregistered continuation policy stops the campaign on this failure" }) + "\n");
          halt("KNOWN_FAILURE_LIMIT", `trial ${trialId} is a known generation failure #${counts.knownFailures}`, trialId);
          break;
        }
      }
      progress({ event: "trial", trialId, dbStatus: attempt.status, outcome: record.outcome });
    } catch (error) {
      if (error instanceof CampaignHalt) {
        try {
          writeOnce(join(trialDir, "stop.json"), canonicalJson({ reason: error.reason, detail: error.detail }) + "\n");
        } catch { /* a stop record that cannot be written must not hide the reason */ }
        halt(error.reason, error.detail, trialId);
      } else {
        halt("AMBIGUOUS", error instanceof Error ? error.message : String(error), trialId);
      }
      break;
    }
  }

  return finish(registration);
}

async function main() {
  const [executionPath, adminConnectionPath, runnerConnectionPath, outputDir, ...extra] = process.argv.slice(2);
  if (!outputDir || extra.length > 0)
    throw new Error("usage: node scripts/runtime-campaign.mjs execution.json admin-connection.json runner-connection.json new-output-dir");
  const summary = await runCampaign({ executionPath, adminConnectionPath, runnerConnectionPath, outputDir });
  console.log(`${summary.status} ${outputDir}`);
  return summary.status === "COMPLETED" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
