import { configDefaults, defineConfig } from "vitest/config";

// The local E2E harness (Task 3.1): a separate vitest project, deliberately
// outside `pnpm test`'s "unit" project — it spawns real child processes
// (the argon fixture, a fake `claude` binary) and is meant to be run
// explicitly on a laptop/mini, not as part of the CI unit lane.
export default defineConfig({
  test: {
    include: ["**/*.e2e.test.ts"],
    // A run from the primary checkout would otherwise also collect
    // `.worktrees/*/plugins/helium/test/e2e/*.e2e.test.ts` and execute
    // whatever commit a worktree happens to sit on, folding that into the
    // gate's evidence. `configDefaults.exclude` is spread back in on purpose:
    // a bare `exclude: [".worktrees/**"]` REPLACES vitest's defaults, and
    // `**/node_modules/**` is one of them — without it the gate also collects
    // `node_modules/.pnpm/node_modules/dsh-plugin-helium/test/e2e/*` (a
    // workspace symlink back to `plugins/helium`) and runs every e2e file
    // twice. Verified by running the gate both ways on 2026-08-29.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    testTimeout: 30_000,
  },
});
