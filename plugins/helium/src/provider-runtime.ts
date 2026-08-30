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
  type Availability,
  type ConformanceRecord,
  type ExecutionTargetId,
  type SelectionPolicy,
  type WorkOrder,
} from "@helium/core";
import type { RegisteredProviderTargets } from "@helium/provider-sdk/registration";
import {
  registerCertifiedClaudeTargets,
} from "@helium/provider-claude-subscription/executor";
import {
  invokeClaude,
} from "@helium/provider-claude-subscription/invoke";
import {
  registerCertifiedCodexTargets,
} from "@helium/provider-codex-subscription/executor";
import {
  invokeCodex,
} from "@helium/provider-codex-subscription/invoke";
import {
  deepseekDshCatalog,
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
  type TeamParentFactory,
  type TeamSubagentRuntime,
} from "./dsh-team-host.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { ProviderAvailability } from "./provider-availability.js";
import {
  productionProviderCertifications,
  type ProviderCertifications,
} from "./provider-certifications.js";
import { RoutingService } from "./routing-service.js";
import type { SeniorLane } from "./dispatch.js";
import {
  ProviderCircuitBreaker,
  type CircuitProvider,
} from "./provider-circuit-breaker.js";

type ProviderId = CircuitProvider;
type AvailabilityRefresher = () => Promise<Availability>;

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
    capabilities: [
      "analysis.general",
      "macro-source-research",
      "inflation-analysis",
      "policy-analysis",
      "rates-path-analysis",
      "usd-transmission-analysis",
      "gold-impact-analysis",
      "claim-verification",
      "fresh-evidence",
      "independent-source",
      "macro-causal-synthesis",
      "render-adjudicated-claims",
      "ops-diagnosis",
      "ops-independent-verification",
      "ops-incident-lead",
      "ops-incident-reporting",
    ],
    operations: {},
    supports: {
      structuredOutput: true,
      toolIsolation: true,
      mutations: false,
    },
  };
}

