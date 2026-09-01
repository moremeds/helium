/**
 * Guarded-cron-step coverage. `apply()` itself needs a full cordis `Context`
 * and is exercised via the contract suite / live smoke, not unit tests; this
 * file covers only the small pure helper the synthesis cron's `jsonl.prune()`
 * step is guarded by (fix round 1: an unguarded sync throw there — e.g. a
 * transient FS failure — would otherwise be an unhandled rejection that
 * takes the whole daemon down, since croner@10.0.1 has no `catch` option for
 * a plain sync `Cron(...)` callback).
 * @module dsh-plugin-helium/index.test
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkOrderSchema } from "@helium/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGuarded, writeTeamMcpConfig } from "./index.js";

describe("runGuarded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the function through to completion", () => {
    let called = false;
    expect(() => {
      runGuarded("x", () => {
        called = true;
      });
    }).not.toThrow();
    expect(called).toBe(true);
  });

  it("catches a throw, logs it under the given label, and never rethrows", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("disk full");
    expect(() => {
      runGuarded("helium.prune", () => {
        throw error;
      });
    }).not.toThrow();
    expect(spy).toHaveBeenCalledWith("helium.prune:", error);
  });
});

const teamConfig = () =>
  ({
      runtimeMode: "legacy-direct",
      jobsDir: "jobs",
      tenantsDir: "/private/plugins",
      stateRoot: "/private/state",
      contextFile: "context",
      calendarsDir: "calendars",
      argonBase: "http://argon",
      apexBase: "http://apex",
      envFile: "env",
      claudeTokenFile: "claude",
      proxy: "http://proxy",
      mcpBin: "/bin/helium-mcp",
    emailTo: "operator@example.invalid",
  }) as Parameters<typeof writeTeamMcpConfig>[0];

const teamWork = () =>
  WorkOrderSchema.parse({
      id: "team-mcp-boundary",
      role: "inflation-researcher",
      taskClass: "team.inflation-evidence",
      requires: ["inflation-analysis"],
      constraints: {
        tools: ["argon_api"],
        mutations: "forbidden",
        minIsolationClass: "process",
      },
      inputs: { artifacts: [], prompt: "read" },
    acceptance: { outputSchema: "ClaimSet.v1" },
  });

describe("writeTeamMcpConfig", () => {
  it("gives a team attempt only its declared read-only MCP tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-team-mcp-"));
    const path = writeTeamMcpConfig(teamConfig(), teamWork(), dir);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.helium.env).toMatchObject({
      HELIUM_TOOLS: "argon_api",
      HELIUM_ALLOW_MUTATIONS: "0",
      HELIUM_ARGON_BASE: "http://argon",
      HELIUM_STATE_ROOT: "/private/state",
      // REQUIRED and ABSOLUTE: the child's cwd is an isolated workspace, so a
      // relative path resolves to nothing and the agent gets zero tools.
      HELIUM_TENANTS_DIR: "/private/plugins",
    });
    // With no tenant-declared keys the env block is exactly today's set plus
    // HELIUM_TENANTS_DIR -- forwarding is opt-in per tenant, never ambient.
    expect(Object.keys(parsed.mcpServers.helium.env).sort()).toEqual([
      "HELIUM_ALLOW_MUTATIONS",
      "HELIUM_APEX_BASE",
      "HELIUM_ARGON_BASE",
      "HELIUM_STATE_ROOT",
      "HELIUM_TENANTS_DIR",
      "HELIUM_TOOLS",
    ]);
  });

  it("forwards a tenant's declared env key NAMES and omits an unset one", () => {
    process.env.OW_TEST_KEY = "value-not-a-secret";
    delete process.env.OW_ABSENT_KEY;
    const dir = mkdtempSync(join(tmpdir(), "helium-team-mcp-"));
    const path = writeTeamMcpConfig(
      teamConfig(),
      teamWork(),
      dir,
      ["OW_TEST_KEY", "OW_ABSENT_KEY"],
    );
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).mcpServers.helium.env.OW_TEST_KEY).toBe(
      "value-not-a-secret",
    );
    // A missing key is OMITTED, not blanked, so a tool preflight can report
    // "unset" rather than "wrong". The name must not appear at all.
    expect(raw).not.toContain("OW_ABSENT_KEY");
    delete process.env.OW_TEST_KEY;
  });
});
