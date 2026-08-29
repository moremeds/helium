/**
 * Volume capacity and mount-identity probes.
 *
 * Every volume is monitored INDEPENDENTLY. A single aggregate "disk is fine"
 * hides the case that matters: the data volume filling while the boot volume
 * has room.
 *
 * Mount identity is checked as well as capacity, because a volume that
 * silently unmounted does not report as full -- it reports as a directory on
 * whatever volume is underneath, with plenty of space, while everything
 * written to it goes somewhere nobody is watching.
 * @module dsh-plugin-ops-agent/probes/disk
 */
import type {
  Observation,
  ObservationState,
} from "@helium/core/operations/observation.js";
import type { CommandRunner } from "./process.js";

export interface VolumeUsage {
  device: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

/**
 * Parse `df -k` output.
 *
 * @returns one entry per volume, or `undefined` if any line cannot be read. A
 * partially parsed table would silently drop the volume that mattered.
 */
export function parseDf(text: string): VolumeUsage[] | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return undefined;
  if (!/^Filesystem\s/i.test(lines[0])) return undefined;

  const volumes: VolumeUsage[] = [];
  for (const line of lines.slice(1)) {
    // device 1k-blocks used available capacity [iused ifree %iused] mount
    const match =
      /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%(?:\s+\S+){0,3}\s+(\/.*)$/.exec(line);
    if (match === null) return undefined;
    const totalBytes = Number(match[2]) * 1024;
    const usedBytes = Number(match[3]) * 1024;
    const availableBytes = Number(match[4]) * 1024;
    if (![totalBytes, usedBytes, availableBytes].every(Number.isFinite)) {
      return undefined;
    }
    volumes.push({
      device: match[1],
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: Number(match[5]),
      mount: match[6].trim(),
    });
  }
  return volumes;
}

export interface DiskThresholds {
  degradedPercent: number;
  failedPercent: number;
  /** An absolute floor, because a percentage of a huge volume is still small. */
  minAvailableBytes: number;
}

export const DEFAULT_DISK_THRESHOLDS: DiskThresholds = {
  degradedPercent: 85,
  failedPercent: 95,
  minAvailableBytes: 2 * 1024 ** 3,
};

export function classifyDisk(
  volume: VolumeUsage | undefined,
  thresholds: DiskThresholds = DEFAULT_DISK_THRESHOLDS,
): ObservationState {
  if (volume === undefined) return "unknown";
  if (
    volume.usedPercent >= thresholds.failedPercent ||
    volume.availableBytes < thresholds.minAvailableBytes
  ) {
    return "failed";
  }
  return volume.usedPercent >= thresholds.degradedPercent ? "degraded" : "ok";
}

export interface ExpectedMount {
  mount: string;
  /** The device this mount must be backed by. */
  device: string;
}

export type MountIdentity =
  | { mount: string; ok: true }
  | { mount: string; ok: false; reason: "not-mounted" | "device-mismatch"; actual?: string };

/**
 * Verify each expected mount is present AND backed by the expected device.
 *
 * A mount point that exists as a plain directory on the parent volume is the
 * dangerous case: it has space, it accepts writes, and nothing it receives is
 * on the volume anyone believes it is on.
 */
export function checkMountIdentity(
  volumes: VolumeUsage[],
  expected: ExpectedMount[],
): MountIdentity[] {
  return expected.map((want) => {
    const found = volumes.find((v) => v.mount === want.mount);
    if (found === undefined) return { mount: want.mount, ok: false, reason: "not-mounted" };
    if (found.device !== want.device) {
      return {
        mount: want.mount,
        ok: false,
        reason: "device-mismatch",
        actual: found.device,
      };
    }
    return { mount: want.mount, ok: true };
  });
}

export interface MonitoredVolume extends ExpectedMount {
  id: string;
  thresholds?: DiskThresholds;
}

export interface DiskProbeOptions {
  componentId: string;
  volumes: readonly MonitoredVolume[];
  timeoutMs?: number;
}

/** Execute one bounded `df` read and report every configured mount separately. */
export function diskProbe(options: DiskProbeOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const aggregateProbeId = `${options.componentId}.volumes.v1`;
  return {
    probeId: aggregateProbeId,
    async observe(
      runner: CommandRunner,
      now: Date,
      ttlMs = 300_000,
    ): Promise<Observation[]> {
      const result = await runner.run(["/bin/df", "-kP"], timeoutMs);
      const volumes =
        !result.timedOut && result.exitCode === 0 ? parseDf(result.stdout) : undefined;
      const observedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

      return options.volumes.map((configured): Observation => {
        const probeId = `${options.componentId}.volume.${configured.id}.v1`;
        const usage = volumes?.find((volume) => volume.mount === configured.mount);
        const identity =
          volumes === undefined
            ? undefined
            : checkMountIdentity(volumes, [configured])[0];
        const state: ObservationState =
          volumes === undefined
            ? "unknown"
            : identity?.ok === true
              ? classifyDisk(usage, configured.thresholds)
              : "failed";
        return {
          version: 1,
          id: `obs-${options.componentId}-volume-${configured.id}-${now.getTime()}`,
          componentId: options.componentId,
          probeId,
          observedAt,
          expiresAt,
          state,
          dimension: `volume-${configured.id}`,
          value: {
            expected: { mount: configured.mount, device: configured.device },
            identity: identity ?? null,
            usage: usage ?? null,
            timedOut: result.timedOut,
          },
          evidenceRefs: [`artifact://probe/${probeId}/${now.getTime()}`],
          parserVersion: "df-kp/1",
        };
      });
    },
  };
}
