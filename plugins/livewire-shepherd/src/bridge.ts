import { isAbsolute, relative, resolve } from "node:path";
import type { ContentAddressedArtifactStore, StoredArtifact } from "@helium/core";
import type {
  ExecutionReceipt,
  ScriptExecutor,
  ScriptRegistry,
} from "dsh-plugin-ops-agent";
import { z } from "zod";
import type { HashedArtifactRef, ShepherdWorkUnit } from "./work-unit.js";

const EvidenceSchema = z.strictObject({
  ref: z.string().min(1).max(2_000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const LivewireReceiptSchema = z.strictObject({
  version: z.literal(1),
  operationKind: z.literal("probe"),
  operationId: z.string().min(1).max(200),
  workUnitId: z.string().min(1).max(200),
  outcome: z.enum(["completed", "no-op", "temporary-unavailable", "unsafe", "failed"]),
  stateHint: z.enum(["VERIFIED", "AWAITING_PROVIDER", "AWAITING_USER", "QUARANTINED", "UNRESOLVED"]),
  scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidence: z.array(EvidenceSchema),
  changedPaths: z.array(z.string().max(2_000)),
  summary: z.record(z.string(), z.unknown()),
}).superRefine((receipt, ctx) => {
  if (receipt.outcome === "temporary-unavailable" &&
      receipt.stateHint !== "AWAITING_PROVIDER" && receipt.stateHint !== "AWAITING_USER") {
    ctx.addIssue({ code: "custom", path: ["stateHint"], message: "temporary-unavailable has invalid state hint" });
  }
  if ((receipt.outcome === "unsafe" || receipt.outcome === "failed") &&
      receipt.stateHint !== "QUARANTINED" && receipt.stateHint !== "UNRESOLVED") {
    ctx.addIssue({ code: "custom", path: ["stateHint"], message: "unsafe or failed has invalid state hint" });
  }
  if (receipt.stateHint === "VERIFIED" &&
      ((receipt.outcome !== "completed" && receipt.outcome !== "no-op") || receipt.evidence.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "VERIFIED requires completed or no-op with evidence" });
  }
  if ((receipt.outcome === "completed" || receipt.outcome === "no-op") && receipt.stateHint !== "VERIFIED") {
    ctx.addIssue({ code: "custom", path: ["stateHint"], message: "completed or no-op must map to VERIFIED" });
  }
});
export type LivewireReceipt = z.infer<typeof LivewireReceiptSchema>;

export interface BridgeProbeResult {
  outcome: LivewireReceipt["outcome"];
  stateHint: LivewireReceipt["stateHint"];
  receipt: LivewireReceipt;
  stdout: StoredArtifact;
  execution: ExecutionReceipt;
  evidence: HashedArtifactRef[];
}

export class LivewireBridge {
  constructor(private readonly options: {
    registry: ScriptRegistry;
    executor: ScriptExecutor;
    artifacts: ContentAddressedArtifactStore;
    changedPathRoots: string[];
  }) {}

  async probe(input: {
    executorId: string;
    operationId: string;
    workUnit: ShepherdWorkUnit;
    argv: string[];
    signal: AbortSignal;
  }): Promise<BridgeProbeResult> {
    const script = this.options.registry.get(input.executorId);
    if (script === undefined) throw new Error(`unknown executor: ${input.executorId}`);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const execution = await this.options.executor.run(
      { actionId: input.operationId, executorId: input.executorId, argv: input.argv },
      input.signal,
      undefined,
      (stream, chunk) => {
        if (stream === "stdout") {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= script.maxOutputBytes) stdout.push(Buffer.from(chunk));
        } else {
          stderrBytes += chunk.length;
          if (stderrBytes <= script.maxOutputBytes) stderr.push(Buffer.from(chunk));
        }
      },
    );
    if (stdoutBytes > script.maxOutputBytes || stderrBytes > script.maxOutputBytes) {
      throw new Error("Livewire bridge output exceeded configured bound");
    }
    const stdoutBody = Buffer.concat(stdout);
    const saved = this.options.artifacts.put(stdoutBody);
    if (stderrBytes > 0) throw new Error(`Livewire probe wrote to stderr: ${Buffer.concat(stderr).toString("utf8")}`);
    if (execution.outputDigest !== saved.hash) throw new Error("Livewire stdout digest mismatch");
    if (execution.exit.code !== 0 || execution.timedOut) throw new Error("Livewire probe process failed");

    const receipt = LivewireBridge.validateReceipt(
      stdoutBody.toString("utf8"),
      input.workUnit,
      input.operationId,
      this.options.changedPathRoots,
    );
    const evidence = LivewireBridge.verifyEvidence(receipt, this.options.artifacts);
    return {
      outcome: receipt.outcome,
      stateHint: receipt.stateHint,
      receipt,
      stdout: saved,
      execution,
      evidence: [...evidence, { ref: saved.ref, hash: saved.hash }],
    };
  }

  static validateReceipt(
    stdout: string,
    workUnit: ShepherdWorkUnit,
    operationId: string,
    changedPathRoots: string[],
  ): LivewireReceipt {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch (error) {
      throw new Error("Livewire stdout must contain exactly one JSON object", { cause: error });
    }
    const receipt = LivewireReceiptSchema.parse(raw);
    if (receipt.workUnitId !== workUnit.workUnitId) throw new Error("Livewire receipt work unit mismatch");
    if (receipt.scopeHash !== workUnit.scopeHash) throw new Error("Livewire receipt scope hash mismatch");
    if (receipt.operationId !== operationId) {
      throw new Error("Livewire receipt operation mismatch");
    }
    for (const path of receipt.changedPaths) {
      if (!isAbsolute(path)) throw new Error(`changed path must be absolute: ${path}`);
      if (!changedPathRoots.some((root) => isWithin(root, path))) {
        throw new Error(`changed path is outside configured roots: ${path}`);
      }
    }
    if (receipt.changedPaths.length > 0) throw new Error("read-only Livewire probe changed paths");
    return receipt;
  }

  static verifyEvidence(
    receipt: LivewireReceipt,
    artifacts: ContentAddressedArtifactStore,
  ): HashedArtifactRef[] {
    return receipt.evidence.map((item): HashedArtifactRef => {
      const hash = `sha256:${item.sha256}` as const;
      artifacts.verify(`artifact://sha256/${item.sha256}`, hash);
      return { ref: item.ref, hash };
    });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}
