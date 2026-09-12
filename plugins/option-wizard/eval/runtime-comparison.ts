/**
 * Tenant-owned paired analysis for the M2 premarket-news comparison.
 *
 * Consumes a frozen registration plus separately bound independent manual
 * measurements. A trial counts only when its actual runtime snapshot and
 * outcome bytes are supplied and verified against the registered engine,
 * input world, config and scope; self-reported hashes alone can never
 * produce REVIEW_READY. The command never generates, never calls a
 * provider and never activates anything.
 *
 * The paired interval is one fixed implementation (seeded cluster
 * bootstrap, "paired-cluster-bootstrap-v1") the registration must select
 * with a frozen seed, replicate count and alpha. It is an implementation
 * requiring preregistration and calibration — not automatically
 * scientifically qualified — and the synthetic tests are mechanism
 * evidence only.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@helium/core";
import { measureRuntimeCoverage } from "./runtime-coverage.js";

export type ComparisonDecision =
  | "INVALID" | "NOT_COMPARABLE" | "REJECT" | "INCONCLUSIVE" | "NO_CHANGE" | "REVIEW_READY";
export type ComparisonMode = "AA_DIAGNOSTIC" | "CONFIRMATION_2V3";
export type Arm = "champion" | "candidate";

/** One trial directory's parsed contents; each sha256 is computed by the caller over original bytes. */
export interface ComparisonTrialInput {
  label: string;
  trial: unknown;
  trialSha256: string | null;
  events: unknown;
  eventsSha256: string | null;
  review: unknown;
  reviewSha256: string | null;
  measurement: unknown;
  measurementSha256: string | null;
  snapshot: unknown;
  snapshotSha256: string | null;
  /** Parsed result.json or failure.json, whichever exists. */
  outcome: unknown;
  outcomeSha256: string | null;
  outcomeFile: "result.json" | "failure.json" | null;
  claims: unknown;
  claimsSha256: string | null;
  /** Parsed usage.json session/attempt evidence, if supplied. */
  usage: unknown;
  usageSha256: string | null;
  finalSha256: string | null;
  finalLines: string[] | null;
  /** Files that existed but failed to parse, e.g. "review.json: not strict JSON". */
  inputErrors: string[];
}

export interface ComparisonInput {
  registration: unknown;
  registrationSha256: string;
  /** Byte-identified reference artifacts (evaluator, qualification, lineage, rubric, evidence reviews). */
  refs: Array<{ name: string; sha256: string }>;
  trials: ComparisonTrialInput[];
}

const HASH = /^[a-f0-9]{64}$/u;
const INTERVAL_METHOD = "paired-cluster-bootstrap-v1";
const DECISION_RULE = "paired-cluster-lower-bound-min-effect";
const ARMS: readonly Arm[] = ["champion", "candidate"];

const text = z.string().min(1);
const sha = z.string().regex(HASH, "must be a SHA-256 hash");
const nullableSha = sha.nullable();
const nullableText = text.nullable();
/** zod v4 numbers already reject NaN and infinities; bounds are added per field. */
const finite = z.number();

const armIdentity = z.strictObject({ configVersionId: text, configHash: sha });

const registrationSchema = z.strictObject({
  schemaVersion: z.literal("runtime-comparison-registration-v1"),
  status: z.literal("REGISTERED"),
  experimentId: text,
  hypothesis: z.string().optional(),
  comparisonMode: z.enum(["AA_DIAGNOSTIC", "CONFIRMATION_2V3"]),
  champion: armIdentity,
  candidate: armIdentity,
  changedPaths: z.array(text),
  engineSha: text,
  engineArtifactHash: sha,
  baseManifestHashes: z.record(z.string(), sha),
  replay: z.strictObject({
    mode: z.literal("SNAPSHOT_PIPELINE"),
    inputCorpusHash: sha,
    ledgerSnapshotHash: nullableSha,
    calendarHash: nullableSha,
    worldCompletenessReceipt: nullableSha,
  }),
  evaluation: z.strictObject({
    evaluatorHash: sha,
    qualificationHash: nullableSha,
    promotionPolicyHash: nullableSha,
    primaryMetric: z.literal("coverage.final"),
    minimumPracticalEffect: finite.min(0).max(1),
    alpha: finite.gt(0).lt(1),
    independentClusterCount: z.number().int().min(2),
    replicatesPerCase: z.number().int().min(1),
    decisionFamilyId: nullableText,
    holdoutCohortId: nullableText,
    holdoutLineageHash: nullableSha,
    criticalErrorsMaximum: z.number().int().min(0),
    claimsSupportedNonInferiorityMargin: finite.min(0).max(1).nullable(),
    reliabilityNonInferiorityMargin: finite.min(0).max(1).nullable(),
    decisionRule: z.literal(DECISION_RULE),
    intervalImplementation: z.strictObject({
      method: z.literal(INTERVAL_METHOD),
      seed: z.number().int().min(0),
      replicates: z.number().int().min(1),
    }),
    clusterDefinition: text,
    sampleSizeRationale: text,
    aaCalibrationEvidence: nullableText,
    armOrderRandomizationPlan: nullableText,
    failureAndRetryRule: text,
    treatmentSlices: z.strictObject({
      definedBeforeGeneration: z.literal(true),
      withThirdEligibleRowCaseIds: z.array(text),
      withoutThirdEligibleRowCaseIds: z.array(text),
    }),
    manualReview: z.strictObject({ requiredReviewerIdentity: text, requiredRubricHash: sha }),
    manualEvidenceValidityReviewRef: nullableText,
    holdoutExposureRecordRef: nullableText,
    unresolvedCriticalDisagreement: z.literal("INCONCLUSIVE"),
  }),
  confirmationCohort: z.strictObject({
    cases: z.array(z.strictObject({ caseId: text, clusterId: text, eventManifestHash: sha, inputWorldHash: sha })).min(1),
  }),
  resourcePolicy: z.strictObject({
    /** Dimensions the runtime actually measured; a limit may exist only for a measured dimension. */
    measured: z.array(z.enum(["requests", "tokens", "latencyMs", "costUsd"])),
    perTrialTokenLimit: z.number().int().min(1).nullable(),
    perTrialCallLimit: z.number().int().min(1).nullable(),
    timeoutSeconds: finite.gt(0).nullable(),
    totalTokenLimit: z.number().int().min(1).nullable(),
    totalCallLimit: z.number().int().min(1).nullable(),
    costIncreaseLimit: finite.min(0).nullable(),
    latencyIncreaseLimit: finite.min(0).nullable(),
    aggregationRule: z.literal("all-attempts-summed"),
  }),
  // The registered model-identity grant: which route grade the comparison accepts and,
  // when registered, which provider. ROUTE_ONLY records the actual route; it never
  // masquerades as a pinned serving revision.
  actualModelIdentityPlan: z.strictObject({
    requestedModelId: text,
    acceptedGrade: z.enum(["ROUTE_ONLY", "PINNED"]),
    providerId: text.optional(),
  }),
  targetDeployment: z.strictObject({ tenant: text, phase: text, environment: text, kind: text }).nullish(),
  executionContext: z.strictObject({
    environment: z.literal("evaluation"),
    stateNamespace: nullableText,
    deliveryMode: z.literal("disabled"),
  }),
  deliveryWave: z.literal("M2"),
  activationMode: z.literal("MANUAL_REVIEW_ONLY"),
});

