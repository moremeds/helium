import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  CapabilityCatalog,
  LeaseStore,
  WorkOrderSchema,
  type AgentResult,
  type ConformanceRecord,
  type ExecutionTargetId,
  type SelectionPolicy,
  type WorkOrder,
} from "@helium/core";
import type {
  EntitlementCertification,
  RegisteredProviderTargets,
} from "@helium/provider-sdk/registration";
import {
  claudeSubscriptionCatalog,
  type ClaudeCatalog,
} from "@helium/provider-claude-subscription/catalog";
import {
  registerCertifiedClaudeTargets,
} from "@helium/provider-claude-subscription/executor";
import type { ClaudeInvocationResult } from "@helium/provider-claude-subscription/invoke";
import {
  codexSubscriptionCatalog,
  type CodexCatalog,
} from "@helium/provider-codex-subscription/catalog";
import {
  registerCertifiedCodexTargets,
} from "@helium/provider-codex-subscription/executor";
import type { CodexInvocationResult } from "@helium/provider-codex-subscription/invoke";
import {
  deepseekDshCatalog,
  type DeepSeekCatalog,
} from "@helium/provider-deepseek-dsh/catalog";
import {
  registerCertifiedDeepSeekTargets,
} from "@helium/provider-deepseek-dsh/executor";
import type { DeepSeekDshBoundary } from "@helium/provider-deepseek-dsh/invoke";
import type { JobSpec } from "@helium/v1-compat";
import { buildChildEnv } from "./claude.js";
import {
  CordisTeamParentFactory,
  CordisTeamSubagentRuntime,
  DshTeamHost,
} from "./dsh-team-host.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { ProviderAvailability } from "./provider-availability.js";
import { RoutingService } from "./routing-service.js";
import type { SeniorLane } from "./dispatch.js";

type ProviderCatalogWithSource =
  | ClaudeCatalog
  | CodexCatalog
  | DeepSeekCatalog;

function certification(catalog: ProviderCatalogWithSource): EntitlementCertification {
  return {
    certificationVersion: `${catalog.catalogVersion}:enabled-v1`,
    catalogSnapshotHash: catalog.snapshotHash,
    recordedAt: catalog.source.recordedAt,
    source: catalog.source.kind,
    targets: catalog.targets
      .filter((target) => target.enabled)
      .map((target) => ({
        targetRef: target.targetRef,
        variants: target.effort.supported ? [...target.effort.options] : [null],
      })),
  };
}

function conformance(
  targetId: ExecutionTargetId,
  provenClass: "in-process" | "process",
  recordedAt: string,
): ConformanceRecord {
  return {
    targetId,
    provenClass,
    basis:
      provenClass === "in-process"
        ? "floor"
        : "execution-boundary-conformance",
    recordedAt,
  };
}

function targetProfile() {
  return {
    capabilities: ["analysis.general"],
    operations: {},
    supports: {
      structuredOutput: true,
      toolIsolation: true,
      mutations: false,
    },
  };
}

function findTarget(
  registered: RegisteredProviderTargets,
  targetRef: string,
  effort: string,
): ExecutionTargetId {
  const found = registered.find(
    (entry) => entry.native.targetRef === targetRef && entry.native.effort === effort,
  );
  if (found === undefined) {
    throw new Error(`production policy names uncertified target ${targetRef}/${effort}`);
  }
  return found.profile.targetId;
}

class DurableNdjsonAudit {
  constructor(private readonly path: string) {}

  append(record: unknown): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(this.path, 0o600);
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

export interface ProviderRuntimeOptions {
  codexInvoke?: (input: never) => Promise<CodexInvocationResult>;
  claudeInvoke?: (input: never) => Promise<ClaudeInvocationResult>;
  deepseekBoundary?: DeepSeekDshBoundary;
}

export interface ProviderRuntimeConfig {
  stateRoot: string;
  workspacesDir: string;
  claudeTokenFile: string;
  envFile: string;
  proxy: string;
}

/** Runnable Phase-2 provider plane used by the production plugin and P3 controller. */
export class ProviderRuntime {
  readonly capabilities = new CapabilityCatalog();
  readonly leases = new LeaseStore();
  readonly availability: ProviderAvailability;
  readonly registry: ExecutorRegistry;
  readonly routing: RoutingService;
  readonly host: DshTeamHost;
  readonly registered: {
    codex: RegisteredProviderTargets;
    deepseek: RegisteredProviderTargets;
    claude: RegisteredProviderTargets;
  };
  readonly #domainDisposers: Array<() => void> = [];
  readonly #cfg: ProviderRuntimeConfig;

