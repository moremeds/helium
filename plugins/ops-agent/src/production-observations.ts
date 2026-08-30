/**
 * Production composition for the six initial application/database adapters.
 *
 * Every source is read through the persisted CommandRunner seam. The probes
 * parse only bounded command output and never source an environment file,
 * interpolate a shell command, or place a credential in argv.
 */
import { isAbsolute, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import type { Observation } from "@helium/core";
import { adaptApex } from "./adapters/apex.js";
import { adaptArgon } from "./adapters/argon.js";
import { adaptColima } from "./adapters/colima.js";
import { adaptHelium } from "./adapters/helium.js";
import { adaptLivewire } from "./adapters/livewire.js";
import { adaptPostgres } from "./adapters/postgres.js";
import type { ObservationProbe } from "./collector.js";
import { checkMountIdentity, diskProbe, parseDf } from "./probes/disk.js";
import {
  processProbe,
  type CommandResult,
  type CommandRunner,
} from "./probes/process.js";

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "expected an absolute path",
});
const PositiveMsSchema = z.number().int().positive().max(7 * 86_400_000);
const LoopbackUrlSchema = z.string().url().refine((value) => {
  const hostname = new URL(value).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}, { message: "observation URL must be loopback" });
const PatternSchema = z.string().min(1).max(200).refine(
  (value) => !value.includes("/") && !value.includes("\0"),
  { message: "backup pattern must be a file-name pattern" },
);
const ExactArgvSchema = z.array(z.string().min(1)).min(1).max(20).superRefine((argv, ctx) => {
  if (!isAbsolute(argv[0] ?? "")) {
    ctx.addIssue({ code: "custom", message: "argv executable must be absolute" });
  }
  if (["/bin/sh", "/bin/bash", "/bin/zsh"].includes(argv[0] ?? "")) {
    ctx.addIssue({ code: "custom", message: "shell executables are forbidden" });
  }
});
const ParquetIntegrityOutputSchema = z.object({
  checked: z.number().int().nonnegative().max(100),
  valid: z.number().int().nonnegative().max(100),
  invalid: z.array(z.object({
    path: AbsolutePathSchema,
    reason: z.string().min(1).max(500),
  }).strict()).max(100),
}).strict();

