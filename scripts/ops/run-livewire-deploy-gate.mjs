#!/usr/bin/env node
/** Required pre-deploy matrix for the Livewire Shepherd production package. */
import { spawnSync } from "node:child_process";

const livewireRoot = process.env.HELIUM_LIVEWIRE_ROOT;
const livewireCommit = process.env.HELIUM_LIVEWIRE_COMMIT;
if (typeof livewireRoot !== "string" || livewireRoot === "" ||
    typeof livewireCommit !== "string" || !/^[0-9a-f]{40}$/.test(livewireCommit)) {
  process.stderr.write("HELIUM_LIVEWIRE_ROOT and exact HELIUM_LIVEWIRE_COMMIT are required\n");
  process.exit(1);
}

const suites = [
  [
    "run", "--project", "unit",
    "plugins/ops-agent/src/action-runner.test.ts",
    "plugins/ops-agent/src/script-executor.test.ts",
    "plugins/ops-agent/src/controller.test.ts",
    "plugins/livewire-shepherd/src/daemon.test.ts",
    "plugins/livewire-shepherd/src/livewire-cycle.test.ts",
    "plugins/livewire-shepherd/src/scheduler.test.ts",
    "plugins/livewire-shepherd/src/coordinator.test.ts",
    "plugins/livewire-shepherd/src/team-tools.test.ts",
    "plugins/livewire-shepherd/src/repair-controller.test.ts",
    "plugins/livewire-shepherd/src/repair-ops-adapter.test.ts",
    "plugins/livewire-shepherd/src/repair-outcomes.test.ts",
    "plugins/livewire-shepherd/src/repair-checks.test.ts",
  ],
  [
    "run", "--project", "contracts",
    "contracts/tests/livewire-shepherd-recovery.contract.spec.ts",
    "contracts/tests/ops-action-boundary.contract.spec.ts",
    "contracts/tests/ops-controller.contract.spec.ts",
  ],
];

for (const args of suites) {
  const result = spawnSync("pnpm", ["exec", "vitest", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HELIUM_REQUIRE_LIVEWIRE_CONTRACT: "1" },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

