import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dshBin,
  makeDshHome,
  PINNED_DSH_VERSION,
  repoRoot,
} from "../src/dsh.js";

const fixtureDir = join(repoRoot, "contracts", "fixtures", "team-host");

describe("contract: Helium dispatches team siblings through the real DSH lifecycle seam", () => {
  let dshHome: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    execFileSync("pnpm", ["--filter", "@helium/core", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync("pnpm", ["--filter", "dsh-plugin-helium", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync("pnpm", ["--filter", "@helium/provider-deepseek-dsh", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync("pnpm", ["-C", fixtureDir, "install"], { stdio: "pipe" });
    execFileSync("pnpm", ["-C", fixtureDir, "build"], { stdio: "pipe" });

    const profileDir = join(dshHome, "profiles", "teamhost");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "package.json"),
      `${JSON.stringify(
        {
          name: "dsh-profile-teamhost",
          private: true,
          dsh: {
            profile: {
              bundles: [
                "@deepseek-ai/dsh-base",
                "dsh-plugin-helium-team-host-fixture",
              ],
            },
          },
          dependencies: {
            "@deepseek-ai/dsh-base": PINNED_DSH_VERSION,
            "dsh-plugin-helium-team-host-fixture": `file:${fixtureDir}`,
          },
        },
        undefined,
        2,
      )}\n`,
    );
    writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
    writeFileSync(
      join(profileDir, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - .",
        "",
        "nodeLinker: hoisted",
        "autoInstallPeers: false",
        "allowBuilds:",
        "  esbuild: true",
        "  koffi: true",
        "  node-pty: true",
        "  protobufjs: true",
        "  '@google/genai': true",
        "  '@deepseek-ai/dsh-subprocess-local': true",
        "",
      ].join("\n"),
    );
    execFileSync("pnpm", ["-C", profileDir, "install"], { stdio: "pipe" });
  }, 180_000);

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("isolates sibling cancellation, dispatches the process target, drains, and cold-resumes its parent", async () => {
    const outFile = join(dshHome, "team-host-proof.json");
    const workspaces = join(dshHome, "team-host-workspaces");
    const child = spawn(dshBin, ["--profile", "teamhost"], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        HELIUM_TEAM_HOST_OUT: outFile,
        HELIUM_TEAM_HOST_WORKSPACES: workspaces,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const deadline = Date.now() + 120_000;
    try {
      while (
        Date.now() < deadline &&
        child.exitCode === null &&
        !existsSync(outFile) &&
        !existsSync(`${outFile}.error`)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
    expect(
      existsSync(`${outFile}.error`),
      existsSync(`${outFile}.error`)
        ? readFileSync(`${outFile}.error`, "utf8")
        : "",
    ).toBe(false);
    expect(
      existsSync(outFile),
      `no proof record written; stderr:\n${stderr.join("")}`,
    ).toBe(true);
    expect(JSON.parse(readFileSync(outFile, "utf8"))).toEqual({
      completeOutcome: "completed",
      cancelledClass: "cancelled",
      processOutcome: "completed",
      processCalls: 1,
      deepSeekOutcome: "failed",
      observedDeepSeekRequest: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
      },
      resumedOutcome: "completed",
      parentStates: [false, true],
      activeChildren: 0,
      liveFixtureChildren: 0,
    });
  }, 150_000);
});