const DatabaseEndpointSchema = z.object({
  postgresHost: z.string().min(1),
  postgresPort: z.number().int().min(1).max(65_535),
  postgresDatabase: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  postgresUser: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict();

export const ProductionObservationTargetsSchema = z.object({
  version: z.literal(1),
  sampleIntervalMs: PositiveMsSchema,
  ttlMs: PositiveMsSchema,
  host: z.object({
    volumes: z.array(z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      mount: AbsolutePathSchema,
      device: z.string().min(1),
    }).strict()).min(1).max(20),
    processArgv: ExactArgvSchema,
    processMatch: z.string().min(1).max(500),
  }).strict(),
  livewire: z.object({
    statusArgv: ExactArgvSchema,
    integrityFiles: z.array(AbsolutePathSchema).min(1).max(100),
    degradedAfterMs: PositiveMsSchema,
    failedAfterMs: PositiveMsSchema,
  }).strict(),
  argon: z.object({
    healthUrl: LoopbackUrlSchema,
    workerMaxAgeMs: PositiveMsSchema,
    productMaxAgeMs: PositiveMsSchema,
    backupDir: AbsolutePathSchema,
    backupNamePattern: PatternSchema,
    backupMaxAgeMs: PositiveMsSchema,
  }).strict(),
  apex: z.object({
    healthUrl: LoopbackUrlSchema,
    pgIsReadyPath: AbsolutePathSchema,
    ...DatabaseEndpointSchema.shape,
    silverRevisionPath: AbsolutePathSchema,
    dataLakeMount: AbsolutePathSchema,
    dataLakeDevice: z.string().min(1),
    maxLivewireLagDays: z.number().int().nonnegative().max(30),
  }).strict(),
  colima: z.object({
    dockerPath: AbsolutePathSchema,
    socketPath: AbsolutePathSchema,
    expectedContainers: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1).max(200),
  }).strict(),
  postgres: z.object({
    pgIsReadyPath: AbsolutePathSchema,
    psqlPath: AbsolutePathSchema,
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    selectOneFailedAfterMs: PositiveMsSchema,
    connectionDegradedRatio: z.number().positive().max(1),
    connectionFailedRatio: z.number().positive().max(1),
    lockFailedAfterMs: PositiveMsSchema,
    backupDir: AbsolutePathSchema,
    backupNamePattern: PatternSchema,
    backupMaxAgeMs: PositiveMsSchema,
    launchOwnerLabel: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  }).strict(),
  helium: z.object({
    dshLabel: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    deadManLabel: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    heartbeatDir: AbsolutePathSchema,
    deadManLogPath: AbsolutePathSchema,
    globalMaxAgeMs: PositiveMsSchema,
    collectorMaxAgeMs: PositiveMsSchema,
    deadManMaxAgeMs: PositiveMsSchema,
    expectedTenantManifestRef: AbsolutePathSchema,
    expectedTenants: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      maxAgeMs: PositiveMsSchema,
    }).strict()).min(1).max(100),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.livewire.failedAfterMs <= value.livewire.degradedAfterMs) {
    ctx.addIssue({ code: "custom", path: ["livewire", "failedAfterMs"], message: "must exceed degradedAfterMs" });
  }
  if (value.postgres.connectionFailedRatio <= value.postgres.connectionDegradedRatio) {
    ctx.addIssue({ code: "custom", path: ["postgres", "connectionFailedRatio"], message: "must exceed degraded ratio" });
  }
  const tenants = value.helium.expectedTenants.map((tenant) => tenant.id);
  if (new Set(tenants).size !== tenants.length) {
    ctx.addIssue({ code: "custom", path: ["helium", "expectedTenants"], message: "duplicate tenant" });
  }
  if (new Set(value.colima.expectedContainers).size !== value.colima.expectedContainers.length) {
    ctx.addIssue({ code: "custom", path: ["colima", "expectedContainers"], message: "duplicate container" });
  }
  const volumeIds = value.host.volumes.map((volume) => volume.id);
  if (new Set(volumeIds).size !== volumeIds.length) {
    ctx.addIssue({ code: "custom", path: ["host", "volumes"], message: "duplicate volume id" });
  }
  if (new Set(value.livewire.integrityFiles).size !== value.livewire.integrityFiles.length) {
    ctx.addIssue({ code: "custom", path: ["livewire", "integrityFiles"], message: "duplicate integrity file" });
  }
});

export type ProductionObservationTargets = z.infer<typeof ProductionObservationTargetsSchema>;

export interface ProductionObservationRuntime {
  releaseDir: string;
  nodePath: string;
}

export function loadProductionObservationTargets(
  path: string,
): ProductionObservationTargets {
  if (!isAbsolute(path)) throw new Error("observation targets path must be absolute");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 1_000_000) {
    throw new Error("observation targets must be a file no larger than 1 MB");
  }
  const documents = parseAllDocuments(readFileSync(path, "utf8"), {
    strict: true,
    uniqueKeys: true,
  });
  const errors = documents.flatMap((document) => document.errors);
  if (errors.length > 0 || documents.length !== 1 || documents[0]?.contents === null) {
    throw new Error(`invalid observation targets YAML: ${path}`);
  }
  return ProductionObservationTargetsSchema.parse(documents[0]!.toJS());
}

export function createConfiguredHostProbes(
  input: ProductionObservationTargets,
): ObservationProbe[] {
  const targets = ProductionObservationTargetsSchema.parse(input);
  return [
    diskProbe({ componentId: "host", volumes: targets.host.volumes }),
    processProbe({
      componentId: "host",
      probeId: "host.process-liveness.v1",
      argv: targets.host.processArgv,
      match: targets.host.processMatch,
      dimension: "process-liveness",
    }),
  ];
}

