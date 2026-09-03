/**
 * A deterministic (tool-only) step whose tool takes an ARRAY parameter —
 * `tickers: string[]`, ow_spot's and ow_argon_levels's shape — could not be
 * fed at all: the runner's old single-string-param auto-fill skips any tool
 * whose one parameter is not a bare string, so a step naming such a tool
 * always reported "skipped, needs parameters this step cannot supply", even
 * when the tickers it needed were sitting right there in a dependency's own
 * tool output.
 */
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
import { registerProviders, runTenant } from "../src/runner.js";

// Two deterministic steps: `universe` returns a real-shaped tickers array
// (the same field name ow_tv_watchlist and ow_spot both use), `design`
// depends on it and names a tool whose only parameter is `tickers: string[]`.
const TEAM = `manifestVersion: "2"
name: demo
roles:
  universe-builder:
    requires: []
    permissions: { tools: [list_universe] }
  structure-designer:
    requires: []
    permissions: { tools: [levels_for] }
tasks:
  - id: universe
    role: universe-builder
    requires: []
    prompt: build the universe
  - id: design
    role: structure-designer
    requires: []
    dependsOn: [universe]
    prompt: design structures
`;

function tenant(): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-arrayfill-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    "tenant: demo\nenabled: true\nteam: team.yaml\nbudget: { usd: 1, tokens: 100000 }\n",
  );
  writeFileSync(join(dir, "demo", "team.yaml"), TEAM);
  return loadTenants(dir).tenants[0]!;
}

const listUniverse: EcosystemTool = {
  name: "list_universe",
  description: "returns a fixed ticker universe",
  paramsSchema: z.object({}),
  mutating: false,
  async run() {
    return JSON.stringify({ source: "operator list", tickers: ["SPY", "QQQ"] });
  },
};

let seenArgs: Record<string, unknown> | undefined;
const levelsFor: EcosystemTool = {
  name: "levels_for",
  description: "records what it was called with",
  paramsSchema: z.object({ tickers: z.array(z.string().min(1)).min(1).max(12) }),
  mutating: false,
  async run(args) {
    seenArgs = args;
    return JSON.stringify({ levels: (args.tickers as string[]).map((t) => ({ ticker: t })) });
  },
};

describe("deterministic array-parameter fill", () => {
  it("fills a tool's array-of-strings parameter from a dependency's tickers, instead of skipping it", async () => {
    seenArgs = undefined;
    const audit = new AuditStore(":memory:");
    const catalog = new CapabilityCatalog();
    registerProviders(catalog, []);
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-arrayfill-state-")),
      providers: [],
      providersSkipped: [],
      tools: [listUniverse, levelsFor],
      gates: [],
      channels: [],
      renderer: null,
      catalog,
    });
    const designStep = report.steps.find((step) => step.task === "design")!;
    expect(designStep.text).not.toContain("skipped, needs parameters this step cannot supply");
    expect(seenArgs).toEqual({ tickers: ["SPY", "QQQ"] });
    audit.close();
  });

  it("still skips an array tool cleanly when no dependency named any ticker", async () => {
    seenArgs = undefined;
    const audit = new AuditStore(":memory:");
    const catalog = new CapabilityCatalog();
    registerProviders(catalog, []);
    const noTickers: EcosystemTool = {
      ...listUniverse,
      name: "list_universe",
      async run() {
        return JSON.stringify({ source: "operator list", watchlists: [] });
      },
    };
    const report = await runTenant({
      tenant: tenant(),
      audit,
      pluginsDir: "/nonexistent",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-arrayfill-state-2-")),
      providers: [],
      providersSkipped: [],
      tools: [noTickers, levelsFor],
      gates: [],
      channels: [],
      renderer: null,
      catalog,
    });
    const designStep = report.steps.find((step) => step.task === "design")!;
    expect(designStep.text).toContain("skipped, needs parameters this step cannot supply");
    expect(seenArgs).toBeUndefined();
    audit.close();
  });
});
