import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryTenants, tenantHealth } from "../src/tenant-health.js";

const MACRO_WATCH = `name: macro-watch
enabled: true
triggers:
  - kind: cron
    schedule: "0 17 * * 1-5"
    tz: America/New_York
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: thesis-file
tools: [argon_api, livewire_sql]
allowMutations: false
max_turns: { triage: 2, senior: 8 }
timeout: 10m
budget: { max_triage_per_hour: 30, max_senior_per_day: 12 }
delivery:
  jsonl: true
  email: { to: operator, subject_prefix: "[helium/macro]", max_per_hour: 4 }
prompt: |
  Analyze the change.
`;

describe("tenantHealth", () => {
  const deadline = Date.parse("2026-08-29T12:00:00Z");

  it("separates a tenant that is heartbeating from one that is silent", () => {
    const expected = [
      { tenant: "macro-watch", load: "loaded" as const },
      { tenant: "broken-job", load: "loaded" as const },
    ];
    const rows = [
      { ts: "2026-08-29T12:05:00Z", job: "macro-watch" },
      { ts: "2026-08-29T11:00:00Z", job: "broken-job" },
    ];
    expect(tenantHealth(expected, rows, deadline)).toEqual([
      { tenant: "macro-watch", state: "healthy" },
      { tenant: "broken-job", state: "missing" },
    ]);
  });

  // The whole point of an EXPECTED inventory: a tenant that fails to parse must
  // stay visible as `invalid`. If it silently vanished from the list, the fleet
  // would look completely healthy while one tenant was simply not running.
  it("keeps a malformed tenant in the inventory as invalid rather than dropping it", () => {
    expect(
      tenantHealth([{ tenant: "typo-watch", load: "invalid" }], [], deadline),
    ).toEqual([{ tenant: "typo-watch", state: "invalid" }]);
  });

  it("reports a disabled tenant as disabled, not as missing", () => {
    expect(
      tenantHealth([{ tenant: "paused", load: "disabled" }], [], deadline),
    ).toEqual([{ tenant: "paused", state: "disabled" }]);
  });

  // Never infer one tenant's health from another's heartbeat: the global
  // dead-man check already passes whenever ANY tenant is alive, which is
  // exactly the blind spot this reducer exists to close.
  it("never credits one tenant's heartbeat to another", () => {
    const expected = [
      { tenant: "loud", load: "loaded" as const },
      { tenant: "silent", load: "loaded" as const },
    ];
    const rows = [{ ts: "2026-08-29T12:30:00Z", job: "loud" }];
    expect(tenantHealth(expected, rows, deadline)).toEqual([
      { tenant: "loud", state: "healthy" },
      { tenant: "silent", state: "missing" },
    ]);
  });

  it("ignores rows with no job or an unparseable timestamp", () => {
    const expected = [{ tenant: "macro-watch", load: "loaded" as const }];
    const rows = [
      { ts: "not-a-date", job: "macro-watch" },
      { ts: "2026-08-29T12:30:00Z" },
    ];
    expect(tenantHealth(expected, rows, deadline)).toEqual([
      { tenant: "macro-watch", state: "missing" },
    ]);
  });
});

describe("inventoryTenants", () => {
  it("inventories every *.yaml before parsing, so a malformed file is still a tenant", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    writeFileSync(join(dir, "a-macro.yaml"), MACRO_WATCH);
    writeFileSync(join(dir, "b-broken.yaml"), "this: [is not a job");
    writeFileSync(
      join(dir, "c-paused.yaml"),
      MACRO_WATCH.replace("name: macro-watch", "name: paused").replace(
        "enabled: true",
        "enabled: false",
      ),
    );

    expect(inventoryTenants(dir)).toEqual([
      { tenant: "macro-watch", load: "loaded" },
      { tenant: "b-broken", load: "invalid" },
      { tenant: "paused", load: "disabled" },
    ]);
  });

  it("names an unparseable tenant after its file, since it has no parsed name", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-tenants-bad-"));
    writeFileSync(join(dir, "typo-watch.yaml"), "not: a: valid: job");
    expect(inventoryTenants(dir)).toEqual([
      { tenant: "typo-watch", load: "invalid" },
    ]);
  });
});
