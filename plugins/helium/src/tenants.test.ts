import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventoryTenantPlugins,
  loadTenants,
  parseTenantYaml,
} from "./tenants.js";

const TEAM_YAML = `
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
`;

const TENANT_YAML = `
tenant: alpha
enabled: true
team: team.yaml
promotionMode: delivered
triggers:
  - kind: cron
    schedule: "35 16 * * 1-5"
    timezone: America/New_York
delivery:
  jsonl: true
  email:
    to: operator
    subject_prefix: "[helium/alpha]"
    max_per_day: 2
env:
  - ALPHA_TEST_KEY
extensions:
  screener:
    top_n: 5
`;

function tenantDir(
  root: string,
  name: string,
  tenantYaml: string,
  teamYaml = TEAM_YAML,
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tenant.yaml"), tenantYaml);
  writeFileSync(join(dir, "team.yaml"), teamYaml);
  return dir;
}

describe("parseTenantYaml", () => {
  it("parses the host-owned keys and renames the snake_case email fields", () => {
    const spec = parseTenantYaml(TENANT_YAML, "alpha/tenant.yaml");
    expect(spec.tenant).toBe("alpha");
    expect(spec.promotionMode).toBe("delivered");
    expect(spec.triggers).toEqual([
      { kind: "cron", schedule: "35 16 * * 1-5", timezone: "America/New_York" },
    ]);
    expect(spec.delivery.email).toEqual({
      to: "operator",
      subjectPrefix: "[helium/alpha]",
      maxPerDay: 2,
    });
  });

  it("keeps the extensions block opaque and verbatim", () => {
    const spec = parseTenantYaml(TENANT_YAML, "alpha/tenant.yaml");
    expect(spec.extensions).toEqual({ screener: { top_n: 5 } });
  });

  it("parses env as key NAMES and rejects a lowercase or valued entry", () => {
    expect(parseTenantYaml(TENANT_YAML, "alpha/tenant.yaml").env).toEqual([
      "ALPHA_TEST_KEY",
    ]);
    expect(() =>
      parseTenantYaml(
        TENANT_YAML.replace("- ALPHA_TEST_KEY", "- alpha_test_key"),
        "alpha/tenant.yaml",
      ),
    ).toThrow(/env/);
  });

  it("rejects an unknown top-level key", () => {
    expect(() =>
      parseTenantYaml(`${TENANT_YAML}surprise: 1\n`, "alpha/tenant.yaml"),
    ).toThrow(/surprise/);
  });

  it("rejects a non-cron trigger", () => {
    const text = TENANT_YAML.replace("kind: cron", "kind: state-change");
    expect(() => parseTenantYaml(text, "alpha/tenant.yaml")).toThrow(
      /triggers/,
    );
  });

  it("rejects a cron trigger with no timezone", () => {
    const text = TENANT_YAML.replace("    timezone: America/New_York\n", "");
    expect(() => parseTenantYaml(text, "alpha/tenant.yaml")).toThrow(
      /timezone/,
    );
  });

  it("rejects a routing key smuggled into the tenant file", () => {
    expect(() =>
      parseTenantYaml(`${TENANT_YAML}model: some-model\n`, "alpha/tenant.yaml"),
    ).toThrow(/model/);
  });
});

describe("loadTenants", () => {
  it("loads a well-formed tenant with its parsed team manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", TENANT_YAML);
    const result = loadTenants(root);
    expect(result.skipped).toEqual([]);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0]!.spec.tenant).toBe("alpha");
    expect(result.tenants[0]!.manifest.name).toBe("fixture");
  });

  it("skips exactly the malformed tenant and records a reason", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", TENANT_YAML);
    tenantDir(root, "broken", "tenant: broken\nenabled: true\n");
    const result = loadTenants(root);
    expect(result.tenants.map((t) => t.spec.tenant)).toEqual(["alpha"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.tenant).toBe("broken");
    expect(result.skipped[0]!.reason).toMatch(/team/);
  });

  it("skips a tenant whose team.yaml does not parse", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", TENANT_YAML, 'manifestVersion: "1"\n');
    const result = loadTenants(root);
    expect(result.tenants).toEqual([]);
    expect(result.skipped[0]!.tenant).toBe("alpha");
  });

  it("fails the whole load on a duplicate tenant name", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "one", TENANT_YAML);
    tenantDir(root, "two", TENANT_YAML);
    expect(() => loadTenants(root)).toThrow(/duplicate tenant: alpha/);
  });

  it("reads promptFile into LoadedTenant.prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    const dir = tenantDir(
      root,
      "alpha",
      `${TENANT_YAML}promptFile: prompts/run.md\n`,
    );
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "run.md"), "run-level instructions\n");
    expect(loadTenants(root).tenants[0]!.prompt).toBe(
      "run-level instructions\n",
    );
  });

  it("skips a tenant whose declared promptFile is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", `${TENANT_YAML}promptFile: prompts/run.md\n`);
    const result = loadTenants(root);
    expect(result.tenants).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(
      /promptFile unreadable: prompts\/run\.md/,
    );
  });

  it("leaves prompt undefined when no promptFile is declared", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", TENANT_YAML);
    expect(loadTenants(root).tenants[0]!.prompt).toBeUndefined();
  });

  it("ignores a plugin directory with no tenant.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    mkdirSync(join(root, "provider-thing"), { recursive: true });
    tenantDir(root, "alpha", TENANT_YAML);
    expect(loadTenants(root).tenants).toHaveLength(1);
  });
});

describe("inventoryTenantPlugins", () => {
  it("keeps a malformed tenant visible as invalid, named after its directory", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    tenantDir(root, "alpha", TENANT_YAML);
    tenantDir(root, "broken", "tenant: [\n");
    // A parseable tenant is reported under its DECLARED name; the directory
    // name is only the fallback for one that never parsed. So this fixture
    // must declare its own name, not reuse alpha's.
    tenantDir(
      root,
      "paused",
      TENANT_YAML.replace("enabled: true", "enabled: false").replace(
        "tenant: alpha",
        "tenant: paused",
      ),
    );
    expect(inventoryTenantPlugins(root)).toEqual([
      { tenant: "alpha", load: "loaded" },
      { tenant: "broken", load: "invalid" },
      { tenant: "paused", load: "disabled" },
    ]);
  });
});

describe("package exports", () => {
  it("resolves through the dsh-plugin-helium/tenants subpath", async () => {
    const mod = await import("dsh-plugin-helium/tenants");
    expect(typeof mod.loadTenants).toBe("function");
  });
});
