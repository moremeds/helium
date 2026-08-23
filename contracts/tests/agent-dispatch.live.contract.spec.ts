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
import { dshBin, makeDshHome, repoRoot } from "../src/dsh.js";

const live = process.env.HELIUM_LIVE === "1";
const fixtureDir = join(
  repoRoot,
  "contracts",
  "fixtures",
  "plugin-live-dispatch",
);

describe.skipIf(!live)(
  "contract (live): one real deepseek-v4-flash turn",
  () => {
    let dshHome: string;

    beforeAll(() => {
      expect(
        process.env.DEEPSEEK_API_KEY,
        "DEEPSEEK_API_KEY must be set for HELIUM_LIVE=1",
      ).toBeTruthy();
      dshHome = makeDshHome();
      execFileSync("pnpm", ["-C", fixtureDir, "install"], { stdio: "pipe" });
      execFileSync("pnpm", ["-C", fixtureDir, "build"], { stdio: "pipe" });
      const profileDir = join(dshHome, "profiles", "heliumlive");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "package.json"),
        `${JSON.stringify(
          {
            name: "dsh-profile-heliumlive",
            private: true,
            dsh: {
              profile: {
                bundles: [
                  "@deepseek-ai/dsh-base",
                  "dsh-plugin-helium-live-dispatch",
                ],
              },
            },
            dependencies: {
              "dsh-plugin-helium-live-dispatch": `file:${fixtureDir}`,
            },
          },
          undefined,
          2,
        )}\n`,
      );
      writeFileSync(join(profileDir, "cordis.patch.yml"), "[]\n");
      writeFileSync(
        join(profileDir, "pnpm-workspace.yaml"),
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
      );
      execFileSync("pnpm", ["-C", profileDir, "install"], { stdio: "pipe" });
    });

    afterAll(() => {
      rmSync(dshHome, { recursive: true, force: true });
    });

    it("creates an agent, follows up, idles, and captures the final text", async () => {
      const outFile = join(dshHome, "live.jsonl");
      const child = spawn(dshBin, ["--profile", "heliumlive"], {
        env: { ...process.env, DSH_HOME: dshHome, HELIUM_LIVE_OUT: outFile },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: string[] = [];
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
      const deadline = Date.now() + 180_000;
      try {
        while (Date.now() < deadline && !existsSync(outFile)) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        child.kill("SIGTERM");
      }
      expect(
        existsSync(outFile),
        `no dispatch record; stderr:\n${stderr.join("")}`,
      ).toBe(true);
      const record = JSON.parse(readFileSync(outFile, "utf8").trim()) as {
        finalText: string;
        sessionId: string;
        latencyMs: number;
      };
      expect(record.sessionId).toMatch(/^session-/);
      expect(record.finalText.trim().length).toBeGreaterThan(0);
      expect(record.latencyMs).toBeGreaterThan(0);
    });
  },
);
