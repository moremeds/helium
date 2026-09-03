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
  type Provider,
} from "@helium/core";
import {
  registerProviders,
  runTenant,
  zonedDay,
  zonedNow,
  type ModelExecutor,
} from "../src/runner.js";

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
  - id: daily
    role: prober
    requires: [tool.use]
    dependsOn: [universe]
    phases: [premarket]
    prompt: only before the open
  - id: markout
    role: prober
    requires: [tool.use]
    dependsOn: [universe, daily]
    phases: [close]
    prompt: settle it
`;

function tenant(extra = ""): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-phase-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    "tenant: demo\nenabled: true\nteam: team.yaml\nbudget: { usd: 1, tokens: 100000 }\n" +
      extra,
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

function catalogFor(providers: Provider[]): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  registerProviders(catalog, providers);
  return catalog;
}

describe("run phase", () => {
  it("skips a task whose phases exclude the run phase, and its dependent still runs", async () => {
    const audit = new AuditStore(":memory:");
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-phase-state-")),
      providers: [],
      providersSkipped: [],
      tools: [echo],
      gates: [],
      channels: [],
      renderer: null,
      catalog: catalogFor([]),
      phase: "close",
    });
    expect(report.phase).toBe("close");
    expect(report.steps.map((step) => step.task)).toEqual(["universe", "markout"]);
    audit.close();
  });

  it("prepends phase and a zoned now to the step prompt", async () => {
    const audit = new AuditStore(":memory:");
    let seenPrompt = "";
    const provider: Provider = {
      id: "fake",
      capabilities: ["tool.use"],
      overheadTokens: 0,
      models: [{ id: "cheap", caps: ["tool.use"], usdIn: 1e-6, usdOut: 2e-6 }],
      async probe() {
        return true;
      },
      select() {
        return { targetId: "fake:cheap" as never, model: "cheap" };
      },
    };
    const modelExecutor: ModelExecutor = {
      async run(work) {
        seenPrompt = work.inputs.prompt;
        return { text: "ok", events: [] };
      },
    };
    await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-phase-state-")),
      providers: [provider],
      providersSkipped: [],
      tools: [echo],
      gates: [],
      channels: [],
      renderer: null,
      modelExecutor,
      catalog: catalogFor([provider]),
      // 2026-09-03T10:00:00Z is 18:00 in Asia/Hong_Kong.
      now: () => new Date("2026-09-03T10:00:00Z"),
    });
    expect(seenPrompt).toContain("phase: premarket");
    expect(seenPrompt).toContain("now: 2026-09-03T18:00:00+08:00");
    // The clause is what stops a model converting the clock to UTC and then
    // being refused by the as-of gate for a timestamp that was true.
    // The UTC twin exists so a model that wants a Z timestamp has one to copy
    // rather than converting the zoned line and being refused by the gate.
    expect(seenPrompt).toContain("now (UTC): 2026-09-03T10:00:00Z");
    expect(seenPrompt).toContain("SAME instant written in more than one zone");
    // A tenant that declares no report zone files its day under UTC, which is
    // what every surface did before the field existed.
    expect(seenPrompt).toContain("report day: 2026-09-03 (UTC)");
    audit.close();
  });

  it("tells the agent the day in the tenant's report zone, which is the one it must treat as today", async () => {
    // The bug this closes: 2026-09-02T18:40Z is 02:40 on the 3rd in the zone
    // the launcher schedules in, and 14:40 on the 2nd in the zone the subject
    // matter lives in. Told only the first, a run reads data stamped the 2nd as
    // yesterday's, calls it frozen and returns nothing.
    const audit = new AuditStore(":memory:");
    let seenPrompt = "";
    const provider: Provider = {
      id: "fake",
      capabilities: ["tool.use"],
      overheadTokens: 0,
      models: [{ id: "cheap", caps: ["tool.use"], usdIn: 1e-6, usdOut: 2e-6 }],
      async probe() {
        return true;
      },
      select() {
        return { targetId: "fake:cheap" as never, model: "cheap" };
      },
    };
    const modelExecutor: ModelExecutor = {
      async run(work) {
        seenPrompt = work.inputs.prompt;
        return { text: "ok", events: [] };
      },
    };
    await runTenant({
      tenant: tenant("reportTimezone: America/New_York\n"),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-phase-state-")),
      providers: [provider],
      providersSkipped: [],
      tools: [echo],
      gates: [],
      channels: [],
      renderer: null,
      modelExecutor,
      catalog: catalogFor([provider]),
      now: () => new Date("2026-09-02T18:40:00Z"),
    });
    expect(seenPrompt).toContain("now: 2026-09-03T02:40:00+08:00");
    expect(seenPrompt).toContain("now (UTC): 2026-09-02T18:40:00Z");
    expect(seenPrompt).toContain("now (America/New_York): 2026-09-02T14:40:00-04:00");
    expect(seenPrompt).toContain("report day: 2026-09-02 (America/New_York)");
    audit.close();
  });
});

describe("zonedNow", () => {
  it("writes the zone's own offset, not the host's", () => {
    expect(zonedNow(new Date("2026-09-03T10:00:00Z"))).toBe("2026-09-03T18:00:00+08:00");
    expect(zonedNow(new Date("2026-09-03T10:00:00Z"), "UTC")).toBe("2026-09-03T10:00:00+00:00");
  });
});

describe("zonedDay", () => {
  it("gives the zone's own calendar date, not the host's or UTC's", () => {
    // One instant, three zones, two dates: 2026-09-02T18:40Z.
    const at = new Date("2026-09-02T18:40:00Z");
    expect(zonedDay(at, "UTC")).toBe("2026-09-02");
    expect(zonedDay(at, "Asia/Hong_Kong")).toBe("2026-09-03");
    expect(zonedDay(at, "America/New_York")).toBe("2026-09-02");
  });
});