function optionalTarget(
  registered: RegisteredProviderTargets,
  targetRef: string,
  effort: string,
): ExecutionTargetId | undefined {
  return registered.find(
    (entry) => entry.native.targetRef === targetRef && entry.native.effort === effort,
  )?.profile.targetId;
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
  codexInvoke?: typeof invokeCodex;
  claudeInvoke?: typeof invokeClaude;
  deepseekBoundary?: DeepSeekDshBoundary;
  certifications?: ProviderCertifications;
  availabilityRefreshers?: Partial<Record<ProviderId, AvailabilityRefresher>>;
  availabilityRefreshDelayMs?: number;
  circuitFailureThreshold?: number;
  subagents?: TeamSubagentRuntime;
  parents?: TeamParentFactory;
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
  readonly #refreshers = new Map<ProviderId, AvailabilityRefresher>();
  readonly #refreshTimers = new Map<ProviderId, NodeJS.Timeout>();
  readonly #refreshDelayMs: number;
  readonly #circuits: ProviderCircuitBreaker;
  readonly #observedResults = new Set<string>();

  constructor(
    ctx: Pick<Context, "agents" | "sessions" | "sessionPersistence" | "subagents">,
    cfg: ProviderRuntimeConfig,
    options: ProviderRuntimeOptions = {},
  ) {
    this.#cfg = cfg;
    this.#refreshDelayMs = options.availabilityRefreshDelayMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.#refreshDelayMs) || this.#refreshDelayMs < 1_000) {
      throw new Error("provider availability refresh delay must be at least one second");
    }
    const certifications = options.certifications ?? productionProviderCertifications;
    const codexInvoker = options.codexInvoke ?? invokeCodex;
    const claudeInvoker = options.claudeInvoke ?? invokeClaude;
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
      onResult: (result) => this.#observeResult(result),
    });
    const processProof = (targetId: ExecutionTargetId) =>
      conformance(targetId, "process", "2026-08-30T00:00:00.000Z");
    this.registered = {
      codex: registerCertifiedCodexTargets({
        certification: certifications.codex,
        capabilityCatalog: this.capabilities,
        executorRegistry: this.registry,
        conformanceFor: processProof,
        targetProfile: targetProfile(),
        invoke: codexInvoker,
      }),
      deepseek: registerCertifiedDeepSeekTargets({
        certification: certifications.deepseek,
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
        certification: certifications.claude,
        capabilityCatalog: this.capabilities,
        executorRegistry: this.registry,
        conformanceFor: processProof,
        targetProfile: targetProfile(),
        invoke: claudeInvoker,
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

    const circuitAudit = new DurableNdjsonAudit(
      join(cfg.stateRoot, "audit", "provider-circuits.ndjson"),
    );
    this.#circuits = new ProviderCircuitBreaker({
      statePath: join(cfg.stateRoot, "providers", "circuits.json"),
      failureThreshold: options.circuitFailureThreshold ?? 3,
      onOpen: (provider) => {
        this.availability.publish(this.#domain(provider), { state: "unavailable" });
        this.#scheduleRefresh(provider);
      },
      onChange: (circuits) => circuitAudit.append({
        at: new Date().toISOString(),
        type: "provider-circuits-changed",
        circuits,
      }),
    });

    const ordered = [
      optionalTarget(this.registered.codex, "gpt-5.6-sol", "high"),
      optionalTarget(this.registered.deepseek, "deepseek-v4-flash", "high"),
      optionalTarget(this.registered.claude, "claude-opus-5", "max"),
    ].filter((target): target is ExecutionTargetId => target !== undefined);
    if (ordered.length === 0) {
      throw new Error("production provider policy has no certified target");
    }
    const policy: SelectionPolicy = {
      policyVersion: "phase-4-production-v1",
      roles: Object.fromEntries([
        "v1-senior",
        "inflation-researcher",
        "policy-researcher",
        "rates-analyst",
        "usd-analyst",
        "gold-analyst",
        "verifier",
        "lead",
        "renderer",
        "diagnostician",
        "independent-verifier",
        "incident-lead",
        "reporter",
      ].map((role) => [
        role,
        { preferred: ordered[0]!, fallback: ordered.slice(1) },
      ])),
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
      subagents: options.subagents ?? new CordisTeamSubagentRuntime(ctx.subagents),
      parents: options.parents ?? new CordisTeamParentFactory(ctx),
      workspacesDir: cfg.workspacesDir,
      env: this.#childEnv(),
      outputSchemaFor: () => ({
        type: "object",
        properties: { analysis: { type: "string" } },
        required: ["analysis"],
        additionalProperties: false,
      }),
      maxDepth: 1,
      observeResult: (result) => this.#observeResult(result),
    });

    const codexRefresh: AvailabilityRefresher = async () => {
      const workspace = join(
        this.#cfg.workspacesDir,
        "provider-refresh",
        `codex-${randomUUID()}`,
      );
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      try {
        const result = await codexInvoker({
          model: "gpt-5.6-sol",
          effort: "high",
          prompt: "Return exactly: HELIUM_PROVIDER_AVAILABLE",
          cwd: workspace,
          timeoutMs: 120_000,
          sandbox: "read-only",
          env: this.#childEnv(),
          allowedTools: [],
        });
        if (result.ok) return { state: "available" };
        if (result.classification === "quota-exhausted") {
          return {
            state: "quota-exhausted",
            ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
          };
        }
        return { state: "unavailable" };
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    };
    for (const [provider, refresher] of Object.entries({
      codex: codexRefresh,
      ...options.availabilityRefreshers,
    }) as Array<[ProviderId, AvailabilityRefresher]>) {
      this.#refreshers.set(provider, refresher);
    }
  }

  async start(): Promise<void> {
    await this.registry.reconcileOrphanProcesses(this.#cfg.workspacesDir);
    for (const circuit of this.#circuits.snapshot()) {
      if (circuit.state === "open") {
        this.availability.publish(this.#domain(circuit.provider), { state: "unavailable" });
      }
    }
    const unavailable = new Set(
      this.availability
        .snapshot()
        .domains.filter((entry) => entry.availability.state !== "available")
        .map((entry) => entry.quotaDomain),
    );
    for (const provider of this.#refreshers.keys()) {
      if (unavailable.has(this.#domain(provider))) {
        await this.refreshProviderAvailability(provider);
      }
    }
  }

  /** Runs the provider-owned probe, then publishes its opaque domain state. */
  async refreshProviderAvailability(provider: ProviderId) {
    const refresher = this.#refreshers.get(provider);
    if (refresher === undefined) {
      throw new Error(`provider has no availability refresher: ${provider}`);
    }
    const availability = await refresher();
    if (availability.state === "available") this.#circuits.reset(provider);
    const published = this.availability.publish(this.#domain(provider), availability);
    if (availability.state !== "available") this.#scheduleRefresh(provider);
    return published;
  }

  healthSnapshot() {
    return {
      ...this.availability.snapshot(),
      circuits: this.#circuits.snapshot(),
    };
  }

  async runTeam(
    teamRunId: string,
    work: WorkOrder,
    lease: import("@helium/core").ExecutionLease,
    signal: AbortSignal,
    mcpConfigFor: (work: WorkOrder, dir: string) => string,
  ): Promise<AgentResult> {
    const configDir = join(
      this.#cfg.workspacesDir,
      "team-routing-config",
      randomUUID(),
    );
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    try {
      return await this.host.run(teamRunId, work, lease, signal, {
        env: this.#childEnv(),
        mcpConfigPath: mcpConfigFor(work, configDir),
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }

  seniorLane(mcpConfigFor: (job: JobSpec, dir: string) => string): SeniorLane {
    return {
      dispatch: async (job, _event, prompt, deadlineSignal) => {
        const ownedController =
          deadlineSignal === undefined ? new AbortController() : undefined;
        const signal = deadlineSignal ?? ownedController!.signal;
        const timeout =
          ownedController === undefined
            ? undefined
            : setTimeout(() => ownedController.abort(), job.timeoutMs);
        timeout?.unref();
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
          return await this.#runSenior(
            work,
            job,
            mcpConfigFor(job, configDir),
            signal,
          );
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          rmSync(configDir, { recursive: true, force: true });
        }
      },
    };
  }

  async dispose(): Promise<void> {
    for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
    this.#refreshTimers.clear();
    await this.host.drain();
    for (const dispose of this.#domainDisposers.reverse()) dispose();
    this.registered.claude.dispose();
    this.registered.deepseek.dispose();
    this.registered.codex.dispose();
  }

  #domain(provider: ProviderId): string {
    return {
      codex: "codex-subscription-session",
      deepseek: "deepseek-api-key",
      claude: "claude-subscription-session",
    }[provider];
  }

  #childEnv(): Record<string, string> {
    return buildChildEnv(this.#cfg, {
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      ...(process.env.CODEX_HOME === undefined
        ? {}
        : { CODEX_HOME: process.env.CODEX_HOME }),
    });
  }

  #providerFor(targetId: string): ProviderId | undefined {
    for (const provider of ["codex", "deepseek", "claude"] as const) {
      if (
        this.registered[provider].some(
          (entry) => String(entry.profile.targetId) === targetId,
        )
      ) {
        return provider;
      }
    }
    return undefined;
  }

  #observeResult(result: AgentResult): void {
    const observationKey = [
      result.workId,
      result.executionSnapshot.targetId,
      result.executionSnapshot.recordedAt,
      result.outcome,
    ].join(":");
    if (this.#observedResults.has(observationKey)) return;
    this.#observedResults.add(observationKey);
    if (this.#observedResults.size > 1_000) {
      const oldest = this.#observedResults.values().next().value;
      if (oldest !== undefined) this.#observedResults.delete(oldest);
    }
    this.availability.observe(result);
    const provider = this.#providerFor(result.executionSnapshot.targetId);
    if (provider !== undefined) this.#circuits.observe(provider, result);
    if (result.failure?.class !== "quota-exhausted") return;
    if (provider !== undefined) this.#scheduleRefresh(provider);
  }

  #scheduleRefresh(provider: ProviderId): void {
    if (this.#refreshers.get(provider) === undefined || this.#refreshTimers.has(provider)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#refreshTimers.delete(provider);
      void this.refreshProviderAvailability(provider).catch(() => {
        this.#scheduleRefresh(provider);
      });
    }, this.#refreshDelayMs);
    timer.unref();
    this.#refreshTimers.set(provider, timer);
  }

  async #runSenior(
    work: WorkOrder,
    job: JobSpec,
    mcpConfigPath: string,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<SeniorLane["dispatch"]>>> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (signal.aborted) {
        return { outcome: "timed_out", error: "senior lane exceeded its wall clock" };
      }
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
        signal,
        {
          env: this.#childEnv(),
          mcpConfigPath,
        },
      );
      if (signal.aborted) {
        return { outcome: "timed_out", error: "senior lane exceeded its wall clock" };
      }
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
