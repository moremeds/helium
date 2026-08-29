/**
 * NOTE ON THE FIXTURES BELOW.
 *
 * As in `macos-resource.test.ts`, these are AUTHORED `df -k` output shapes,
 * not captures from the audited host — the AC#1 observation window forbids
 * touching the mini. They pin the parser and the classification rule; they are
 * not evidence about the real machine.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISK_THRESHOLDS,
  checkMountIdentity,
  classifyDisk,
  parseDf,
  type VolumeUsage,
} from "./disk.js";

const GIB = 1024 ** 3;

/** `df -k` on macOS: the long form, with the iused/ifree/%iused columns. */
const DF_MACOS = [
  "Filesystem   1024-blocks       Used  Available Capacity iused      ifree %iused  Mounted on",
  "/dev/disk3s1s1   482797652   10485760  120586240    8%  425000 4294542279    0%   /",
  "/dev/disk3s5     482797652  340000000   30000000   92%  900000 4294067279    0%   /System/Volumes/Data",
  "/dev/disk5s1    1953514584 1900000000    5000000   99%  120000 4294847279    0%   /Volumes/DATA_LAKE",
].join("\n");

/** The short form, without the inode columns. Both are legal `df` output. */
const DF_SHORT = [
  "Filesystem   1024-blocks       Used  Available Capacity  Mounted on",
  "/dev/disk3s1s1   482797652   10485760  120586240    8%   /",
].join("\n");

describe("parseDf", () => {
  it("reads every volume from the long macOS form", () => {
    const volumes = parseDf(DF_MACOS);
    expect(volumes?.map((v) => v.mount)).toEqual([
      "/",
      "/System/Volumes/Data",
      "/Volumes/DATA_LAKE",
    ]);
  });

  it("reads the short form too", () => {
    expect(parseDf(DF_SHORT)?.[0]?.device).toBe("/dev/disk3s1s1");
  });

  it("converts 1k blocks to bytes", () => {
    const root = parseDf(DF_SHORT)?.[0];
    expect(root?.totalBytes).toBe(482797652 * 1024);
    expect(root?.usedBytes).toBe(10485760 * 1024);
    expect(root?.availableBytes).toBe(120586240 * 1024);
    expect(root?.usedPercent).toBe(8);
  });

  it("refuses the WHOLE table when any single line is unreadable", () => {
    // The dropped volume would be the one that mattered. All or nothing.
    const corrupted = DF_MACOS.split("\n")
      .map((line, i) => (i === 2 ? "/dev/disk3s5   <unreadable garbage>" : line))
      .join("\n");
    expect(parseDf(corrupted)).toBeUndefined();
  });

  it("refuses output with no header", () => {
    expect(parseDf("/dev/disk3s1s1 100 50 50 50%  /")).toBeUndefined();
  });

  it("refuses empty output", () => {
    expect(parseDf("")).toBeUndefined();
    expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on")).toBeUndefined();
  });
});

describe("classifyDisk", () => {
  const volume = (over: Partial<VolumeUsage>): VolumeUsage => ({
    device: "/dev/disk5s1",
    mount: "/Volumes/DATA_LAKE",
    totalBytes: 1000 * GIB,
    usedBytes: 100 * GIB,
    availableBytes: 900 * GIB,
    usedPercent: 10,
    ...over,
  });

  it("reports unknown when the volume is missing from the table", () => {
    // Not `ok`: an absent volume has proven nothing about its capacity.
    expect(classifyDisk(undefined)).toBe("unknown");
  });

  it("reports ok below the degraded threshold", () => {
    expect(classifyDisk(volume({ usedPercent: 84 }))).toBe("ok");
  });

  it("reports degraded at the threshold", () => {
    expect(classifyDisk(volume({ usedPercent: DEFAULT_DISK_THRESHOLDS.degradedPercent }))).toBe(
      "degraded",
    );
  });

  it("reports failed at the failed threshold", () => {
    expect(classifyDisk(volume({ usedPercent: DEFAULT_DISK_THRESHOLDS.failedPercent }))).toBe(
      "failed",
    );
  });

  it("reports failed on the absolute floor even at a low percentage", () => {
    // A big volume at 20% can still have less headroom than one write needs.
    expect(
      classifyDisk(
        volume({ totalBytes: 4000 * GIB, usedPercent: 20, availableBytes: GIB }),
      ),
    ).toBe("failed");
  });

  it("honours caller-supplied thresholds", () => {
    expect(
      classifyDisk(volume({ usedPercent: 50 }), {
        degradedPercent: 40,
        failedPercent: 60,
        minAvailableBytes: 0,
      }),
    ).toBe("degraded");
  });
});

describe("checkMountIdentity", () => {
  const volumes = parseDf(DF_MACOS)!;

  it("accepts a mount backed by the expected device", () => {
    expect(
      checkMountIdentity(volumes, [
        { mount: "/Volumes/DATA_LAKE", device: "/dev/disk5s1" },
      ]),
    ).toEqual([{ mount: "/Volumes/DATA_LAKE", ok: true }]);
  });

  it("catches a mount point that is not mounted at all", () => {
    // The dangerous case: the path exists as a directory on the parent volume,
    // it has space, it accepts writes, and none of it lands where anyone thinks.
    expect(
      checkMountIdentity(volumes, [{ mount: "/Volumes/BACKUP", device: "/dev/disk6s1" }]),
    ).toEqual([{ mount: "/Volumes/BACKUP", ok: false, reason: "not-mounted" }]);
  });

  it("catches a mount backed by the wrong device", () => {
    expect(
      checkMountIdentity(volumes, [
        { mount: "/Volumes/DATA_LAKE", device: "/dev/disk9s1" },
      ]),
    ).toEqual([
      {
        mount: "/Volumes/DATA_LAKE",
        ok: false,
        reason: "device-mismatch",
        actual: "/dev/disk5s1",
      },
    ]);
  });

  it("checks every expected mount independently", () => {
    const results = checkMountIdentity(volumes, [
      { mount: "/", device: "/dev/disk3s1s1" },
      { mount: "/Volumes/BACKUP", device: "/dev/disk6s1" },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});
