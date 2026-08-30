import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PROCESS_RECEIPT_FILE = ".helium-provider-process.json";

interface ProviderProcessReceipt {
  version: 1;
  pid: number;
  provider: string;
  identityHash: string;
  recordedAt: string;
}

export interface ProviderProcessReceiptHandle {
  readonly path: string;
  clear(): void;
}

export interface ReapOutcome {
  path: string;
  pid: number;
  outcome: "reaped" | "already-exited" | "identity-mismatch" | "invalid-receipt";
}

const PS = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";

function identityHash(pid: number): string | undefined {
  let output: string;
  try {
    output = execFileSync(
      PS,
      ["-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
  if (output === "") return undefined;
  const status = /^\s*(\S+)/.exec(output)?.[1];
  if (status?.startsWith("Z")) return undefined;
  return `sha256:${createHash("sha256").update(output).digest("hex")}`;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeProviderProcessReceipt(input: {
  workspace: string;
  pid: number;
  provider: string;
}): ProviderProcessReceiptHandle {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error(`invalid provider process pid: ${input.pid}`);
  }
  if (input.provider.trim() === "") throw new Error("provider name must not be empty");
  const observed = identityHash(input.pid);
  if (observed === undefined) {
    throw new Error(`provider process ${input.pid} exited before its receipt was recorded`);
  }
  mkdirSync(input.workspace, { recursive: true, mode: 0o700 });
  const path = join(input.workspace, PROCESS_RECEIPT_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const receipt: ProviderProcessReceipt = {
    version: 1,
    pid: input.pid,
    provider: input.provider,
    identityHash: observed,
    recordedAt: new Date().toISOString(),
  };
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(input.workspace);
  let cleared = false;
  return {
    path,
    clear() {
      if (cleared) return;
      cleared = true;
      try {
        unlinkSync(path);
        syncDirectory(input.workspace);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function receiptPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === PROCESS_RECEIPT_FILE) paths.push(path);
    }
  };
  visit(root);
  return paths.sort();
}

function parseReceipt(path: string): ProviderProcessReceipt | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderProcessReceipt>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.provider !== "string" ||
      value.provider.length === 0 ||
      typeof value.identityHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(value.identityHash) ||
      typeof value.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(value.recordedAt))
    ) {
      return undefined;
    }
    return value as ProviderProcessReceipt;
  } catch {
    return undefined;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function reapOrphanProviderProcesses(
  workspacesRoot: string,
  options: { graceMs?: number } = {},
): Promise<ReapOutcome[]> {
  const graceMs = options.graceMs ?? 1_000;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("reaper graceMs must be non-negative");
  const outcomes: ReapOutcome[] = [];
  for (const path of receiptPaths(workspacesRoot)) {
    const receipt = parseReceipt(path);
    if (receipt === undefined) {
      outcomes.push({ path, pid: -1, outcome: "invalid-receipt" });
      continue;
    }
    const current = identityHash(receipt.pid);
    if (current === undefined) {
      rmSync(dirname(path), { recursive: true, force: true });
      outcomes.push({ path, pid: receipt.pid, outcome: "already-exited" });
      continue;
    }
    if (current !== receipt.identityHash) {
      outcomes.push({ path, pid: receipt.pid, outcome: "identity-mismatch" });
      continue;
    }
    try {
      process.kill(-receipt.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && identityHash(receipt.pid) === receipt.identityHash) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    if (identityHash(receipt.pid) === receipt.identityHash) {
      try {
        process.kill(-receipt.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      for (let attempt = 0; attempt < 40 && identityHash(receipt.pid) !== undefined; attempt += 1) {
        await delay(25);
      }
    }
    rmSync(dirname(path), { recursive: true, force: true });
    outcomes.push({ path, pid: receipt.pid, outcome: "reaped" });
  }
  return outcomes;
}
