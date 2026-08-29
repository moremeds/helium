import { describe, expect, it } from "vitest";
import type { Observation } from "@helium/core";
import {
  Collector,
  type ObservationProbe,
  type ObservationSink,
} from "./collector.js";
import {
  processProbe,
  type CommandResult,
  type CommandRunner,
} from "./probes/process.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function observation(
  probeId: string,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    version: 1,
    id: `obs-${probeId}-${NOW.getTime()}`,
    componentId: "host",
    probeId,
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    state: "ok",
    dimension: "readiness",
    evidenceRefs: [`artifact://probe/${probeId}`],
    parserVersion: "fixture/1",
    ...overrides,
  };
}

function sink(): ObservationSink & { rows: Observation[] } {
  const rows: Observation[] = [];
  return {
    rows,
    async append(row) {
      rows.push(row);
    },
  };
}

const runner = (
  reply: CommandResult = { stdout: "helium-opsd", exitCode: 0, timedOut: false },
): CommandRunner & { calls: { argv: readonly string[]; timeoutMs: number }[] } => {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  return {
    calls,
    async run(argv, timeoutMs) {
      calls.push({ argv, timeoutMs });
      return reply;
    },
  };
};

describe("Collector", () => {
  it("runs a probe with its exact argv and timeout, then appends to the injected sink", async () => {
    const output = sink();
    const commands = runner();
    const probe = processProbe({
      componentId: "host",
      probeId: "host.process.v1",
      argv: ["/bin/ps", "-Ao", "pid,comm"],
      match: "helium-opsd",
      timeoutMs: 1_250,
    });

    const collector = new Collector({
      probes: [probe],
      runner: commands,
      sink: output,
      now: () => NOW,
    });
    const result = await collector.collectOnce();

    expect(commands.calls).toEqual([
      { argv: ["/bin/ps", "-Ao", "pid,comm"], timeoutMs: 1_250 },
    ]);
    expect(output.rows).toHaveLength(1);
    expect(result).toEqual({ observations: output.rows, failures: [] });
  });

  it("appends every volume observation independently", async () => {
    const output = sink();
    const volumes: ObservationProbe = {
      probeId: "host.volumes.v1",
      async observe() {
        return [
          observation("host.volume.internal-data.v1", {
            id: "obs-internal-data",
            dimension: "volume-internal-data",
          }),
          observation("host.volume.data-lake.v1", {
            id: "obs-data-lake",
            dimension: "volume-data-lake",
            state: "degraded",
          }),
          observation("host.volume.colima.v1", {
            id: "obs-colima",
            dimension: "volume-colima",
          }),
          observation("host.volume.backup.v1", {
            id: "obs-backup",
            dimension: "volume-backup",
          }),
          observation("host.volume.helium-state.v1", {
            id: "obs-helium-state",
            dimension: "volume-helium-state",
          }),
        ];
      },
    };

    await new Collector({
      probes: [volumes],
      runner: runner(),
      sink: output,
      now: () => NOW,
    }).collectOnce();

    expect(output.rows.map((row) => row.dimension)).toEqual([
      "volume-internal-data",
      "volume-data-lake",
      "volume-colima",
      "volume-backup",
      "volume-helium-state",
    ]);
    expect(output.rows.map((row) => row.state)).toEqual([
      "ok",
      "degraded",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("turns a stale reading unknown instead of retaining last-known-good health", async () => {
    const output = sink();
    const stale: ObservationProbe = {
      probeId: "host.stale.v1",
      async observe() {
        return observation("host.stale.v1", {
          observedAt: "2026-08-29T11:58:00.000Z",
          expiresAt: "2026-08-29T11:59:00.000Z",
          value: { raw: "healthy" },
        });
      },
    };

    await new Collector({
      probes: [stale],
      runner: runner(),
      sink: output,
      now: () => NOW,
    }).collectOnce();

    expect(output.rows[0]).toMatchObject({
      state: "unknown",
      value: { raw: "healthy", stale: true },
    });
  });

  it("isolates a failed probe and still collects the remaining probes", async () => {
    const output = sink();
    const broken: ObservationProbe = {
      probeId: "host.broken.v1",
      async observe() {
        throw new Error("fixture timeout");
      },
    };
    const healthy: ObservationProbe = {
      probeId: "host.healthy.v1",
      async observe() {
        return observation("host.healthy.v1");
      },
    };

    const result = await new Collector({
      probes: [broken, healthy],
      runner: runner(),
      sink: output,
      now: () => NOW,
    }).collectOnce();

    expect(output.rows.map((row) => row.probeId)).toEqual(["host.healthy.v1"]);
    expect(result.failures).toEqual([
      { probeId: "host.broken.v1", reason: "fixture timeout" },
    ]);
  });

  it("rejects an unbounded probe set before collection starts", () => {
    const probes: ObservationProbe[] = Array.from({ length: 3 }, (_, index) => ({
      probeId: `probe-${index}`,
      async observe() {
        return observation(`probe-${index}`);
      },
    }));

    expect(
      () =>
        new Collector({
          probes,
          runner: runner(),
          sink: sink(),
          now: () => NOW,
          maxProbes: 2,
        }),
    ).toThrow(/probe limit/);
  });
});
