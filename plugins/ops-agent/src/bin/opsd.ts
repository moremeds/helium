#!/usr/bin/env node
/**
 * Standalone deterministic operations daemon composition.
 *
 * DSH and model providers are deliberately absent from this module. An
 * optional analysis client receives completed tick snapshots after the
 * authoritative deterministic path has finished; its failure is reported and
 * cannot fail collection, correlation, policy, execution, or verification.
 */
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ActionLeaseController,
  ActionLeaseTable,
  OperationsStore,
  type PostconditionSample,
} from "@helium/core";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  ApprovalLedger,
  FileOperatorEnvelopeStore,
  OperatorEnvelopeVerifier,
} from "../approval.js";
import { DurableOpsAnalysisClient } from "../analysis-client.js";
import { OpsBundleLoader } from "../bundle-loader.js";
import { Collector, type ObservationProbe } from "../collector.js";
import {
  FileComponentActionLocks,
  hostBootId,
} from "../component-action-lock.js";
import { OpsConfigSchema } from "../config.js";
import {
  OpsController,
  type ControllerTickResult,
  type OpsControllerOptions,
} from "../controller.js";
import type { OpsControlServer } from "../ipc.js";
import { OpsControlServer as UnixOpsControlServer } from "../ipc.js";
import { macosResourceProbe } from "../probes/macos-resource.js";
import { FileRecoveryEvidenceStore } from "../recovery-evidence-store.js";
import { ScriptRegistry } from "../script-registry.js";
import type { CommandResult, CommandRunner } from "../probes/process.js";

export interface OpsDaemonController<T> {
  tick(signal?: AbortSignal): Promise<T>;
}

export interface OpsDaemonControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OpsAnalysisClient<T = ControllerTickResult> {
  publish(snapshot: T): Promise<void>;
}

export interface OpsDaemonOptions<T> {
  controller: OpsDaemonController<T>;
  control: OpsDaemonControl;
  analysis?: OpsAnalysisClient<T>;
  intervalMs: number;
  onError?: (error: Error) => void;
  onTickSuccess?: (snapshot: T) => void | Promise<void>;
}

/** Owns the daemon lifecycle and serializes deterministic ticks. */
export class OpsDaemon<T = ControllerTickResult> {
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<T> | undefined;
  #abort: AbortController | undefined;
  #started = false;

  constructor(private readonly options: OpsDaemonOptions<T>) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("opsd interval must be a positive integer");
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("opsd already started");
    this.#started = true;
    this.#abort = new AbortController();
    try {
      await this.options.control.start();
      await this.tickOnce();
      this.#timer = setInterval(() => {
        void this.tickOnce().catch((error: unknown) => this.#report(error));
      }, this.options.intervalMs);
      this.#timer.unref();
    } catch (error) {
      this.#started = false;
      this.#abort.abort();
      this.#abort = undefined;
      await this.options.control.stop().catch((stopError: unknown) => {
        this.#report(stopError);
      });
      throw error;
    }
  }

  async tickOnce(): Promise<T> {
    if (!this.#started || this.#abort === undefined) {
      throw new Error("opsd is not started");
    }
    if (this.#inFlight !== undefined) return await this.#inFlight;

    const run = this.options.controller.tick(this.#abort.signal).then(
      async (snapshot) => {
        await this.options.onTickSuccess?.(snapshot);
        if (this.options.analysis !== undefined) {
          await this.options.analysis.publish(snapshot).catch((error: unknown) => {
            this.#report(error);
          });
        }
        return snapshot;
      },
    );
    this.#inFlight = run;
    try {
      return await run;
    } finally {
      if (this.#inFlight === run) this.#inFlight = undefined;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
    await this.#inFlight?.catch((error: unknown) => this.#report(error));
    this.#inFlight = undefined;
    await this.options.control.stop();
  }

  #report(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error("unknown opsd failure"),
    );
  }
}

