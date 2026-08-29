/**
 * `dsh-plugin-ops-agent` — the operations plugin.
 *
 * This package is the ONLY place a concrete operations mechanism lives: real
 * scripts, real process spawning, real host probes. Core holds the contracts
 * and the pure policy and knows nothing about launchd, containers, databases
 * or any other host detail.
 *
 * It is created on plain `spawn` and depends on no team controller: the
 * deterministic observe -> decide -> execute -> verify path has to keep
 * working when every model provider is unavailable.
 * @module dsh-plugin-ops-agent
 */
import { z } from "zod";

export const name = "ops-agent";
/** No DSH service, agent runtime, provider, model, or tool is mandatory. */
export const inject: readonly string[] = [];

const PluginConfigSchema = z.strictObject({ socketPath: z.string().min(1) });
export type OpsPluginConfig = z.infer<typeof PluginConfigSchema>;

interface EffectContext {
  effect(start: () => () => void, label?: string): unknown;
}

/**
 * The DSH-side half is intentionally optional and authority-free in Phase D.
 * Phase E attaches analysis to this lifecycle; execution remains in the
 * standalone daemon and is never made a Cordis effect.
 */
export function apply(ctx: EffectContext, raw: OpsPluginConfig): void {
  PluginConfigSchema.parse(raw);
  ctx.effect(() => () => {}, "ops-agent.optional-analysis-client()");
}

export {
  OpsDaemon,
  createStandaloneOpsDaemon,
  validateOpsdRelease,
  runOpsdReleaseCheck,
  type OpsAnalysisClient,
  type OpsDaemonControl,
  type OpsDaemonController,
  type OpsDaemonOptions,
  type StandaloneOpsDaemonOptions,
} from "./bin/opsd.js";
export { OpsControlClient, OpsControlServer } from "./ipc.js";
export {
  ApprovalLedger,
  FileOperatorEnvelopeStore,
  OperatorEnvelopeVerifier,
  SignedApprovalEnvelopeSchema,
  SignedInterventionEnvelopeSchema,
  approvalSigningPayload,
  interventionSigningPayload,
  type AcceptedIntervention,
  type AcceptedApproval,
  type SignedApprovalEnvelope,
  type SignedInterventionEnvelope,
  type OperatorEnvelopePersistence,
} from "./approval.js";
export {
  OpsController,
  type ControllerTickResult,
  type OpsControllerOptions,
} from "./controller.js";
export {
  OPS_MODES,
  OpsModeSchema,
  decideRuntimeMode,
  type OpsMode,
  type RuntimeModeDecision,
} from "./mode.js";
export { DurableOpsAnalysisClient } from "./analysis-client.js";
export {
  FileComponentActionLocks,
  hostBootId,
  type ComponentActionLockPort,
  type ComponentActionLockInput,
  type ComponentActionLockAcquisition,
} from "./component-action-lock.js";
export {
  FileRecoveryEvidenceStore,
  RECOVERY_EVIDENCE_SCHEMA,
  type RecoveryEvidencePort,
  type TerminalEvidenceRef,
} from "./recovery-evidence-store.js";
export {
  ScriptRegistry,
  ArgvSchemaSchema,
  ArgvParamSchema,
  RegisteredScriptSchema,
  type ArgvSchema,
  type IdentityCheck,
  type RegisteredScript,
} from "./script-registry.js";
export {
  ComponentRegistry,
  type LoadedSop,
  type OpsBundle,
  type RegistryLimits,
} from "./component-registry.js";
export { OpsConfigSchema, type OpsConfig } from "./config.js";
export {
  loadAuthoritySource,
  resolveSopAuthority,
  type AuthoritySource,
  type ResolvedSopAuthority,
} from "./authority-manifest-loader.js";
export {
  launchdControllerProbe,
  parseLoadedLabels,
  type LaunchctlResult,
  type LaunchctlRunner,
  type LaunchdControllerProbe,
} from "./probes/launchd-controller.js";
export {
  ScriptExecutor,
  ExecutionSuppressedError,
  type ExecutionGate,
  type ExecutionReceipt,
  type ExecutionRequest,
} from "./script-executor.js";
export {
  DEFAULT_DISK_THRESHOLDS,
  checkMountIdentity,
  classifyDisk,
  diskProbe,
  parseDf,
  type DiskProbeOptions,
  type DiskThresholds,
  type ExpectedMount,
  type MonitoredVolume,
  type MountIdentity,
  type VolumeUsage,
} from "./probes/disk.js";
export {
  SUSTAINED_PAGEOUT_RATE,
  classifyMemory,
  macosResourceProbe,
  pageoutRate,
  parseCpuTop,
  parseLoadAverage,
  parseMemoryPressure,
  parseSize,
  parseSwapUsage,
  parseVmStat,
  type CpuProcessContribution,
  type CpuTopSample,
  type LoadAverage,
  type MacosResourceProbeOptions,
  type MemoryPressure,
  type MemorySample,
  type SwapUsage,
  type VmStat,
} from "./probes/macos-resource.js";
export {
  classifyProcess,
  processProbe,
  type CommandResult,
  type CommandRunner,
  type ProcessProbeOptions,
} from "./probes/process.js";
export {
  Collector,
  type CollectionResult,
  type CollectorFailure,
  type CollectorOptions,
  type ObservationProbe,
  type ObservationSink,
} from "./collector.js";
export { adaptLivewire, type LivewireSnapshot } from "./adapters/livewire.js";
export { adaptArgon, type ArgonSnapshot } from "./adapters/argon.js";
export { adaptApex, type ApexSnapshot } from "./adapters/apex.js";
export {
  COLIMA_READ_COMMANDS,
  adaptColima,
  type ColimaSnapshot,
} from "./adapters/colima.js";
export {
  POSTGRES_READ_PROBES,
  adaptPostgres,
  type BackupIntegrityTier,
  type PostgresSnapshot,
} from "./adapters/postgres.js";
export { adaptHelium, type HeliumSnapshot } from "./adapters/helium.js";
export {
  AlertManager,
  type AlertDelivery,
  type AlertEvaluation,
  type AlertInput,
  type AlertMessage,
} from "./alerts.js";
export {
  OpsBundleLoader,
  type OpsBundleLoaderOptions,
  type TenantConfigHealth,
  type TenantInstallResult,
} from "./bundle-loader.js";
