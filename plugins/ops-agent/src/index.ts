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
  type ExecutionReceipt,
  type ExecutionRequest,
} from "./script-executor.js";
export {
  DEFAULT_DISK_THRESHOLDS,
  checkMountIdentity,
  classifyDisk,
  parseDf,
  type DiskThresholds,
  type ExpectedMount,
  type MountIdentity,
  type VolumeUsage,
} from "./probes/disk.js";
export {
  SUSTAINED_PAGEOUT_RATE,
  classifyMemory,
  pageoutRate,
  parseLoadAverage,
  parseSize,
  parseSwapUsage,
  parseVmStat,
  type LoadAverage,
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