type Registration = z.infer<typeof registrationSchema>;

const attemptSchema = z.strictObject({
  attemptId: text,
  status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  requests: z.number().int().min(0).nullable(),
  tokens: z.number().int().min(0).nullable(),
  latencyMs: finite.min(0).nullable(),
  costUsd: finite.min(0).nullable(),
  usageUnknown: z.boolean(),
});

const trialSchema = z.strictObject({
  schemaVersion: z.literal("runtime-comparison-trial-v1"),
  trialId: text,
  caseId: text,
  arm: z.enum(ARMS as [Arm, Arm]),
  replicate: z.number().int().min(1),
  configVersionId: text,
  configHash: sha,
  model: z.strictObject({ requestedId: text, reportedId: nullableText }),
  /** Declared bindings; every value must equal the caller-computed hash of the supplied file. */
  snapshotSha256: sha,
  outcomeFile: z.enum(["result.json", "failure.json"]),
  outcomeSha256: sha,
  claimsEvidenceSha256: nullableSha,
  /** Hash of the bound usage/session evidence artifact; null = attempt accounting is self-declared only. */
  usageEvidenceSha256: nullableSha,
  /** Whether a third eligible row actually entered this trial's context; null = not recorded. */
  observedThirdRow: z.boolean().nullable(),
  attempts: z.array(attemptSchema).min(1),
});

type ParsedTrial = z.infer<typeof trialSchema>;

const claimsSchema = z.strictObject({
  schemaVersion: z.literal("runtime-comparison-claims-v1"),
  reviewer: z.strictObject({ identity: text, rubricHash: sha }),
  reviewed: z.number().int().min(0),
  supported: z.number().int().min(0),
});

// Operator-normalized per-attempt usage record for the execution session, bound by
// hash; the self-declared manifest attempts must reproduce it exactly. This is
// operator-side session evidence, never independent provider-side billing proof.
const usageSchema = z.strictObject({
  schemaVersion: z.literal("runtime-comparison-usage-v1"),
  attempts: z.array(attemptSchema).min(1),
});

// The route identity the runtime actually writes into snapshot metadata
// (packages/cli runtime-evaluate composition): the "NONE_TOOL_ONLY" sentinel for a
// model-free run, or the bound route object.
const routeIdentitySchema = z.object({
  grade: text,
  provider: text,
  requestedModel: text,
  policyHash: sha,
  captureManifestHash: sha,
  limits: z.unknown(),
});

const snapshotSchema = z.object({
  scope: z.object({ tenant: text, phase: text, kind: text, environment: z.literal("test") }),
  configVersionId: text,
  configHash: sha,
  resolvedPayload: z.unknown(),
  metadata: z.object({
    engineSha: text,
    engineArtifactHash: sha,
    inputWorldHash: sha,
    deliveryMode: text,
    executionEnvironment: text,
    actualModelIdentity: z.union([z.literal("NONE_TOOL_ONLY"), routeIdentitySchema]).optional(),
  }),
  effectiveSnapshotHash: sha,
});

