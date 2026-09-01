import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventoryTenants,
  tenantHealth,
  type TenantParser,
} from "../src/tenant-health.js";

/**
 * A deliberately minimal stand-in for the real tenant parser. Task 6 made the
 * parser an injected dependency — parsing a tenant file is v1 job-spec
 * knowledge that core may not import — so this suite tests the inventory
 * ordering rule and the injection seam, not the v1 schema. The v1 parser has
 * its own tests in the host (`plugins/helium`).
 */
const parse: TenantParser = (text, source) => {
  const name = /^name: (\S+)$/m.exec(text);
  if (name === null) throw new Error(`no name in ${source}`);
  return { name: name[1], enabled: !/^enabled: false$/m.test(text) };
};

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

  it("does not let a future timestamp keep a dead tenant healthy", () => {
    const expected = [{ tenant: "macro-watch", load: "loaded" as const }];
    const rows = [{ ts: "2026-08-29T13:00:00Z", job: "macro-watch" }];
    expect(tenantHealth(expected, rows, deadline, Date.parse("2026-08-29T12:10:00Z")))
      .toEqual([{ tenant: "macro-watch", state: "missing" }]);
  });
});

describe("inventoryTenants", () => {
  it("inventories every *.yaml before parsing, so a malformed file is still a tenant", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-tenants-"));
    writeFileSync(join(dir, "a-first.yaml"), "name: first\nenabled: true\n");
    writeFileSync(join(dir, "b-broken.yaml"), "this: [is not a tenant");
    writeFileSync(join(dir, "c-paused.yaml"), "name: paused\nenabled: false\n");

    expect(inventoryTenants(dir, parse)).toEqual([
      { tenant: "first", load: "loaded" },
      { tenant: "b-broken", load: "invalid" },
      { tenant: "paused", load: "disabled" },
    ]);
  });

  it("names an unparseable tenant after its file, since it has no parsed name", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-tenants-bad-"));
    writeFileSync(join(dir, "typo-watch.yaml"), "nothing: usable");
    expect(inventoryTenants(dir, parse)).toEqual([
      { tenant: "typo-watch", load: "invalid" },
    ]);
  });
});
