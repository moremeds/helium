import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dshBin, makeDshHome, repoRoot } from "../src/dsh.js";

describe("contract: dsh plugin add file: installs helium into a fresh profile", () => {
  let dshHome: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    execFileSync("pnpm", ["-C", repoRoot, "-F", "dsh-plugin-helium", "build"], {
      stdio: "pipe",
    });
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("adds the package and joins it to the profile bundle stack", () => {
    execFileSync(
      dshBin,
      [
        "plugin",
        "--profile",
        "heliumadd",
        "add",
        `file:${join(repoRoot, "plugins", "helium")}`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, DSH_HOME: dshHome },
        encoding: "utf8",
      },
    );
    const manifest = JSON.parse(
      readFileSync(
        join(dshHome, "profiles", "heliumadd", "package.json"),
        "utf8",
      ),
    ) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };
    expect(Object.keys(manifest.dependencies ?? {})).toContain(
      "dsh-plugin-helium",
    );
    expect(manifest.dsh?.profile?.bundles).toContain("dsh-plugin-helium");
  });
});
