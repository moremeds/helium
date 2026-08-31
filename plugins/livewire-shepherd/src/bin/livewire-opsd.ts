#!/usr/bin/env node
/** Production composition: Shepherd state feeds one existing durable OpsController. */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, type OperationsStore } from "@helium/core";
import {
  authorizeAutomaticArgv,
  composeOpsDaemon,
  loadOpsdRuntimeConfig,
  validateOpsdRelease,
  type OpsDaemon,
  type OpsdRuntimeConfig,
  ScriptRegistry,
  hostBootId,
} from "dsh-plugin-ops-agent";
import { FileAppendCoordination } from "../append-coordination.js";
import { loadShepherdRuntimeConfig, type ShepherdRuntimeConfig } from "../config.js";
import { ShepherdRepairOpsAdapter } from "../repair-ops-adapter.js";
import { LivewireRepairCheckSampler } from "../repair-checks.js";
import { ShepherdRepairPreparer } from "../repair-controller.js";
import { ShepherdRepairOutcomeProjector } from "../repair-outcomes.js";
import { openShepherdStore, type ShepherdStore } from "../store.js";

export interface LivewireOpsdArgs {
  command: "run" | "check-config";
  opsConfigPath: string;
  shepherdConfigPath: string;
}

export function parseLivewireOpsdArgs(argv: readonly string[]): LivewireOpsdArgs {
  const command = argv[0] === "check-config" || argv[0] === "run" ? argv[0] : "run";
  const args = command === "run" && argv[0] !== "run" ? argv : argv.slice(1);
  let opsConfigPath: string | undefined;
  let shepherdConfigPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag ?? "argument"} requires an absolute path`);
    }
    if (flag === "--ops-config" && opsConfigPath === undefined) opsConfigPath = value;
    else if (flag === "--shepherd-config" && shepherdConfigPath === undefined) shepherdConfigPath = value;
    else throw new Error(`unknown or duplicate livewire-opsd argument: ${flag}`);
    index += 1;
  }
  if (opsConfigPath === undefined || shepherdConfigPath === undefined) {
    throw new Error("livewire-opsd requires --ops-config and --shepherd-config");
  }
  if (!isAbsolute(opsConfigPath) || !isAbsolute(shepherdConfigPath)) {
    throw new Error("livewire-opsd config paths must be absolute");
  }
  return { command, opsConfigPath, shepherdConfigPath };
}

export function assertLivewireOpsBinding(
  ops: OpsdRuntimeConfig,
  shepherd: ShepherdRuntimeConfig,
): asserts ops is OpsdRuntimeConfig & {
  mode: "auto";
  automaticAuthority: NonNullable<OpsdRuntimeConfig["automaticAuthority"]> & {
    kind: "manifest-argv-v1";
  };
} {
  const cap = ops.automaticAuthority;
  if (ops.mode !== "auto" || cap?.kind !== "manifest-argv-v1") {
    throw new Error("Livewire repair requires auto mode with a manifest-scoped authority cap");
  }
  if (resolve(cap.manifestRoot) !== resolve(shepherd.livewire.repair.readyDir)) {
    throw new Error("Livewire repair ready directory differs from the signed authority root");
  }
  if (cap.componentId !== "livewire" || cap.executorId !== shepherd.livewire.repair.executorId) {
    throw new Error("Livewire repair config does not match the signed component/executor capability");
  }
  const verifier = cap.verificationExecutor;
  const configuredVerifier = shepherd.scripts.find(
    (script) => script.executorId === shepherd.livewire.repair.postconditionExecutorId,
  );
  if (shepherd.livewire.repair.postconditionExecutorId === cap.executorId ||
      configuredVerifier === undefined || verifier.executorId !== configuredVerifier.executorId ||
      verifier.path !== configuredVerifier.path ||
      JSON.stringify(verifier.identity) !== JSON.stringify(configuredVerifier.identity) ||
      verifier.expectedOwnerUid !== configuredVerifier.expectedOwnerUid ||
      JSON.stringify(verifier.argvSchema) !== JSON.stringify(configuredVerifier.argvSchema)) {
    throw new Error("Livewire postcondition executor differs from the signed read-only capability");
  }
  if (cap.postconditionIds.length !== 1) {
    throw new Error("Livewire repair capability requires one manifest-bound postcondition");
  }
  const promotionInput = JSON.parse(readFileSync(
    join(ops.promotionBundleDir ?? "", "promotion-input.json"),
    "utf8",
  )) as { opsConfig?: unknown; shepherdConfig?: unknown };
  if (canonicalJson(promotionInput.opsConfig) !== canonicalJson(ops) ||
      canonicalJson(promotionInput.shepherdConfig) !== canonicalJson(shepherd)) {
    throw new Error("runtime config differs from the signed promotion config");
  }
}

export function composeLivewireOpsDaemon(
  ops: OpsdRuntimeConfig,
  shepherd: ShepherdRuntimeConfig,
  suppliedStore?: ShepherdStore,
): OpsDaemon {
  assertLivewireOpsBinding(ops, shepherd);
  const store = suppliedStore ?? openShepherdStore(shepherd.stateRoot);
  const cap = ops.automaticAuthority;
  const preparer = new ShepherdRepairPreparer({
    readyDir: shepherd.livewire.repair.readyDir,
    dataLakeRoots: shepherd.livewire.repair.dataLakeRoots,
    now: () => new Date(),
    authorizeArgv: (argv) => authorizeAutomaticArgv(cap, argv),
    verifyEvidence: (evidence) => {
      store.artifacts.verify(evidence.ref, evidence.hash);
    },
  });
  const adapter = new ShepherdRepairOpsAdapter({
    store,
    preparer,
    componentId: cap.componentId,
    sopId: cap.sopId,
    ttlMs: Math.max(ops.intervalMs * 2, 120_000),
  });
  const checkSampler = new LivewireRepairCheckSampler({
    registry: ScriptRegistry.load(shepherd.scripts),
    executorId: shepherd.livewire.repair.postconditionExecutorId,
  });
  let operations: OperationsStore | undefined;
  let operationsEvidence: { readArtifact(ref: { ref: string; sha256: string }): Buffer } | undefined;
  const projector = new ShepherdRepairOutcomeProjector({
    store,
    componentId: cap.componentId,
    sopId: cap.sopId,
    coordination: new FileAppendCoordination({
      directory: shepherd.appendLockRoot,
      bootId: hostBootId(),
    }),
    readRecoveryEvidence: (ref) => {
      if (operationsEvidence === undefined) throw new Error("Ops recovery evidence store is not ready");
      return operationsEvidence.readArtifact(ref);
    },
  });
  projector.reconcile();
  return composeOpsDaemon(ops, {
    additionalProbes: [adapter],
    prepareAction: (sop, incident, policy) => adapter.prepareAction(sop, incident, policy),
    readAdditionalSourceArtifact: (ref) => store.artifacts.read(ref),
    registeredProbeIds: ["livewire.repair-postcondition.v1"],
    additionalCheckSampler: (checks, phase, runner, now) =>
      checkSampler.sample(checks, phase, runner, now),
    onOperationsReady: (store, evidence) => {
      operations = store;
      operationsEvidence = evidence;
      projector.recordOperations(store);
    },
    onTickSuccess: () => {
      if (operations !== undefined) projector.recordOperations(operations);
    },
  });
}

export function validateLivewireOpsConfiguration(
  ops: OpsdRuntimeConfig,
  shepherd: ShepherdRuntimeConfig,
): void {
  assertLivewireOpsBinding(ops, shepherd);
  validateOpsdRelease(ops, ops.releaseDir, {
    registeredProbeIds: ["livewire.repair-postcondition.v1"],
  });
  const scripts = ScriptRegistry.load(shepherd.scripts);
  for (const id of [
    shepherd.livewire.repair.executorId,
    shepherd.livewire.repair.postconditionExecutorId,
  ]) {
    const script = scripts.get(id);
    if (script === undefined) throw new Error(`missing Livewire repair script: ${id}`);
    const identity = scripts.verifyIdentity(script);
    if (!identity.ok) throw new Error(`Livewire repair script identity failed: ${id}: ${identity.reason}`);
  }
}

export async function runLivewireOpsd(argv: readonly string[]): Promise<void> {
  const args = parseLivewireOpsdArgs(argv);
  const ops = loadOpsdRuntimeConfig(args.opsConfigPath);
  const shepherd = loadShepherdRuntimeConfig(args.shepherdConfigPath);
  if (args.command === "check-config") {
    validateLivewireOpsConfiguration(ops, shepherd);
    process.stdout.write(`${JSON.stringify({ ok: true, command: "check-config" })}\n`);
    return;
  }
  const daemon = composeLivewireOpsDaemon(ops, shepherd);
  let finish!: () => void;
  const stopping = new Promise<void>((resolveStopping) => { finish = resolveStopping; });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await daemon.start();
    await stopping;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await daemon.stop();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLivewireOpsd(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`[livewire-opsd] ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
