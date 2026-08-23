import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/tests/**/*.spec.ts",
            "plugins/*/tests/**/*.spec.ts",
            "plugins/*/src/**/*.test.ts",
          ],
          // Belt-and-suspenders: the local E2E harness (Task 3.1) already
          // lives outside these include globs (plugins/*/test/e2e/, not
          // src/ or tests/), but excluding it explicitly keeps it out of
          // the CI unit lane even if that ever changes.
          exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          name: "contracts",
          environment: "node",
          include: ["contracts/tests/**/*.spec.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          // dsh boots and pnpm installs are not parallel-safe against one
          // throwaway $DSH_HOME each; keep contract files serialized.
          fileParallelism: false,
        },
      },
    ],
  },
});
