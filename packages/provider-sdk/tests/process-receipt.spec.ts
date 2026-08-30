import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_RECEIPT_FILE,
  ProviderProcessExitedBeforeReceiptError,
  reapOrphanProviderProcesses,
  spawnSupervisedProviderProcess,
  writeProviderProcessReceipt,
} from "../src/process-receipt.js";

const children = new Set<number>();
afterEach(() => {
  for (const pid of children) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
  }
  children.clear();
});

function stubbornChild() {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { detached: true, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("missing child pid");
  children.add(child.pid);
  return child;
}

describe("provider process receipts", () => {
  it("distinguishes a child that finished before receipt capture from a receipt failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-process-reaper-"));
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("missing child pid");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(() =>
      writeProviderProcessReceipt({
        workspace: join(root, "work", "fast-attempt"),
        pid: child.pid!,
        provider: "fixture",
      }),
    ).toThrow(ProviderProcessExitedBeforeReceiptError);
  });

  it("reaps a matching orphan process group and removes its owned workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-process-reaper-"));
    const workspace = join(root, "work", "attempt-1");
    const child = stubbornChild();
    writeProviderProcessReceipt({ workspace, pid: child.pid!, provider: "fixture" });
    expect(existsSync(join(workspace, PROCESS_RECEIPT_FILE))).toBe(true);

    const outcomes = await reapOrphanProviderProcesses(root, { graceMs: 50 });
    expect(outcomes).toEqual([
      expect.objectContaining({ pid: child.pid, outcome: "reaped" }),
    ]);
    expect(existsSync(workspace)).toBe(false);
    children.delete(child.pid!);
  });

  it("refuses to kill a reused or otherwise mismatched PID identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-process-reaper-"));
    const workspace = join(root, "work", "attempt-2");
    const child = stubbornChild();
    writeProviderProcessReceipt({ workspace, pid: child.pid!, provider: "fixture" });
    const path = join(workspace, PROCESS_RECEIPT_FILE);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...receipt, identityHash: "sha256:" + "0".repeat(64) }));

    const outcomes = await reapOrphanProviderProcesses(root, { graceMs: 50 });
    expect(outcomes).toEqual([
      expect.objectContaining({ pid: child.pid, outcome: "identity-mismatch" }),
    ]);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

  it("reaps the owned process group after its launcher execs the provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-process-reaper-"));
    const workspace = join(root, "work", "exec-attempt");
    const child = spawnSupervisedProviderProcess(
      "/bin/sh",
      ["-c", "/bin/sleep 0.1; exec /bin/sleep 100"],
      { stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("missing child pid");
    children.add(child.pid);
    writeProviderProcessReceipt({ workspace, pid: child.pid, provider: "fixture" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const outcomes = await reapOrphanProviderProcesses(root, { graceMs: 50 });
    expect(outcomes).toEqual([
      expect.objectContaining({ pid: child.pid, outcome: "reaped" }),
    ]);
    expect(existsSync(workspace)).toBe(false);
    children.delete(child.pid);
  });
});
