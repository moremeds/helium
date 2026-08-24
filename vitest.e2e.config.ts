import { defineConfig } from "vitest/config";

// The local E2E harness (Task 3.1): a separate vitest project, deliberately
// outside `pnpm test`'s "unit" project — it spawns real child processes
// (the argon fixture, a fake `claude` binary) and is meant to be run
// explicitly on a laptop/mini, not as part of the CI unit lane.
export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    testTimeout: 30_000,
  },
});
