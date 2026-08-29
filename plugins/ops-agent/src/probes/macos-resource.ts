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
import type {
  Observation,
  ObservationState,
} from "@helium/core/operations/observation.js";
import type { CommandResult, CommandRunner } from "./process.js";

const MEMORY_PRESSURE_ARGV = ["/usr/bin/memory_pressure", "-Q"] as const;
const VM_STAT_ARGV = ["/usr/bin/vm_stat"] as const;
const SWAP_USAGE_ARGV = ["/usr/sbin/sysctl", "-n", "vm.swapusage"] as const;
const UPTIME_ARGV = ["/usr/bin/uptime"] as const;
const MEMORY_SIZE_ARGV = ["/usr/sbin/sysctl", "-n", "hw.memsize"] as const;
const LOGICAL_CPU_ARGV = ["/usr/sbin/sysctl", "-n", "hw.logicalcpu"] as const;
const TOP_ARGV = [
  "/usr/bin/top",
  "-l",
  "1",
  "-n",
  "10",
  "-stats",
  "pid,command,cpu",
] as const;

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

function successful(result: CommandResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

function parsePositiveInteger(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface MemoryPressure {
  level: "normal" | "warning" | "critical";
  freePercent?: number;
}

export function parseMemoryPressure(text: string): MemoryPressure | undefined {
  const named = /System-wide memory pressure:\s*(normal|warning|critical)/i.exec(text);
  if (named !== null) {
    return { level: named[1].toLowerCase() as MemoryPressure["level"] };
  }
  const free = /System-wide memory free percentage:\s*([0-9]+(?:[.,][0-9]+)?)%/i.exec(
    text,
  );
  if (free !== null) {
    const freePercent = Number(free[1].replace(",", "."));
    if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) {
      return undefined;
    }
    return {
      level: freePercent <= 5 ? "critical" : freePercent <= 15 ? "warning" : "normal",
      freePercent,
    };
  }
  return undefined;
}

export interface CpuProcessContribution {
  pid: number;
  command: string;
  cpuPercent: number;
}

export interface CpuTopSample {
  busyPercent: number;
  idlePercent: number;
  processes: CpuProcessContribution[];
}

/** Parse one bounded `top` sample: aggregate busy time plus top contributors. */
export function parseCpuTop(text: string): CpuTopSample | undefined {
  const usage =
    /CPU usage:\s*([0-9.,]+)% user,\s*([0-9.,]+)% sys,\s*([0-9.,]+)% idle/i.exec(
      text,
    );
  if (usage === null) return undefined;
  const number = (raw: string): number => Number(raw.replace(",", "."));
  const user = number(usage[1]);
  const system = number(usage[2]);
  const idlePercent = number(usage[3]);
  if (![user, system, idlePercent].every(Number.isFinite)) return undefined;
  const lines = text.split("\n");
  const header = lines.findIndex((line) => /^\s*PID\s+COMMAND\s+%CPU\s*$/.test(line));
  if (header < 0) return undefined;
  const processes: CpuProcessContribution[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\S+)\s+([0-9.,]+)\s*$/.exec(line);
    if (match === null) return undefined;
    const pid = Number(match[1]);
    const cpuPercent = number(match[3]);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(cpuPercent)) return undefined;
    processes.push({ pid, command: match[2], cpuPercent });
  }
  return {
    busyPercent: Math.round((user + system) * 100) / 100,
    idlePercent,
    processes,
  };
}

export interface MemorySample {
  /** `false` when any input could not be parsed. */
  parsed: boolean;
  totalBytes: number;
  swap?: SwapUsage;
  vmStat?: VmStat;
  pressure?: MemoryPressure;
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

  if (sample.pressure?.level === "critical") return "failed";

  const rate = pageoutRate(sample);
  if (rate !== undefined && rate >= SUSTAINED_PAGEOUT_RATE && sample.serviceImpact) {
    return "failed";
  }

  const compressedBytes = sample.vmStat.compressedPages * sample.vmStat.pageSizeBytes;
  const pressured =
    sample.pressure?.level === "warning" ||
    sample.swap.usedBytes > 0 || compressedBytes > sample.totalBytes * 0.1;

  if (rate === undefined && pressured) {
    // Swap is allocated and the rate is unknowable. Not an outage on this
    // evidence, and not healthy either.
    return "degraded";
  }
  return pressured ? "degraded" : "ok";
}

export interface MacosResourceProbeOptions {
  componentId: string;
  timeoutMs?: number;
  serviceImpact?: () => boolean;
}

/**
 * Execute the bounded, read-only macOS resource command set.
 *
 * Exact argv is owned here rather than configuration so this probe cannot be
 * turned into a general command runner. All seven readings form one sample: if
 * any command fails or cannot be parsed, neither derived health row is allowed
 * to claim a known state.
 */
