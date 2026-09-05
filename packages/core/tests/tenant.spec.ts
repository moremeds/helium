import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTenants,
  parseTenantYaml,
  parseTeamYaml,
  topologicalOrder,
} from "../src/index.js";

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
    const dir = root({
      demo: { "tenant.yaml": TENANT, "team.yaml": TEAM },
      "not-a-tenant": {},
    });
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

  it("carries the tenant's report timezone, which is not its trigger timezone", () => {
    // The two answer different questions: a trigger's zone says when the run
    // starts, `reportTimezone` says which day its output is about. A tenant
    // scheduled in one zone about a market in another needs both, and dropping
    // this field would not fail loudly — the tenant would just quietly go back
    // to filing its day under UTC.
    const spec = parseTenantYaml(
      `${TENANT}reportTimezone: America/New_York\n`,
      "tenant.yaml",
    );
    expect(spec.reportTimezone).toBe("America/New_York");
    expect(
      parseTenantYaml(TENANT, "tenant.yaml").reportTimezone,
    ).toBeUndefined();
  });

  it("carries a calendar, defaults both halves, and refuses a date it cannot trust", () => {
    // The scheduler fires every day; this block is the only place that says
    // which of those days the tenant has anything to say about. A tenant
    // without one runs every day, exactly as it did before the field existed.
    const spec = parseTenantYaml(
      `${TENANT}calendar:\n  weekdaysOnly: true\n  appliesTo: [premarket]\n  closed: [2026-09-07, 2026-11-26]\n`,
      "tenant.yaml",
    );
    expect(spec.calendar).toEqual({
      weekdaysOnly: true,
      appliesTo: ["premarket"],
      closed: ["2026-09-07", "2026-11-26"],
    });
    // Unquoted `2026-09-07` must reach zod as a STRING: the day comparison is
    // string equality against a zoned date, and a Date here would compare
    // against nothing and close no day at all.
    expect(typeof spec.calendar?.closed[0]).toBe("string");
    expect(parseTenantYaml(TENANT, "tenant.yaml").calendar).toBeUndefined();
    expect(
      parseTenantYaml(`${TENANT}calendar: { closed: [2026-09-07] }\n`, "x")
        .calendar,
    ).toEqual({ weekdaysOnly: false, closed: ["2026-09-07"] });
    // A date-shaped string only. `Sept 7` or `2026-9-7` would parse into a day
    // that never equals a zoned `yyyy-mm-dd`, so the run would fire on a day
    // the operator believes is closed — a silent failure, hence a load error.
    expect(() =>
      parseTenantYaml(`${TENANT}calendar: { closed: ["2026-9-7"] }\n`, "x"),
    ).toThrow(/closed/);
    expect(() =>
      parseTenantYaml(`${TENANT}calendar: { weekdaysOnly: yes-please }\n`, "x"),
    ).toThrow(/weekdaysOnly/);
  });

  it("refuses a vendor routing key anywhere in a declaration", () => {
    expect(() =>
      parseTenantYaml(`${TENANT}extensions: { model: some-model }\n`, "x"),
    ).toThrow(/unrecognized key "model"/);
    expect(() =>
      parseTeamYaml(
        TEAM.replace("permissions: {", "permissions: { provider: x,"),
      ),
    ).toThrow(/unrecognized key "provider"/);
  });

  it("orders tasks by dependency", () => {
    expect(topologicalOrder(parseTeamYaml(TEAM))).toEqual(["probe", "report"]);
  });
});
