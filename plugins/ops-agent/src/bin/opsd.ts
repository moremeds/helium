#!/usr/bin/env node
/**
 * Standalone deterministic operations daemon composition.
 *
 * DSH and model providers are deliberately absent from this module. An
 * optional analysis client receives completed tick snapshots after the
 * authoritative deterministic path has finished; its failure is reported and
 * cannot fail collection, correlation, policy, execution, or verification.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  lstatSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  ActionLeaseController,
  ActionLeaseTable,
  OperationsStore,
  canonicalJson,
  type CheckDefinition,
  type PostconditionSample,
} from "@helium/core";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  ApprovalLedger,
  FileOperatorEnvelopeStore,
  FileSuggestionDecisionStore,
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
import { OpsControlServer as UnixOpsControlServer } from "../ipc.js";
import { macosResourceProbe } from "../probes/macos-resource.js";
import { launchdControllerProbe } from "../probes/launchd-controller.js";
import {
  createConfiguredHostProbes,
  createProductionObservationProbes,
  loadProductionObservationTargets,
} from "../production-observations.js";
import {
  createProductionCheckRuntime,
  type ProductionCheckRuntime,
} from "../production-checks.js";
import { FileRecoveryEvidenceStore } from "../recovery-evidence-store.js";
import { ArgvSchemaSchema, ScriptRegistry } from "../script-registry.js";
import { ScriptExecutor } from "../script-executor.js";
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
  control: OpsDaemonControl;
  analysis?: OpsAnalysisClient;
  intervalMs: number;
  onError?: (error: Error) => void;
  onTickSuccess?: (snapshot: ControllerTickResult) => void | Promise<void>;
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
    onTickSuccess,
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
    ...(runtimeReleaseRef === undefined && onTickSuccess === undefined
      ? {}
      : {
          onTickSuccess: async (snapshot: ControllerTickResult) => {
            if (runtimeReleaseRef !== undefined) {
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
            }
            await onTickSuccess?.(snapshot);
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

const AutomaticAuthorityCommon = {
  sopId: z.string().min(1).max(128),
  componentId: z.string().min(1).max(128),
  executorId: z.string().min(1).max(128),
  postconditionIds: z.array(z.string().min(1).max(128)).min(1).max(50),
};
const VerificationExecutorCapSchema = z.strictObject({
  executorId: z.string().min(1).max(128),
  path: AbsolutePathSchema,
  identity: z.strictObject({
    kind: z.literal("sha256"),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  expectedOwnerUid: z.number().int().nonnegative(),
  argvSchema: ArgvSchemaSchema,
});
const AutomaticAuthorityCapSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...AutomaticAuthorityCommon,
    kind: z.literal("exact-argv"),
    argv: z.array(z.string().max(4096)).max(32),
  }),
  z.strictObject({
    ...AutomaticAuthorityCommon,
    kind: z.literal("manifest-argv-v1"),
    manifestRoot: AbsolutePathSchema,
    verificationExecutor: VerificationExecutorCapSchema,
  }),
]);

/** Auto is representable only as one signed, exact runtime capability. */
export const OpsdRuntimeConfigSchema = OpsConfigSchema.extend({
  version: z.literal(1),
  mode: z.enum(["observe", "suggest", "approve", "auto"]),
  releaseDir: AbsolutePathSchema,
  promotionBundleDir: AbsolutePathSchema.optional(),
  automaticAuthority: AutomaticAuthorityCapSchema.optional(),
  executorsDir: z.string().min(1),
  stateDir: AbsolutePathSchema,
  socketPath: UnixSocketPathSchema,
  observationTargetsPath: AbsolutePathSchema.optional(),
  intervalMs: z.number().int().positive().max(86_400_000),
}).strict().superRefine((config, ctx) => {
  if (config.mode !== "observe" && config.promotionBundleDir === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["promotionBundleDir"],
      message: `${config.mode} mode requires an explicit promotion bundle`,
    });
  }
  if ((config.mode === "auto") !== (config.automaticAuthority !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["automaticAuthority"],
      message: "auto mode requires exactly one explicit automatic authority cap",
    });
  }
});
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
  options: { registeredProbeIds?: readonly string[] } = {},
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
    ...(config.observationTargetsPath === undefined
      ? {}
      : { observationTargetsPath: rebase(config.observationTargetsPath) }),
    ...(config.promotionBundleDir === undefined
      ? {}
      : { promotionBundleDir: rebase(config.promotionBundleDir) }),
  });
  const checkRuntime = configuredCheckRuntime(parsed);
  const compiledProbeIds = checkRuntime?.probeIds() ?? [];
  const registeredProbeIds = [...new Set([
    ...compiledProbeIds,
    ...(options.registeredProbeIds ?? []),
  ])].sort();
  if (checkRuntime !== undefined) {
    validateRegisteredProbeExport(parsed.releaseDir, compiledProbeIds);
  }
  const loader = new OpsBundleLoader({
    baseDir: activeBundleBase(parsed),
    config: loaderConfig(parsed),
    registeredProbeIds,
    now: () => new Date(),
  });
  const installed = loader.installTenant("standalone-host", activeBundleBase(parsed));
  if (installed.health.state !== "loaded") {
    throw new Error(`ops bundle invalid: ${installed.health.detail ?? "unknown error"}`);
  }
  const scripts = ScriptRegistry.load(loadConfiguredDocuments(
    parsed,
    activeBundleBase(parsed),
    parsed.executorsDir,
    "executor",
  ));
  assertRuntimeAuthority(parsed, loader, scripts, registeredProbeIds);
  createPublicKey(readFileSync(parsed.trustedKeyPath, "utf8"));
  if (checkRuntime !== undefined) {
    statSync(resolve(parsed.releaseDir, "scripts/ops/read-latest-heartbeats.mjs"));
    statSync(resolve(parsed.releaseDir, "scripts/ops/check-parquet-integrity.py"));
  }
}

