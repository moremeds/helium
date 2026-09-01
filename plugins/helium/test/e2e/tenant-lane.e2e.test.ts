import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutionTargetId,
  JsonlWriter,
  openTeamStore,
  type AgentResult,
  type TeamRunProjection,
  type WorkOrder,
} from "@helium/core";
import { Delivery } from "../../src/delivery.js";
import {
  TeamController,
  type TeamExecutionPort,
} from "../../src/team-controller.js";
import { TenantDelivery } from "../../src/tenant-delivery.js";
import { loadTenantTools, validateTeamTools } from "../../src/tenant-tools.js";
import {
  buildTenantRunInput,
  loadValidatedTenants,
  TenantRuntime,
  tenantOutputContracts,
  type TenantRuntimeDeps,
} from "../../src/tenant-runtime.js";
import {
  inventoryTenantPlugins,
  loadTenants,
  parseTenantYaml,
} from "../../src/tenants.js";

const pluginsDir = resolve(import.meta.dirname, "../../..");

/**
 * The e2e-project copy of the tenant-lane proof, replacing the deleted v1
 * `harness.e2e.test.ts`. `vitest.e2e.config.ts` includes every e2e test file
 * and sets no `passWithNoTests`, so this project needs at least one real
 * end-to-end subject; the tenant lane's is a genuine TeamController run.
 *
 * The CI seam drill deliberately moves this whole tenant directory away, runs
 * the unit suite, and moves it back. These assertions are about the tenant
 * BEING there, so running them while it is deliberately absent would fail for
 * the wrong reason and prove nothing about the seam. (`vitest --exclude` is
 * silently ignored for a `--project` run here, so the guard lives in the file.)
 *
 * An ACCIDENTAL deletion still fails loudly: the contracts job never runs the
 * drill, and `contracts/tests/tenant-tools.contract.spec.ts` requires the real
 * plugins directory to serve `fake_probe`.
 */
const tenantPresent = existsSync(join(pluginsDir, "fake-tenant", "tenant.yaml"));

/**
 * The shipped tenant is `enabled: false`, deliberately. Every test that needs
 * it armed works on a COPY with the flag flipped, so the proof never depends on
 * the deployed file being armed.
 */
function enabledCopyOfPlugins(): string {
  const root = mkdtempSync(join(tmpdir(), "helium-fake-plugins-"));
  cpSync(pluginsDir, root, { recursive: true });
  const file = join(root, "fake-tenant", "tenant.yaml");
  // Anchored to the start of a line: the file's own comment block quotes
  // `enabled: false`, and an unanchored replace flips the COMMENT and leaves
  // the real key untouched.
  const flipped = readFileSync(file, "utf8").replace(
    /^enabled: false$/m,
    "enabled: true",
  );
  expect(flipped).toMatch(/^enabled: true$/m);
  writeFileSync(file, flipped);
  return root;
}