export function macosResourceProbe(options: MacosResourceProbeOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const aggregateProbeId = `${options.componentId}.resources.v1`;
  const memoryProbeId = `${options.componentId}.memory.v1`;
  const cpuProbeId = `${options.componentId}.cpu-load.v1`;
  let previous: { pageoutsCounter: number; atMs: number } | undefined;

  return {
    probeId: aggregateProbeId,
    async observe(
      runner: CommandRunner,
      now: Date,
      ttlMs = 300_000,
    ): Promise<Observation[]> {
      const pressureResult = await runner.run(MEMORY_PRESSURE_ARGV, timeoutMs);
      const vmStatResult = await runner.run(VM_STAT_ARGV, timeoutMs);
      const swapResult = await runner.run(SWAP_USAGE_ARGV, timeoutMs);
      const uptimeResult = await runner.run(UPTIME_ARGV, timeoutMs);
      const memorySizeResult = await runner.run(MEMORY_SIZE_ARGV, timeoutMs);
      const logicalCpuResult = await runner.run(LOGICAL_CPU_ARGV, timeoutMs);
      const topResult = await runner.run(TOP_ARGV, timeoutMs);
      const results = [
        pressureResult,
        vmStatResult,
        swapResult,
        uptimeResult,
        memorySizeResult,
        logicalCpuResult,
        topResult,
      ];

      const pressure = parseMemoryPressure(pressureResult.stdout);
      const vmStat = parseVmStat(vmStatResult.stdout);
      const swap = parseSwapUsage(swapResult.stdout);
      const load = parseLoadAverage(uptimeResult.stdout);
      const totalBytes = parsePositiveInteger(memorySizeResult.stdout);
      const logicalCpu = parsePositiveInteger(logicalCpuResult.stdout);
      const cpuTop = parseCpuTop(topResult.stdout);
      const parsed =
        results.every(successful) &&
        pressure !== undefined &&
        vmStat !== undefined &&
        swap !== undefined &&
        load !== undefined &&
        totalBytes !== undefined &&
        logicalCpu !== undefined &&
        cpuTop !== undefined;
      const serviceImpact = options.serviceImpact?.() ?? false;
      const normalizedFiveMinuteLoad =
        load !== undefined && logicalCpu !== undefined ? load.five / logicalCpu : undefined;
      const sample: MemorySample = {
        parsed,
        totalBytes: totalBytes ?? 0,
        swap,
        vmStat,
        pressure,
        atMs: now.getTime(),
        previous,
        serviceImpact,
        ampleIdleCpu:
          normalizedFiveMinuteLoad !== undefined && normalizedFiveMinuteLoad < 0.8,
      };
      const rate = pageoutRate(sample);
      if (parsed && vmStat !== undefined) {
        previous = { pageoutsCounter: vmStat.pageoutsCounter, atMs: now.getTime() };
      }

      const observedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const memory: Observation = {
        version: 1,
        id: `obs-${options.componentId}-memory-${now.getTime()}`,
        componentId: options.componentId,
        probeId: memoryProbeId,
        observedAt,
        expiresAt,
        state: classifyMemory(sample),
        dimension: "memory-pressure",
        value: {
          pressure: pressure ?? null,
          totalBytes: totalBytes ?? null,
          swap: swap ?? null,
          vmStat: vmStat ?? null,
          pageoutRate: rate ?? null,
          serviceImpact,
          timedOut: results.some((result) => result.timedOut),
        },
        evidenceRefs: [
          pressureResult.evidenceRef,
          vmStatResult.evidenceRef,
          swapResult.evidenceRef,
          memorySizeResult.evidenceRef,
        ],
        parserVersion: "macos-memory/1",
      };
      const normalizedLoad = normalizedFiveMinuteLoad ?? null;
      const cpuState: ObservationState =
        !parsed || normalizedFiveMinuteLoad === undefined || cpuTop === undefined
        ? "unknown"
        : (cpuTop.busyPercent >= 95 || normalizedFiveMinuteLoad >= 0.95) &&
            serviceImpact
          ? "failed"
          : cpuTop.busyPercent >= 80 || normalizedFiveMinuteLoad >= 0.8
            ? "degraded"
            : "ok";
      const cpu: Observation = {
        version: 1,
        id: `obs-${options.componentId}-cpu-${now.getTime()}`,
        componentId: options.componentId,
        probeId: cpuProbeId,
        observedAt,
        expiresAt,
        state: cpuState,
        dimension: "cpu-load",
        value: {
          load: load ?? null,
          logicalCpu: logicalCpu ?? null,
          normalizedFiveMinuteLoad: normalizedLoad,
          busyPercent: cpuTop?.busyPercent ?? null,
          idlePercent: cpuTop?.idlePercent ?? null,
          processContributions: cpuTop?.processes ?? [],
          serviceImpact,
          timedOut: results.some((result) => result.timedOut),
        },
        evidenceRefs: [
          uptimeResult.evidenceRef,
          logicalCpuResult.evidenceRef,
          topResult.evidenceRef,
        ],
        parserVersion: "macos-cpu-load/1",
      };
      return [memory, cpu];
    },
  };
}