function issues(error: z.ZodError, name: string): string {
  return `${name}: ${error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(issues(result.error, name));
  return result.data;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Deterministic PRNG (mulberry32) so the registered seed reproduces the interval exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile cluster bootstrap over equal-weight paired cluster differences. */
function pairedClusterBootstrap(diffs: number[], seed: number, replicates: number, alpha: number) {
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < replicates; b++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rng() * diffs.length)]!;
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  return {
    mean: diffs.reduce((sum, value) => sum + value, 0) / diffs.length,
    lower: means[Math.max(0, Math.floor((alpha / 2) * replicates))]!,
    upper: means[Math.min(replicates - 1, Math.ceil((1 - alpha / 2) * replicates) - 1)]!,
  };
}

/** Replace each registered changed path with a sentinel so the remaining payloads must be identical. */
function maskAtPaths(payload: unknown, paths: string[], name: string): unknown {
  const masked = structuredClone(payload);
  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) throw new Error(`${name}: changed path ${path} is empty`);
    let node: Record<string, unknown> = masked as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      const next: unknown = node[segment];
      if (typeof next !== "object" || next === null || Array.isArray(next))
        throw new Error(`${name}: changed path ${path} does not resolve in a bound config payload`);
      node = next as Record<string, unknown>;
    }
    const leaf = segments.at(-1)!;
    if (!(leaf in node)) throw new Error(`${name}: changed path ${path} does not resolve in a bound config payload`);
    node[leaf] = "__CHANGED__";
  }
  return masked;
}

type TrialStatus = "measured" | "incomplete" | "generation-failed" | "unresolved";

interface EvaluatedTrial {
  parsed: ParsedTrial;
  status: TrialStatus;
  coverage: number | null;
  verifiedCritical: number;
  unresolvedCriticalDisagreement: boolean;
  claims: { reviewed: number; supported: number } | null;
  usage: { requests: number | null; tokens: number | null; latencyMs: number | null; costUsd: number | null; unknownAttempts: boolean };
  /** True only when a bound usage.json reproduced the declared attempts. */
  usageVerified: boolean;
  /** Actual route bound from snapshot metadata; null when the snapshot records none. */
  actualModel: string | null;
}

function sumAttempts(attempts: ParsedTrial["attempts"], pick: (attempt: ParsedTrial["attempts"][number]) => number | null): number | null {
  let sum = 0;
  for (const attempt of attempts) {
    if (attempt.status === "UNKNOWN" || attempt.usageUnknown) return null;
    const value = pick(attempt);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

const FINAL_REF = /^final:([1-9][0-9]*)(?:-([1-9][0-9]*))?$/u;

export function analyzeComparison(input: ComparisonInput): Record<string, unknown> {
  const invalid: string[] = [];
  const notComparable: string[] = [];
  const inconclusive: string[] = [];
  const provenance: Array<Record<string, unknown>> = [
    { name: "registration.json", sha256: input.registrationSha256, role: "registration" },
    ...input.refs.map((ref) => ({ name: `refs/${ref.name}`, sha256: ref.sha256, role: "reference" })),
  ];

  const registrationResult = registrationSchema.safeParse(input.registration);
  if (!registrationResult.success) {
    return {
      schemaVersion: "runtime-comparison-result-v1", decision: "INVALID" satisfies ComparisonDecision, mode: null,
      reasons: [`registration rejected: ${issues(registrationResult.error, "registration")}`],
      assumptions: [], registration: { experimentId: null, sha256: input.registrationSha256 },
      provenance: { files: provenance },
    };
  }
  const registration = registrationResult.data;
  const ev = registration.evaluation;
  const mode = registration.comparisonMode;

  // Registration-internal consistency: slices partition the cohort; cluster count matches the mapping.
  const cohortCaseIds = new Set(registration.confirmationCohort.cases.map((entry) => entry.caseId));
  const sliceAll = [...ev.treatmentSlices.withThirdEligibleRowCaseIds, ...ev.treatmentSlices.withoutThirdEligibleRowCaseIds];
  if (new Set(sliceAll).size !== sliceAll.length || sliceAll.length !== cohortCaseIds.size || sliceAll.some((id) => !cohortCaseIds.has(id)))
    invalid.push("treatment slices must be disjoint and cover exactly the registered cohort case ids");
  const clusterIds = [...new Set(registration.confirmationCohort.cases.map((entry) => entry.clusterId))];
  if (clusterIds.length !== ev.independentClusterCount)
    invalid.push(`registration declares ${ev.independentClusterCount} independent clusters but the cohort mapping has ${clusterIds.length}`);
  if (mode === "CONFIRMATION_2V3" && (registration.champion.configHash === registration.candidate.configHash || registration.changedPaths.length === 0))
    invalid.push("confirmation requires distinct arm configurations and a non-empty changedPaths");
  if (mode === "AA_DIAGNOSTIC" && (registration.champion.configHash !== registration.candidate.configHash || registration.changedPaths.length > 0))
    invalid.push("A/A diagnostic requires the same arm configuration and no changed paths");

  // The registered corpus hash is the hash of the ordered case/world manifest; each case may keep its own world.
  const corpusManifest = registration.confirmationCohort.cases.map((entry) => ({ caseId: entry.caseId, inputWorldHash: entry.inputWorldHash }));
  if (contentHash(corpusManifest) !== registration.replay.inputCorpusHash)
    invalid.push("replay.inputCorpusHash must equal the hash of the ordered case/world manifest");

  // Resource basis consistency: no limits on unmeasured dimensions; confirmation keeps finite enforceable calls/time.
  const measured = new Set(registration.resourcePolicy.measured);
  const limitDimensions: Array<[keyof Registration["resourcePolicy"], "requests" | "tokens" | "latencyMs" | "costUsd"]> = [
    ["perTrialTokenLimit", "tokens"], ["perTrialCallLimit", "requests"], ["timeoutSeconds", "latencyMs"],
    ["totalTokenLimit", "tokens"], ["totalCallLimit", "requests"], ["costIncreaseLimit", "costUsd"],
    ["latencyIncreaseLimit", "latencyMs"],
  ];
  for (const [field, dimension] of limitDimensions)
    if (registration.resourcePolicy[field] !== null && !measured.has(dimension))
      invalid.push(`resourcePolicy.${field} limits an unmeasured dimension (${dimension} is not in measured)`);
  if (mode === "CONFIRMATION_2V3") {
    if (!measured.has("requests") || !measured.has("latencyMs"))
      invalid.push("confirmation requires a measured basis covering calls and time");
    if (registration.resourcePolicy.perTrialCallLimit === null || registration.resourcePolicy.timeoutSeconds === null ||
        registration.resourcePolicy.totalCallLimit === null)
      invalid.push("confirmation requires finite perTrialCallLimit, timeoutSeconds and totalCallLimit");
  }

  const caseById = new Map(registration.confirmationCohort.cases.map((entry) => [entry.caseId, entry]));
  const evaluated: EvaluatedTrial[] = [];
  const seenKeys = new Set<string>();
  const seenTrialIds = new Set<string>();
  const actualModels = new Set<string>();
  const payloads: Partial<Record<Arm, unknown>> = {};

  for (const raw of input.trials) {
    for (const [file, hashValue] of [["trial.json", raw.trialSha256], ["events.json", raw.eventsSha256], ["review.json", raw.reviewSha256],
      ["measurement.json", raw.measurementSha256], ["snapshot.json", raw.snapshotSha256],
      [raw.outcomeFile ?? "outcome", raw.outcomeSha256], ["claims.json", raw.claimsSha256],
      ["usage.json", raw.usageSha256], ["final.txt", raw.finalSha256]] as const)
      if (hashValue !== null) provenance.push({ name: `${raw.label}/${file}`, sha256: hashValue, role: "trial-input" });

    let parsed: ParsedTrial;
    try {
      parsed = parse(trialSchema, raw.trial, `${raw.label}/trial.json`);
    } catch (error) {
      invalid.push((error as Error).message);
      continue;
    }
    const key = `${parsed.caseId}${parsed.arm}${parsed.replicate}`;
    const cohortCase = caseById.get(parsed.caseId);
    const problems: string[] = [];
    if (seenTrialIds.has(parsed.trialId)) problems.push("duplicate trialId");
    if (cohortCase === undefined) problems.push(`unregistered case ${parsed.caseId}`);
    else if (parsed.replicate > ev.replicatesPerCase) problems.push(`replicate exceeds registered ${ev.replicatesPerCase}`);
    else if (seenKeys.has(key)) problems.push(`duplicate ${parsed.caseId}/${parsed.arm}#${parsed.replicate}`);
    if (problems.length > 0) {
      invalid.push(...problems.map((problem) => `${parsed.trialId}: ${problem}`));
      continue;
    }
    seenTrialIds.add(parsed.trialId);
    seenKeys.add(key);

    const usage = {
      requests: sumAttempts(parsed.attempts, (attempt) => attempt.requests),
      tokens: sumAttempts(parsed.attempts, (attempt) => attempt.tokens),
      latencyMs: sumAttempts(parsed.attempts, (attempt) => attempt.latencyMs),
      costUsd: sumAttempts(parsed.attempts, (attempt) => attempt.costUsd),
      unknownAttempts: parsed.attempts.some((attempt) => attempt.status === "UNKNOWN" || attempt.usageUnknown),
    };
    const trial: EvaluatedTrial = { parsed, status: "unresolved", coverage: null, verifiedCritical: 0,
      unresolvedCriticalDisagreement: false, claims: null, usage, usageVerified: false, actualModel: null };
    evaluated.push(trial);

    if (raw.inputErrors.length > 0) { notComparable.push(`${parsed.trialId}: ${raw.inputErrors.join("; ")}`); continue; }

    // Artifact presence: absent evidence is unknown (INCONCLUSIVE), never zero.
    let unbound = false;
    if (raw.snapshot == null) { inconclusive.push(`${parsed.trialId}: runtime snapshot bytes not supplied; identity unverified`); unbound = true; }
    if (raw.outcome == null) { inconclusive.push(`${parsed.trialId}: run outcome bytes not supplied; completion unverified`); unbound = true; }
    const measurementMissing = raw.measurement == null || raw.review == null || raw.events == null;
    if (measurementMissing)
      inconclusive.push(`${parsed.trialId}: no complete measurement supplied; treated as unknown, never zero`);

    // Actual runtime identity must be bound to supplied snapshot/outcome bytes, never self-declared.
    if (!unbound) try {
      if (raw.snapshotSha256 !== parsed.snapshotSha256)
        throw new Error("snapshot.json bytes do not match the declared snapshotSha256");
      if (raw.outcomeFile !== parsed.outcomeFile || raw.outcomeSha256 !== parsed.outcomeSha256)
        throw new Error(`${parsed.outcomeFile} bytes do not match the declared outcomeSha256`);
      const snapshot = parse(snapshotSchema, raw.snapshot, "snapshot");
      // Hash the raw parsed object: the zod view intentionally drops fields the integrity hash covers.
      const { effectiveSnapshotHash, ...unsigned } = raw.snapshot as Record<string, unknown>;
      if (contentHash(unsigned) !== effectiveSnapshotHash)
        throw new Error("snapshot effectiveSnapshotHash fails its own integrity check");
      if (contentHash(snapshot.resolvedPayload) !== snapshot.configHash)
        throw new Error("snapshot resolvedPayload does not hash to its configHash");
      const identity = registration[parsed.arm];
      if (snapshot.configHash !== identity.configHash || snapshot.configVersionId !== identity.configVersionId ||
          parsed.configHash !== identity.configHash || parsed.configVersionId !== identity.configVersionId)
        throw new Error(`bound config is not the registered ${parsed.arm} identity`);
      if (snapshot.metadata.inputWorldHash !== cohortCase!.inputWorldHash)
        throw new Error("snapshot input world is not the registered world for this case");
      if (snapshot.metadata.engineSha !== registration.engineSha || snapshot.metadata.engineArtifactHash !== registration.engineArtifactHash)
        throw new Error("snapshot engine identity is not the registered engine");
      if (snapshot.metadata.deliveryMode !== "disabled" || snapshot.metadata.executionEnvironment !== "evaluation")
        throw new Error("snapshot was not produced in the disabled-delivery evaluation context");
      if (registration.targetDeployment != null &&
          (snapshot.scope.tenant !== registration.targetDeployment.tenant || snapshot.scope.phase !== registration.targetDeployment.phase ||
           snapshot.scope.kind !== registration.targetDeployment.kind))
        throw new Error("snapshot scope is outside the registered target deployment");
      if (parsed.model.requestedId !== registration.actualModelIdentityPlan.requestedModelId)
        throw new Error("requested model is not the registered model identity plan");
      // The actual route is accepted only from bound snapshot metadata; a self-declared
      // reportedId must agree with it but can never verify it. "NONE_TOOL_ONLY" (or an
      // absent field) means the run recorded no route at all.
      const route = snapshot.metadata.actualModelIdentity;
      if (route !== undefined && route !== "NONE_TOOL_ONLY") {
        if (route.grade !== registration.actualModelIdentityPlan.acceptedGrade)
          throw new Error(`bound route grade ${route.grade} is not the registered accepted grade ${registration.actualModelIdentityPlan.acceptedGrade}`);
        if (route.requestedModel !== parsed.model.requestedId)
          throw new Error("bound route requested model does not match the declared requested model");
        if (registration.actualModelIdentityPlan.providerId !== undefined && route.provider !== registration.actualModelIdentityPlan.providerId)
          throw new Error("bound route provider is not the registered provider");
        if (contentHash(route.limits) !== route.policyHash)
          throw new Error("route policyHash fails its own integrity check over the recorded limits");
        if (parsed.model.reportedId !== null && parsed.model.reportedId !== route.requestedModel)
          throw new Error("declared reported model contradicts the bound route requested model");
        trial.actualModel = `${route.provider}:${route.requestedModel}`;
        actualModels.add(trial.actualModel);
      }
      // Actual treatment exposure must be recorded and consistent with the slice assigned before generation.
      if (mode === "CONFIRMATION_2V3") {
        const expected = parsed.arm === "candidate" && ev.treatmentSlices.withThirdEligibleRowCaseIds.includes(parsed.caseId);
        if (parsed.observedThirdRow === null)
          inconclusive.push(`${parsed.trialId}: treatment exposure (third eligible row in context) was not recorded`);
        else if (parsed.observedThirdRow !== expected)
          throw new Error(`observed third-row exposure contradicts the registered slice assignment (expected ${expected})`);
      }
      if (payloads[parsed.arm] === undefined) payloads[parsed.arm] = snapshot.resolvedPayload;
    } catch (error) {
      notComparable.push(`${parsed.trialId}: ${(error as Error).message}`);
      unbound = true;
    }

    // Measurement chain: supplied files must reproduce the bound diagnostic measurement.
    if (!unbound && !measurementMissing) try {
      const review = raw.review as Record<string, unknown>;
      // Outcome agreement in both directions: a recognized outcome must match the review state.
      if (raw.outcomeFile === "result.json") {
        const outcomeValue = (raw.outcome as Record<string, unknown>).outcome;
        if (typeof outcomeValue !== "string" || outcomeValue.length === 0)
          throw new Error("result.json carries no recognized outcome");
        if (review.completed === true && outcomeValue !== "completed")
          throw new Error(`result.json outcome "${outcomeValue}" cannot accompany a completed review`);
        if (review.completed === false && outcomeValue === "completed")
          throw new Error("result.json reports completed but the review claims failed generation");
      }
      if (raw.outcomeFile === "failure.json" && review.completed !== false)
        throw new Error("failure.json outcome cannot accompany a completed review");
      const measurement = parse(z.strictObject({
        mode: z.literal("MANUAL_REVIEW_DIAGNOSTIC"),
        eventManifestHash: sha, reviewHash: sha, finalArtifactHash: nullableSha, measurement: z.unknown(),
      }), raw.measurement, "measurement");
      if (measurement.eventManifestHash !== raw.eventsSha256 || raw.eventsSha256 !== cohortCase!.eventManifestHash)
        throw new Error("event manifest bytes do not bind the registered case denominator");
      if (measurement.reviewHash !== raw.reviewSha256) throw new Error("review bytes do not match the bound review hash");
      if (measurement.finalArtifactHash !== raw.finalSha256) throw new Error("final artifact hash does not match the supplied article bytes");
      const recomputed = measureRuntimeCoverage({ ...review, events: raw.events });
      if (canonicalJson(recomputed) !== canonicalJson(measurement.measurement))
        throw new Error("supplied measurement disagrees with recomputed coverage semantics");
      if (review.completed === true) {
        const reviewer = parse(z.strictObject({ identity: text, rubricHash: sha }), review.reviewer, "review.reviewer");
        if (reviewer.identity !== ev.manualReview.requiredReviewerIdentity || reviewer.rubricHash !== ev.manualReview.requiredRubricHash)
          throw new Error("reviewer identity or rubric hash is not the registered manual review");
        if (raw.finalLines == null) throw new Error("completed generation requires the final article bytes");
        const events = raw.events as Array<{ id: string; evidenceRefs: string[] }>;
        for (const row of review.reviews as Array<Record<string, unknown>>) {
          const event = events.find((entry) => entry.id === row.eventId);
          for (const ref of row.sourceRefs as string[])
            if (!event?.evidenceRefs.includes(ref)) throw new Error("review source reference is outside its preregistered event evidence");
          for (const ref of row.finalSpanRefs as string[]) {
            const match = FINAL_REF.exec(ref);
            const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
            if (!match || end < start || end > raw.finalLines.length || !raw.finalLines.slice(start - 1, end).join("\n").trim())
              throw new Error("final span reference does not resolve to nonempty article lines");
          }
        }
        const rows = review.reviews as Array<{ criticalErrors: number; adjudication: string }>;
        trial.verifiedCritical = rows.filter((row) => row.adjudication === "resolved").reduce((sum, row) => sum + row.criticalErrors, 0);
        trial.unresolvedCriticalDisagreement = rows.some((row) => row.adjudication === "unknown" && row.criticalErrors > 0);
        trial.status = recomputed.status === "measured" ? "measured" : "incomplete";
        trial.coverage = recomputed.coverageFinal;
      } else {
        if (raw.finalSha256 !== null) throw new Error("failed generation must not carry a final artifact");
        trial.status = "generation-failed";
        trial.coverage = recomputed.coverageFinal; // 0 for a nonempty denominator, null when empty
      }
    } catch (error) {
      notComparable.push(`${parsed.trialId}: ${(error as Error).message}`);
    }

    // Claim support arrives as its own byte-bound reviewer artifact, never an inline self-report.
    if (parsed.claimsEvidenceSha256 !== null) {
      if (raw.claims == null) inconclusive.push(`${parsed.trialId}: declared claim evidence is not supplied`);
      else try {
        if (raw.claimsSha256 !== parsed.claimsEvidenceSha256) throw new Error("claims.json bytes do not match the declared claimsEvidenceSha256");
        const claims = parse(claimsSchema, raw.claims, "claims");
        if (claims.supported > claims.reviewed) throw new Error("claim support exceeds reviewed count");
        if (claims.reviewer.identity !== ev.manualReview.requiredReviewerIdentity || claims.reviewer.rubricHash !== ev.manualReview.requiredRubricHash)
          throw new Error("claim evidence reviewer is not the registered manual review");
        trial.claims = { reviewed: claims.reviewed, supported: claims.supported };
      } catch (error) { notComparable.push(`${parsed.trialId}: ${(error as Error).message}`); }
    } else if (raw.claims != null) notComparable.push(`${parsed.trialId}: undeclared claims.json was supplied without a binding hash`);

    // Attempt accounting is self-declared in trial.json; it is verified only when a bound
    // usage/session artifact reproduces it exactly. Otherwise usage stays unverified.
    if (parsed.usageEvidenceSha256 !== null) {
      if (raw.usage == null) inconclusive.push(`${parsed.trialId}: declared usage evidence is not supplied`);
      else try {
        if (raw.usageSha256 !== parsed.usageEvidenceSha256) throw new Error("usage.json bytes do not match the declared usageEvidenceSha256");
        const evidence = parse(usageSchema, raw.usage, "usage evidence");
        if (canonicalJson(evidence.attempts) !== canonicalJson(parsed.attempts))
          throw new Error("bound usage evidence disagrees with the declared attempt accounting");
        trial.usageVerified = true;
      } catch (error) { notComparable.push(`${parsed.trialId}: ${(error as Error).message}`); }
    } else if (raw.usage != null) notComparable.push(`${parsed.trialId}: undeclared usage.json was supplied without a binding hash`);
  }

  // The two arms' bound payloads may differ only at the registered changed paths.
  if (mode === "CONFIRMATION_2V3" && payloads.champion !== undefined && payloads.candidate !== undefined) {
    try {
      if (canonicalJson(maskAtPaths(payloads.champion, registration.changedPaths, "champion")) !==
          canonicalJson(maskAtPaths(payloads.candidate, registration.changedPaths, "candidate")))
        notComparable.push("bound arm payloads differ outside the registered changedPaths");
    } catch (error) { notComparable.push((error as Error).message); }
  }

  // Expected inventory: every registered case x arm x replicate stays in the denominator.
  const missing: Array<{ caseId: string; arm: Arm; replicate: number }> = [];
  for (const cohortCase of registration.confirmationCohort.cases)
    for (const arm of ARMS)
      for (let replicate = 1; replicate <= ev.replicatesPerCase; replicate++)
        if (!seenKeys.has(`${cohortCase.caseId}${arm}${replicate}`))
          missing.push({ caseId: cohortCase.caseId, arm, replicate });
  if (missing.length > 0)
    inconclusive.push(`${missing.length} registered trial(s) have no supplied measurement: ${missing.map((entry) => `${entry.caseId}/${entry.arm}#${entry.replicate}`).join(", ")}`);

  // Model identity compatibility: one bound route across all trials of both arms.
  // Self-declared reportedId alone never verifies the actual model.
  if (actualModels.size > 1)
    inconclusive.push(`bound snapshots record multiple actual model identities (${[...actualModels].join(", ")}); the actual route is not comparable`);
  if (evaluated.some((entry) => entry.status !== "unresolved" && entry.actualModel === null))
    inconclusive.push("at least one measured trial has no bound snapshot model identity; the actual route is unknown");

  // Aggregate: replicates within case-arm, then paired case differences, then equal-weight clusters.
  const byKey = new Map(evaluated.map((entry) => [`${entry.parsed.caseId}${entry.parsed.arm}${entry.parsed.replicate}`, entry]));
  const caseDiff = new Map<string, number>();
  const unresolvedCases: string[] = [];
  for (const cohortCase of registration.confirmationCohort.cases) {
    const means: Record<Arm, number | null> = { champion: null, candidate: null };
    for (const arm of ARMS) {
      const values: number[] = [];
      let known = true;
      for (let replicate = 1; replicate <= ev.replicatesPerCase; replicate++) {
        const trial = byKey.get(`${cohortCase.caseId}${arm}${replicate}`);
        if (trial === undefined || trial.coverage === null) { known = false; break; }
        values.push(trial.coverage);
      }
      means[arm] = known ? values.reduce((sum, value) => sum + value, 0) / ev.replicatesPerCase : null;
    }
    if (means.champion === null || means.candidate === null) unresolvedCases.push(cohortCase.caseId);
    else caseDiff.set(cohortCase.caseId, means.candidate - means.champion);
  }
  const clusterDiffs: Array<{ clusterId: string; pairedCases: number; registeredCases: number; diff: number | null }> =
    clusterIds.map((clusterId) => {
      const cases = registration.confirmationCohort.cases.filter((entry) => entry.clusterId === clusterId);
      const complete = cases.every((entry) => caseDiff.has(entry.caseId));
      return { clusterId, pairedCases: cases.filter((entry) => caseDiff.has(entry.caseId)).length, registeredCases: cases.length,
        diff: complete ? cases.reduce((sum, entry) => sum + caseDiff.get(entry.caseId)!, 0) / cases.length : null };
    });
  const pairedDiffs = clusterDiffs.flatMap((entry) => entry.diff === null ? [] : [entry.diff]);
  if (unresolvedCases.length > 0)
    inconclusive.push(`cases without a complete paired measurement: ${unresolvedCases.join(", ")}`);
  if (pairedDiffs.length < ev.independentClusterCount)
    inconclusive.push(`only ${pairedDiffs.length} of ${ev.independentClusterCount} registered independent clusters are fully paired`);
  if (pairedDiffs.length < 2)
    inconclusive.push("fewer than two independent clusters are paired; a one-cluster interval would be degenerate");

  // Reliability and usage accounting over every registered trial; all attempts preserved.
  // A dimension absent from the registered measured basis is reported but never "unknown";
  // a measured dimension with missing values is unknown usage, never zero.
  const usageUnknown = (trial: EvaluatedTrial) =>
    trial.usage.unknownAttempts || [...measured].some((dimension) => trial.usage[dimension] === null);
  const armSummary = (arm: Arm) => {
    const trials = evaluated.filter((entry) => entry.parsed.arm === arm);
    const registeredCount = registration.confirmationCohort.cases.length * ev.replicatesPerCase;
    const claims = trials.map((entry) => entry.claims);
    const sum = (pick: (trial: EvaluatedTrial) => number | null) => {
      let total = 0;
      for (const trial of trials) { const value = pick(trial); if (value === null) return null; total += value; }
      return total;
    };
    const completed = trials.filter((entry) => entry.status === "measured" || entry.status === "incomplete").length;
    const unresolved = trials.filter((entry) => entry.status === "unresolved").length;
    const missingCount = registeredCount - trials.length;
    return {
      identity: registration[arm], registeredTrials: registeredCount, suppliedTrials: trials.length,
      completed,
      generationFailed: trials.filter((entry) => entry.status === "generation-failed").length,
      unresolved, missing: missingCount,
      verifiedCriticalErrors: trials.reduce((total, entry) => total + entry.verifiedCritical, 0),
      unresolvedCriticalDisagreement: trials.some((entry) => entry.unresolvedCriticalDisagreement),
      // Unknown is never a verified failure: unresolved or missing trials make reliability unknown.
      reliability: missingCount > 0 || unresolved > 0 ? null : completed / registeredCount,
      claims: claims.every((entry) => entry !== null)
        ? { reviewed: claims.reduce((total, entry) => total + entry!.reviewed, 0), supported: claims.reduce((total, entry) => total + entry!.supported, 0) }
        : null,
      usage: {
        requests: sum((entry) => entry.usage.requests), tokens: sum((entry) => entry.usage.tokens),
        latencyMs: sum((entry) => entry.usage.latencyMs), costUsd: sum((entry) => entry.usage.costUsd),
        unknown: trials.some((entry) => usageUnknown(entry)) || trials.length < registeredCount,
        bound: trials.length === registeredCount && trials.every((entry) => entry.usageVerified),
        attempts: trials.flatMap((entry) => entry.parsed.attempts.map((attempt) => ({ trialId: entry.parsed.trialId, ...attempt }))),
      },
    };
  };
  const arms = { champion: armSummary("champion"), candidate: armSummary("candidate") };

  // Verified fixed constraints (REJECT) evaluated before sufficiency, per the registered decision order.
  const violations: string[] = [];
  const constraints: Record<string, unknown> = {};
  const criticalPass = arms.champion.verifiedCriticalErrors <= ev.criticalErrorsMaximum &&
    arms.candidate.verifiedCriticalErrors <= ev.criticalErrorsMaximum;
  constraints.criticalErrors = {
    champion: arms.champion.verifiedCriticalErrors, candidate: arms.candidate.verifiedCriticalErrors,
    maximum: ev.criticalErrorsMaximum, pass: criticalPass,
  };
  if (!criticalPass)
    violations.push(`verified critical errors exceed the registered maximum of ${ev.criticalErrorsMaximum} (champion ${arms.champion.verifiedCriticalErrors}, candidate ${arms.candidate.verifiedCriticalErrors})`);

  const proportion = (claimsValue: { reviewed: number; supported: number } | null) =>
    claimsValue !== null && claimsValue.reviewed > 0 ? claimsValue.supported / claimsValue.reviewed : null;
  if (ev.claimsSupportedNonInferiorityMargin !== null) {
    const championP = proportion(arms.champion.claims), candidateP = proportion(arms.candidate.claims);
    const pass = championP === null || candidateP === null ? null : candidateP >= championP - ev.claimsSupportedNonInferiorityMargin;
    constraints.claimsSupported = { champion: championP, candidate: candidateP, margin: ev.claimsSupportedNonInferiorityMargin, pass };
    if (pass === false) violations.push("candidate claim support violates the registered noninferiority margin");
    if (pass === null) inconclusive.push("claim support cannot be settled: byte-bound reviewed claim evidence is missing");
  } else constraints.claimsSupported = { declared: false };

  if (ev.reliabilityNonInferiorityMargin !== null) {
    const championR = arms.champion.reliability, candidateR = arms.candidate.reliability;
    const pass = championR === null || candidateR === null ? null : candidateR >= championR - ev.reliabilityNonInferiorityMargin;
    constraints.reliability = { champion: championR, candidate: candidateR, margin: ev.reliabilityNonInferiorityMargin, pass };
    if (pass === false) violations.push("candidate reliability violates the registered noninferiority margin");
    if (pass === null) inconclusive.push("reliability cannot be settled");
  } else constraints.reliability = { declared: false };

  const policy = registration.resourcePolicy;
  const resources: Record<string, unknown> = {};
  const anyUnknownUsage = evaluated.some((entry) => usageUnknown(entry)) || missing.length > 0;
  // Self-declared manifest usage alone cannot verify or violate a registered limit.
  const usageBound = missing.length === 0 && evaluated.length > 0 && evaluated.every((entry) => entry.usageVerified);
  const perTrial = (pick: (usage: EvaluatedTrial["usage"]) => number | null) => {
    let max: number | null = 0;
    for (const trial of evaluated) {
      const value = pick(trial.usage);
      if (value === null) { max = null; continue; }
      if (max !== null && value > max) max = value;
    }
    return max;
  };
  const limitCheck = (name: string, dimension: "requests" | "tokens" | "latencyMs" | "costUsd", limit: number | null, observed: number | null) => {
    if (limit === null) { resources[name] = { declared: false, measured: measured.has(dimension), observed }; return; }
    const pass = observed === null || !usageBound ? null : observed <= limit;
    resources[name] = { limit, observed, pass };
    if (pass === false) violations.push(`${name} exceeded: observed ${observed} over the registered ${limit}`);
    if (pass === null)
      inconclusive.push(`${name} cannot be verified: ${observed === null ? "usage accounting is unknown" : "attempt usage is self-declared without bound source evidence"}`);
  };
  const tokensMax = perTrial((usage) => usage.tokens);
  const callsMax = perTrial((usage) => usage.requests);
  const latencyMax = perTrial((usage) => usage.latencyMs);
  limitCheck("perTrialTokenLimit", "tokens", policy.perTrialTokenLimit, tokensMax);
  limitCheck("perTrialCallLimit", "requests", policy.perTrialCallLimit, callsMax);
  limitCheck("perTrialWallTimeMs", "latencyMs", policy.timeoutSeconds === null ? null : policy.timeoutSeconds * 1000, latencyMax);
  limitCheck("totalTokenLimit", "tokens", policy.totalTokenLimit,
    arms.champion.usage.tokens === null || arms.candidate.usage.tokens === null ? null : arms.champion.usage.tokens + arms.candidate.usage.tokens);
  limitCheck("totalCallLimit", "requests", policy.totalCallLimit,
    arms.champion.usage.requests === null || arms.candidate.usage.requests === null ? null : arms.champion.usage.requests + arms.candidate.usage.requests);
  const meanPerTrial = (arm: Arm, pick: (usage: EvaluatedTrial["usage"]) => number | null) => {
    const trials = evaluated.filter((entry) => entry.parsed.arm === arm);
    if (trials.length === 0) return null;
    let total = 0;
    for (const trial of trials) { const value = pick(trial.usage); if (value === null) return null; total += value; }
    return total / trials.length;
  };
  const relativeIncrease = (pick: (usage: EvaluatedTrial["usage"]) => number | null) => {
    const championMean = meanPerTrial("champion", pick), candidateMean = meanPerTrial("candidate", pick);
    if (championMean === null || candidateMean === null) return null;
    if (championMean === 0) return candidateMean === 0 ? 0 : Number.POSITIVE_INFINITY;
    return (candidateMean - championMean) / championMean;
  };
  limitCheck("costIncreaseLimit", "costUsd", policy.costIncreaseLimit, relativeIncrease((usage) => usage.costUsd));
  limitCheck("latencyIncreaseLimit", "latencyMs", policy.latencyIncreaseLimit, relativeIncrease((usage) => usage.latencyMs));
  constraints.resources = resources;

  // Confirmation evidence: artifact references must be SHA-256 values resolving to supplied
  // bytes; identifiers are identifiers and are required but never hashed.
  if (mode === "CONFIRMATION_2V3") {
    const refHashes = new Map(input.refs.map((ref) => [ref.sha256, ref.name]));
    const missingEvidence: string[] = [];
    const requireArtifact = (name: string, value: string | null) => {
      if (value === null) { missingEvidence.push(`${name} is not registered`); return; }
      if (!HASH.test(value)) { missingEvidence.push(`${name} is not a byte-bindable SHA-256 reference`); return; }
      if (!refHashes.has(value)) missingEvidence.push(`${name} artifact bytes were not supplied`);
    };
    const requireId = (name: string, value: string | null) => {
      if (value === null) missingEvidence.push(`${name} is not registered`);
    };
    requireArtifact("evaluator", ev.evaluatorHash);
    requireArtifact("evaluator qualification", ev.qualificationHash);
    requireArtifact("promotion policy", ev.promotionPolicyHash);
    requireArtifact("holdout lineage", ev.holdoutLineageHash);
    requireArtifact("world completeness receipt", registration.replay.worldCompletenessReceipt);
    requireArtifact("ledger snapshot", registration.replay.ledgerSnapshotHash);
    requireArtifact("calendar snapshot", registration.replay.calendarHash);
    requireArtifact("manual review rubric", ev.manualReview.requiredRubricHash);
    requireArtifact("holdout exposure record", ev.holdoutExposureRecordRef);
    requireArtifact("manual evidence validity review", ev.manualEvidenceValidityReviewRef);
    requireArtifact("A/A calibration evidence", ev.aaCalibrationEvidence);
    requireArtifact("arm order randomization plan", ev.armOrderRandomizationPlan);
    requireId("decision family", ev.decisionFamilyId);
    requireId("holdout cohort", ev.holdoutCohortId);
    if (ev.claimsSupportedNonInferiorityMargin === null) missingEvidence.push("claims noninferiority margin is not registered");
    if (ev.reliabilityNonInferiorityMargin === null) missingEvidence.push("reliability noninferiority margin is not registered");
    if (missingEvidence.length > 0)
      inconclusive.push(`confirmation lacks frozen, byte-bound evidence: ${missingEvidence.join(", ")}`);
  }

  for (const arm of ARMS) {
    if (arms[arm].unresolvedCriticalDisagreement)
      inconclusive.push(`${arm}: unresolved critical disagreement stays INCONCLUSIVE per the registered rule`);
    if (evaluated.some((entry) => entry.parsed.arm === arm && entry.status === "incomplete"))
      inconclusive.push(`${arm}: at least one measurement has unknown verdicts or unadjudicated rows`);
  }
  if (anyUnknownUsage) inconclusive.push("usage accounting is unknown or incomplete; unknown cost is never zero");
  if (evaluated.some((entry) => !entry.usageVerified))
    inconclusive.push("attempt usage is self-declared without bound usage.json source evidence; resource conclusions are unverified");

  // Primary paired interval plus the two treatment slices defined before generation.
  const intervalArgs = [ev.intervalImplementation.seed, ev.intervalImplementation.replicates, ev.alpha] as const;
  const summarize = (diffs: number[]) => ({
    clusters: diffs.length,
    meanDiff: diffs.length === 0 ? null : diffs.reduce((sum, value) => sum + value, 0) / diffs.length,
    interval: diffs.length >= 2 ? pairedClusterBootstrap(diffs, ...intervalArgs) : null,
  });
  const primary = summarize(pairedDiffs);
  const sliceDiffs = (caseIds: string[]) => {
    const set = new Set(caseIds);
    return clusterDiffs.flatMap((entry) => {
      const sliceCases = registration.confirmationCohort.cases.filter((c) => c.clusterId === entry.clusterId && set.has(c.caseId));
      if (sliceCases.length === 0 || sliceCases.some((c) => !caseDiff.has(c.caseId))) return [];
      return [sliceCases.reduce((sum, c) => sum + caseDiff.get(c.caseId)!, 0) / sliceCases.length];
    });
  };
  const slices = {
    withThirdEligibleRow: { cases: ev.treatmentSlices.withThirdEligibleRowCaseIds.length, ...summarize(sliceDiffs(ev.treatmentSlices.withThirdEligibleRowCaseIds)) },
    withoutThirdEligibleRow: { cases: ev.treatmentSlices.withoutThirdEligibleRowCaseIds.length, ...summarize(sliceDiffs(ev.treatmentSlices.withoutThirdEligibleRowCaseIds)) },
  };

  const reasons: string[] = [];
  let decision: ComparisonDecision;
  if (invalid.length > 0) { decision = "INVALID"; reasons.push(...invalid); }
  else if (notComparable.length > 0) { decision = "NOT_COMPARABLE"; reasons.push(...notComparable); }
  else if (violations.length > 0) { decision = "REJECT"; reasons.push(...violations); }
  else if (inconclusive.length > 0) { decision = "INCONCLUSIVE"; reasons.push(...inconclusive); }
  else if (primary.interval === null) { decision = "INCONCLUSIVE"; reasons.push("primary paired interval could not be computed"); }
  else if (primary.interval.lower < ev.minimumPracticalEffect) {
    decision = "NO_CHANGE";
    reasons.push(`paired interval lower bound ${primary.interval.lower} is below the registered minimum practical effect ${ev.minimumPracticalEffect}`);
  } else if (mode === "AA_DIAGNOSTIC") {
    decision = "NO_CHANGE";
    reasons.push("A/A diagnostic output can never authorize confirmation or activation");
  } else {
    decision = "REVIEW_READY";
    reasons.push("all registered requirements and byte-bound evidence hold; awaiting human review, never activation");
  }
  if (mode === "AA_DIAGNOSTIC" && primary.interval !== null)
    reasons.push(`A/A diagnostic estimate ${primary.meanDiff} with interval [${primary.interval.lower}, ${primary.interval.upper}]; its relation to zero is a diagnostic observation only — random sampling produces nonzero estimates and even an interval excluding zero can be an expected false positive, so this alone neither proves nor rules out measurement bias`);

  return {
    schemaVersion: "runtime-comparison-result-v1", decision, mode, reasons,
    assumptions: [
      "Manual review validity, evaluator qualification and holdout lineage are bound only by byte-identical artifacts and registered references; this analysis cannot itself establish semantic truth.",
      `The paired interval is the registered fixed implementation (${INTERVAL_METHOD}); it requires preregistration and calibration and is not automatically scientifically qualified.`,
      "Coverage scores reuse the manual review semantics of the coverage command; unresolved judgment is unknown, never zero or tie.",
      "Model identity is ROUTE_ONLY: the actual route is accepted only from bound snapshot metadata; a self-declared reportedId alone does not verify it and nothing is promoted to a pinned revision.",
      "Attempt usage values are retained as declared; a resource conclusion is verified only against a bound usage.json session artifact, and unmeasured dimensions are reported as unmeasured, never fabricated.",
    ],
    registration: { experimentId: registration.experimentId, sha256: input.registrationSha256 },
    inventory: {
      expectedTrials: registration.confirmationCohort.cases.length * 2 * ev.replicatesPerCase,
      suppliedTrials: evaluated.length, missing,
      cases: registration.confirmationCohort.cases.length, clusters: clusterIds, replicatesPerCase: ev.replicatesPerCase,
    },
    arms,
    primary: {
      metric: "coverage.final", decisionRule: DECISION_RULE, alpha: ev.alpha,
      minimumPracticalEffect: ev.minimumPracticalEffect,
      completeClusters: pairedDiffs.length, clusterDiffs,
      estimate: primary.interval === null ? null : { meanDiff: primary.meanDiff,
        interval: { method: INTERVAL_METHOD, seed: ev.intervalImplementation.seed, replicates: ev.intervalImplementation.replicates,
          lower: primary.interval.lower, upper: primary.interval.upper } },
    },
    slices,
    constraints,
    unresolvedCases,
    provenance: { files: provenance },
  };
}