export function createProductionObservationProbes(
  input: ProductionObservationTargets,
  runtime: ProductionObservationRuntime,
): ObservationProbe[] {
  const targets = ProductionObservationTargetsSchema.parse(input);
  return createUnpacedProductionObservationProbes(targets, runtime)
    .map((probe) => paceProbe(probe, targets.sampleIntervalMs));
}

/** Fresh, unpaced snapshots used only for action baseline/postcondition checks. */
export function createUnpacedProductionObservationProbes(
  input: ProductionObservationTargets,
  runtime: ProductionObservationRuntime,
): ObservationProbe[] {
  const targets = ProductionObservationTargetsSchema.parse(input);
  if (!isAbsolute(runtime.releaseDir) || !isAbsolute(runtime.nodePath)) {
    throw new Error("production observation runtime paths must be absolute");
  }
  return [
    livewireProbe(targets, runtime),
    argonProbe(targets),
    apexProbe(targets),
    colimaProbe(targets),
    postgresProbe(targets),
    heliumProbe(targets, runtime),
  ];
}

function paceProbe(probe: ObservationProbe, intervalMs: number): ObservationProbe {
  let lastCompletedAt: number | undefined;
  return {
    probeId: probe.probeId,
    async observe(runner, now) {
      if (lastCompletedAt !== undefined && now.getTime() - lastCompletedAt < intervalMs) {
        return [];
      }
      const output = await probe.observe(runner, now);
      lastCompletedAt = now.getTime();
      return output;
    },
  };
}

function context(now: Date, ttlMs: number, sourceVersion: string, results: CommandResult[]) {
  return {
    observedAt: now.toISOString(),
    ttlMs,
    sourceVersion,
    evidenceRefs: results.map((result) => result.evidenceRef),
  };
}

async function persistedRun(
  runner: CommandRunner,
  argv: readonly string[],
  timeoutMs = 10_000,
): Promise<CommandResult> {
  const executable = argv[0];
  if (executable === undefined || !isAbsolute(executable)) {
    throw new Error("production observation command must use an absolute executable");
  }
  if (["/bin/sh", "/bin/bash", "/bin/zsh"].includes(executable)) {
    throw new Error("production observation command cannot use a shell");
  }
  const result = await runner.run(argv, timeoutMs);
  if (result.evidenceRef.length === 0) throw new Error("runner returned no evidence ref");
  return result;
}

function httpArgv(url: string): string[] {
  return [
    "/usr/bin/curl",
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    "--write-out",
    "\n%{http_code}",
    url,
  ];
}

function parseHttpJson(result: CommandResult): { status: number; body: Record<string, unknown> } {
  if (result.timedOut || result.exitCode !== 0) throw new Error("HTTP observation failed");
  const split = result.stdout.lastIndexOf("\n");
  if (split < 0) throw new Error("HTTP observation omitted status");
  const status = Number(result.stdout.slice(split + 1).trim());
  if (!Number.isInteger(status)) throw new Error("invalid HTTP status");
  const parsed = JSON.parse(result.stdout.slice(0, split)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HTTP observation body is not an object");
  }
  return { status, body: parsed as Record<string, unknown> };
}

function parseParquetIntegrity(
  result: CommandResult,
  expectedFiles: readonly string[],
): { valid?: boolean; error?: string } {
  if (result.timedOut || result.exitCode !== 0) {
    return { valid: undefined, error: "integrity checker unavailable" };
  }
  try {
    const parsed = ParquetIntegrityOutputSchema.parse(JSON.parse(result.stdout));
    if (
      parsed.checked !== expectedFiles.length ||
      parsed.valid + parsed.invalid.length !== parsed.checked ||
      parsed.invalid.some((row) => !expectedFiles.includes(row.path))
    ) {
      return { valid: undefined, error: "integrity checker scope mismatch" };
    }
    return parsed.invalid.length === 0
      ? { valid: true }
      : {
          valid: false,
          error: parsed.invalid.map((row) => `${row.path}: ${row.reason}`).join("; "),
        };
  } catch {
    return { valid: undefined, error: "invalid integrity checker output" };
  }
}

