/**
 * The closed-day skip. launchd fires this tenant's phases every day — none of
 * the plists carries a Weekday key — so the only thing standing between a
 * market holiday and a briefing about a session that never happened is the
 * tenant's own `calendar:` block.
 *
 * Three properties are worth a test. A closed day must produce NO delivery:
 * the delivery loop deliberately runs even for a failed run, so a skip that
 * merely marked the report would still have sent the mail. It must stay
 * `completed`, because `helium run` exits nonzero on a failed run and a
 * holiday that pages the operator teaches them to ignore the one exit code
 * that means the cron is dead. And an open day must be untouched.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuditStore,
  CapabilityCatalog,
  loadTenants,
  type Channel,
  type EcosystemTool,
  type LoadedTenant,
} from "@helium/core";
import { z } from "zod";
import {
  calendarSkipReason,
  registerProviders,
  runTenant,
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
`;

/** A tenant closed at weekends, on 2026-09-07, and only for the `premarket`
 *  label — the same shape option-wizard declares. */
function tenant(): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-calendar-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    [
      "tenant: demo",
      "enabled: true",
      "team: team.yaml",
      "budget: { usd: 1, tokens: 100000 }",
      "reportTimezone: America/New_York",
      "delivery: [{ channel: fake }]",
      "calendar:",
      "  weekdaysOnly: true",
      "  appliesTo: [premarket]",
      "  closed: [2026-09-07]",
      "",
    ].join("\n"),
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

/** Local, so the operator brake does not decide this test's outcome: an
 *  `external: false` channel delivers on a laptop, which is what makes the
 *  absence of a delivery row on a closed day mean something. */
function recorder(sent: string[]): Channel {
  return {
    id: "fake",
    external: false,
    async deliver(message) {
      sent.push(message.subject);
      return { state: "sent" };
    },
  };
}

async function run(
  phase: string,
  now: Date,
  sent: string[],
  audit: AuditStore,
  asOf?: Date,
) {
  const catalog = new CapabilityCatalog();
  registerProviders(catalog, []);
  return runTenant({
    tenant: tenant(),
    audit,
    pluginsDir: "/nonexistent",
    stateRoot: mkdtempSync(join(tmpdir(), "helium-calendar-state-")),
    providers: [],
    providersSkipped: [],
    tools: [echo],
    gates: [],
    channels: [recorder(sent)],
    renderer: null,
    catalog,
    phase,
    now: () => now,
    ...(asOf === undefined ? {} : { asOf, variant: "smoke" }),
  });
}

describe("calendar", () => {
  it("names the closed day, the weekend, and lets an ungoverned label through", () => {
    const calendar = {
      weekdaysOnly: true,
      closed: ["2026-09-07"],
      appliesTo: ["premarket"],
    };
    expect(calendarSkipReason(calendar, "2026-09-07", "premarket")).toBe(
      "calendar closed 2026-09-07",
    );
    // 2026-09-05 is a Friday and 09-06 the Sunday before the holiday.
    expect(calendarSkipReason(calendar, "2026-09-06", "premarket")).toBe(
      "calendar closed 2026-09-06 (weekend)",
    );
    expect(
      calendarSkipReason(calendar, "2026-09-04", "premarket"),
    ).toBeUndefined();
    // The weekly review exists BECAUSE the market is shut; a calendar that
    // governed every label would delete it.
    expect(
      calendarSkipReason(calendar, "2026-09-07", "weekly"),
    ).toBeUndefined();
    expect(
      calendarSkipReason(undefined, "2026-09-07", "premarket"),
    ).toBeUndefined();
  });

  it("skips a closed day: no steps, no delivery, one audit row, and exit-0 outcome", async () => {
    const audit = new AuditStore(":memory:");
    const sent: string[] = [];
    // 2026-09-07 09:00 ET, the instant the premarket plist would fire.
    const report = await run(
      "premarket",
      new Date("2026-09-07T13:00:00Z"),
      sent,
      audit,
    );
    expect(report.day).toBe("2026-09-07");
    expect(report.skipped).toEqual({ reason: "calendar closed 2026-09-07" });
    // `completed`, because the CLI turns any other outcome into a nonzero exit.
    expect(report.outcome).toBe("completed");
    expect(report.steps).toEqual([]);
    expect(report.delivery).toEqual([]);
    expect(sent).toEqual([]);
    // The day still has a record: a run that wrote nothing at all is
    // indistinguishable from a scheduler that never fired.
    const rows = audit.runCost(report.runId);
    expect(rows.map((row) => row.toolName)).toEqual(["calendar:closed"]);
    audit.close();
  });

  it("skips a weekend day for a governed label and runs the ungoverned one", async () => {
    const audit = new AuditStore(":memory:");
    const sent: string[] = [];
    // Sunday 2026-09-06 08:00 ET — the hour the weekly plist fires.
    const at = new Date("2026-09-06T12:00:00Z");
    const skipped = await run("premarket", at, sent, audit);
    expect(skipped.skipped).toEqual({
      reason: "calendar closed 2026-09-06 (weekend)",
    });
    expect(sent).toEqual([]);
    const weekly = await run("weekly", at, sent, audit);
    expect(weekly.skipped).toBeUndefined();
    expect(weekly.steps).not.toEqual([]);
    expect(sent).toHaveLength(1);
    audit.close();
  });

  it("replays a closed day as a skip: the day comes from --as-of, not the wall clock", async () => {
    const audit = new AuditStore(":memory:");
    const sent: string[] = [];
    const asOf = new Date("2026-09-07T12:45:00Z");
    const report = await run("premarket", asOf, sent, audit, asOf);
    expect(report.skipped).toEqual({ reason: "calendar closed 2026-09-07" });
    expect(report.asOf).toBe("2026-09-07T12:45:00.000Z");
    expect(report.variant).toBe("smoke");
    expect(sent).toEqual([]);
    audit.close();
  });

  it("leaves an open day exactly as it was: it runs and it delivers", async () => {
    const audit = new AuditStore(":memory:");
    const sent: string[] = [];
    // Friday 2026-09-04.
    const report = await run(
      "premarket",
      new Date("2026-09-04T13:00:00Z"),
      sent,
      audit,
    );
    expect(report.skipped).toBeUndefined();
    expect(report.day).toBe("2026-09-04");
    expect(report.steps).not.toEqual([]);
    expect(sent).toHaveLength(1);
    audit.close();
  });
});
