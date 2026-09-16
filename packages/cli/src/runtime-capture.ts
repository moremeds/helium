/** Capture a tenant's live source calls into a fresh, replayable input world. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  type EcosystemTool,
  type LoadedTenant,
} from "@helium/core";
import { loadTenantTools } from "./discovery.js";
import { sha256, writeRecording } from "./tool-io.js";
import { loadSnapshotRecordings } from "./replay-strict.js";

export interface RuntimeSourceCapture {
  stateRoot: string;
  status: "COMPLETE" | "INCOMPLETE";
  startedAt: string;
  finishedAt: string;
  replayAsOf: string;
  sourceCount: number;
  sourceFailureCount: number;
  recordingFailureCount: number;
  entry: { tool: string; raw: string | null; sha256: string | null; bytes: number; error?: string };
  failures: Array<{ tool: string; sequence: number; at: string; kind: "tool" | "recording"; error: string }>;
}

interface CaptureDependencies {
  loadTools?: typeof loadTenantTools;
  makeStateRoot?: () => string;
  write?: typeof writeRecording;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copiedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalJson(args)) as Record<string, unknown>;
}

/**
 * Acquire one entry tool's complete source surface without a runner, provider,
 * renderer, or delivery channel.  The result is development input capture,
 * never a point-in-time market snapshot or evaluation result.
 */
export async function captureRuntimeSources(
  options: {
    tenant: LoadedTenant;
    phase: string;
    entryTool: string;
    env: NodeJS.ProcessEnv;
  },
  dependencies: CaptureDependencies = {},
): Promise<RuntimeSourceCapture> {
  if (options.phase.trim() === "") throw new Error("Capture requires a phase");
  if (options.entryTool.trim() === "") throw new Error("Capture requires an entry tool");

  const stateRoot = (dependencies.makeStateRoot ?? (() => mkdtempSync(join(tmpdir(), "helium-runtime-capture-"))))();
  // Tools receive only this fresh local state and cannot turn an acquisition
  // into a delivery by inheriting an operator's ambient settings.
  const captureEnv: NodeJS.ProcessEnv = {
    ...options.env,
    HELIUM_STATE_ROOT: stateRoot,
    HELIUM_TENANT_DELIVERY: "0",
    HELIUM_DEPLOYMENT: "test",
    HELIUM_ALLOW_MUTATIONS: "0",
  };
  const tools = await (dependencies.loadTools ?? loadTenantTools)(options.tenant.dir, {
    stateRoot,
    env: captureEnv,
    variant: "runtime-source-capture",
    phase: options.phase,
    ...(options.tenant.spec.calendar === undefined ? {} : { calendar: options.tenant.spec.calendar }),
    ...(Object.keys(options.tenant.spec.extensions).length === 0 ? {} : { extensions: options.tenant.spec.extensions }),
  });
  const entry = tools.find((tool) => tool.name === options.entryTool);
  if (entry === undefined) throw new Error(`Capture entry tool is not built: ${options.entryTool}`);
  if (entry.mutating) throw new Error(`Capture entry tool is mutating: ${options.entryTool}`);

  const startedAt = new Date().toISOString();
  const identity = { tenant: options.tenant.spec.tenant, phase: options.phase,
    entryTool: options.entryTool, startedAt };
  writeFileSync(join(stateRoot, "capture-start.json"), canonicalJson(identity) + "\n", { flag: "wx", mode: 0o600 });
  const inputs = join(stateRoot, "inputs");
  const failures: RuntimeSourceCapture["failures"] = [];
  let sourceCount = 0;
  const write = dependencies.write ?? writeRecording;

  const record = async (
    tool: EcosystemTool,
    args: Record<string, unknown>,
    original: () => Promise<string>,
    refuse = false,
  ): Promise<string> => {
    const sequence = ++sourceCount;
    const at = new Date().toISOString();
    let copied: Record<string, unknown>;
    try {
      copied = copiedArgs(args);
    } catch (error) {
      failures.push({ tool: tool.name, sequence, at, kind: "tool", error: `arguments are not canonical JSON: ${message(error)}` });
      throw error;
    }
    try {
      if (refuse) throw new Error(`Capture refuses mutating tool: ${tool.name}`);
      const raw = await original();
      try {
        write(inputs, sequence, {
          tool: tool.name, args: copied, at, raw, rawSha256: sha256(raw),
          rawBytes: Buffer.byteLength(raw, "utf8"), context: null,
        });
      } catch (error) {
        failures.push({ tool: tool.name, sequence, at, kind: "recording", error: message(error) });
      }
      return raw;
    } catch (error) {
      const detail = message(error);
      failures.push({ tool: tool.name, sequence, at, kind: "tool", error: detail });
      try {
        write(inputs, sequence, {
          tool: tool.name, args: copied, at, raw: null, rawSha256: null,
          rawBytes: 0, context: null, error: detail,
        });
      } catch (recordingError) {
        failures.push({ tool: tool.name, sequence, at, kind: "recording", error: message(recordingError) });
      }
      throw error;
    }
  };

  // Mutate the returned objects themselves: tenant entry tools can close over
  // sibling objects, so a copied wrapper catalog would miss those calls.
  for (const tool of tools) {
    const original = tool.run.bind(tool);
    tool.run = (args) => record(tool, args, () => original(args), tool.mutating);
  }

  let raw: string | null = null;
  let entryError: string | undefined;
  try {
    raw = await entry.run({});
  } catch (error) {
    entryError = message(error);
  }
  const finishedAt = new Date().toISOString();
  const result: RuntimeSourceCapture = {
    stateRoot,
    status: entryError === undefined && failures.length === 0 ? "COMPLETE" : "INCOMPLETE",
    startedAt,
    finishedAt,
    replayAsOf: finishedAt,
    sourceCount,
    sourceFailureCount: failures.filter((failure) => failure.kind === "tool").length,
    recordingFailureCount: failures.filter((failure) => failure.kind === "recording").length,
    entry: {
      tool: options.entryTool,
      raw,
      sha256: raw === null ? null : sha256(raw),
      bytes: raw === null ? 0 : Buffer.byteLength(raw, "utf8"),
      ...(entryError === undefined ? {} : { error: entryError }),
    },
    failures,
  };
  writeFileSync(join(stateRoot, "capture.json"), canonicalJson({
    ...identity,
    ...result,
    inputs: "inputs",
    inputWorldHash: failures.some(failure => failure.kind === "recording")
      ? null : loadSnapshotRecordings(inputs).inputHash,
    eligibility: "DIAGNOSTIC_ONLY",
    acquisitionWindow: { startedAt, finishedAt },
    replay: { asOf: finishedAt },
    localState: "fresh temporary state root; no prior reports, ledger, or recordings were supplied",
    exactSameTimeMarketSnapshot: false,
  }) + "\n", { flag: "wx", mode: 0o600 });
  return result;
}
