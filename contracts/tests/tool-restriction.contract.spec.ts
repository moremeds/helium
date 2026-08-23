/**
 * Runtime proof for the coverage gap task-2.3-report.md flagged: does
 * agentCtx.tools.restrict({ deny }) inside a real dsh agent's setup()
 * actually remove a tool from that agent's own schemas() view? Non-live:
 * the fixture plugin never calls followup()/turn(), so no model is ever
 * invoked and no API key is required -- this boots a real dsh-base profile
 * and a real ToolRuntime, the cheapest genuine runtime proof available
 * without DEEPSEEK_API_KEY (task-2.7's carry-in 1).
 */
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

const fixtureDir = join(
  repoRoot,
  "contracts",
  "fixtures",
  "plugin-restrict-proof",
);

describe("contract: agentCtx.tools.restrict() denies a tool in the agent's own scoped view", () => {
  let dshHome: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    execFileSync("pnpm", ["-C", fixtureDir, "install"], { stdio: "pipe" });
    execFileSync("pnpm", ["-C", fixtureDir, "build"], { stdio: "pipe" });

    const profileDir = join(dshHome, "profiles", "restrictproof");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "package.json"),
      `${JSON.stringify(
        {
          name: "dsh-profile-restrictproof",
          private: true,
          dsh: {
            profile: {
              bundles: [
                "@deepseek-ai/dsh-base",
                "dsh-plugin-helium-restrict-proof",
              ],
            },
          },
          dependencies: {
            // dsh-base must be an explicit dependency, not only a bundle
            // entry -- listing it only in `dsh.profile.bundles` leaves it
            // unresolvable from the profile's own node_modules, and the
            // agent this fixture creates then gets an UNSCOPED agentCtx
            // (agentCtx.tools.restrict() throws "requires a scoped
            // context"). Verified by reproducing both states live during
            // this task: this dependency entry is the fix.
            "@deepseek-ai/dsh-base": PINNED_DSH_VERSION,
            "dsh-plugin-helium-restrict-proof": `file:${fixtureDir}`,
          },
        },
        undefined,
        2,
      )}\n`,
    );
    writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
    // Mirrors the root pnpm-workspace.yaml allowBuilds block: dsh-base pulls
    // koffi/node-pty/protobufjs/@google/genai/dsh-subprocess-local, whose
    // install scripts pnpm otherwise refuses to run
    // (ERR_PNPM_IGNORED_BUILDS, task-1.7-report.md's fix round 1).
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
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("keeps the allow-listed tool visible and removes the denied one", async () => {
    const outFile = join(dshHome, "restrict-proof.json");
    const child = spawn(dshBin, ["--profile", "restrictproof"], {
      env: { ...process.env, DSH_HOME: dshHome, HELIUM_RESTRICT_OUT: outFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const deadline = Date.now() + 120_000;
    try {
      while (
        Date.now() < deadline &&
        !existsSync(outFile) &&
        !existsSync(`${outFile}.error`)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      child.kill("SIGTERM");
    }
    expect(
      existsSync(`${outFile}.error`),
      `fixture plugin threw:\n${existsSync(`${outFile}.error`) ? readFileSync(`${outFile}.error`, "utf8") : ""}`,
    ).toBe(false);
    expect(
      existsSync(outFile),
      `no proof record written; stderr:\n${stderr.join("")}`,
    ).toBe(true);

    const record = JSON.parse(readFileSync(outFile, "utf8")) as {
      globalBefore: string[];
      visibleAfterRestrict: string[];
    };
    // globalBefore also carries dsh-base's own built-in tools (bash, edit,
    // read, ...); only the two probes this fixture registered are asserted.
    expect(record.globalBefore).toContain("probe_kept");
    expect(record.globalBefore).toContain("probe_denied");
    expect(record.visibleAfterRestrict).toContain("probe_kept");
    expect(record.visibleAfterRestrict).not.toContain("probe_denied");
  });
});