describe.skipIf(!tenantPresent)("plugins/fake-tenant", () => {
  it("ships disabled, with no cron armed in the release root", () => {
    // The deployed tree IS the tenants directory. Assert the shipped file,
    // not a copy.
    const spec = parseTenantYaml(
      readFileSync(join(pluginsDir, "fake-tenant", "tenant.yaml"), "utf8"),
      "fake-tenant/tenant.yaml",
    );
    expect(spec.enabled).toBe(false);
    expect(inventoryTenantPlugins(pluginsDir)).toContainEqual({
      tenant: "fake-tenant",
      load: "disabled",
    });
  });

  it("loads from the real plugins directory with its tool vocabulary", async () => {
    const loaded = loadTenants(enabledCopyOfPlugins());
    const fake = loaded.tenants.find((t) => t.spec.tenant === "fake-tenant");
    expect(fake, `skipped: ${JSON.stringify(loaded.skipped)}`).toBeDefined();
    expect(fake!.spec.promotionMode).toBe("delivered");
    const catalog = await loadTenantTools([fake!], {
      stateRoot: mkdtempSync(join(tmpdir(), "helium-fake-")),
      env: {},
    });
    expect(catalog.vocabulary.has("fake_probe")).toBe(true);
    expect(() =>
      validateTeamTools(fake!.manifest, catalog.vocabulary),
    ).not.toThrow();
  });

  it("writes a jsonl delivery outcome end to end through delivered", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-fake-"));
    const jsonlDir = join(stateRoot, "jsonl");
    const port = new TenantDelivery({
      tenant: "fake-tenant",
      policy: { jsonl: true },
      enabled: true,
      delivery: new Delivery({
        jsonl: new JsonlWriter(jsonlDir),
        jsonlDir,
        reportsDir: join(stateRoot, "reports"),
        emailTo: "operator@example.invalid",
        smtp: null,
      }),
    });
    const outcomes: string[] = [];
    await port.deliver({
      teamRunId: "t1",
      team: {
        teamRunId: "t1",
        caseId: "c1",
        state: "running",
        tasks: {},
        artifacts: {},
      } as never,
      outcome: "completed",
      artifacts: {},
      recordIntent: () => "d1",
      recordOutcome: (_id, outcome) => outcomes.push(outcome),
    });
    // `skipped` is NOT `delivered`. There is no SMTP transport and no email
    // policy here, so nothing went out; the team outcome must say so.
    expect(outcomes).toEqual(["uncertain"]);
    const rows = readdirSync(jsonlDir)
      .filter((name) => name.startsWith("deliveries-"))
      .flatMap((name) =>
        readFileSync(join(jsonlDir, name), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    expect(rows.map((r) => r.kind)).toEqual([
      "delivery-intent",
      "delivery-outcome",
    ]);
    expect(rows[1]!.state).toBe("skipped");
    expect(rows[1]!.job).toBe("fake-tenant");
  });

  it("drives a real TeamController through TenantRuntime with a stub execution port", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-fake-e2e-"));
    const { tenants, skipped } = await loadValidatedTenants({
      tenantsDir: enabledCopyOfPlugins(),
      stateRoot,
      env: process.env,
    });
    const fake = tenants.find((t) => t.spec.tenant === "fake-tenant");
    expect(fake, `skipped: ${JSON.stringify(skipped)}`).toBeDefined();

    const jsonlDir = join(stateRoot, "jsonl");
    const teamsRoot = join(stateRoot, "teams", "fake-tenant");
    const port = new TenantDelivery({
      tenant: "fake-tenant",
      policy: fake!.spec.delivery,
      enabled: true,
      delivery: new Delivery({
        jsonl: new JsonlWriter(jsonlDir),
        jsonlDir,
        reportsDir: join(stateRoot, "reports"),
        emailTo: "operator@example.invalid",
        smtp: null,
      }),
    });
    const runtime = new TenantRuntime({
      tenantsDir: pluginsDir,
      stateRoot,
      tenants: [fake!],
      skipped: [],
      livenessMs: 0,
      // Real TeamController, real store, real output-contract registry; only
      // the provider edge is a stub, returning schema-valid JSON per task.
      controllerFor: () =>
        new TeamController({
          stateRoot: teamsRoot,
          manifest: fake!.manifest,
          outputContracts: tenantOutputContracts(fake!),
          routing: routePort(),
          execution: stubExecution(),
          delivery: port,
        }),
      promotion: passthrough,
      jsonl: new JsonlWriter(jsonlDir),
      // `#fire` swallows a run failure into a log line; without this a failed
      // run reports as an empty directory instead of its reason.
      log: (message, extra) => {
        throw new Error(`${message}: ${JSON.stringify(extra)}`);
      },
    });
    await runtime.fireForTest("fake-tenant");

    const projection = onlyTeamRun(teamsRoot);
    expect(projection.state).toBe("completed");
    // The four declared tasks, plus whatever cross-reference verification the
    // controller added for itself.
    expect(Object.keys(projection.tasks)).toEqual(
      expect.arrayContaining(["probe-a", "probe-b", "checker", "render"]),
    );
    expect(projection.tasks.render!.state).toBe("completed");
    // The ordering invariant, observed rather than asserted in isolation.
    const delivery = Object.values(projection.deliveries)[0]!;
    expect(Date.parse(delivery.intentAt)).toBeLessThanOrEqual(
      Date.parse(delivery.outcomeAt!),
    );
    // No SMTP configured, so nothing left the machine: `uncertain`, not
    // `delivered`.
    expect(delivery.state).toBe("uncertain");
  });
});

