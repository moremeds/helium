#!/usr/bin/env node
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContentAddressedArtifactStore } from "@helium/core";
import {
  hostBootId,
  ScriptExecutor,
  ScriptRegistry,
} from "dsh-plugin-ops-agent";
import { FileAppendCoordination } from "../append-coordination.js";
import { LivewireBridge } from "../bridge.js";
import { loadShepherdRuntimeConfig } from "../config.js";
import { ShepherdCoordinator } from "../coordinator.js";
import { ShepherdDaemon } from "../daemon.js";
import { ShepherdScheduler } from "../scheduler.js";
import { openShepherdStore } from "../store.js";

export function composeShepherdDaemon(configPath: string): ShepherdDaemon {
  const config = loadShepherdRuntimeConfig(configPath);
  const store = openShepherdStore(config.stateRoot);
  const registry = ScriptRegistry.load(config.scripts);
  const coordinator = new ShepherdCoordinator(
    store,
    new FileAppendCoordination({ directory: config.appendLockRoot, bootId: hostBootId() }),
    { ownerId: `shepherdd-${process.pid}` },
  );
  const bridge = new LivewireBridge({
    registry,
    executor: new ScriptExecutor(registry),
    artifacts: new ContentAddressedArtifactStore(join(config.stateRoot, "artifacts")),
    changedPathRoots: config.livewire.changedPathRoots,
  });
  const probeScript = registry.get(config.livewire.executorId)!;
  return new ShepherdDaemon({
    store,
    coordinator,
    scheduler: new ShepherdScheduler(),
    scanner: { scan: async () => [] },
    bridge,
    executorId: config.livewire.executorId,
    providerRetryMs: config.providerRetryMs,
    attemptLeaseMs: probeScript.timeoutMs + 10_000,
    intervalMs: config.intervalMs,
  });
}

export async function runShepherdd(argv: readonly string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--config" || argv[1] === undefined || !isAbsolute(argv[1])) {
    throw new Error("usage: shepherdd --config ABSOLUTE_PATH");
  }
  const daemon = composeShepherdDaemon(argv[1]);
  let finish!: () => void;
  const stopping = new Promise<void>((resolve) => { finish = resolve; });
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
  runShepherdd(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`[shepherdd] ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