  constructor(
    ctx: Pick<Context, "agents" | "sessions" | "sessionPersistence" | "subagents">,
    cfg: ProviderRuntimeConfig,
    options: ProviderRuntimeOptions = {},
  ) {
    this.#cfg = cfg;
    const availabilityAudit = new DurableNdjsonAudit(
      join(cfg.stateRoot, "audit", "provider-availability.ndjson"),
    );
    this.availability = new ProviderAvailability(this.capabilities, {
      statePath: join(cfg.stateRoot, "providers", "availability.json"),
      onChange: (snapshot) =>
        availabilityAudit.append({
          at: new Date().toISOString(),
          type: "provider-availability-changed",
          snapshot,
        }),
    });
    this.registry = new ExecutorRegistry({
      onResult: (result) => {
        this.availability.observe(result);
      },
    });
    const processProof = (targetId: ExecutionTargetId) =>
      conformance(targetId, "process", "2026-08-30T00:00:00.000Z");
    this.registered = {
      codex: registerCertifiedCodexTargets({
        certification: certification(codexSubscriptionCatalog),
        capabilityCatalog: this.capabilities,
        executorRegistry: this.registry,
        conformanceFor: processProof,
        targetProfile: targetProfile(),
        ...(options.codexInvoke === undefined
          ? {}
          : { invoke: options.codexInvoke as never }),
      }),
      deepseek: registerCertifiedDeepSeekTargets({
        certification: certification(deepseekDshCatalog),
        capabilityCatalog: this.capabilities,
        executorRegistry: this.registry,
        conformanceFor: (targetId) =>
          conformance(targetId, "in-process", deepseekDshCatalog.source.recordedAt),
        targetProfile: targetProfile(),
        subagentProviderName: "spawn",
        boundary:
          options.deepseekBoundary ??
          ({
            run: async () => {
              throw new Error("DeepSeek work must run through DshTeamHost");
            },
          } satisfies DeepSeekDshBoundary),
      }),
      claude: registerCertifiedClaudeTargets({
        certification: certification(claudeSubscriptionCatalog),
        capabilityCatalog: this.capabilities,
        executorRegistry: this.registry,
        conformanceFor: processProof,
        targetProfile: targetProfile(),
        ...(options.claudeInvoke === undefined
          ? {}
          : { invoke: options.claudeInvoke as never }),
      }),
    };

    const byDomain = new Map<string, ExecutionTargetId[]>();
    for (const entry of Object.values(this.registered).flat()) {
      const targets = byDomain.get(entry.native.quotaDomain) ?? [];
      targets.push(entry.profile.targetId);
      byDomain.set(entry.native.quotaDomain, targets);
    }
    for (const [domain, targets] of byDomain) {
      this.#domainDisposers.push(
        this.availability.registerDomain(
          domain,
          targets,
          domain === "claude-subscription-session"
            ? { state: "quota-exhausted" }
            : { state: "available" },
        ),
      );
    }

