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
import {
  ProviderCircuitBreaker,
  type CircuitProvider,
} from "./provider-circuit-breaker.js";

type ProviderId = CircuitProvider;
type AvailabilityRefresher = () => Promise<Availability>;
type RegisteredTarget = RegisteredProviderTargets[number];

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
      "shepherd-incident-lead",
      "shepherd-bounded-repair-planning",
      "shepherd-independent-verification",
      "shepherd-reporting",
      "ib-source-investigation",
      "massive-source-investigation",
      "corporate-action-universe-research",
      "point-in-time-adjudication",
    ],
    operations: {},
    supports: {
      structuredOutput: true,
      toolIsolation: true,
      mutations: false,
    },
  };
}

function orderedTargets(
  registered: ProviderRuntime["registered"],
  preference: ReadonlyArray<readonly [ProviderId, string, string | undefined]>,
): ExecutionTargetId[] {
  const entries = new Map<string, RegisteredTarget>();
  for (const [provider, targets] of Object.entries(registered) as Array<[ProviderId, RegisteredProviderTargets]>) {
    for (const entry of targets) {
      entries.set(`${provider}\0${entry.native.targetRef}\0${entry.native.effort ?? ""}`, entry);
    }
  }
  const ordered: ExecutionTargetId[] = [];
  for (const [provider, targetRef, effort] of preference) {
    const entry = entries.get(`${provider}\0${targetRef}\0${effort ?? ""}`);
    if (entry === undefined) continue;
    ordered.push(entry.profile.targetId);
    entries.delete(`${provider}\0${targetRef}\0${effort ?? ""}`);
  }
  ordered.push(...[...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.profile.targetId));
  return ordered;
}

const CHEAP_TARGET_PREFERENCE = [
  ["codex", "gpt-5.6-luna", "low"],
  ["codex", "gpt-5.6-luna", "medium"],
  ["claude", "claude-haiku-4-5-20251001", undefined],
  ["deepseek", "deepseek-v4-flash", "off"],
  ["deepseek", "deepseek-v4-flash", "low"],
  ["codex", "gpt-5.6-terra", "low"],
  ["codex", "gpt-5.6-terra", "medium"],
  ["claude", "claude-sonnet-5", "low"],
  ["codex", "gpt-5.6-sol", "high"],
] as const;