export interface StandaloneOpsDaemonOptions
  extends Omit<OpsControllerOptions, "collect"> {
  probes: readonly ObservationProbe[];
  runner: CommandRunner;
  control: OpsControlServer;
  analysis?: OpsAnalysisClient;
  intervalMs: number;
  onError?: (error: Error) => void;
  runtimeReleaseRef?: string;
}

/**
 * The production composition boundary: one controller owns one collector and
 * one control server. Every concrete probe and executor is injected; no DSH or
 * provider package participates in this graph.
 */
export function createStandaloneOpsDaemon(
  options: StandaloneOpsDaemonOptions,
): OpsDaemon {
  const {
    probes,
    runner,
    control,
    analysis,
    intervalMs,
    onError,
    runtimeReleaseRef,
    ...controllerOptions
  } = options;
  const controller = new OpsController({
    ...controllerOptions,
    collect: async (sink) =>
      await new Collector({
        probes,
        runner,
        sink,
        now: controllerOptions.now,
      }).collectOnce(),
  });
  const supervisedAnalysis = analysis === undefined
    ? undefined
    : new DurableOpsAnalysisClient({
        analysisId: "optional-team-analysis",
        delegate: analysis,
        store: controllerOptions.store,
        now: controllerOptions.now,
      });
  return new OpsDaemon({
    controller,
    control,
    ...(supervisedAnalysis === undefined ? {} : { analysis: supervisedAnalysis }),
    intervalMs,
    ...(runtimeReleaseRef === undefined
      ? {}
      : {
          onTickSuccess: (snapshot: ControllerTickResult) => {
            controllerOptions.store.append({
              v: 1,
              id: `evt-controller-cycle-${randomUUID()}`,
              at: controllerOptions.now().toISOString(),
              type: "controller-cycle-recorded",
              controllerId: "com.helium.opsd",
              releaseRef: runtimeReleaseRef,
              observationCount: snapshot.observations.length,
              collectionFailureCount: snapshot.collectionFailures.length,
            });
          },
        }),
    ...(onError === undefined ? {} : { onError }),
  });
}

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "expected an absolute path",
});
const UnixSocketPathSchema = AbsolutePathSchema.refine(
  (path) => Buffer.byteLength(path) <= 103,
  { message: "Unix socket path exceeds the macOS 103-byte limit" },
);

/** The packaged executable is deliberately observe-only. */
export const OpsdRuntimeConfigSchema = OpsConfigSchema.extend({
  version: z.literal(1),
  mode: z.literal("observe"),
  releaseDir: AbsolutePathSchema,
  executorsDir: z.string().min(1),
  stateDir: AbsolutePathSchema,
  socketPath: UnixSocketPathSchema,
  intervalMs: z.number().int().positive().max(86_400_000),
}).strict();
export type OpsdRuntimeConfig = z.infer<typeof OpsdRuntimeConfigSchema>;

export function parseOpsdArgs(argv: readonly string[]): { configPath: string } {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== "--config") throw new Error(`unknown opsd argument: ${arg}`);
    if (configPath !== undefined) throw new Error("duplicate opsd --config");
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("opsd --config requires a path");
    }
    configPath = value;
    i += 1;
  }
  if (configPath === undefined) throw new Error("opsd requires --config");
  if (!isAbsolute(configPath)) throw new Error("opsd config path must be absolute");
  return { configPath };
}

export function loadOpsdRuntimeConfig(path: string): OpsdRuntimeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read opsd config ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  return OpsdRuntimeConfigSchema.parse(raw);
}

export function validateOpsdRelease(
  config: OpsdRuntimeConfig,
  releaseDir = config.releaseDir,
): void {
  const rebase = (path: string) =>
    path === config.releaseDir
      ? releaseDir
      : path.startsWith(`${config.releaseDir}/`)
        ? `${releaseDir}${path.slice(config.releaseDir.length)}`
        : path;
  const parsed = OpsdRuntimeConfigSchema.parse({
    ...config,
    releaseDir,
    authorityManifestPath: rebase(config.authorityManifestPath),
    trustedKeyPath: rebase(config.trustedKeyPath),
  });
  const registeredProbeIds = discoverConfiguredProbeIds(parsed);
  const loader = new OpsBundleLoader({
    baseDir: parsed.releaseDir,
    config: loaderConfig(parsed),
    registeredProbeIds,
    now: () => new Date(),
  });
  const installed = loader.installTenant("standalone-host", parsed.releaseDir);
  if (installed.health.state !== "loaded") {
    throw new Error(`ops bundle invalid: ${installed.health.detail ?? "unknown error"}`);
  }
  ScriptRegistry.load(loadConfiguredDocuments(parsed, parsed.executorsDir, "executor"));
  createPublicKey(readFileSync(parsed.trustedKeyPath, "utf8"));
}