export interface OpsCompositionOverrides {
  runner?: CommandRunner;
  probes?: readonly ObservationProbe[];
  additionalProbes?: readonly ObservationProbe[];
  prepareAction?: OpsControllerOptions["prepareAction"];
  registeredProbeIds?: readonly string[];
  additionalCheckSampler?: (
    checks: readonly CheckDefinition[],
    phase: "baseline" | "postcondition",
    runner: CommandRunner,
    now: Date,
  ) => Promise<PostconditionSample[] | undefined>;
  onTickSuccess?: (snapshot: ControllerTickResult) => void | Promise<void>;
  onOperationsReady?: (store: OperationsStore, evidence: FileRecoveryEvidenceStore) => void;
  readAdditionalSourceArtifact?: (ref: string) => string | Buffer;
  now?: () => Date;
}

/**
 * Concrete provider-free composition used by the launchd binary. Suggest and
 * approve modes are admitted only through a separately signed,
 * identity-checked promotion bundle; observe and suggest cannot reach a real
 * executor.
 */
export function composeOpsDaemon(
  config: OpsdRuntimeConfig,
  overrides: OpsCompositionOverrides = {},
): OpsDaemon {
  const parsed = OpsdRuntimeConfigSchema.parse(config);
  const now = overrides.now ?? (() => new Date());
  mkdirSync(parsed.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(parsed.socketPath), { recursive: true, mode: 0o700 });

  const targets = parsed.observationTargetsPath === undefined
    ? undefined
    : loadProductionObservationTargets(parsed.observationTargetsPath);
  const checkRuntime = targets === undefined
    ? undefined
    : createProductionCheckRuntime(targets, {
        releaseDir: parsed.releaseDir,
        nodePath: process.execPath,
      });
  const compiledProbeIds = checkRuntime?.probeIds() ?? [];
  const registeredProbeIds = [...new Set([
    ...compiledProbeIds,
    ...(overrides.registeredProbeIds ?? []),
  ])].sort();
  if (checkRuntime !== undefined) {
    validateRegisteredProbeExport(parsed.releaseDir, compiledProbeIds);
  }
  const loader = new OpsBundleLoader({
    baseDir: activeBundleBase(parsed),
    config: loaderConfig(parsed),
    registeredProbeIds,
    now,
  });
  const installed = loader.installTenant("standalone-host", activeBundleBase(parsed));
  if (installed.health.state !== "loaded") {
    throw new Error(`ops bundle invalid: ${installed.health.detail ?? "unknown error"}`);
  }
  const scripts = ScriptRegistry.load(loadConfiguredDocuments(
    parsed,
    activeBundleBase(parsed),
    parsed.executorsDir,
    "executor",
  ));
  const promotion = assertRuntimeAuthority(parsed, loader, scripts, registeredProbeIds);

  const trustedKey = createPublicKey(readFileSync(parsed.trustedKeyPath, "utf8"));
  const evidence = new FileRecoveryEvidenceStore(resolve(parsed.stateDir, "evidence"), {
    ...(overrides.readAdditionalSourceArtifact === undefined
      ? {}
      : { readAdditionalSourceArtifact: overrides.readAdditionalSourceArtifact }),
  });
  const store = OperationsStore.open(parsed.stateDir, {
    validateEvent: (event) => evidence.verifyEvent(event),
  });
  overrides.onOperationsReady?.(store, evidence);
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
    suggestionDecisions: new FileSuggestionDecisionStore(parsed.stateDir),
    store,
    now,
  });
  const runner = overrides.runner ??
    new PersistingCommandRunner(resolve(parsed.stateDir, "raw"), now);
  const defaultProbes = [
    macosResourceProbe({ componentId: "host" }),
    ...(targets === undefined ? [] : createConfiguredHostProbes(targets)),
    ...(targets === undefined
      ? []
      : createProductionObservationProbes(targets, {
          releaseDir: parsed.releaseDir,
          nodePath: process.execPath,
        })),
  ];
  const probes = [
    ...(overrides.probes ?? defaultProbes),
    ...(overrides.additionalProbes ?? []),
  ];
  const leases = new ActionLeaseController(new ActionLeaseTable(), {
    controllerId: "com.helium.opsd",
    ttlMs: Math.max(parsed.intervalMs * 2, 120_000),
    now,
  });

  return createStandaloneOpsDaemon({
    mode: parsed.mode,
    registry: loader.registry,
    store,
    now,
    runChecks: async (ids) => {
      if (checkRuntime === undefined) {
        return Object.fromEntries(ids.map((id) => [id, "unknown" as const]));
      }
      const samples = await checkRuntime.sample(
        loader.registry.checks(ids),
        "baseline",
        runner,
        now(),
      );
      return Object.fromEntries(samples.map((sample) => [sample.checkId, sample.state]));
    },
    sampleChecks: async (checks, phase) => {
      const sampledAt = now();
      const additional = await overrides.additionalCheckSampler?.(
        checks,
        phase,
        runner,
        sampledAt,
      );
      if (additional !== undefined) return additional;
      return checkRuntime === undefined
        ? unavailableSamples(checks, phase, sampledAt)
        : checkRuntime.sample(checks, phase, runner, sampledAt);
    },
    controllerProbe: parsed.mode === "approve" || parsed.mode === "auto"
      ? launchdControllerProbe({
          launchctl: {
            async list(argv) {
              const result = await runner.run(["/bin/launchctl", ...argv], 10_000);
              return { ...result, truncated: false };
            },
          },
        })
      : {
          async check() {
            return {
              result: "unknown",
              observedLabels: [],
              evidenceRef: "artifact://ops/controller/not-enumerated-in-non-mutating-mode",
              detail: "non-mutating-runtime",
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
    createExecutor: () => parsed.mode === "approve" || parsed.mode === "auto"
      ? new ScriptExecutor(scripts, { now })
      : {
          async run() {
            throw new Error("non-mutating runtime has no executor");
          },
        },
    argvFor: (sop) => compiledActionArgv(sop.id, parsed),
    ...(overrides.prepareAction === undefined
      ? {}
      : { prepareAction: overrides.prepareAction }),
    ...(promotion === undefined
      ? {}
      : {
          promotionId: promotion.promotionId,
          promotionInputSha256: promotion.inputSha256,
        }),
    probes,
    runner,
    control,
    intervalMs: parsed.intervalMs,
    onError: (error) => writeBoundedOpsLog("err", error.message),
    runtimeReleaseRef: realpathSync(parsed.releaseDir),
    ...(overrides.onTickSuccess === undefined
      ? {}
      : { onTickSuccess: overrides.onTickSuccess }),
  });
}

/** Compatibility entrypoint retained for the installed observe-only service. */
export function composeObserveOnlyOpsDaemon(
  config: OpsdRuntimeConfig,
  overrides: OpsCompositionOverrides = {},
): OpsDaemon {
  if (config.mode !== "observe") {
    throw new Error("observe-only composition requires mode observe");
  }
  return composeOpsDaemon(config, overrides);
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
  baseDir: string,
  configured: string,
  label: string,
): unknown[] {
  const dir = configuredDir(baseDir, configured);
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

function activeBundleBase(config: OpsdRuntimeConfig): string {
  return config.mode !== "observe"
    ? config.promotionBundleDir as string
    : config.releaseDir;
}

function assertRuntimeAuthority(
  config: OpsdRuntimeConfig,
  loader: OpsBundleLoader,
  scripts: ScriptRegistry,
  registeredProbeIds: readonly string[],
): { promotionId: string; inputSha256: string } | undefined {
  if (config.mode === "observe") return undefined;
  const mode = config.mode;
  const sops = loader.registry.sops();
  if (sops.length === 0) throw new Error(`${mode} promotion bundle contains no SOP`);
  const manifest = z.object({
    entries: z.array(z.object({
      sopId: z.string(),
      version: z.number(),
      digest: z.string(),
      authority: z.string(),
    }).passthrough()),
    promotion: z.object({
      promotionId: z.string().min(1),
      inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
  }).passthrough().parse(JSON.parse(readFileSync(config.authorityManifestPath, "utf8")));
  const expectedEntries = sops.map(({ definition }) => ({
    sopId: definition.id,
    version: definition.version,
    digest: definition.digest,
    authority: definition.authority,
  }));
  if (JSON.stringify(manifest.entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`${mode} authority manifest does not exactly match the promotion SOP set`);
  }
  const requiredAuthority = mode === "auto" ? "auto" : "approve";
  if (mode === "auto") {
    if (sops.length !== 1 || config.automaticAuthority === undefined) {
      throw new Error("auto promotion must contain exactly one SOP and one authority cap");
    }
  }
  for (const loaded of sops) {
    if (loaded.definition.authority !== requiredAuthority || loaded.authority !== requiredAuthority ||
        loaded.authorityManifestEntry === undefined) {
      throw new Error(`${mode} SOP lacks an exact signed authority grant: ${loaded.definition.id}`);
    }
    if (!loaded.certified) {
      throw new Error(
        `${mode} SOP is not certified: ${loaded.definition.id}: ${loaded.certificationReasons.join(", ")}`,
      );
    }
    const component = loader.registry.component(loaded.definition.componentId);
    if (component === undefined || component.mutationOwner.owner !== "opsd" ||
        (mode === "auto" && component.mutationOwner.competingLabels.length !== 0)) {
      throw new Error(`${mode} SOP component lacks exclusive opsd mutation ownership: ${loaded.definition.id}`);
    }
    if (mode === "auto") {
      const cap = config.automaticAuthority!;
      if (cap.sopId !== loaded.definition.id ||
          cap.componentId !== loaded.definition.componentId ||
          cap.executorId !== loaded.definition.action.executorId ||
          JSON.stringify(cap.postconditionIds) !== JSON.stringify(loaded.definition.postconditions)) {
        throw new Error("auto authority cap does not exactly match the signed SOP");
      }
      if (cap.kind === "manifest-argv-v1" && cap.verificationExecutor.executorId === cap.executorId) {
        throw new Error("automatic postcondition executor must be distinct from the mutation executor");
      }
    }
    const script = scripts.get(loaded.definition.action.executorId);
    if (script === undefined || script.path !== loaded.definition.action.executable.path ||
        script.identity.kind !== loaded.definition.action.executable.identity?.kind ||
        script.identity.value !== loaded.definition.action.executable.identity?.value ||
        script.argvSchema.id !== loaded.definition.action.argvSchemaId ||
        script.timeoutMs < loaded.definition.action.timeoutMs) {
      throw new Error(`${mode} SOP action does not match its registered executor: ${loaded.definition.id}`);
    }
    if (mode === "auto") {
      const cap = config.automaticAuthority!;
      const verificationExecutor = cap.kind === "manifest-argv-v1"
        ? scripts.get(cap.verificationExecutor.executorId)
        : undefined;
      if (cap.kind === "manifest-argv-v1") {
        if (verificationExecutor === undefined ||
            verificationExecutor.path !== cap.verificationExecutor.path ||
            JSON.stringify(verificationExecutor.identity) !== JSON.stringify(cap.verificationExecutor.identity) ||
            verificationExecutor.expectedOwnerUid !== cap.verificationExecutor.expectedOwnerUid ||
            JSON.stringify(verificationExecutor.argvSchema) !== JSON.stringify(cap.verificationExecutor.argvSchema)) {
          throw new Error("automatic postcondition executor differs from the signed capability");
        }
        const verifierIdentity = scripts.verifyIdentity(verificationExecutor);
        if (!verifierIdentity.ok) {
          throw new Error(`automatic postcondition executor identity failed: ${verifierIdentity.reason}`);
        }
      }
      const automaticAuthorityDigest = automaticAuthorityInputDigest({
        cap: config.automaticAuthority!,
        component,
        sop: loaded.definition,
        checks: loader.registry.checks([
          ...loaded.definition.preconditions,
          ...loaded.definition.postconditions,
        ]),
        executor: script,
        ...(verificationExecutor === undefined ? {} : { verificationExecutor }),
      });
      if (cap.kind === "manifest-argv-v1") {
        validateManifestPromotionInput(
          config,
          manifest.promotion,
          automaticAuthorityDigest,
          registeredProbeIds,
        );
      } else if (automaticAuthorityDigest !== manifest.promotion.inputSha256) {
        throw new Error("auto executable capability is not bound by the signed promotion input hash");
      }
    }
    const argv = mode === "auto" && config.automaticAuthority?.kind === "manifest-argv-v1"
      ? [
          "--manifest",
          resolve(config.automaticAuthority.manifestRoot, `sha256:${"a".repeat(64)}.json`),
        ]
      : compiledActionArgv(loaded.definition.id, config);
    if (mode === "auto" && config.automaticAuthority?.kind === "manifest-argv-v1") {
      authorizeAutomaticArgv(config.automaticAuthority, argv);
    }
    scripts.validateArgv(script, argv);
    const identity = scripts.verifyIdentity(script);
    if (!identity.ok) {
      throw new Error(
        `${mode} executor identity is not certified: ${loaded.definition.id}: ${identity.reason}`,
      );
    }
  }
  return manifest.promotion;
}

function validateManifestPromotionInput(
  config: OpsdRuntimeConfig,
  promotion: { promotionId: string; inputSha256: string },
  automaticAuthorityDigest: string,
  registeredProbeIds: readonly string[],
): void {
  const root = config.promotionBundleDir;
  if (root === undefined) throw new Error("manifest promotion bundle is missing");
  const value = z.object({
    version: z.literal(1),
    promotionId: z.string().min(1),
    release: z.object({ dir: AbsolutePathSchema, commit: z.string().min(1) }).strict(),
    nodeBinary: z.object({
      path: AbsolutePathSchema,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    runtimeManifest: z.object({
      path: AbsolutePathSchema,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    bundleFiles: z.array(z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict()).min(1),
    runtimeFiles: z.array(z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict()).min(1),
    registeredProbes: z.object({
      path: AbsolutePathSchema,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      probeIds: z.array(z.string().min(1)),
    }).strict(),
    automaticAuthority: AutomaticAuthorityCapSchema,
    automaticAuthorityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).passthrough().parse(JSON.parse(readFileSync(join(root, "promotion-input.json"), "utf8")));
  const { inputSha256, ...unsigned } = value;
  const actualInputSha256 = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  if (inputSha256 !== actualInputSha256 || inputSha256 !== promotion.inputSha256 ||
      value.promotionId !== promotion.promotionId) {
    throw new Error("signed promotion input hash does not bind the complete runtime bundle");
  }
  if (value.automaticAuthorityDigest !== automaticAuthorityDigest ||
      canonicalJson(value.automaticAuthority) !== canonicalJson(config.automaticAuthority)) {
    throw new Error("automatic executable capability differs from the signed promotion input");
  }
  if (resolve(value.release.dir) !== resolve(config.releaseDir)) {
    throw new Error("signed promotion release directory differs from runtime");
  }
  let actualCommit: string;
  try {
    actualCommit = execFileSync("git", ["-C", config.releaseDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error("cannot verify signed promotion release commit");
  }
  if (actualCommit !== value.release.commit) {
    throw new Error("signed promotion release commit differs from runtime");
  }
  const actualRuntimeFiles = livewireRuntimeFiles(config.releaseDir, value.nodeBinary.path);
  if (canonicalJson(value.runtimeFiles) !== canonicalJson(actualRuntimeFiles)) {
    throw new Error("signed promotion runtime hashes differ from executed bytes");
  }
  const runtimeManifestBytes = readFileSync(value.runtimeManifest.path);
  const expectedRuntimeManifest = `${actualRuntimeFiles
    .map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`;
  if (value.nodeBinary.sha256 !== createHash("sha256").update(readFileSync(value.nodeBinary.path)).digest("hex") ||
      value.runtimeManifest.sha256 !== createHash("sha256").update(runtimeManifestBytes).digest("hex") ||
      !runtimeManifestBytes.equals(Buffer.from(expectedRuntimeManifest))) {
    throw new Error("signed Node runtime manifest differs from executed bytes");
  }
  const actualBundleFiles = [
    configuredDir(root, config.componentsDir),
    configuredDir(root, config.checksDir),
    configuredDir(root, config.executorsDir),
    configuredDir(root, config.sopsDir),
  ].flatMap((dir) => readdirSync(dir)
    .filter((name) => [".yaml", ".yml", ".json"].includes(extname(name)))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return {
        path: relative(root, path),
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    }));
  if (canonicalJson(value.bundleFiles) !== canonicalJson(actualBundleFiles)) {
    throw new Error("signed promotion bundle hashes differ from runtime bytes");
  }
  const probePath = join(root, "registered-probes.json");
  if (resolve(value.registeredProbes.path) !== resolve(probePath)) {
    throw new Error("signed registered probe path differs from promotion bundle");
  }
  const probeSha256 = createHash("sha256").update(readFileSync(probePath)).digest("hex");
  if (value.registeredProbes.sha256 !== probeSha256 ||
      canonicalJson(value.registeredProbes.probeIds) !== canonicalJson([...registeredProbeIds].sort())) {
    throw new Error("signed registered probe inventory differs from runtime");
  }
}

/** Exact Helium files that participate in the installed Livewire Ops process. */
export function livewireRuntimeFiles(
  releaseDir: string,
  nodeBinary = process.execPath,
): Array<{ path: string; sha256: string }> {
  const resolvedNodeBinary = realpathSync(nodeBinary);
  const roots = [
    "packages/core/lib",
    "plugins/ops-agent/lib",
    "plugins/livewire-shepherd/lib",
  ];
  const fixed = [
    "packages/core/package.json",
    "plugins/ops-agent/package.json",
    "plugins/livewire-shepherd/package.json",
    "scripts/ops/run-livewire-opsd.sh",
    "pnpm-lock.yaml",
  ];
  const paths = [...fixed];
  const visit = (relativeDir: string): void => {
    const absoluteDir = join(releaseDir, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(relativeDir, entry.name);
      const stat = lstatSync(join(releaseDir, child));
      if (stat.isSymbolicLink()) throw new Error(`runtime bundle contains symlink: ${child}`);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile() && (child.endsWith(".js") || child.endsWith(".json"))) paths.push(child);
    }
  };
  for (const root of roots) visit(root);
  const packageQueue = [
    join(releaseDir, "packages/core"),
    join(releaseDir, "plugins/ops-agent"),
    join(releaseDir, "plugins/livewire-shepherd"),
  ];
  const workspacePackages = new Set(packageQueue.map((path) => realpathSync(path)));
  const visitedPackages = new Set<string>();
  while (packageQueue.length > 0) {
    const packageDir = realpathSync(packageQueue.shift()!);
    if (visitedPackages.has(packageDir)) continue;
    visitedPackages.add(packageDir);
    const packageJsonPath = join(packageDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (!workspacePackages.has(packageDir)) {
      const visitDependencyFiles = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name === "node_modules") continue;
          const child = join(dir, entry.name);
          const stat = lstatSync(child);
          if (stat.isSymbolicLink()) throw new Error(`Node dependency contains symlink: ${child}`);
          if (stat.isDirectory()) visitDependencyFiles(child);
          else if (stat.isFile()) paths.push(child);
        }
      };
      visitDependencyFiles(packageDir);
    }
    for (const dependency of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    }).sort()) {
      try {
        try {
          packageQueue.push(realpathSync(join(packageDir, "node_modules", ...dependency.split("/"))));
        } catch {
          const requireFromPackage = createRequire(packageJsonPath);
          try {
            packageQueue.push(realpathSync(dirname(requireFromPackage.resolve(`${dependency}/package.json`))));
          } catch {
            let cursor = dirname(requireFromPackage.resolve(dependency));
            for (;;) {
              try {
                const candidate = JSON.parse(readFileSync(join(cursor, "package.json"), "utf8")) as { name?: string };
                if (candidate.name === dependency) {
                  packageQueue.push(realpathSync(cursor));
                  break;
                }
              } catch { /* keep walking to the package root */ }
              const parent = dirname(cursor);
              if (parent === cursor) throw new Error(`cannot locate package root for ${dependency}`);
              cursor = parent;
            }
          }
        }
      } catch {
        if (packageJson.optionalDependencies?.[dependency] === undefined) {
          throw new Error(`cannot resolve Node runtime dependency ${dependency} from ${packageDir}`);
        }
      }
    }
  }
  paths.push(resolvedNodeBinary, ...nativeRuntimeFiles([resolvedNodeBinary]));
  return [...new Set(paths)].sort().map((path) => {
    const absolutePath = isAbsolute(path) ? path : join(releaseDir, path);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe runtime file: ${path}`);
    return { path, sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex") };
  });
}

/** Resolve existing native libraries that the selected executable objects load. */
export function nativeRuntimeFiles(seeds: readonly string[]): string[] {
  const executable = realpathSync(seeds[0] ?? process.execPath);
  const queue = [...new Set(seeds.map((path) => realpathSync(path)))];
  const visited = new Set<string>();
  const discovered = new Set<string>(queue);
  const resolveToken = (token: string, loader: string, rpaths: readonly string[]): string | undefined => {
    const loaderDir = dirname(loader);
    const executableDir = dirname(executable);
    const candidates = token.startsWith("@loader_path/")
      ? [join(loaderDir, token.slice("@loader_path/".length))]
      : token.startsWith("@executable_path/")
        ? [join(executableDir, token.slice("@executable_path/".length))]
        : token.startsWith("@rpath/")
          ? rpaths.map((root) => join(root, token.slice("@rpath/".length)))
          : isAbsolute(token) ? [token] : [];
    const existing = candidates.find((path) => existsSync(path));
    return existing === undefined ? undefined : realpathSync(existing);
  };
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    let dependencies: string[] = [];
    let rpaths: string[] = [];
    try {
      if (process.platform === "darwin") {
        const load = execFileSync("/usr/bin/otool", ["-L", current], {
          encoding: "utf8",
          timeout: 10_000,
        });
        dependencies = load.split("\n").slice(1)
          .map((line) => line.trim().split(/\s+\(/, 1)[0] ?? "")
          .filter((line) => line !== "");
        const commands = execFileSync("/usr/bin/otool", ["-l", current], {
          encoding: "utf8",
          timeout: 10_000,
        }).split("\n");
        for (let index = 0; index < commands.length; index += 1) {
          if (commands[index]?.trim() !== "cmd LC_RPATH") continue;
          const pathLine = commands.slice(index + 1, index + 5)
            .find((line) => line.trim().startsWith("path "))?.trim();
          const token = pathLine?.slice("path ".length).split(" (offset ", 1)[0];
          if (token !== undefined) {
            const resolved = resolveToken(token, current, []);
            if (resolved !== undefined) rpaths.push(resolved);
            else if (token.startsWith("@loader_path/")) {
              rpaths.push(resolve(dirname(current), token.slice("@loader_path/".length)));
            } else if (token.startsWith("@executable_path/")) {
              rpaths.push(resolve(dirname(executable), token.slice("@executable_path/".length)));
            }
          }
        }
      } else if (process.platform === "linux") {
        const load = execFileSync("ldd", [current], { encoding: "utf8", timeout: 10_000 });
        dependencies = load.split("\n").flatMap((line) => {
          const match = line.match(/=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)/);
          return match?.[1] ?? match?.[2] ?? "";
        }).filter((line) => line !== "");
      }
    } catch {
      continue; // A regular seed can be data rather than a loadable object.
    }
    rpaths = [...new Set([
      ...rpaths,
      join(dirname(current), "..", "lib"),
      join(dirname(executable), "..", "lib"),
    ].map((path) => resolve(path)))];
    for (const dependency of dependencies) {
      const resolved = resolveToken(dependency, current, rpaths);
      if (resolved === undefined || discovered.has(resolved)) continue;
      if (resolved.includes("\n") || resolved.includes("\r")) {
        throw new Error("native runtime path contains a newline");
      }
      discovered.add(resolved);
      queue.push(resolved);
    }
  }
  return [...discovered].sort();
}

export function automaticAuthorityInputDigest(input: {
  cap: z.infer<typeof AutomaticAuthorityCapSchema>;
  component: unknown;
  sop: unknown;
  checks: readonly unknown[];
  executor: unknown;
  verificationExecutor?: unknown;
}): string {
  const cap = AutomaticAuthorityCapSchema.parse(input.cap);
  return createHash("sha256")
    .update(canonicalJson({
      cap,
      component: input.component,
      sop: input.sop,
      checks: input.checks,
      executor: input.executor,
      ...(cap.kind === "manifest-argv-v1"
        ? { verificationExecutor: input.verificationExecutor }
        : {}),
    }))
    .digest("hex");
}

/** Check one runtime argv against the signed automatic capability class. */
export function authorizeAutomaticArgv(
  cap: z.infer<typeof AutomaticAuthorityCapSchema>,
  argv: readonly string[],
): void {
  if (cap.kind === "exact-argv") {
    if (JSON.stringify(argv) !== JSON.stringify(cap.argv)) {
      throw new Error("automatic argv does not match the exact signed capability");
    }
    return;
  }
  const manifest = argv.length === 2 && argv[0] === "--manifest" ? argv[1] : undefined;
  if (manifest === undefined || !isAbsolute(manifest)) {
    throw new Error("automatic manifest capability requires only --manifest ABS");
  }
  const root = resolve(cap.manifestRoot);
  const candidate = resolve(manifest);
  const name = candidate.slice(root.length + 1);
  if (dirname(candidate) !== root || !/^sha256:[0-9a-f]{64}\.json$/.test(name)) {
    throw new Error("automatic manifest argv is outside the signed ready directory");
  }
}

function compiledActionArgv(sopId: string, config: OpsdRuntimeConfig): string[] {
  if (config.mode === "auto" && config.automaticAuthority?.sopId === sopId) {
    if (config.automaticAuthority.kind !== "exact-argv") {
      throw new Error("scoped automatic capability requires its registered adapter");
    }
    return [...config.automaticAuthority.argv];
  }
  if (sopId === "trading-stack-container-reconcile") {
    return ["--scope", "containers", "--pull", "false"];
  }
  throw new Error(`no compiled argv for SOP: ${sopId}`);
}

function configuredCheckRuntime(config: OpsdRuntimeConfig): ProductionCheckRuntime | undefined {
  if (config.observationTargetsPath === undefined) return undefined;
  return createProductionCheckRuntime(
    loadProductionObservationTargets(config.observationTargetsPath),
    { releaseDir: config.releaseDir, nodePath: process.execPath },
  );
}

function validateRegisteredProbeExport(releaseDir: string, compiledIds: readonly string[]): void {
  const path = resolve(releaseDir, "ops/registered-probes.json");
  const inventory = z.object({
    version: z.literal(1),
    probeIds: z.array(z.string().min(1)),
  }).strict().parse(JSON.parse(readFileSync(path, "utf8")));
  const exported = [...inventory.probeIds].sort();
  const compiled = [...compiledIds].sort();
  if (new Set(exported).size !== exported.length ||
      exported.length !== compiled.length ||
      exported.some((id, index) => id !== compiled[index])) {
    throw new Error("registered probe inventory does not match compiled runtime");
  }
}

function unavailableSamples(
  checks: readonly { id: string }[],
  phase: "baseline" | "postcondition",
  at: Date,
): PostconditionSample[] {
  return checks.map((check) => ({
    checkId: check.id,
    state: "unknown",
    observedAt: at.toISOString(),
    evidenceRefs: [`artifact://ops/check-unavailable/${phase}/${check.id}`],
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
      flush: true,
    });
    const dirFd = openSync(this.artifactDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
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
  const daemon = composeOpsDaemon(loadOpsdRuntimeConfig(configPath));
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
