/**
 * Local end-to-end proof of the whole loop (spec §13 AC#2's mechanism, run
 * without any live LLM): poll -> trigger -> triage -> senior -> delivery ->
 * heartbeat, dedup no-refire, restart no-refire. Builds `HeliumRuntime`
 * directly (no dsh runtime, no cordis `Context`) with a stub triage port and
 * the **real** `runClaude` senior lane pointed at a fake `claude` binary, a
 * standalone mutable argon fixture server, and a real `Delivery` instance so
 * the senior report file actually lands on disk. This fixture mechanism is
 * reused verbatim by Task 3.7's AC#3 mini drill.
 * @module dsh-plugin-helium/test/e2e/harness
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonlWriter, jsonlFileName } from "@helium/core";
import { runClaude } from "../../src/claude.js";
import { Delivery } from "../../src/delivery.js";
import type { DispatchResult } from "../../src/dispatch.js";
import { HeliumRuntime } from "../../src/runtime.js";
import { startFixture } from "../fixtures/start-fixture.js";

const FAKE_CLAUDE = fileURLToPath(
  new URL("../fixtures/fake-claude.sh", import.meta.url),
);

const JOB = (argonBase: string): string => `
name: e2e-watch
enabled: true
triggers:
  - kind: state-change
    url: ${argonBase}/api/rates/snapshot
    fields: [regime.state, direction, confidence]
    interval: 200ms
    dedup: 5m
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: none
tools: [argon_api]
max_turns: { triage: 2, senior: 2 }
timeout: 60s
budget: { max_triage_per_hour: 60, max_senior_per_day: 60 }
delivery:
  jsonl: true
prompt: |
  E2E fixture job.
`;

/** Poll `predicate` every 50ms until it holds, or throw after `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitFor: predicate never became true within ${timeoutMs}ms`);
}

// Run the whole golden path in BOTH runtime modes. `work-order-adapter`
// routes every job through adaptV1Job() and back before the dispatcher sees
// it, so this is what turns the v1 regression path into a test of the
// adapter's fidelity: a dropped field changes a delivery record here rather
// than surfacing later as a tenant behaving differently in production.
describe.each(["legacy-direct", "work-order-adapter"] as const)(
  "harness e2e (%s)",
  (runtimeMode) => {
  it("polls, triages, escalates, delivers, dedups and survives restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-e2e-"));
    const stateRoot = join(root, "state");
    const jobsDir = join(root, "jobs");
    mkdirSync(jobsDir, { recursive: true });

    const fx = await startFixture(root, {
      regime: { state: "neutral" },
      direction: "flat",
      confidence: 0.4,
    });

    writeFileSync(join(jobsDir, "e2e-watch.yaml"), JOB(fx.base), "utf8");
    writeFileSync(
      join(root, "ecosystem.md"),
      "# ecosystem\nfixture context\n",
      "utf8",
    );

    // A `claude` binary on PATH: a copy of the fixture script (not a
    // symlink, so mode 0755 survives regardless of the source file's
    // on-disk permissions in this checkout).
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const claudeBin = join(binDir, "claude");
    copyFileSync(FAKE_CLAUDE, claudeBin);
    chmodSync(claudeBin, 0o755);
    const claudeLog = join(root, "claude.log");

    const mails: { job: string; r: DispatchResult }[] = [];
    const heartbeats: Record<string, unknown>[] = [];

    const make = (): HeliumRuntime => {
      const jsonl = new JsonlWriter(join(stateRoot, "jsonl"));
      const delivery = new Delivery({
        jsonl,
        jsonlDir: join(stateRoot, "jsonl"),
        reportsDir: join(stateRoot, "reports"),
        emailTo: "e2e@example.invalid",
        smtp: null,
      });
      return new HeliumRuntime({
        config: {
          runtimeMode,
          jobsDir,
          stateRoot,
          contextFile: join(root, "ecosystem.md"),
          calendarsDir: join(root, "calendars"),
          argonBase: fx.base,
          apexBase: "http://127.0.0.1:1",
          envFile: join(root, "helium.env"),
          claudeTokenFile: join(root, "token.env"),
          proxy: "",
          mcpBin: "",
          emailTo: "e2e@example.invalid",
        },
        engines: {
          triage: {
            dispatch: async () => ({
              outcome: "run_completed" as const,
              verdict: {
                escalate: true,
                severity: "material" as const,
                reason: "regime flipped",
              },
            }),
          },
          senior: {
            dispatch: async (job, _ev, prompt) => {
              const result = await runClaude({
                prompt,
                cwd: root,
                maxTurns: job.maxTurns.senior,
                timeoutMs: job.timeoutMs,
                allowedTools: job.tools,
                env: {
                  PATH: `${binDir}:${process.env.PATH ?? ""}`,
                  FAKE_CLAUDE_LOG: claudeLog,
                },
              });
              if (result.ok) {
                return {
                  outcome: "run_completed" as const,
                  analysis: result.text,
                };
              }
              return {
                outcome:
                  result.classification === "timeout"
                    ? ("timed_out" as const)
                    : ("run_failed" as const),
                error: result.classification,
              };
            },
          },
        },
        delivery: {
          deliver: async (job, ev, r) => {
            await delivery.deliver(job, ev, r);
            mails.push({ job: job.name, r });
          },
          budgetExhausted: (job, ev, info) =>
            delivery.budgetExhausted(job, ev, info),
          heartbeat: (row) => {
            heartbeats.push(row);
            delivery.heartbeat(row);
          },
          // The REAL reconciliation, not a stub: this is the only place the
          // boot-time close-out of a crash-orphaned delivery intent is
          // exercised against a real Delivery over a real JSONL directory.
          reconcileDeliveries: () => delivery.reconcileDeliveries(),
        },
      });
    };

    const rt = make();
    rt.start();

    // 1st cycle establishes the sensor baseline (cold start, never fires).
    await waitFor(
      () => readdirSync(join(stateRoot, "sensors")).length === 1,
      3_000,
    );

    await fx.set({
      regime: { state: "hawkish" },
      direction: "up",
      confidence: 0.8,
    });

    // Assertion 1: the state change fires the trigger and reaches delivery.
    // `deliver()` runs once for the triage-tier outcome and, since the
    // stubbed verdict clears the job's escalation threshold, once more for
    // the senior-tier outcome — wait for that second (senior) delivery.
    await waitFor(() => mails.some((m) => m.r.tier === "senior"), 5_000);
    expect(mails).toHaveLength(2);
    const seniorMail = mails.find((m) => m.r.tier === "senior");

    // Assertion 2: the triage verdict was parsed and carried through to delivery.
    expect(seniorMail?.r.verdict?.severity).toBe("material");

    // Assertion 3: the fake `claude` binary was actually invoked with the
    // job's turn cap.
    expect(readFileSync(claudeLog, "utf8")).toContain("--max-turns");

    // Assertion 4: the senior run landed in the runs ledger.
    const runsText = readFileSync(
      join(stateRoot, "jsonl", jsonlFileName("runs", new Date())),
      "utf8",
    );
    expect(runsText).toContain('"tier":"senior"');

    // Assertion 5: exactly one senior report was written for the job.
    expect(readdirSync(join(stateRoot, "reports", "e2e-watch"))).toHaveLength(
      1,
    );

    // Assertion 6: an unchanged poll after that is silent (dedup holds).
    const before = mails.length;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(mails.length).toBe(before);

    // Heartbeat rows: appended every sensor cycle regardless of outcome
    // (spec §8) — at a 200ms interval, well over 800ms elapsed by now.
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);

    rt.stop();

    // Restart: a brand-new runtime reads the persisted baseline/dedup back
    // from disk (the fixture's state is unchanged since the last poll) and
    // must not re-fire the already-delivered change.
    const rt2 = make();
    rt2.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(mails.length).toBe(before);
    rt2.stop();
    await fx.close();
  }, 20_000);
  },
);