const passthrough: TenantRuntimeDeps["promotion"] = {
  handle: async (tenant, event, run) => {
    await run(
      buildTenantRunInput(
        tenant.spec.tenant,
        event,
        tenant.prompt ?? `${tenant.spec.tenant} scheduled run`,
      ),
    );
  },
  processCanaryInbox: async () => {},
};

const targetId = ExecutionTargetId("fake-tenant-target");

function routePort() {
  let lease = 0;
  return {
    route: async ({ work }: { work: WorkOrder }) => ({
      decision: {
        selected: targetId,
        candidates: [],
        fallbackPosition: 0,
        policyVersion: "fake",
        catalogVersion: "catalog-1",
      },
      lease: {
        id: `lease-${++lease}`,
        targetId,
        workId: work.id,
        reservedCost: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      catalogVersion: "catalog-1",
    }),
  } as never;
}

/** Schema-valid JSON per task class. No model, no network. */
function stubExecution(): TeamExecutionPort {
  const key = "fake.probe";
  const statement = "The probe echoed its query.";
  const evidence = {
    assertionId: key,
    assertion: statement,
    acceptanceBound: "Echoed deterministically by the stub tool.",
    assertionClass: "claim:fact" as const,
    evidencePolicyVersion: "claim-v1",
    requiredStages: ["raw", "replay"],
    stages: {
      raw: [{ ref: "artifact://fake/raw", sha256: "a".repeat(64) }],
      replay: [{ ref: "artifact://fake/replay", sha256: "b".repeat(64) }],
    },
    verifier: {
      identity: "fake-verifier",
      version: "1",
      decision: "pass" as const,
      decidedAt: "2026-09-01T00:00:00.000Z",
    },
    freshness: { recordedAt: "2026-09-01T00:00:00.000Z" },
    executionSnapshot: {
      targetId,
      providerId: "stub",
      model: "stub",
      providerVersion: "1",
      isolationClass: "process" as const,
      recordedAt: "2026-09-01T00:00:00.000Z",
    },
    status: "PROVEN" as const,
    limitation: "Stub evidence only.",
  };
  const claim = {
    key,
    statement,
    kind: "fact" as const,
    evidenceRefs: ["artifact://fake/raw"],
    confidence: 0.8,
    assumptions: [],
    asOf: "2026-09-01T00:00:00.000Z",
  };
  const structuredFor = (work: WorkOrder): unknown => {
    const task = work.taskClass.replace("team.", "");
    if (task.startsWith("probe-")) {
      return {
        claimSet: { claimSetId: task, producerRole: "prober", claims: [claim] },
        evidence: [evidence],
      };
    }
    if (task === "checker" || task.startsWith("verify-")) {
      return { acceptedClaimKeys: [key] };
    }
    return { summary: "fake synthesis", acceptedClaimKeys: [key] };
  };
  return {
    run: async (_teamRunId: string, work: WorkOrder) =>
      ({
        workId: work.id,
        outcome: "completed",
        structured: structuredFor(work),
        artifacts: [],
        usage: { ms: 1 },
        executionSnapshot: evidence.executionSnapshot,
        runtimeMetadata: {},
      }) as AgentResult,
    closeTeam: async () => {},
    drain: async () => {},
  };
}

/** The single team run this tenant's state root holds. */
function onlyTeamRun(teamsRoot: string): TeamRunProjection {
  // `openTeamStore(root, caseId)` partitions under `<root>/cases/<caseId>`.
  const caseIds = readdirSync(join(teamsRoot, "cases")).map((name) =>
    decodeURIComponent(name),
  );
  expect(caseIds).toHaveLength(1);
  const teams = openTeamStore(teamsRoot, caseIds[0]!).load().teams;
  const ids = Object.keys(teams);
  expect(ids).toHaveLength(1);
  return teams[ids[0]!]!;
}