interface ObserveCompositionOverrides {
  runner?: CommandRunner;
  probes?: readonly ObservationProbe[];
  now?: () => Date;
}

/**
 * Concrete provider-free observe-only composition used by the launchd binary.
 * Unsupported business checks are registered as unavailable and therefore
 * evaluate to `unknown`; they can never manufacture a passing precondition.
 */
export function composeObserveOnlyOpsDaemon(
  config: OpsdRuntimeConfig,
  overrides: ObserveCompositionOverrides = {},
): OpsDaemon {
  const parsed = OpsdRuntimeConfigSchema.parse(config);
  const now = overrides.now ?? (() => new Date());
  mkdirSync(parsed.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(parsed.socketPath), { recursive: true, mode: 0o700 });

  const registeredProbeIds = discoverConfiguredProbeIds(parsed);
  const loader = new OpsBundleLoader({
    baseDir: parsed.releaseDir,
    config: loaderConfig(parsed),
    registeredProbeIds,
    now,
  });
  const installed = loader.installTenant("standalone-host", parsed.releaseDir);
  if (installed.health.state !== "loaded") {
    throw new Error(`ops bundle invalid: ${installed.health.detail ?? "unknown error"}`);
  }

  const trustedKey = createPublicKey(readFileSync(parsed.trustedKeyPath, "utf8"));
  const evidence = new FileRecoveryEvidenceStore(resolve(parsed.stateDir, "evidence"));
  const store = OperationsStore.open(parsed.stateDir, {
    validateEvent: (event) => evidence.verifyEvent(event),
  });
  const operatorPersistence = new FileOperatorEnvelopeStore(
    resolve(parsed.stateDir, "operator-envelopes"),
  );
  const approvals = new ApprovalLedger({
    trustedKey,
    now,
    persistence: operatorPersistence,
  });
  const interventions = new OperatorEnvelopeVerifier({
    trustedKey,
    now,
    persistence: operatorPersistence,
  });
  const control = new UnixOpsControlServer({
    socketPath: parsed.socketPath,
    approvals,
    interventions,
    store,
    now,
  });
  const runner = overrides.runner ??
    new PersistingCommandRunner(resolve(parsed.stateDir, "raw"), now);
  const probes = overrides.probes ?? [macosResourceProbe({ componentId: "host" })];
  const leases = new ActionLeaseController(new ActionLeaseTable(), {
    controllerId: "com.helium.opsd",
    ttlMs: Math.max(parsed.intervalMs * 2, 120_000),
    now,
  });

  return createStandaloneOpsDaemon({
    mode: "observe",
    registry: loader.registry,
    store,
    now,
    runChecks: async (ids) =>
      Object.fromEntries(ids.map((id) => [id, "unknown" as const])),
    sampleChecks: async (ids, phase) => unavailableSamples(ids, phase, now()),
    controllerProbe: {
      async check() {
        return {
          result: "unknown",
          observedLabels: [],
          evidenceRef: "artifact://ops/controller/not-enumerated-in-observe-mode",
          detail: "observe-only-runtime",
        };
      },
    },
    leases,
    componentLocks: new FileComponentActionLocks({
      dir: resolve(parsed.stateDir, "component-locks"),
      bootId: hostBootId(),
    }),
    approvals,
    evidence,
    createExecutor: () => ({
      async run() {
        throw new Error("observe-only runtime has no executor");
      },
    }),
    argvFor: () => [],
    probes,
    runner,
    control,
    intervalMs: parsed.intervalMs,
    onError: (error) => writeBoundedOpsLog("err", error.message),
    runtimeReleaseRef: realpathSync(parsed.releaseDir),
  });
}

