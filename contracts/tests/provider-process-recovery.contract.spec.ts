import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PROCESS_RECEIPT_FILE,
  reapOrphanProviderProcesses,
} from "../../packages/provider-sdk/src/process-receipt.js";
import { execFileSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@helium/provider-sdk", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["--filter", "@helium/provider-codex-subscription", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
});

describe("provider process crash recovery", () => {
  it("kills the controller during execution and reaps the exact orphan process group", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-provider-crash-"));
    const workspace = join(root, "workspaces", "attempt-1");
    const bin = join(root, "bin");
    const ready = join(root, "provider-ready");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, "codex");
    writeFileSync(
      codex,
      [
        "#!/bin/sh",
        "trap '' TERM",
        'printf ready > "$HELIUM_PROVIDER_READY"',
        "while true; do /bin/sleep 1; done",
      ].join("\n"),
    );
    chmodSync(codex, 0o755);

    const controller = spawn(
      process.execPath,
      [join(repoRoot, "contracts", "fixtures", "provider-process-controller.mjs")],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HELIUM_PROVIDER_WORKSPACE: workspace,
          HELIUM_PROVIDER_PATH: bin,
          HELIUM_PROVIDER_READY: ready,
        },
        stdio: "ignore",
      },
    );
    const receiptPath = join(workspace, PROCESS_RECEIPT_FILE);
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (!existsSync(receiptPath) || !existsSync(ready)) &&
      controller.exitCode === null
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(ready)).toBe(true);
    const providerPid = JSON.parse(readFileSync(receiptPath, "utf8")).pid as number;

    controller.kill("SIGKILL");
    await new Promise<void>((resolve) => controller.once("exit", () => resolve()));
    expect(() => process.kill(providerPid, 0)).not.toThrow();

    const outcomes = await reapOrphanProviderProcesses(join(root, "workspaces"), {
      graceMs: 100,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ pid: providerPid, outcome: "reaped" }),
    ]);
    expect(existsSync(workspace)).toBe(false);
    expect(() => process.kill(providerPid, 0)).toThrow();
  }, 30_000);
});
