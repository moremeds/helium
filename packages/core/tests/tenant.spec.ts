import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTenants, parseTenantYaml, parseTeamYaml, topologicalOrder } from "../src/index.js";

const TEAM = `manifestVersion: "1"
name: t
roles:
  prober:
    requires: [tool.use]
    permissions: { tools: [fake_probe] }
tasks:
  - id: probe
    role: prober
    requires: [tool.use]
  - id: report
    role: prober
    dependsOn: [probe]
    requires: [tool.use]
`;

const TENANT = `tenant: demo
enabled: true
team: team.yaml
budget: { usd: 0.5, tokens: 100000 }
triggers: []
`;

function root(entries: Record<string, Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-tenants-"));
  for (const [name, files] of Object.entries(entries)) {
    mkdirSync(join(dir, name), { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(dir, name, file), body);
    }
  }
  return dir;
}

describe("tenant discovery", () => {
  it("finds a tenant by glob with no registry to edit", () => {
    const dir = root({ demo: { "tenant.yaml": TENANT, "team.yaml": TEAM }, "not-a-tenant": {} });
    const { tenants, skipped } = loadTenants(dir);
    expect(tenants.map((t) => t.spec.tenant)).toEqual(["demo"]);
    expect(tenants[0]?.spec.budget).toEqual({ usd: 0.5, tokens: 100_000 });
    expect(skipped).toEqual([]);
  });

  it("skips exactly the malformed tenant, with a reason, and keeps the rest", () => {
    const dir = root({
      broken: { "tenant.yaml": "tenant: broken\nenabled: true\n" },
      demo: { "tenant.yaml": TENANT, "team.yaml": TEAM },
    });
    const { tenants, skipped } = loadTenants(dir);
    expect(tenants.map((t) => t.spec.tenant)).toEqual(["demo"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/team|budget/);
  });

  it("fails the whole load on a duplicate tenant name", () => {
    const dir = root({
      a: { "tenant.yaml": TENANT, "team.yaml": TEAM },
      b: { "tenant.yaml": TENANT, "team.yaml": TEAM },
    });
    expect(() => loadTenants(dir)).toThrow(/duplicate tenant: demo/);
  });

  it("refuses a vendor routing key anywhere in a declaration", () => {
    expect(() => parseTenantYaml(`${TENANT}extensions: { model: some-model }\n`, "x")).toThrow(
      /unrecognized key "model"/,
    );
    expect(() => parseTeamYaml(TEAM.replace("permissions: {", "permissions: { provider: x,"))).toThrow(
      /unrecognized key "provider"/,
    );
  });

  it("orders tasks by dependency", () => {
    expect(topologicalOrder(parseTeamYaml(TEAM))).toEqual(["probe", "report"]);
  });
});
