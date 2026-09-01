/** Durable, one-shot operator inbox for controlled per-tenant canaries. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ControlledCanaryRequestSchema,
  type ControlledCanaryRequest,
} from "./promotion.js";

export interface CanaryInboxResult {
  requestId: string;
  state: "completed" | "failed" | "rejected";
  error?: string;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeExclusive(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

function safeStem(name: string): string {
  const stem = name.replace(/\.json$/, "");
  return /^[A-Za-z0-9_-]{1,96}$/.test(stem)
    ? stem
    : `invalid-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function validateRequest(
  raw: unknown,
  filename: string,
  knownTenants: ReadonlySet<string>,
  now: Date,
): ControlledCanaryRequest {
  const request = ControlledCanaryRequestSchema.parse(raw);
  if (filename !== `${request.requestId}.json`) {
    throw new Error("canary request filename does not match request id");
  }
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (createdAt > now.getTime()) throw new Error("canary request is future-dated");
  if (expiresAt <= now.getTime()) throw new Error("canary request is expired");
  if (expiresAt - createdAt > 60 * 60_000) {
    throw new Error("canary request lifetime exceeds one hour");
  }
  if (!knownTenants.has(request.tenant)) {
    throw new Error(`unknown canary tenant: ${request.tenant}`);
  }
  return request;
}

export async function processCanaryInbox(options: {
  directory: string;
  knownTenants: ReadonlySet<string>;
  now?: () => Date;
  handle(request: ControlledCanaryRequest): Promise<void>;
}): Promise<CanaryInboxResult[]> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const root = dirname(options.directory);
  const results: CanaryInboxResult[] = [];
  for (const name of readdirSync(options.directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const source = join(options.directory, name);
    let request: ControlledCanaryRequest | undefined;
    let result: CanaryInboxResult;
    try {
      request = validateRequest(
        JSON.parse(readFileSync(source, "utf8")),
        name,
        options.knownTenants,
        options.now?.() ?? new Date(),
      );
      try {
        await options.handle(request);
        result = { requestId: request.requestId, state: "completed" };
      } catch (error) {
        result = {
          requestId: request.requestId,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      result = {
        requestId: request?.requestId ?? safeStem(name),
        state: "rejected",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const archive = join(root, result.state === "completed" ? "processed" : result.state);
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const stem = safeStem(name);
    const requestArchive = join(archive, `${stem}.request.json`);
    const outcome = join(archive, `${stem}.outcome.json`);
    try {
      renameSync(source, requestArchive);
      syncDirectory(options.directory);
      syncDirectory(archive);
      writeExclusive(outcome, {
        version: 1,
        ...result,
        processedAt: (options.now?.() ?? new Date()).toISOString(),
      });
    } catch (error) {
      // A pre-existing immutable archive is never overwritten. Preserve the
      // incoming request under a unique rejected name for operator inspection.
      const collision = join(archive, `${stem}.${randomUUID()}.request.json`);
      try { renameSync(source, collision); } catch { /* source may already have moved */ }
      throw error;
    }
    results.push(result);
  }
  return results;
}
