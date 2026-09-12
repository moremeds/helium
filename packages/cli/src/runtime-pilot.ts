/** M1 composition: test database -> frozen tenant input -> the existing runner. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { AuditStore, canonicalJson, type LoadedTenant, type Provider } from "@helium/core";
import { RuntimeControl, type ControlConnection } from "@helium/runtime-control";
import { runTenant, type RunReport } from "./runner.js";
import { loadSnapshotRecordings } from "./replay-strict.js";
import { sha256 } from "./tool-io.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

function buildIdentity(tenantDir: string, providerDirs: string[] = []): Record<string, unknown> {
  const artifacts: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js"))
        artifacts.push([relative(repoRoot, path), sha256(readFileSync(path, "utf8"))]);
    }
  };
  for (const dir of ["packages/core/lib", "packages/cli/lib", "plugins/runtime-control/lib"])
    walk(join(repoRoot, dir));
  walk(join(tenantDir, "lib"));
  for (const dir of providerDirs) walk(dir);
  return {
    engineSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    dirtySource: execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() !== "",
    engineArtifactHash: sha256(canonicalJson(artifacts)),
    lockfileHash: sha256(readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8")),
  };
}

/** Trusted composition only: credentials remain inside the provider, not tenant tools. */
export interface RuntimeInference {
  targetId: string;
  identity: Record<string, unknown>;
  artifactDirs: string[];
  create(stateRoot: string): { provider: Provider; summary(): Record<string, unknown> };
}