function loaderConfig(config: OpsdRuntimeConfig): z.input<typeof OpsConfigSchema> {
  return {
    componentsDir: config.componentsDir,
    dependenciesDir: config.dependenciesDir,
    sopsDir: config.sopsDir,
    checksDir: config.checksDir,
    authorityManifestPath: config.authorityManifestPath,
    trustedKeyPath: config.trustedKeyPath,
    maxFiles: config.maxFiles,
    maxComponents: config.maxComponents,
    maxSops: config.maxSops,
    maxChecks: config.maxChecks,
    maxFileBytes: config.maxFileBytes,
  };
}

function configuredDir(releaseDir: string, configured: string): string {
  return isAbsolute(configured) ? configured : resolve(releaseDir, configured);
}

function loadConfiguredDocuments(
  config: OpsdRuntimeConfig,
  configured: string,
  label: string,
): unknown[] {
  const dir = configuredDir(config.releaseDir, configured);
  const names = readdirSync(dir)
    .filter((name) => /\.(?:ya?ml|json)$/i.test(name))
    .sort();
  if (names.length > config.maxFiles) throw new Error(`${label} file limit exceeded`);
  return names.flatMap((name) => {
    const path = resolve(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`);
    if (stat.size > config.maxFileBytes) {
      throw new Error(`${label} file byte limit exceeded: ${path}`);
    }
    if (/\.json$/i.test(name)) return [JSON.parse(readFileSync(path, "utf8"))];
    const documents = parseAllDocuments(readFileSync(path, "utf8"), {
      strict: true,
      uniqueKeys: true,
    });
    const errors = documents.flatMap((document) => document.errors);
    if (errors.length > 0) throw new Error(`invalid ${label} YAML: ${path}`);
    return documents
      .filter((document) => document.contents !== null)
      .map((document) => document.toJS() as unknown);
  });
}

function discoverConfiguredProbeIds(config: OpsdRuntimeConfig): string[] {
  const dir = configuredDir(config.releaseDir, config.checksDir);
  const names = readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  if (names.length > config.maxFiles) throw new Error("check file limit exceeded");
  const ids = new Set<string>();
  for (const name of names) {
    const path = resolve(dir, name);
    if (!statSync(path).isFile()) throw new Error(`check is not a file: ${path}`);
    if (statSync(path).size > config.maxFileBytes) {
      throw new Error(`check file byte limit exceeded: ${path}`);
    }
    const documents = parseAllDocuments(readFileSync(path, "utf8"), {
      strict: true,
      uniqueKeys: true,
    });
    const errors = documents.flatMap((document) => document.errors);
    if (errors.length > 0) throw new Error(`invalid check YAML: ${path}`);
    for (const document of documents) {
      const raw = document.toJS() as { probe?: { probeId?: unknown } } | null;
      const id = raw?.probe?.probeId;
      if (typeof id !== "string" || id === "") {
        throw new Error(`check does not name a probe: ${path}`);
      }
      ids.add(id);
    }
  }
  return [...ids].sort();
}

function unavailableSamples(
  ids: readonly string[],
  phase: "baseline" | "postcondition",
  at: Date,
): PostconditionSample[] {
  return ids.map((checkId) => ({
    checkId,
    state: "unknown",
    observedAt: at.toISOString(),
    evidenceRefs: [`artifact://ops/check-unavailable/${phase}/${checkId}`],
  }));
}

class PersistingCommandRunner implements CommandRunner {
  #sequence = 0;

  constructor(
    private readonly artifactDir: string,
    private readonly now: () => Date,
  ) {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  }

