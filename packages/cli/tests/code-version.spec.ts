import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dshVersion } from "../src/code-version.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("dshVersion", () => {
  // dsh is a devDependency of the root manifest. Reading only `dependencies`
  // is why a deployed evidence header recorded `dshVersion: "unknown"`, which
  // makes the prompt beside it unreproducible.
  it("reads the pin out of devDependencies, not only dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned =
      manifest.dependencies?.["@deepseek-ai/dsh"] ??
      manifest.devDependencies?.["@deepseek-ai/dsh"];
    expect(pinned).toBeDefined();
    expect(dshVersion()).toBe(pinned);
    expect(dshVersion()).not.toBe("unknown");
  });
});
