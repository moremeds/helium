import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["bundles/*/tests/**/*.spec.ts"],
        },
      },
      {
        // Boots the real `dsh` against a throwaway $DSH_HOME with a fake LLM.
        // Needs `pnpm build` first: DSH loads the bundles' lib/ output.
        test: {
          name: "compose",
          environment: "node",
          include: ["bundles/*/tests/**/*.compose.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