export async function runRuntimePilot(options: {
  connection: ControlConnection;
  tenant: LoadedTenant;
  pluginsDir: string;
  inputDir: string;
  asOf: Date;
  phase: string;
  inference?: RuntimeInference;
  expectedInputHash?: string;
}): Promise<{ stateRoot: string; attemptId: string; report: RunReport }> {
  if (options.connection.user !== "runtime_control_runner")
    throw new Error("Pilot must use the restricted runner database role");
  if (!Number.isFinite(options.asOf.getTime())) throw new Error("Pilot requires a valid frozen clock");
  const runtime = await import(pathToFileURL(join(options.tenant.dir, "lib/runtime/index.js")).href);
  if (runtime.supportsSnapshotReplay !== true || typeof runtime.parseRuntimeConfig !== "function")
    throw new Error("Tenant has no validated snapshot-pipeline runtime adapter");
  const recordings = loadSnapshotRecordings(options.inputDir);
  if (options.expectedInputHash !== undefined && recordings.inputHash !== options.expectedInputHash)
    throw new Error("Frozen input changed after capture validation");
  const control = new RuntimeControl(options.connection);
  const scope = { tenant: options.tenant.spec.tenant, phase: options.phase, kind: "product", environment: "test" as const };
  const metadata = {
    ...buildIdentity(options.tenant.dir, options.inference?.artifactDirs),
    baseTenantHash: sha256(readFileSync(join(options.tenant.dir, "tenant.yaml"), "utf8")),
    baseTeamHash: sha256(readFileSync(join(options.tenant.dir, options.tenant.spec.team), "utf8")),
    effectiveTenantHash: sha256(canonicalJson({ ...options.tenant.spec, delivery: [] })),
    effectiveTeamHash: sha256(canonicalJson(options.tenant.manifest)),
    inputWorldHash: recordings.inputHash,
    asOf: options.asOf.toISOString(),
    actualModelIdentity: options.inference?.identity ?? "NONE_TOOL_ONLY",
    executionEnvironment: "evaluation",
    deliveryMode: "disabled",
  };
  const snapshot = await control.resolve(scope, metadata);
  const payload = runtime.parseRuntimeConfig(snapshot.resolvedPayload);
  if (canonicalJson(payload) !== canonicalJson(snapshot.resolvedPayload) ||
      payload.tenant !== scope.tenant || payload.phase !== scope.phase)
    throw new Error("Runtime payload and target scope differ");
  // A fresh namespace, never the caller's production state directory.
  const stateRoot = mkdtempSync(join(tmpdir(), "helium-runtime-pilot-"));
  const attemptId = `pilot-${randomUUID()}`;
  recordings.persist(join(stateRoot, "inputs"));
  writeFileSync(join(stateRoot, "snapshot.json"), canonicalJson(snapshot) + "\n", { flag: "wx" });
  const inference = options.inference?.create(stateRoot);
  if (inference && (inference.provider.models.length !== 1 ||
      `${inference.provider.id}:${inference.provider.models[0]!.id}` !== options.inference!.targetId))
    throw new Error("Evaluation provider must expose exactly the registered target");
  const audit = new AuditStore(join(stateRoot, "audit.db"));
  let started = false;
  let report: RunReport | undefined;
  try {
    await control.startAttempt({ attemptId, snapshot, metadata: { stateRoot, inputDir: join(stateRoot, "inputs") } });
    started = true;
    report = await runTenant({
      tenant: { ...options.tenant, spec: { ...options.tenant.spec, delivery: [] } },
      pluginsDir: options.pluginsDir,
      stateRoot,
      audit,
      // Neither ambient service credentials nor database credentials reach tools.
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_DEPLOYMENT: "test", HELIUM_TENANT_DELIVERY: "0" },
      providers: inference ? [inference.provider] : [], channels: [],
      // Preserve normal tenant gates for comparable development output; this is not the independent quality evaluation.
      ...(inference ? { modelPin: options.inference!.targetId } : { gates: [] }),
      phase: options.phase,
      asOf: options.asOf,
      now: () => new Date(options.asOf.getTime()),
      variant: inference ? "runtime-evaluation" : "runtime-mechanism",
      runId: attemptId,
      runtimePilot: { snapshot, recordings, ...(inference ? { inference: true } : {}) },
    });
    const issues = recordings.issues();
    if (issues.length > 0 || report.skipped !== undefined || recordings.served().length === 0) {
      report.outcome = "failed";
      report.failure = { class: "NOT_COMPARABLE", detail: issues.join("; ") || "pilot skipped or consumed no frozen source" };
    }
    if (report.rendererSkipped !== undefined) {
      report.outcome = "failed";
      report.failure = { class: "renderer-failed", detail: report.rendererSkipped.reason };
    }
    const reportBytes = canonicalJson(report);
    writeFileSync(join(stateRoot, "result.json"), reportBytes + "\n", { flag: "wx" });
    const usage = inference?.summary();
    await control.finalizeAttempt({ attemptId, status: inference && usage?.unknown !== false ? "UNKNOWN" : report.outcome === "completed" ? "SUCCEEDED" : "FAILED",
      evidence: { resultHash: sha256(reportBytes), stateRoot, inputWorldHash: recordings.inputHash,
        ...(inference ? { cost: null, auditCost: audit.runCost(attemptId), inference: usage }
          : { cost: audit.runCost(attemptId), modelCalls: 0 }),
        qualityEvaluated: false, issues } });
    return { stateRoot, attemptId, report };
  } catch (error) {
    const usage = inference?.summary();
    const failure = { stateRoot, error: error instanceof Error ? error.message : String(error),
      ...(inference ? { cost: null, auditCost: audit.runCost(attemptId), inference: usage }
        : { cost: audit.runCost(attemptId), modelCalls: 0 }), qualityEvaluated: false };
    writeFileSync(join(stateRoot, "failure.json"), canonicalJson(failure) + "\n");
    // A lost DB acknowledgement is not permission to retry the run. The DB
    // attempt stays RUNNING/UNKNOWN if this terminal write cannot be confirmed.
    try { if (started) await control.finalizeAttempt({ attemptId, status: inference && usage?.unknown !== false ? "UNKNOWN" : "FAILED", evidence: failure }); }
    catch { /* local failure evidence survives; operator must reconcile */ }
    throw new Error(`Runtime pilot failed; evidence: ${stateRoot}`, { cause: error });
  } finally {
    audit.close();
  }
}