    const policy: SelectionPolicy = {
      policyVersion: "phase-2-production-v1",
      roles: {
        "v1-senior": {
          preferred: findTarget(this.registered.codex, "gpt-5.6-sol", "high"),
          fallback: [
            findTarget(this.registered.deepseek, "deepseek-v4-pro", "high"),
            findTarget(this.registered.deepseek, "deepseek-v4-flash", "high"),
            findTarget(this.registered.claude, "claude-opus-5", "max"),
          ],
        },
      },
    };
    const audit = new DurableNdjsonAudit(
      join(cfg.stateRoot, "audit", "routing.ndjson"),
    );
    this.routing = new RoutingService({
      catalog: this.capabilities,
      leases: this.leases,
      policy,
      audit: async (record) => audit.append(record),
    });
    this.host = new DshTeamHost({
      registry: this.registry,
      leases: this.leases,
      subagents: new CordisTeamSubagentRuntime(ctx.subagents),
      parents: new CordisTeamParentFactory(ctx),
      workspacesDir: cfg.workspacesDir,
      env: buildChildEnv(cfg, { PATH: process.env.PATH ?? "" }),
      outputSchemaFor: () => ({
        type: "object",
        properties: { analysis: { type: "string" } },
        required: ["analysis"],
        additionalProperties: false,
      }),
      maxDepth: 1,
      observeResult: (result) => {
        this.availability.observe(result);
      },
    });
  }

  async start(): Promise<void> {
    await this.registry.reconcileOrphanProcesses(this.#cfg.workspacesDir);
  }

  seniorLane(mcpConfigFor: (job: JobSpec, dir: string) => string): SeniorLane {
    return {
      dispatch: async (job, _event, prompt) => {
        const configDir = join(
          this.#cfg.workspacesDir,
          "routing-config",
          randomUUID(),
        );
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const work = WorkOrderSchema.parse({
          id: `v1-senior-${job.name}-${randomUUID()}`,
          role: "v1-senior",
          taskClass: "analysis.v1-senior",
          requires: ["analysis.general"],
          constraints: {
            tools: [...job.tools],
            mutations: "forbidden",
            minIsolationClass: "in-process",
            maxLatencyMs: job.timeoutMs,
          },
          inputs: { artifacts: [], prompt },
          acceptance: { outputSchema: "v1-senior-analysis" },
        });
        try {
          return await this.#runSenior(work, job, mcpConfigFor(job, configDir));
        } finally {
          rmSync(configDir, { recursive: true, force: true });
        }
      },
    };
  }

  async dispose(): Promise<void> {
    await this.host.drain();
    for (const dispose of this.#domainDisposers.reverse()) dispose();
    this.registered.claude.dispose();
    this.registered.deepseek.dispose();
    this.registered.codex.dispose();
  }

  async #runSenior(
    work: WorkOrder,
    job: JobSpec,
    mcpConfigPath: string,
  ): Promise<Awaited<ReturnType<SeniorLane["dispatch"]>>> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const routed = await this.routing.route({
        work,
        reservedCost: 0,
        leaseExpiresAt: new Date(Date.now() + job.timeoutMs + 5_000).toISOString(),
      });
      if (routed.lease === undefined) {
        return {
          outcome: "run_failed",
          error: `waiting-for-capacity: ${routed.decision.failure?.reasons.join("; ") ?? "no eligible target"}`,
        };
      }
      if (tried.has(String(routed.lease.targetId))) {
        return { outcome: "run_failed", error: "waiting-for-capacity: no new target" };
      }
      tried.add(String(routed.lease.targetId));
      const result = await this.host.run(
        `v1-${job.name}`,
        work,
        routed.lease,
        new AbortController().signal,
        {
          env: buildChildEnv(this.#cfg, { PATH: process.env.PATH ?? "" }),
          mcpConfigPath,
        },
      );
      if (result.failure?.class === "quota-exhausted") continue;
      return resultToSenior(result);
    }
    return { outcome: "run_failed", error: "waiting-for-capacity" };
  }
}

function resultToSenior(result: AgentResult): Awaited<ReturnType<SeniorLane["dispatch"]>> {
  if (result.outcome === "completed") {
    const structured = result.structured as { analysis?: unknown } | string | undefined;
    const analysis =
      typeof structured === "string"
        ? structured
        : typeof structured?.analysis === "string"
          ? structured.analysis
          : JSON.stringify(structured ?? {});
    return { outcome: "run_completed", analysis };
  }
  if (result.failure?.class === "timeout") {
    return { outcome: "timed_out", error: "senior lane exceeded its wall clock" };
  }
  return {
    outcome: "run_failed",
    error: `${result.failure?.class ?? "provider-error"}${result.failure?.retryAfter ? ` (retry after ${result.failure.retryAfter})` : ""}`,
  };
}
