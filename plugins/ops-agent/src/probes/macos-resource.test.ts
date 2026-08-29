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
import { describe, expect, it } from "vitest";
import {
  classifyMemory,
  pageoutRate,
  parseLoadAverage,
  parseSize,
  parseSwapUsage,
  parseVmStat,
  SUSTAINED_PAGEOUT_RATE,
  type MemorySample,
} from "./macos-resource.js";

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