function livewireProbe(
  targets: ProductionObservationTargets,
  runtime: ProductionObservationRuntime,
): ObservationProbe {
  return {
    probeId: "livewire.production-snapshot.v1",
    async observe(runner, now) {
      const statusResult = await persistedRun(runner, targets.livewire.statusArgv, 15_000);
      if (statusResult.timedOut || statusResult.exitCode !== 0) {
        throw new Error("livewire status command failed");
      }
      const text = statusResult.stdout;
      const integrityResult = await persistedRun(runner, [
        targets.livewire.statusArgv[0]!,
        resolve(runtime.releaseDir, "scripts/ops/check-parquet-integrity.py"),
        ...targets.livewire.integrityFiles.flatMap((path) => ["--path", path]),
      ], 30_000);
      const integrity = parseParquetIntegrity(integrityResult, targets.livewire.integrityFiles);
      const found = /^Livewire status\s*$/m.test(text);
      const measuredState = !found
        ? "unknown"
        : text.includes("[BAD ]")
          ? "failed"
          : text.includes("[WARN]")
            ? "degraded"
            : text.includes("[?? ]")
              ? "unknown"
              : "ok";
      const coverage = /\b(\d{4}-\d{2}-\d{2}) coverage:([^\n]*)/.exec(text);
      const ratios = [...(coverage?.[2] ?? "").matchAll(/\b(?:1m|5m|30m|1h)=\d+\/\d+ \(([0-9.]+)%\)/g)]
        .map((match) => Number(match[1]) / 100)
        .filter(Number.isFinite);
      const coverageAt = coverage?.[1] === undefined
        ? undefined
        : `${coverage[1]}T23:59:59.999Z`;
      return adaptLivewire({
        ...context(now, targets.ttlMs, "livewire-status+parquet-footer/1", [
          statusResult,
          integrityResult,
        ]),
        status: {
          found,
          state: measuredState,
          ...(coverageAt === undefined ? {} : { coverageAt }),
          ...(ratios.length === 0 ? {} : { intradayCoverage: Math.min(...ratios) }),
        },
        sourceLogs: {},
        parquet: integrity,
        ibAvailable: /\bIB down\b/i.test(text) ? false : undefined,
        expectedCoverageAt: now.toISOString(),
        freshness: {
          degradedAfterMs: targets.livewire.degradedAfterMs,
          failedAfterMs: targets.livewire.failedAfterMs,
        },
      });
    },
  };
}

interface BackupReading {
  result: CommandResult;
  createdAt?: string;
  size: number;
  path?: string;
}

async function newestBackup(
  runner: CommandRunner,
  dir: string,
  pattern: string,
): Promise<BackupReading> {
  const result = await persistedRun(runner, [
    "/usr/bin/find",
    dir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    pattern,
    "-exec",
    "/usr/bin/stat",
    "-f",
    "%m|%z|%Su|%Sp|%N",
    "{}",
    "+",
  ], 20_000);
  if (result.timedOut || result.exitCode !== 0) return { result, size: 0 };
  const rows = result.stdout.split("\n").flatMap((line) => {
    const parts = line.split("|");
    const epoch = Number(parts[0]);
    const size = Number(parts[1]);
    const path = parts.slice(4).join("|");
    return Number.isFinite(epoch) && Number.isFinite(size) && path !== ""
      ? [{ epoch, size, path }]
      : [];
  });
  rows.sort((a, b) => b.epoch - a.epoch);
  const latest = rows[0];
  return latest === undefined
    ? { result, size: 0 }
    : {
        result,
        createdAt: new Date(latest.epoch * 1000).toISOString(),
        size: latest.size,
        path: latest.path,
      };
}