  async run(argv: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const executable = argv[0];
    if (executable === undefined || !isAbsolute(executable)) {
      throw new Error("observe command must name an absolute executable");
    }
    const result = await runBounded(executable, argv.slice(1), timeoutMs);
    const payload = {
      at: this.now().toISOString(),
      argv: [...argv],
      ...result,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    const name = `${String(++this.#sequence).padStart(6, "0")}-${digest}.json`;
    writeFileSync(resolve(this.artifactDir, name), `${JSON.stringify(payload)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return {
      stdout: result.stdout,
      // A truncated successful command is not a successful observation. The
      // parsers do not receive a partial prefix with exit 0 and mistake it for
      // the complete host result.
      exitCode: result.truncated ? 74 : result.exitCode,
      timedOut: result.timedOut,
      evidenceRef: `artifact://ops/raw/${name}`,
    };
  }
}

const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

async function runBounded(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }> {
  return await new Promise((resolveResult) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let finished = false;
    const absorb = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - bytes);
      const kept = chunk.subarray(0, remaining);
      bytes += kept.length;
      if (kept.length < chunk.length) truncated = true;
      if (stream === "stdout") stdout += kept.toString("utf8");
      else stderr += kept.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => absorb("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => absorb("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveResult({ stdout, stderr, exitCode, timedOut, truncated });
    };
    child.once("error", () => finish(127));
    child.once("close", (code) => finish(code ?? 128));
  });
}

export async function runOpsd(argv: readonly string[]): Promise<void> {
  const { configPath } = parseOpsdArgs(argv);
  const daemon = composeObserveOnlyOpsDaemon(loadOpsdRuntimeConfig(configPath));
  let stop!: () => void;
  const stopping = new Promise<void>((resolveStop) => {
    stop = resolveStop;
  });
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await daemon.start();
    writeBoundedOpsLog("out", "observe-only runtime started");
    await stopping;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await daemon.stop();
  }
}

export function runOpsdReleaseCheck(argv: readonly string[]): void {
  if (argv.length !== 4 || argv[0] !== "--check-config" || argv[2] !== "--release") {
    throw new Error("usage: opsd --check-config ABS --release ABS");
  }
  const configPath = argv[1];
  const releaseDir = argv[3];
  if (configPath === undefined || releaseDir === undefined ||
      !isAbsolute(configPath) || !isAbsolute(releaseDir)) {
    throw new Error("opsd release check requires absolute paths");
  }
  validateOpsdRelease(loadOpsdRuntimeConfig(configPath), releaseDir);
}

/** Write a tail-preserving daemon log without allowing indefinite growth. */
export function writeBoundedOpsLog(
  stream: "out" | "err",
  message: string,
  maxBytes = 1_000_000,
): void {
  const line = Buffer.from(`[opsd] ${new Date().toISOString()} ${message}\n`, "utf8");
  const logRoot = process.env.HELIUM_OPSD_LOG_ROOT;
  if (logRoot === undefined || !isAbsolute(logRoot)) {
    (stream === "out" ? process.stdout : process.stderr).write(line);
    return;
  }
  try {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("log byte bound must be a positive integer");
    }
    mkdirSync(logRoot, { recursive: true, mode: 0o700 });
    const path = resolve(logRoot, `opsd.${stream}.log`);
    const incoming = line.length > maxBytes ? line.subarray(line.length - maxBytes) : line;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // First line for this stream.
    }
    if (size + incoming.length <= maxBytes) {
      appendFileSync(path, incoming, { mode: 0o600 });
      return;
    }

    const keep = Math.max(0, maxBytes - incoming.length);
    const prior = Buffer.alloc(Math.min(size, keep));
    if (prior.length > 0) {
      const fd = openSync(path, "r");
      try {
        readSync(fd, prior, 0, prior.length, Math.max(0, size - prior.length));
      } finally {
        closeSync(fd);
      }
    }
    writeFileSync(path, Buffer.concat([prior, incoming]), { mode: 0o600 });
  } catch (error) {
    // Observability must not become the daemon's availability dependency.
    process.stderr.write(
      `[opsd] log failure: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const argv = process.argv.slice(2);
  const running = argv[0] === "--check-config"
    ? Promise.resolve().then(() => runOpsdReleaseCheck(argv))
    : runOpsd(argv);
  running.catch((error: unknown) => {
    writeBoundedOpsLog(
      "err",
      `fatal: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
