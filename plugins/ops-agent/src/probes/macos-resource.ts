/**
 * Host memory, swap and CPU probes.
 *
 * The classification rule comes straight from the audit: a host with several
 * gigabytes of swap ALLOCATED but no sustained swap churn and ample idle CPU
 * is under chronic capacity pressure, not in an immediate memory outage.
 * Alerting on percentage-of-RAM alone gets that backwards in both directions
 * -- it screams at a healthy machine and stays quiet through a real one.
 *
 * Every parser here is total: it returns `undefined` rather than throwing, and
 * an unparseable sample classifies `unknown`. A probe that throws takes the
 * collector down; a probe that guesses reports health it never observed.
 * @module dsh-plugin-ops-agent/probes/macos-resource
 */
import type { ObservationState } from "@helium/core";

/** Bytes per unit, for the suffixes the host tools actually emit. */
const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/**
 * Parse a size like `6.67G`, `1024K` or `6,67G`.
 *
 * The comma form is not hypothetical: these tools format through the host
 * locale, and a comma decimal separator parsed as a thousands separator turns
 * 6.67 GiB into 667 GiB.
 */
export function parseSize(raw: string): number | undefined {
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*([bkmgt])i?b?$/i.exec(raw.trim());
  if (match === null) return undefined;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * (UNITS[match[2].toLowerCase()] ?? 1));
}

export interface SwapUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

/** Parse `sysctl vm.swapusage` output. */
export function parseSwapUsage(text: string): SwapUsage | undefined {
  const match =
    /total\s*=\s*([0-9.,]+[A-Za-z]+)\s+used\s*=\s*([0-9.,]+[A-Za-z]+)\s+free\s*=\s*([0-9.,]+[A-Za-z]+)/i.exec(
      text,
    );
  if (match === null) return undefined;
  const [totalBytes, usedBytes, freeBytes] = [match[1], match[2], match[3]].map(
    parseSize,
  );
  if (totalBytes === undefined || usedBytes === undefined || freeBytes === undefined) {
    return undefined;
  }
  return { totalBytes, usedBytes, freeBytes };
}

export interface VmStat {
  pageSizeBytes: number;
  compressedPages: number;
  /** Monotonic counter since boot. */
  pageoutsCounter: number;
}

/** Parse `vm_stat` output. */
export function parseVmStat(text: string): VmStat | undefined {
  const pageSize = /page size of (\d+) bytes/i.exec(text);
  if (pageSize === null) return undefined;

  const field = (label: string): number | undefined => {
    const hit = new RegExp(`${label}:\\s*([0-9.,]+)`, "i").exec(text);
    if (hit === null) return undefined;
    const value = Number(hit[1].replace(/[.,]$/, "").replace(/,/g, ""));
    return Number.isFinite(value) ? value : undefined;
  };

  const compressedPages = field("Pages occupied by compressor");
  const pageoutsCounter = field("Pageouts");
  if (compressedPages === undefined || pageoutsCounter === undefined) {
    return undefined;
  }
  return {
    pageSizeBytes: Number(pageSize[1]),
    compressedPages,
    pageoutsCounter,
  };
}

export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

/** Parse the load averages out of `uptime`. */
export function parseLoadAverage(text: string): LoadAverage | undefined {
  const match =
    /load averages?:\s*([0-9.,]+)[\s,]+([0-9.,]+)[\s,]+([0-9.,]+)/i.exec(text);
  if (match === null) return undefined;
  const [one, five, fifteen] = [match[1], match[2], match[3]].map((n) =>
    Number(n.replace(",", ".")),
  );
  if (![one, five, fifteen].every(Number.isFinite)) return undefined;
  return { one, five, fifteen };
}

export interface MemorySample {
  /** `false` when any input could not be parsed. */
  parsed: boolean;
  totalBytes: number;
  swap?: SwapUsage;
  vmStat?: VmStat;
  atMs: number;
  /** The previous sample, for rate calculation. */
  previous?: { pageoutsCounter: number; atMs: number };
  /** Whether any dependent service is actually degraded right now. */
  serviceImpact: boolean;
  /** Idle CPU headroom, from load average against core count. */
  ampleIdleCpu: boolean;
}

/** Sustained pageout rate, in pages per second, or undefined when unknowable. */
export function pageoutRate(sample: MemorySample): number | undefined {
  const current = sample.vmStat?.pageoutsCounter;
  const previous = sample.previous;
  if (current === undefined || previous === undefined) return undefined;
  const elapsedMs = sample.atMs - previous.atMs;
  if (elapsedMs <= 0) return undefined;
  // A counter that went BACKWARDS means the host rebooted or the counter
  // wrapped. There is no valid rate across that boundary, and computing one
  // would invent a burst that never happened.
  if (current < previous.pageoutsCounter) return undefined;
  return ((current - previous.pageoutsCounter) / elapsedMs) * 1000;
}

/** Pages per second that counts as a sustained burst rather than background. */
export const SUSTAINED_PAGEOUT_RATE = 500;

/**
 * Classify host memory.
 *
 * - `unknown` when the sample could not be parsed, or when a rate is needed
 *   and cannot be computed.
 * - `failed` only for a sustained pageout burst WITH observed service impact.
 *   Swap traffic on its own is what a busy machine does.
 * - `degraded` for allocated swap or substantial compression with no burst --
 *   chronic capacity pressure, which is a planning problem, not an outage.
 */
export function classifyMemory(sample: MemorySample): ObservationState {
  if (!sample.parsed || sample.swap === undefined || sample.vmStat === undefined) {
    return "unknown";
  }

  const rate = pageoutRate(sample);
  if (rate !== undefined && rate >= SUSTAINED_PAGEOUT_RATE && sample.serviceImpact) {
    return "failed";
  }

  const compressedBytes = sample.vmStat.compressedPages * sample.vmStat.pageSizeBytes;
  const pressured =
    sample.swap.usedBytes > 0 || compressedBytes > sample.totalBytes * 0.1;

  if (rate === undefined && pressured) {
    // Swap is allocated and the rate is unknowable. Not an outage on this
    // evidence, and not healthy either.
    return "degraded";
  }
  return pressured ? "degraded" : "ok";
}
