import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployHeliumProfile, dshBin, makeDshHome } from "../src/dsh.js";

/** Resolve once `predicate()` holds, or reject after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Re-enabled per task-3.1-brief.md Step 11 (carried in from task-2.7-report.md):
 * `profile/cordis.patch.yml` now carries the same pinned env contract as
 * `plugins/helium/cordis.patch.yml` instead of the stale Task-1.5-era
 * `tickFile` field, so `apply()` receives a real `Config` and the runtime's
 * per-job sensor loop actually starts. `HELIUM_CONTRACT_TICK_FILE` was
 * dropped along with that placeholder mechanism (no reader anywhere in
 * plugins/helium/src/ — grepped, zero matches); this contract now observes
 * the real mechanism instead, the `heartbeat` JSONL stream `HeliumRuntime`
 * appends to every sensor cycle (spec §8).
 */
/** An ephemeral loopback port, so a booted profile never collides with whatever already holds dsh's default :3080. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("contract: ctx.effect interval timers run inside a booted profile", () => {
  let dshHome: string;
  let stateRoot: string;
  let tenantsDir: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    deployHeliumProfile(dshHome);

    stateRoot = join(dshHome, "helium-state");
    tenantsDir = join(dshHome, "helium-plugins");
    mkdirSync(join(tenantsDir, "contract-watch"), { recursive: true });
    writeFileSync(
      join(dshHome, "ecosystem.md"),
      "# ecosystem\ncontract fixture\n",
      "utf8",
    );
    // One enabled tenant with a daily cron. The heartbeat under observation
    // is the LIVENESS row `TenantRuntime.start()` arms — a business trigger
    // would need a real fire, and the dead-man's window is fed by liveness
    // anyway (a daily tenant is otherwise MISSING for ~23h50m every day).
    writeFileSync(
      join(tenantsDir, "contract-watch", "tenant.yaml"),
      [
        "tenant: contract-watch",
        "enabled: true",
        "team: team.yaml",
        "promotionMode: shadow",
        "triggers:",
        "  - kind: cron",
        '    schedule: "0 4 * * *"',
        "    timezone: UTC",
        "delivery:",
        "  jsonl: true",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(tenantsDir, "contract-watch", "team.yaml"),
      [
        'manifestVersion: "1"',
        "name: contract-watch",
        "roles:",
        "  scribe:",
        "    responsibility: rendering",
        "    requires: [render]",
        "    permissions:",
        "      externalResearch: false",
        "      mutations: forbidden",
        "      artifactRead: [accepted-claim-ledger]",
        "      tools: []",
        "tasks:",
        "  - id: render",
        "    role: scribe",
        "    dependsOn: []",
        "    requires: [render]",
        "    inputs: [accepted-claim-ledger]",
        "    outputSchema: report@1",
        "crossReference:",
        "  compareClaims: true",
        "  materialContradictions: fresh-evidence-work-order",
        "  requireIndependentEvidence: true",
        "budgets: { maxAttempts: 1, maxTokens: 1000 }",
        "acceptance: { allowPartialClaims: true, terminalTasks: [render] }",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("starts the per-tenant liveness loop and stops cleanly on SIGTERM", async () => {
    const heartbeatFile = (): string =>
      join(
        stateRoot,
        "jsonl",
        `heartbeat-${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
    const rowCount = (): number => {
      if (!existsSync(heartbeatFile())) return 0;
      return readFileSync(heartbeatFile(), "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "").length;
    };

    const stderr: string[] = [];
    const stdout: string[] = [];
    // The helium profile carries the @deepseek-ai/dsh-web-app bundle, which
    // binds :3080 by default and would also pop a browser window on every
    // contract run. Neither belongs in a test that only cares about ctx.effect
    // timers, and the default port is genuinely taken during bring-up work (an
    // ssh -L tunnel to the mini's UI made this test hang for its full 60s
    // timeout). Bind an ephemeral port instead and keep the browser shut.
    const port = await freePort();
    const child = spawn(
      dshBin,
      ["--profile", "helium", "--port", String(port), "--no-open"],
      {
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          HELIUM_TENANTS_DIR: tenantsDir,
          HELIUM_TENANT_LIVENESS_MS: "500",
          HELIUM_STATE_ROOT: stateRoot,
          HELIUM_CONTEXT_FILE: join(dshHome, "ecosystem.md"),
          HELIUM_ARGON_BASE: "http://127.0.0.1:1",
          HELIUM_APEX_BASE: "http://127.0.0.1:1",
          HELIUM_ENV_FILE: join(dshHome, "helium.env"),
          HELIUM_CLAUDE_TOKEN_FILE: join(dshHome, "claude-token.env"),
          HELIUM_PROXY: "",
          HELIUM_MCP_BIN: "true",
          HELIUM_EMAIL_TO: "contract@example.invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    try {
      await waitFor(
        () => rowCount() >= 2,
        60_000,
        `two heartbeat rows in ${heartbeatFile()}; stdout was:\n${stdout.join("")}\nstderr was:\n${stderr.join("")}`,
      );
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
  });
});
