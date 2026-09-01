import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlWriter, parseTeamYaml } from "@helium/core";
import {
  buildTenantRunInput,
  loadValidatedTenants,
  TenantRuntime,
  tenantOutputContracts,
  type TenantRuntimeDeps,
} from "./tenant-runtime.js";
import type { OutputContractDefinition } from "./output-contract-registry.js";
import type { TeamRunInput } from "./team-controller.js";
import type { LoadedTenant } from "./tenants.js";

const manifest = parseTeamYaml(`
manifestVersion: "1"
name: fixture
roles:
  scribe:
    responsibility: rendering
    requires: [render]
    permissions:
      externalResearch: false
      mutations: forbidden
      artifactRead: [accepted-claim-ledger]
      tools: []
tasks:
  - id: render
    role: scribe
    dependsOn: []
    requires: [render]
    inputs: [accepted-claim-ledger]
    outputSchema: report@1
crossReference:
  compareClaims: true
  materialContradictions: fresh-evidence-work-order
  requireIndependentEvidence: true
budgets: { maxAttempts: 1, maxTokens: 1000 }
acceptance: { allowPartialClaims: true, terminalTasks: [render] }
`);

function tenant(name: string, enabled = true): LoadedTenant {
  return {
    dir: `/tmp/${name}`,
    manifest,
    spec: {
      tenant: name,
      enabled,
      team: "team.yaml",
      promotionMode: "review-only",
      triggers: [{ kind: "cron", schedule: "* * * * *", timezone: "UTC" }],
      delivery: { jsonl: true },
      extensions: {},
    },
  };
}

/**
 * The pass-through promotion the tests use. Production hands `TenantRuntime`
 * the real `TeamPromotionAdapter`; the point of the seam is that the runtime
 * never reaches past it to the controller, which is why it is required, not
 * optional.
 */
const passthrough: TenantRuntimeDeps["promotion"] = {
  handle: async (tenant, event, run) => {
    await run(
      buildTenantRunInput(tenant.spec.tenant, event, tenant.prompt ?? "run"),
    );
  },
  processCanaryInbox: async () => {},
};

describe("buildTenantRunInput", () => {
  it("hashes the trigger into a stable caseId and one input artifact", () => {
    const event = {
      tenant: "alpha",
      kind: "cron" as const,
      firedAt: "2026-09-01T20:35:00.000Z",
      dedupKey: "alpha:cron:2026-09-01T20:35Z",
      payload: { scheduledFor: "2026-09-01T20:35:00.000Z" },
    };
    const a = buildTenantRunInput("alpha", event, "do the thing");
    const b = buildTenantRunInput("alpha", event, "do the thing");
    expect(a.caseId).toBe(b.caseId);
    expect(a.caseId).toMatch(/^tenant-[0-9a-f]{24}$/);
    expect(a.subject).toBe("alpha:cron");
    expect(a.inputArtifacts).toHaveLength(1);
    expect(a.inputArtifacts[0]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("gives a different caseId to a different fired minute", () => {
    const base = {
      tenant: "alpha",
      kind: "cron" as const,
      firedAt: "2026-09-01T20:35:00.000Z",
      payload: {},
    };
    const one = buildTenantRunInput("alpha", { ...base, dedupKey: "a:1" }, "p");
    const two = buildTenantRunInput("alpha", { ...base, dedupKey: "a:2" }, "p");
    expect(one.caseId).not.toBe(two.caseId);
  });
});

describe("TenantRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads only enabled tenants and writes one tenant-health row each", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-tenant-runtime-"));
    const jsonl = new JsonlWriter(join(stateRoot, "jsonl"));
    const rows: Record<string, unknown>[] = [];
    vi.spyOn(jsonl, "append").mockImplementation((_stream, row) => {
      rows.push(row as Record<string, unknown>);
    });
    const runtime = new TenantRuntime({
      tenantsDir: stateRoot,
      stateRoot,
      tenants: [tenant("alpha"), tenant("beta", false)],
      skipped: [
        { dir: "/tmp/broken", tenant: "broken", reason: "bad team.yaml" },
      ],
      controllerFor: () => ({ run: async () => ({}) as never }),
      promotion: passthrough,
      jsonl,
    });
    runtime.start();
    runtime.stop();
    expect(runtime.tenantNames).toEqual(["alpha"]);
    expect(rows.filter((r) => r.load === "disabled")).toHaveLength(1);
    expect(rows.filter((r) => r.load === "invalid")).toHaveLength(1);
    expect(rows.find((r) => r.tenant === "broken")!.reason).toBe(
      "bad team.yaml",
    );
  });

  it("runs the controller once per cron fire", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-tenant-runtime-"));
    const seen: TeamRunInput[] = [];
    const runtime = new TenantRuntime({
      tenantsDir: stateRoot,
      stateRoot,
      tenants: [tenant("alpha")],
      skipped: [],
      controllerFor: () => ({
        run: async (input: TeamRunInput) => {
          seen.push(input);
          return { state: "completed" } as never;
        },
      }),
      promotion: passthrough,
      jsonl: new JsonlWriter(join(stateRoot, "jsonl")),
    });
    runtime.start();
    await runtime.fireForTest("alpha");
    runtime.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.subject).toBe("alpha:cron");
  });

  it("writes a liveness heartbeat for a tenant that never fired", () => {
    vi.useFakeTimers();
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-tenant-runtime-"));
    const jsonl = new JsonlWriter(join(stateRoot, "jsonl"));
    const rows: Record<string, unknown>[] = [];
    vi.spyOn(jsonl, "append").mockImplementation((_stream, row) => {
      rows.push(row as Record<string, unknown>);
    });
    const runtime = new TenantRuntime({
      tenantsDir: stateRoot,
      stateRoot,
      tenants: [tenant("alpha")],
      skipped: [],
      controllerFor: () => ({ run: async () => ({}) as never }),
      promotion: passthrough,
      jsonl,
      livenessMs: 10,
    });
    runtime.start();
    vi.advanceTimersByTime(35);
    runtime.stop();
    const liveness = rows.filter((r) => r.trigger === "liveness");
    expect(liveness.length).toBeGreaterThanOrEqual(3);
    // `tenantHealth()` reads `row.job`; renaming it would silently break the
    // dead-man check against the retained 90-day trail.
    expect(liveness[0]!.job).toBe("alpha");
    // 10 ms << the 600 s HELIUM_DEADMAN_STALE_S default, so the dead-man's
    // window accepts a tenant whose only cron fire is daily.
    expect(10).toBeLessThan(600_000);
  });
});

