/**
 * NOTE ON THE FIXTURES BELOW.
 *
 * These are AUTHORED command-output shapes, not captures from the audited
 * host. The AC#1 observation window forbids touching the mini, so nothing here
 * was read off it. They are representative of the format these tools emit and
 * are sufficient to pin the parsers and the classification rule; they are not
 * evidence about the real machine, and the P2.5a manifest records that limit.
 *
 * The NUMBERS, however, are the audited ones: 16 GiB total and ~6.67 GiB of
 * swap allocated with no sustained burst, which the audit classified as
 * chronic capacity pressure rather than an immediate outage.
 */
import { readFileSync } from "node:fs";
import { ComponentSpecSchema } from "@helium/core/operations/component.js";
import { ObservationSchema } from "@helium/core/operations/observation.js";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  classifyMemory,
  macosResourceProbe,
  pageoutRate,
  parseCpuTop,
  parseLoadAverage,
  parseMemoryPressure,
  parseSize,
  parseSwapUsage,
  parseVmStat,
  SUSTAINED_PAGEOUT_RATE,
  type MemorySample,
} from "./macos-resource.js";
import type { CommandResult, CommandRunner } from "./process.js";

const HOST_COMPONENT = ComponentSpecSchema.parse(
  parse(
    readFileSync(
      new URL("../../../../ops/components/host.yaml", import.meta.url),
      "utf8",
    ),
  ),
);

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              123456.
Pages active:                            234567.
Pages inactive:                          345678.
Pages occupied by compressor:            120000.
Pageouts:                                987654.
Swapins:                                 1234.
Swapouts:                                5678.`;

const SWAP_USAGE = `vm.swapusage: total = 8192.00M  used = 6830.08M  free = 1361.92M  (encrypted)`;
const SWAP_USAGE_COMMA = `vm.swapusage: total = 8192,00M  used = 6830,08M  free = 1361,92M  (encrypted)`;
const UPTIME = `19:42  up 12 days,  3:11, 2 users, load averages: 1.85 2.04 2.11`;
const UPTIME_COMMA = `19:42  up 12 days,  3:11, 2 users, load averages: 1,85 2,04 2,11`;
const TOP = `Processes: 550 total, 3 running, 547 sleeping, 3300 threads
CPU usage: 12.00% user, 8.00% sys, 80.00% idle
PID COMMAND %CPU
200 helium-opsd 12.5
300 postgres 4.0`;
const TOP_BUSY = `Processes: 550 total, 6 running, 544 sleeping, 3300 threads
CPU usage: 70.00% user, 20.00% sys, 10.00% idle
PID COMMAND %CPU
200 helium-opsd 62.5
300 postgres 20.0`;
const NOW = "2026-08-29T12:00:00.000Z";

const GIB = 1024 ** 3;
const TOTAL = 16 * GIB;

const sample = (overrides: Partial<MemorySample> = {}): MemorySample => ({
  parsed: true,
  totalBytes: TOTAL,
  swap: parseSwapUsage(SWAP_USAGE),
  vmStat: parseVmStat(VM_STAT),
  atMs: 60_000,
  serviceImpact: false,
  ampleIdleCpu: true,
  ...overrides,
});

describe("parseSize", () => {
  it("reads the suffixes these tools emit", () => {
    expect(parseSize("1024K")).toBe(1024 * 1024);
    expect(parseSize("6.67G")).toBe(Math.round(6.67 * GIB));
    expect(parseSize("8192.00M")).toBe(8192 * 1024 * 1024);
  });

  // A comma decimal separator read as a thousands separator turns 6.67 GiB
  // into 667 GiB, which would classify a pressured host as healthy.
  it("reads a comma decimal separator as a decimal point", () => {
    expect(parseSize("6,67G")).toBe(parseSize("6.67G"));
  });

  it("returns undefined rather than guessing", () => {
    for (const bad of ["", "lots", "6.67X", "G", "--"]) {
      expect(parseSize(bad)).toBeUndefined();
    }
  });
});

describe("parseSwapUsage", () => {
  it("reads the audited swap allocation", () => {
    const swap = parseSwapUsage(SWAP_USAGE);
    expect(swap?.usedBytes).toBe(Math.round(6830.08 * 1024 * 1024));
    expect((swap?.usedBytes ?? 0) / GIB).toBeCloseTo(6.67, 2);
  });

  it("is locale-tolerant", () => {
    expect(parseSwapUsage(SWAP_USAGE_COMMA)).toEqual(parseSwapUsage(SWAP_USAGE));
  });

  it("returns undefined on missing fields rather than defaulting them to zero", () => {
    expect(parseSwapUsage("vm.swapusage: total = 8192.00M")).toBeUndefined();
    expect(parseSwapUsage("")).toBeUndefined();
  });
});

describe("parseVmStat", () => {
  it("reads the page size, compressor pages and the pageouts counter", () => {
    expect(parseVmStat(VM_STAT)).toEqual({
      pageSizeBytes: 16384,
      compressedPages: 120000,
      pageoutsCounter: 987654,
    });
  });

  it("returns undefined when a required field is absent", () => {
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)")).toBeUndefined();
    expect(parseVmStat("nonsense")).toBeUndefined();
  });
});

describe("parseLoadAverage", () => {
  it("reads three load averages", () => {
    expect(parseLoadAverage(UPTIME)).toEqual({ one: 1.85, five: 2.04, fifteen: 2.11 });
  });

  it("is locale-tolerant", () => {
    expect(parseLoadAverage(UPTIME_COMMA)).toEqual(parseLoadAverage(UPTIME));
  });

  it("returns undefined on unparseable input", () => {
    expect(parseLoadAverage("up 3 days")).toBeUndefined();
  });
});

describe("parseMemoryPressure", () => {
  it("interprets named pressure states and free percentages", () => {
    expect(parseMemoryPressure("System-wide memory pressure: critical")).toEqual({
      level: "critical",
    });
    expect(parseMemoryPressure("System-wide memory free percentage: 9%"))
      .toEqual({ level: "warning", freePercent: 9 });
  });

  it("refuses a recognizable prefix with an unknown value", () => {
    expect(parseMemoryPressure("System-wide memory pressure: mysterious"))
      .toBeUndefined();
  });
});

describe("parseCpuTop", () => {
  it("reads busy time and bounded per-process contribution", () => {
    expect(parseCpuTop(TOP)).toEqual({
      busyPercent: 20,
      idlePercent: 80,
      processes: [
        { pid: 200, command: "helium-opsd", cpuPercent: 12.5 },
        { pid: 300, command: "postgres", cpuPercent: 4 },
      ],
    });
  });
});

describe("pageoutRate", () => {
  it("computes a rate from consecutive samples", () => {
    expect(
      pageoutRate(sample({ previous: { pageoutsCounter: 987_054, atMs: 0 } })),
    ).toBe(10);
  });

  it("has no rate without a previous sample", () => {
    expect(pageoutRate(sample())).toBeUndefined();
  });

  // A counter that went backwards means a reboot or a wrap. Computing a rate
  // across that boundary invents a burst that never happened.
  it("has no rate across a counter reset", () => {
    expect(
      pageoutRate(sample({ previous: { pageoutsCounter: 999_999_999, atMs: 0 } })),
    ).toBeUndefined();
  });

  it("has no rate across a zero or negative interval", () => {
    expect(
      pageoutRate(sample({ atMs: 0, previous: { pageoutsCounter: 1, atMs: 0 } })),
    ).toBeUndefined();
  });
});

describe("classifyMemory", () => {
  // The audited case, and the reason this classifier exists.
  it("calls allocated swap with no churn DEGRADED, not failed", () => {
    expect(
      classifyMemory(
        sample({ previous: { pageoutsCounter: 987_600, atMs: 0 }, serviceImpact: false }),
      ),
    ).toBe("degraded");
  });

  it("calls a sustained burst WITH service impact FAILED", () => {
    const burst = sample({
      previous: { pageoutsCounter: 987_654 - SUSTAINED_PAGEOUT_RATE * 60, atMs: 0 },
      serviceImpact: true,
    });
    expect(pageoutRate(burst)).toBeGreaterThanOrEqual(SUSTAINED_PAGEOUT_RATE);
    expect(classifyMemory(burst)).toBe("failed");
  });

  // Swap traffic on its own is what a busy machine does.
  it("does not call a sustained burst failed without service impact", () => {
    expect(
      classifyMemory(
        sample({
          previous: { pageoutsCounter: 987_654 - SUSTAINED_PAGEOUT_RATE * 60, atMs: 0 },
          serviceImpact: false,
        }),
      ),
    ).toBe("degraded");
  });

  it("calls an unparseable sample UNKNOWN", () => {
    expect(classifyMemory(sample({ parsed: false }))).toBe("unknown");
    expect(classifyMemory(sample({ swap: undefined }))).toBe("unknown");
    expect(classifyMemory(sample({ vmStat: undefined }))).toBe("unknown");
  });

  it("calls a host with no swap and little compression OK", () => {
    expect(
      classifyMemory(
        sample({
          swap: { totalBytes: 8 * GIB, usedBytes: 0, freeBytes: 8 * GIB },
          vmStat: { pageSizeBytes: 16384, compressedPages: 100, pageoutsCounter: 10 },
          previous: { pageoutsCounter: 9, atMs: 0 },
        }),
      ),
    ).toBe("ok");
  });

  it("never reaches failed without a computable rate", () => {
    expect(classifyMemory(sample({ serviceImpact: true, previous: undefined }))).toBe(
      "degraded",
    );
  });
});

describe("macosResourceProbe", () => {
  const command = (stdout: string, artifact = "fixture"): CommandResult => ({
    stdout,
    exitCode: 0,
    timedOut: false,
    evidenceRef: `artifact://raw-command/${artifact}`,
  });

  function resourceRunner(
    vmStats: string[],
    overrides: { pressure?: string; top?: string } = {},
  ): CommandRunner & {
    calls: { argv: readonly string[]; timeoutMs: number }[];
  } {
    const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
    let vmIndex = 0;
    const byCommand = (argv: readonly string[]): CommandResult => {
      const key = argv.join(" ");
      if (key === "/usr/bin/memory_pressure -Q") return command(overrides.pressure ?? "System-wide memory pressure: normal", "memory-pressure");
      if (key === "/usr/bin/vm_stat") return command(vmStats[Math.min(vmIndex++, vmStats.length - 1)]!, "vm-stat");
      if (key === "/usr/sbin/sysctl -n vm.swapusage") return command(SWAP_USAGE, "swap-usage");
      if (key === "/usr/bin/uptime") return command(UPTIME, "uptime");
      if (key === "/usr/sbin/sysctl -n hw.memsize") return command(String(TOTAL), "memory-size");
      if (key === "/usr/sbin/sysctl -n hw.logicalcpu") return command("8", "logical-cpu");
      if (key === "/usr/bin/top -l 1 -n 10 -stats pid,command,cpu") return command(overrides.top ?? TOP, "top");
      return {
        stdout: "",
        exitCode: 1,
        timedOut: false,
        evidenceRef: "artifact://raw-command/unexpected",
      };
    };
    return {
      calls,
      async run(argv, timeoutMs) {
        calls.push({ argv, timeoutMs });
        return byCommand(argv);
      },
    };
  }

  it("runs every host resource command with exact argv and an individual timeout", async () => {
    const runner = resourceRunner([VM_STAT]);
    const observations = await macosResourceProbe({
      componentId: "host",
      timeoutMs: 2_000,
      serviceImpact: () => false,
    }).observe(runner, new Date(NOW));

    expect(runner.calls).toEqual([
      { argv: ["/usr/bin/memory_pressure", "-Q"], timeoutMs: 2_000 },
      { argv: ["/usr/bin/vm_stat"], timeoutMs: 2_000 },
      { argv: ["/usr/sbin/sysctl", "-n", "vm.swapusage"], timeoutMs: 2_000 },
      { argv: ["/usr/bin/uptime"], timeoutMs: 2_000 },
      { argv: ["/usr/sbin/sysctl", "-n", "hw.memsize"], timeoutMs: 2_000 },
      { argv: ["/usr/sbin/sysctl", "-n", "hw.logicalcpu"], timeoutMs: 2_000 },
      { argv: ["/usr/bin/top", "-l", "1", "-n", "10", "-stats", "pid,command,cpu"], timeoutMs: 2_000 },
    ]);
    ObservationSchema.array().parse(observations);
    expect(observations.map((row) => row.probeId)).toEqual([
      "host.memory.v1",
      "host.cpu-load.v1",
    ]);
    expect(observations.map((row) => row.dimension)).toEqual([
      "memory-pressure",
      "cpu-load",
    ]);
    for (const observation of observations) {
      expect(HOST_COMPONENT.dimensions).toContain(observation.dimension);
    }
    expect(observations.flatMap((row) => row.evidenceRefs)).toEqual(
      expect.arrayContaining([
        "artifact://raw-command/memory-pressure",
        "artifact://raw-command/vm-stat",
        "artifact://raw-command/top",
      ]),
    );
  });

  it("uses only continuous consecutive counters for a pageout rate", async () => {
    let impacted = false;
    const burst = VM_STAT.replace("987654.", String(987_654 + SUSTAINED_PAGEOUT_RATE * 60) + ".");
    const runner = resourceRunner([VM_STAT, burst]);
    const probe = macosResourceProbe({
      componentId: "host",
      serviceImpact: () => impacted,
    });
    const first = await probe.observe(runner, new Date("2026-08-29T12:00:00.000Z"));
    impacted = true;
    const second = await probe.observe(runner, new Date("2026-08-29T12:01:00.000Z"));

    expect(first[0]?.state).toBe("degraded");
    expect(second[0]).toMatchObject({ state: "failed", value: { pageoutRate: SUSTAINED_PAGEOUT_RATE } });
  });

  it("reports unknown rather than healthy when any required command times out", async () => {
    const runner = resourceRunner([VM_STAT]);
    const original = runner.run.bind(runner);
    runner.run = async (argv, timeoutMs) =>
      argv[0] === "/usr/bin/vm_stat"
        ? {
            stdout: "",
            exitCode: 1,
            timedOut: true,
            evidenceRef: "artifact://raw-command/vm-stat-timeout",
          }
        : original(argv, timeoutMs);
    const observations = await macosResourceProbe({ componentId: "host" }).observe(
      runner,
      new Date(NOW),
    );
    expect(observations.map((row) => row.state)).toEqual(["unknown", "unknown"]);
  });

  it("makes a critical memory-pressure reading a failed memory observation", async () => {
    const observations = await macosResourceProbe({ componentId: "host" }).observe(
      resourceRunner([VM_STAT], {
        pressure: "System-wide memory pressure: critical",
      }),
      new Date(NOW),
    );
    expect(observations[0]).toMatchObject({
      state: "failed",
      value: { pressure: { level: "critical" } },
    });
  });

  it("uses CPU busy time and records process contribution", async () => {
    const observations = await macosResourceProbe({ componentId: "host" }).observe(
      resourceRunner([VM_STAT], { top: TOP_BUSY }),
      new Date(NOW),
    );
    expect(observations[1]).toMatchObject({
      state: "degraded",
      value: {
        busyPercent: 90,
        processContributions: [
          { pid: 200, command: "helium-opsd", cpuPercent: 62.5 },
          { pid: 300, command: "postgres", cpuPercent: 20 },
        ],
      },
    });
  });
});