function argonProbe(targets: ProductionObservationTargets): ObservationProbe {
  return {
    probeId: "argon.production-snapshot.v1",
    async observe(runner, now) {
      const healthResult = await persistedRun(runner, httpArgv(targets.argon.healthUrl));
      const health = parseHttpJson(healthResult);
      const backup = await newestBackup(
        runner,
        targets.argon.backupDir,
        targets.argon.backupNamePattern,
      );
      const workers = Array.isArray(health.body.workers)
        ? health.body.workers as Record<string, unknown>[]
        : [];
      const beats = workers
        .map((worker) => worker.last_beat_at)
        .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const workerLags = workers
        .map((worker) => numericValue(worker.lag_seconds))
        .filter((value): value is number => value !== undefined && value >= 0);
      const workerAgeMs = workers.length > 0 && workerLags.length === workers.length
        ? Math.max(...workerLags) * 1000
        : undefined;
      const freshness = objectValue(health.body.freshness);
      const asOf = typeof freshness?.as_of === "string" ? freshness.as_of : undefined;
      return adaptArgon({
        ...context(now, targets.ttlMs, "argon-health/1", [healthResult, backup.result]),
        api: {
          httpStatus: health.status,
          bodyOk: typeof health.body.ok === "boolean" ? health.body.ok : undefined,
        },
        database: { ready: health.body.db === "up" },
        worker: {
          heartbeatAt: beats[0],
          ...(workerAgeMs === undefined ? {} : { heartbeatAgeMs: workerAgeMs }),
          maxAgeMs: targets.argon.workerMaxAgeMs,
        },
        product: {
          freshAt: /^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "") ? `${asOf}T23:59:59.999Z` : undefined,
          maxAgeMs: targets.argon.productMaxAgeMs,
        },
        backup: {
          createdAt: backup.createdAt,
          maxAgeMs: targets.argon.backupMaxAgeMs,
        },
      });
    },
  };
}

function databaseReadyArgv(
  path: string,
  endpoint: { postgresHost: string; postgresPort: number; postgresDatabase: string; postgresUser: string },
): string[] {
  return [
    path,
    "--quiet",
    "-h",
    endpoint.postgresHost,
    "-p",
    String(endpoint.postgresPort),
    "-d",
    endpoint.postgresDatabase,
    "-U",
    endpoint.postgresUser,
  ];
}

function apexProbe(targets: ProductionObservationTargets): ObservationProbe {
  return {
    probeId: "apex.production-snapshot.v1",
    async observe(runner, now) {
      const healthResult = await persistedRun(runner, httpArgv(targets.apex.healthUrl));
      const health = parseHttpJson(healthResult);
      const readyResult = await persistedRun(runner, databaseReadyArgv(targets.apex.pgIsReadyPath, targets.apex));
      const revisionResult = await persistedRun(runner, [
        "/usr/bin/grep",
        "-Eo",
        '"revision"[[:space:]]*:[[:space:]]*[0-9]+',
        targets.apex.silverRevisionPath,
      ], 10_000);
      const mountResult = await persistedRun(runner, ["/bin/df", "-kP", targets.apex.dataLakeMount]);
      const revision = Number(/([0-9]+)\s*$/.exec(revisionResult.stdout.trim())?.[1]);
      const silver = objectValue(health.body.silver_revision);
      const observed = numericValue(silver?.observed_revision);
      const applied = numericValue(silver?.last_fully_applied_revision);
      const livewire = objectValue(health.body.livewire);
      const recency = objectValue(livewire?.recency);
      const lagDays = numericValue(recency?.lag_days);
      const volumes = mountResult.exitCode === 0 && !mountResult.timedOut
        ? parseDf(mountResult.stdout)
        : undefined;
      const mountVerified = volumes === undefined
        ? false
        : checkMountIdentity(volumes, [{
            mount: targets.apex.dataLakeMount,
            device: targets.apex.dataLakeDevice,
          }])[0]?.ok === true;
      const revisionVerified =
        revisionResult.exitCode === 0 && Number.isFinite(revision) && observed !== undefined && applied !== undefined;
      return adaptApex({
        ...context(now, targets.ttlMs, "apex-health/1", [
          healthResult,
          readyResult,
          revisionResult,
          mountResult,
        ]),
        api: { httpStatus: health.status, bodyOk: health.body.status === "ok" },
        postgres: {
          reportedHealthy: health.body.pg_connected === true,
          independentlyVerified:
            readyResult.exitCode === 0 && !readyResult.timedOut,
        },
        livewire: {
          reportedRevisionMatches:
            revisionVerified && observed === applied && applied === revision,
          reportedRecencyHealthy:
            lagDays !== undefined && lagDays <= targets.apex.maxLivewireLagDays,
          independentlyVerified: revisionVerified,
        },
        mount: {
          reportedAvailable: livewire?.configured === true,
          independentlyVerified: mountVerified,
        },
      });
    },
  };
}

