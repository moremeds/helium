import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditStore,
  CapabilityCatalog,
  loadTenants,
  type EcosystemTool,
  type LoadedTenant,
} from "@helium/core";
import { parseRunArgs } from "../src/args.js";
import { registerProviders, runTenant } from "../src/runner.js";

const TEAM = `manifestVersion: "2"
name: demo
roles:
  prober:
    requires: [tool.use]
    permissions: { tools: [echo] }
tasks:
  - id: universe
    role: prober
    requires: [tool.use]
    prompt: list it
`;

function tenant(): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-as-of-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    "tenant: demo\nenabled: true\nteam: team.yaml\nbudget: { usd: 1, tokens: 100000 }\nreportTimezone: America/New_York\n",
  );
  writeFileSync(join(dir, "demo", "team.yaml"), TEAM);
  return loadTenants(dir).tenants[0]!;
}

const echo: EcosystemTool = {
  name: "echo",
  description: "echo",
  paramsSchema: z.object({ q: z.string() }),
  mutating: false,
  async run(args) {
    return JSON.stringify({ echoed: args.q });
  },
};

function catalog(): CapabilityCatalog {
  const made = new CapabilityCatalog();
  registerProviders(made, []);
  return made;
}

describe("--as-of", () => {
  it("parses the instant, keeps the default variant, and refuses a typo", () => {
    const parsed = parseRunArgs([
      "--phase",
      "close",
      "--as-of",
      "2026-09-02T12:45:00Z",
    ]);
    expect(parsed).toEqual({
      phase: "close",
      variant: "live",
      asOf: new Date("2026-09-02T12:45:00Z"),
    });
    // An unparseable instant must be refused HERE. `Invalid Date` propagates
    // silently and only throws somewhere far from the argument that caused it.
    expect(parseRunArgs(["--as-of", "yesterday"])).toEqual({
      error: "--as-of is not a parseable instant: yesterday",
    });
  });

  it("becomes the run's clock, so the report day is the replayed day and not today", async () => {
    const audit = new AuditStore(":memory:");
    // 2026-09-01 23:45 in New York, which is already 09-02 in UTC. The day is
    // the tenant's zone applied to the REPLAYED instant: a run that read it
    // off the wall clock, or off UTC, files the report under the wrong date.
    const asOf = new Date("2026-09-02T03:45:00Z");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-as-of-state-")),
      providers: [],
      providersSkipped: [],
      tools: [echo],
      gates: [],
      channels: [],
      renderer: null,
      catalog: catalog(),
      phase: "premarket",
      asOf,
      variant: "smoke",
      now: () => asOf,
    });
    expect(report.day).toBe("2026-09-01");
    expect(report.asOf).toBe("2026-09-02T03:45:00.000Z");
    expect(report.variant).toBe("smoke");
    // Nothing marked itself unavailable, so the coverage line is the full
    // tool surface — the denominator is the tools the run was given.
    expect(report.pitCoverage).toEqual({
      available: 1,
      total: 1,
      unavailable: [],
    });
    audit.close();
  });

  it("leaves an ordinary run with no as-of fields at all", async () => {
    const audit = new AuditStore(":memory:");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-as-of-state-")),
      providers: [],
      providersSkipped: [],
      tools: [echo],
      gates: [],
      channels: [],
      renderer: null,
      catalog: catalog(),
      phase: "premarket",
    });
    expect(report.asOf).toBeUndefined();
    expect(report.variant).toBeUndefined();
    expect(report.pitCoverage).toBeUndefined();
    audit.close();
  });
});
