/**
 * `stateBlock`: two strings that let a tenant hand structured state from one
 * run to the next without core learning what the state IS.
 * @module core/tests/tenant-state-block
 */
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "../src/tenant.js";

const BASE = `tenant: t
enabled: true
team: team.yaml
sandbox: none
budget: { usd: 1, tokens: 1000 }
triggers: [{ kind: cron, schedule: "0 0 * * *", timezone: UTC, phase: p }]
delivery: []
`;

describe("tenant stateBlock", () => {
  it("is absent when the tenant does not declare one", () => {
    expect(parseTenantYaml(BASE, "t.yaml").stateBlock).toBeUndefined();
  });

  it("carries the fence and the file suffix verbatim", () => {
    const spec = parseTenantYaml(
      `${BASE}stateBlock:\n  fence: regime-state\n  suffix: regime.json\n`,
      "t.yaml",
    );
    expect(spec.stateBlock).toEqual({
      fence: "regime-state",
      suffix: "regime.json",
    });
  });

  it("refuses a fence or a suffix that could escape the state directory", () => {
    // The suffix becomes a path segment. `../` in it would write anywhere the
    // process can reach, from a string a tenant file supplies.
    expect(() =>
      parseTenantYaml(
        `${BASE}stateBlock:\n  fence: ok\n  suffix: ../../etc/passwd\n`,
        "t.yaml",
      ),
    ).toThrow(/suffix/u);
    expect(() =>
      parseTenantYaml(
        `${BASE}stateBlock:\n  fence: "a b"\n  suffix: x.json\n`,
        "t.yaml",
      ),
    ).toThrow(/fence/u);
  });

  it("refuses a stateBlock missing either half", () => {
    expect(() =>
      parseTenantYaml(`${BASE}stateBlock:\n  fence: ok\n`, "t.yaml"),
    ).toThrow();
  });
});