function colimaProbe(targets: ProductionObservationTargets): ObservationProbe {
  return {
    probeId: "colima.production-snapshot.v1",
    async observe(runner, now) {
      const socketResult = await persistedRun(runner, [
        "/usr/bin/stat",
        "-f",
        "%Sp|%N",
        targets.colima.socketPath,
      ]);
      const infoResult = await persistedRun(runner, [
        targets.colima.dockerPath,
        "info",
        "--format",
        '{"Name":{{json .Name}},"ServerVersion":{{json .ServerVersion}}}',
      ]);
      const inventoryResult = await persistedRun(runner, [
        targets.colima.dockerPath,
        "ps",
        "--no-trunc",
        "--format",
        "{{json .Names}}",
      ]);
      const names = inventoryResult.stdout.split("\n").flatMap((line) => {
        try {
          const name = JSON.parse(line) as unknown;
          return typeof name === "string" && /^[A-Za-z0-9_.-]+$/.test(name)
            ? [name]
            : [];
        } catch {
          return [];
        }
      });
      const inspectResult = names.length === 0
        ? undefined
        : await persistedRun(runner, [
            targets.colima.dockerPath,
            "inspect",
            "--format",
            "{{json .Name}}|{{.RestartCount}}|{{.State.OOMKilled}}",
            ...names,
          ]);
      const inspected = new Map<string, { restartCount: number; oomKilled: boolean }>();
      for (const line of inspectResult?.stdout.split("\n") ?? []) {
        const [rawName, rawRestarts, rawOom] = line.split("|");
        try {
          const name = String(JSON.parse(rawName ?? "")).replace(/^\//, "");
          const restartCount = Number(rawRestarts);
          if (/^[A-Za-z0-9_.-]+$/.test(name) && Number.isInteger(restartCount)) {
            inspected.set(name, { restartCount, oomKilled: rawOom === "true" });
          }
        } catch {
          // One malformed container row is omitted; the expected inventory then fails.
        }
      }
      let info: Record<string, unknown> | undefined;
      try {
        info = objectValue(JSON.parse(infoResult.stdout));
      } catch {
        info = undefined;
      }
      const results = [socketResult, infoResult, inventoryResult, ...(inspectResult === undefined ? [] : [inspectResult])];
      return adaptColima({
        ...context(now, targets.ttlMs, "docker-readonly/1", results),
        hostSocketAvailable:
          socketResult.exitCode === 0 && !socketResult.timedOut && /^s/.test(socketResult.stdout),
        guestRuntimeReady: infoResult.exitCode === 0 && !infoResult.timedOut && info !== undefined,
        vmState: info?.Name === "colima" ? "running" : "unknown",
        expectedContainers: targets.colima.expectedContainers,
        containers: names.map((name) => ({
          name,
          restartCount: inspected.get(name)?.restartCount ?? 0,
          oomKilled: inspected.get(name)?.oomKilled ?? false,
        })),
      });
    },
  };
}

const SELECT_ONE_SQL = "BEGIN READ ONLY; SET LOCAL statement_timeout = '2s'; SELECT 1; COMMIT;";
const POSTGRES_STATS_SQL = [
  "BEGIN READ ONLY;",
  "SET LOCAL statement_timeout = '2s';",
  "SELECT json_build_object(",
  "'used', (SELECT count(*) FROM pg_stat_activity),",
  "'max', current_setting('max_connections')::int,",
  "'blocked', (SELECT count(*) FROM pg_locks WHERE NOT granted),",
  "'oldest_ms', COALESCE((SELECT EXTRACT(EPOCH FROM (clock_timestamp()-MIN(query_start)))*1000 FROM pg_stat_activity WHERE wait_event IS NOT NULL), 0),",
  "'bytes', (SELECT sum(pg_database_size(datname)) FROM pg_database));",
  "COMMIT;",
].join(" ");

function postgresProbe(targets: ProductionObservationTargets): ObservationProbe {
  let previousDatabase: { bytes: number; at: number } | undefined;
  return {
    probeId: "postgres.production-snapshot.v1",
    async observe(runner, now) {
      const postgres = targets.postgres;
      const readyResult = await persistedRun(runner, [
        postgres.pgIsReadyPath,
        "--quiet",
        "-h",
        postgres.host,
        "-p",
        String(postgres.port),
        "-d",
        postgres.database,
        "-U",
        postgres.user,
      ]);
      const psqlBase = [
        postgres.psqlPath,
        "-X",
        "-w",
        "-h",
        postgres.host,
        "-p",
        String(postgres.port),
        "-U",
        postgres.user,
        "-d",
        postgres.database,
        "-At",
        "-c",
      ];
      const started = performance.now();
      const selectResult = await persistedRun(runner, [...psqlBase, SELECT_ONE_SQL]);
      const latencyMs = Math.max(0, performance.now() - started);
      const statsResult = await persistedRun(runner, [...psqlBase, POSTGRES_STATS_SQL]);
      const backup = await newestBackup(runner, postgres.backupDir, postgres.backupNamePattern);
      const ownerResult = await persistedRun(runner, [
        "/bin/launchctl",
        "print",
        `gui/${process.getuid?.() ?? 501}/${postgres.launchOwnerLabel}`,
      ]);
      const statsLine = statsResult.stdout.split("\n").find((line) => line.trim().startsWith("{"));
      let stats: Record<string, unknown> = {};
      try {
        stats = objectValue(JSON.parse(statsLine ?? "{}")) ?? {};
      } catch {
        stats = {};
      }
      const bytes = numericValue(stats.bytes) ?? 0;
      const intervalMs = previousDatabase === undefined ? 0 : now.getTime() - previousDatabase.at;
      const deltaBytes = previousDatabase === undefined ? 0 : bytes - previousDatabase.bytes;
      if (bytes > 0) previousDatabase = { bytes, at: now.getTime() };
      return adaptPostgres({
        ...context(now, targets.ttlMs, "postgres-readonly/1", [
          readyResult,
          selectResult,
          statsResult,
          backup.result,
          ownerResult,
        ]),
        isReady: readyResult.exitCode === 0 && !readyResult.timedOut,
        selectOne: {
          ok: selectResult.exitCode === 0 && !selectResult.timedOut && /^1$/m.test(selectResult.stdout),
          latencyMs,
          failedAfterMs: postgres.selectOneFailedAfterMs,
        },
        connections: {
          used: numericValue(stats.used) ?? 0,
          max: numericValue(stats.max) ?? 0,
          degradedRatio: postgres.connectionDegradedRatio,
          failedRatio: postgres.connectionFailedRatio,
        },
        locks: {
          blockedCount: numericValue(stats.blocked) ?? 0,
          oldestMs: numericValue(stats.oldest_ms) ?? 0,
          failedAfterMs: postgres.lockFailedAfterMs,
        },
        database: { bytes, deltaBytes, intervalMs },
        backup: {
          createdAt: backup.createdAt,
          maxAgeMs: postgres.backupMaxAgeMs,
          metadataValid: backup.path !== undefined && backup.size > 0,
          integrityTier: "unchecked",
        },
        launchOwnership: {
          expectedOwner: postgres.launchOwnerLabel,
          ...(ownerResult.exitCode === 0 && !ownerResult.timedOut
            ? { actualOwner: postgres.launchOwnerLabel }
            : {}),
        },
      });
    },
  };
}

function heliumProbe(
  targets: ProductionObservationTargets,
  runtime: ProductionObservationRuntime,
): ObservationProbe {
  return {
    probeId: "helium.production-snapshot.v1",
    async observe(runner, now) {
      const helium = targets.helium;
      const dshResult = await persistedRun(runner, [
        "/bin/launchctl",
        "print",
        `gui/${process.getuid?.() ?? 501}/${helium.dshLabel}`,
      ]);
      const deadManResult = await persistedRun(runner, [
        "/bin/launchctl",
        "print",
        `gui/${process.getuid?.() ?? 501}/${helium.deadManLabel}`,
      ]);
      const heartbeatResult = await persistedRun(runner, [
        runtime.nodePath,
        resolve(runtime.releaseDir, "scripts/ops/read-latest-heartbeats.mjs"),
        helium.heartbeatDir,
        ...helium.expectedTenants.map((tenant) => tenant.id),
      ]);
      const deadManLogResult = await persistedRun(runner, [
        "/usr/bin/stat",
        "-f",
        "%m|%z|%N",
        helium.deadManLogPath,
      ]);
      const rows = heartbeatResult.stdout.split("\n").flatMap((line) => {
        try {
          const row = JSON.parse(line) as { ts?: unknown; job?: unknown };
          return typeof row.ts === "string" && Number.isFinite(Date.parse(row.ts)) && typeof row.job === "string"
            ? [{ ts: row.ts, job: row.job }]
            : [];
        } catch {
          return [];
        }
      });
      rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      const tenantHeartbeats = Object.fromEntries(
        helium.expectedTenants.flatMap((tenant) => {
          const found = rows.find((row) => row.job === tenant.id);
          return found === undefined ? [] : [[tenant.id, found.ts]];
        }),
      );
      const deadManEpoch = Number(deadManLogResult.stdout.split("|")[0]);
      return adaptHelium({
        ...context(now, targets.ttlMs, "helium-heartbeat/1", [
          dshResult,
          deadManResult,
          heartbeatResult,
          deadManLogResult,
        ]),
        processRunning: dshResult.exitCode === 0 && !dshResult.timedOut,
        globalHeartbeat: { at: rows[0]?.ts, maxAgeMs: helium.globalMaxAgeMs },
        expectedTenantManifestRef: helium.expectedTenantManifestRef,
        expectedTenants: helium.expectedTenants.map((tenant) => tenant.id),
        tenantHeartbeats,
        tenantMaxAgeMs: helium.globalMaxAgeMs,
        tenantMaxAgeMsByTenant: Object.fromEntries(
          helium.expectedTenants.map((tenant) => [tenant.id, tenant.maxAgeMs]),
        ),
        collectorHeartbeat: { at: rows[0]?.ts, maxAgeMs: helium.collectorMaxAgeMs },
        deadMan: {
          armed: deadManResult.exitCode === 0 && !deadManResult.timedOut,
          at: Number.isFinite(deadManEpoch) ? new Date(deadManEpoch * 1000).toISOString() : undefined,
          maxAgeMs: helium.deadManMaxAgeMs,
        },
      });
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numericValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export type ProductionObservation = Observation;