const stubDefinition = {
  id: "stub",
  prompt: () => "stub",
  parse: (raw: string) => JSON.parse(raw) as unknown,
} as unknown as OutputContractDefinition;

describe("tenantOutputContracts", () => {
  it("lets a tenant descriptor ADD to the builtin output contracts", () => {
    const registry = tenantOutputContracts({
      ...tenant("alpha"),
      descriptor: {
        outputContracts: () => ({ "alpha-gates@1": stubDefinition }),
      },
    });
    expect(registry.has("alpha-gates@1")).toBe(true);
    expect(registry.has("ClaimSet.v1")).toBe(true);
    expect(registry.has("EvidenceDecisionSet.v1")).toBe(true);
  });

  it("keeps the builtin registry when the tenant ships no extension", () => {
    const registry = tenantOutputContracts(tenant("alpha"));
    expect(registry.has("EvidenceDecisionSet.v1")).toBe(true);
    expect(registry.has("alpha-gates@1")).toBe(false);
  });

  it("refuses a tenant redefining a builtin, naming the tenant", () => {
    expect(() =>
      tenantOutputContracts({
        ...tenant("alpha"),
        descriptor: {
          outputContracts: () => ({ "ClaimSet.v1": stubDefinition }),
        },
      }),
    ).toThrow(/tenant alpha output contract ClaimSet\.v1/);
  });
});

const TENANT_YAML = `
tenant: alpha
enabled: true
team: team.yaml
promotionMode: review-only
triggers:
  - kind: cron
    schedule: "0 20 * * 1-5"
    timezone: UTC
delivery:
  jsonl: true
`;

/** A real on-disk tenant whose built descriptor answers `readiness()`. */
function readinessFixture(verdict: string): string {
  const root = mkdtempSync(join(tmpdir(), "helium-readiness-"));
  const dir = join(root, "alpha");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "tenant.yaml"), TENANT_YAML);
  writeFileSync(
    join(dir, "team.yaml"),
    `
manifestVersion: "1"
name: fixture
roles:
  scribe:
    responsibility: rendering
    requires: [render]
    permissions:
      externalResearch: false
      mutations: forbidden
      artifactRead: [accepted-claim-ledger]
      tools: []
tasks:
  - id: render
    role: scribe
    dependsOn: []
    requires: [render]
    inputs: [accepted-claim-ledger]
    outputSchema: report@1
crossReference:
  compareClaims: true
  materialContradictions: fresh-evidence-work-order
  requireIndependentEvidence: true
budgets: { maxAttempts: 1, maxTokens: 1000 }
acceptance: { allowPartialClaims: true, terminalTasks: [render] }
`,
  );
  writeFileSync(
    join(dir, "lib", "index.js"),
    `export default { readiness: async () => (${verdict}) };\n`,
  );
  return root;
}

describe("loadValidatedTenants readiness", () => {
  it("skips a tenant whose readiness probe says no, with its reason", async () => {
    const root = readinessFixture('{ ok: false, reason: "uv missing" }');
    const result = await loadValidatedTenants({
      tenantsDir: root,
      stateRoot: root,
      env: {},
    });
    expect(result.tenants).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.tenant).toBe("alpha");
    expect(result.skipped[0]!.reason).toBe("not ready: uv missing");
  });

  it("loads a tenant whose readiness probe says yes", async () => {
    const root = readinessFixture("{ ok: true }");
    const result = await loadValidatedTenants({
      tenantsDir: root,
      stateRoot: root,
      env: {},
    });
    expect(result.skipped).toEqual([]);
    expect(result.tenants.map((t) => t.spec.tenant)).toEqual(["alpha"]);
  });
});
