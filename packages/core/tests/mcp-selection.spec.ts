import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selected, type SelectionEnv } from "../src/mcp/selection.js";
import { TOOL_VOCABULARY, validateToolSelection } from "../src/tools/index.js";

// Extracted out of mcp/server.ts (Task 2.7 post-merge hardening item 5/6):
// server.ts's own top-level code connects a real StdioServerTransport on
// import, so selected()'s env-driven filtering logic had never had a unit
// test of its own.
describe("mcp selection", () => {
  const baseEnv = (overrides: Partial<SelectionEnv> = {}): SelectionEnv => ({
    HELIUM_ARGON_BASE: "http://127.0.0.1:1",
    HELIUM_APEX_BASE: "http://127.0.0.1:1",
    HELIUM_STATE_ROOT: mkdtempSync(join(tmpdir(), "helium-mcp-select-")),
    ...overrides,
  });

  it("defaults to every non-mutating tool, with livewire_sql absent when no lake is configured", () => {
    const names = selected(baseEnv())
      .tools.map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "apex_api",
      "apex_compute",
      "argon_api",
      "thesis_read",
      "thesis_write",
    ]);
  });

  it("includes livewire_sql once HELIUM_LIVEWIRE_DB is set", () => {
    const names = selected(
      baseEnv({ HELIUM_LIVEWIRE_DB: "/nonexistent.duckdb" }),
    ).tools.map((t) => t.name);
    expect(names).toContain("livewire_sql");
  });

  it("admits mutating tools only under HELIUM_ALLOW_MUTATIONS=1", () => {
    const withoutFlag = selected(baseEnv()).tools.map((t) => t.name);
    expect(withoutFlag).not.toContain("argon_rescan");

    const withFlag = selected(
      baseEnv({ HELIUM_ALLOW_MUTATIONS: "1" }),
    ).tools.map((t) => t.name);
    expect(withFlag).toContain("argon_rescan");
    expect(withFlag).toContain("argon_ai_analysis");
  });

  it("HELIUM_TOOLS narrows the set, and the mutation filter still wins even when a mutating tool is named", () => {
    const named = selected(baseEnv({ HELIUM_TOOLS: "argon_api,thesis_read" }))
      .tools.map((t) => t.name)
      .sort();
    expect(named).toEqual(["argon_api", "thesis_read"]);

    // Naming a mutating tool without HELIUM_ALLOW_MUTATIONS=1 drops it: the
    // mutation filter runs first, fail-closed even under an explicit
    // allow-list. That is policy, not a configuration gap, so it is NOT
    // reported as a degradation.
    const namedMutating = selected(baseEnv({ HELIUM_TOOLS: "argon_rescan" }));
    expect(namedMutating.tools).toEqual([]);
    expect(namedMutating.degraded).toEqual([]);

    const namedMutatingAllowed = selected(
      baseEnv({ HELIUM_TOOLS: "argon_rescan", HELIUM_ALLOW_MUTATIONS: "1" }),
    ).tools.map((t) => t.name);
    expect(namedMutatingAllowed).toEqual(["argon_rescan"]);
  });

  // Replaces "silently drops a HELIUM_TOOLS name that matches no known tool".
  // That test asserted `.not.toThrow()` around a silent drop and locked in
  // exactly the behaviour this task removes. The two conditions below are
  // deliberately NOT collapsed into one rule: see selection.ts's own comment.
  it("starts with the remaining tools when a declared tool is unconfigured", () => {
    const env = baseEnv({
      HELIUM_TOOLS: "argon_api,apex_api,livewire_sql,thesis_read,thesis_write",
      HELIUM_ALLOW_MUTATIONS: "0",
      // HELIUM_LIVEWIRE_DB deliberately absent
    });
    const result = selected(env);

    expect(() => selected(env)).not.toThrow();
    expect(result.tools.map((t) => t.name)).toEqual([
      "argon_api",
      "apex_api",
      "thesis_read",
      "thesis_write",
    ]);
    expect(result.degraded).toEqual([
      { tool: "livewire_sql", reason: "unconfigured: HELIUM_LIVEWIRE_DB" },
    ]);
  });

  it("never throws for an unknown name either — the job-load validator is that gate, and server.ts calls this at import time", () => {
    const env = baseEnv({ HELIUM_TOOLS: "argon_api,not_a_real_tool" });
    expect(() => selected(env)).not.toThrow();
    const result = selected(env);
    expect(result.tools.map((t) => t.name)).toEqual(["argon_api"]);
    expect(result.degraded).toEqual([
      { tool: "not_a_real_tool", reason: "unknown tool name" },
    ]);
  });
});

describe("validateToolSelection", () => {
  it("rejects an unknown name", () => {
    expect(() =>
      validateToolSelection(["argon_api", "typo_tool"], {
        allowMutations: false,
      }),
    ).toThrow(/unknown tools: typo_tool/);
  });

  it("rejects a mutating tool when the job does not permit mutation", () => {
    expect(() =>
      validateToolSelection(["argon_rescan"], { allowMutations: false }),
    ).toThrow(/require mutation permission/);
    expect(() =>
      validateToolSelection(["argon_ai_analysis"], { allowMutations: false }),
    ).toThrow(/require mutation permission/);
  });

  it("admits a mutating tool when the job does permit mutation", () => {
    expect(() =>
      validateToolSelection(["argon_rescan"], { allowMutations: true }),
    ).not.toThrow();
  });

  it("treats livewire_sql as a real name regardless of whether the lake is configured", () => {
    // The vocabulary is every name the BUILD knows about, not the subset this
    // environment happens to have configured. livewireTools() returns [] with
    // no HELIUM_LIVEWIRE_DB, so a catalog-based check would call this a typo
    // and reject the shipped macro-watch job.
    expect(TOOL_VOCABULARY.has("livewire_sql")).toBe(true);
    expect(() =>
      validateToolSelection(["livewire_sql"], { allowMutations: false }),
    ).not.toThrow();
  });
});

// The senior lane spawns this file directly as an MCP stdio server
// (writeMcpConfig -> {"command": HELIUM_MCP_BIN, "args": []}), because pnpm
// cannot link a bin shim for it: `lib/` is a tsc build product and install
// always runs before build, so pnpm warns ENOENT and creates nothing
// (observed on the mini, task 3.3). Spawning the artifact directly therefore
// depends on two properties tsc does not give us for free — the shebang has
// to survive compilation, and `pnpm build` has to chmod +x the output. If
// either regresses, the daemon still boots and only the senior lane's tools
// break, silently, so assert them here where a normal `pnpm build && pnpm
// test` catches it.
describe("mcp server artifact", () => {
  const built = new URL("../lib/mcp/server.js", import.meta.url);

  it("is executable and keeps its node shebang after the build", () => {
    const st = statSync(built);
    expect(st.mode & 0o111).not.toBe(0);
    expect(readFileSync(built, "utf8").split("\n", 1)[0]).toBe(
      "#!/usr/bin/env node",
    );
  });
});