const SENIOR_TARGET_PREFERENCE = [
  ["codex", "gpt-5.6-sol", "high"],
  ["codex", "gpt-5.6-sol", "xhigh"],
  ["codex", "gpt-5.6-sol", "max"],
  ["deepseek", "deepseek-v4-pro", "high"],
  ["deepseek", "deepseek-v4-pro", "max"],
  ["claude", "claude-opus-5", "high"],
  ["claude", "claude-opus-5", "max"],
  ["deepseek", "deepseek-v4-flash", "high"],
  ["claude", "claude-sonnet-5", "high"],
] as const;

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
  readonly #refreshInFlight = new Map<ProviderId, Promise<ReturnType<ProviderAvailability["publish"]>>>();
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
    const deepseekBoundary = options.deepseekBoundary ?? ({
      run: async () => {
        throw new Error("DeepSeek work must run through DshTeamHost");
      },
    } satisfies DeepSeekDshBoundary);
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
        boundary: deepseekBoundary,
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

    const cheap = orderedTargets(this.registered, CHEAP_TARGET_PREFERENCE);
    const senior = orderedTargets(this.registered, SENIOR_TARGET_PREFERENCE);
    if (senior.length === 0) {
      throw new Error("production provider policy has no certified target");
    }
    const route = (ordered: ExecutionTargetId[]) => ({
      preferred: ordered[0]!,
      fallback: ordered.slice(1),
    });
    const seniorRoles = [
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
      "repair-planner",
      "pit-adjudicator",
    ];
    const cheapRoles = [
      "reporter",
      "ib-investigator",
      "massive-investigator",
      "corporate-action-universe-researcher",
    ];
    const policy: SelectionPolicy = {
      policyVersion: "livewire-shepherd-cost-aware-v1",
      roles: {
        ...Object.fromEntries(seniorRoles.map((role) => [role, route(senior)])),
        ...Object.fromEntries(cheapRoles.map((role) => [role, route(cheap)])),
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

    const probeWorkspace = async <T>(provider: ProviderId, run: (workspace: string) => Promise<T>): Promise<T> => {
      const workspace = join(
        this.#cfg.workspacesDir,
        "provider-refresh",
        `${provider}-${randomUUID()}`,
      );
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      try {
        return await run(workspace);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    };
    const cheapest = (provider: ProviderId): RegisteredTarget | undefined => {
      const targets = orderedTargets(this.registered, CHEAP_TARGET_PREFERENCE);
      return targets.flatMap((targetId) => this.registered[provider].filter((entry) => entry.profile.targetId === targetId))[0];
    };
    const defaultRefreshers: Partial<Record<ProviderId, AvailabilityRefresher>> = {};
    const codexProbe = cheapest("codex");
    if (codexProbe !== undefined) {
      defaultRefreshers.codex = async () => await probeWorkspace("codex", async (workspace) => {
        const result = await codexInvoker({
          model: codexProbe.native.model,
          effort: codexProbe.native.effort as never,
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
      });
    }
    const claudeProbe = cheapest("claude");
    if (claudeProbe !== undefined) {
      defaultRefreshers.claude = async () => await probeWorkspace("claude", async (workspace) => {
        const result = await claudeInvoker({
          model: claudeProbe.native.model,
          ...(claudeProbe.native.effort === undefined ? {} : { effort: claudeProbe.native.effort as never }),
          prompt: "Return exactly: HELIUM_PROVIDER_AVAILABLE",
          cwd: workspace,
          maxTurns: 1,
          timeoutMs: 120_000,
          allowedTools: [],
          env: this.#childEnv(),
        });
        if (result.ok) return { state: "available" };
        if (result.classification === "quota-exhausted") {
          return { state: "quota-exhausted", ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }) };
        }
        return { state: "unavailable" };
      });
    }
    const deepseekProbe = cheapest("deepseek");
    if (deepseekProbe !== undefined) {
      defaultRefreshers.deepseek = async () => await probeWorkspace("deepseek", async (workspace) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        timeout.unref();
        try {
          await deepseekBoundary.run({
            prompt: "Return exactly: HELIUM_PROVIDER_AVAILABLE",
            workspace,
            allowedTools: [],
            signal: controller.signal,
            agentOptions: {
              provider: "deepseek-official",
              model: deepseekProbe.native.model,
              reasoningEffort: deepseekProbe.native.effort as never,
              maxTokens: 32,
            },
          });
          return { state: "available" };
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          return code === "QUOTA" || code === "RATE_LIMIT"
            ? { state: "quota-exhausted" }
            : { state: "unavailable" };
        } finally {
          clearTimeout(timeout);
        }
      });
    }
    for (const [provider, refresher] of Object.entries({
      ...defaultRefreshers,
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
    const unavailable = new Map(
      this.availability
        .snapshot()
        .domains.filter((entry) => entry.availability.state !== "available")
        .map((entry) => [entry.quotaDomain, entry.availability]),
    );
    for (const provider of this.#refreshers.keys()) {
      const state = unavailable.get(this.#domain(provider));
      if (state === undefined) continue;
      if (state.retryAfter !== undefined && retryDelayMs(state.retryAfter, this.#refreshDelayMs) > 0) {
        this.#scheduleRefresh(provider, state);
      } else await this.refreshProviderAvailability(provider);
    }
  }

  /** Runs the provider-owned probe, then publishes its opaque domain state. */
  async refreshProviderAvailability(provider: ProviderId) {
    const active = this.#refreshInFlight.get(provider);
    if (active !== undefined) return await active;
    const pending = this.#refreshProviderAvailability(provider);
    this.#refreshInFlight.set(provider, pending);
    try {
      return await pending;
    } finally {
      this.#refreshInFlight.delete(provider);
    }
  }

  async #refreshProviderAvailability(provider: ProviderId) {
    const refresher = this.#refreshers.get(provider);
    if (refresher === undefined) {
      throw new Error(`provider has no availability refresher: ${provider}`);
    }
    let availability: Availability;
    try {
      availability = await refresher();
    } catch {
      availability = {
        state: "unavailable",
        retryAfter: new Date(Date.now() + this.#refreshDelayMs).toISOString(),
      };
    }
    if (availability.state === "available") this.#circuits.reset(provider);
    const published = this.availability.publish(this.#domain(provider), availability);
    if (availability.state !== "available") this.#scheduleRefresh(provider, availability);
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
    if (provider !== undefined) {
      this.#scheduleRefresh(provider, {
        state: "quota-exhausted",
        ...(result.failure.retryAfter === undefined ? {} : { retryAfter: result.failure.retryAfter }),
      });
    }
  }

  #scheduleRefresh(provider: ProviderId, availability?: Availability): void {
    if (this.#refreshers.get(provider) === undefined || this.#refreshTimers.has(provider)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#refreshTimers.delete(provider);
      void this.refreshProviderAvailability(provider).catch(() => {
        this.#scheduleRefresh(provider);
      });
    }, retryDelayMs(availability?.retryAfter, this.#refreshDelayMs));
    timer.unref();
    this.#refreshTimers.set(provider, timer);
  }

}

function retryDelayMs(retryAfter: string | undefined, fallbackMs: number): number {
  if (retryAfter === undefined) return fallbackMs;
  const relative = /^provider-ms:(\d+)$/.exec(retryAfter)?.[1];
  if (relative !== undefined) return Math.max(1_000, Math.min(Number(relative), 2_147_000_000));
  const absolute = Date.parse(retryAfter);
  if (Number.isFinite(absolute)) {
    return Math.max(1_000, Math.min(absolute - Date.now(), 2_147_000_000));
  }
  return fallbackMs;
}
