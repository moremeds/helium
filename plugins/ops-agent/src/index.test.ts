import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { OpsDaemon, type OpsAnalysisClient } from "./bin/opsd.js";
import { apply, inject, name } from "./index.js";

async function dshFixture(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "process.stdout.write('READY\\n'); process.stdin.resume();",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(child.stdout, "data");
  return child;
}

describe("standalone opsd", () => {
  it("keeps the deterministic path running after the optional DSH process stops", async () => {
    interface FakeSnapshot {
      observations: { id: string }[];
      incidents: { id: string }[];
      actions: { disposition: string; outcome: string }[];
      collectionFailures: never[];
    }
    process.env.HELIUM_TEST_NO_PROVIDERS = "1";
    const dsh = await dshFixture();
    let ticks = 0;
    let controlStarted = 0;
    let controlStopped = 0;
    const analysisErrors: string[] = [];
    const analysis: OpsAnalysisClient<FakeSnapshot> = {
      async publish() {
        if (dsh.exitCode !== null || dsh.killed) {
          throw new Error("DSH fixture unavailable");
        }
        dsh.stdin.write("incident\n");
      },
    };
    const daemon = new OpsDaemon<FakeSnapshot>({
      controller: {
        async tick() {
          ticks += 1;
          return {
            // One tick represents the complete deterministic sequence: the
            // fake collector, correlator and eligible auto SOP all completed.
            observations: [{ id: `observation-${ticks}` }],
            incidents: [{ id: `incident-${ticks}` }],
            actions: [{ disposition: "execute", outcome: "succeeded" }],
            collectionFailures: [],
          };
        },
      },
      control: {
        async start() {
          controlStarted += 1;
        },
        async stop() {
          controlStopped += 1;
        },
      },
      analysis,
      intervalMs: 60_000,
      onError: (error) => analysisErrors.push(error.message),
    });

    try {
      await daemon.start();
      expect(ticks).toBe(1);
      dsh.kill("SIGTERM");
      await once(dsh, "exit");

      const second = await daemon.tickOnce();
      expect(second.actions).toEqual([
        { disposition: "execute", outcome: "succeeded" },
      ]);
      expect(ticks).toBe(2);
      expect(analysisErrors).toContain("DSH fixture unavailable");
      expect(controlStarted).toBe(1);
    } finally {
      if (dsh.exitCode === null) dsh.kill("SIGKILL");
      await daemon.stop();
      delete process.env.HELIUM_TEST_NO_PROVIDERS;
    }
    expect(controlStopped).toBe(1);
  });

  it("exports a provider-free optional DSH adapter", () => {
    expect(name).toBe("ops-agent");
    expect(inject).toEqual([]);
    expect(() =>
      apply(
        {
          effect(start: () => () => void) {
            start()();
          },
        },
        { socketPath: "/tmp/opsd.sock" },
      ),
    ).not.toThrow();
  });
});
