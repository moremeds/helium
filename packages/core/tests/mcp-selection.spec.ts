import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selected, type SelectionEnv } from "../src/mcp/selection.js";

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
      .map((t) => t.name)
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
    ).map((t) => t.name);
    expect(names).toContain("livewire_sql");
  });

  it("admits mutating tools only under HELIUM_ALLOW_MUTATIONS=1", () => {
    const withoutFlag = selected(baseEnv()).map((t) => t.name);
    expect(withoutFlag).not.toContain("argon_rescan");

    const withFlag = selected(baseEnv({ HELIUM_ALLOW_MUTATIONS: "1" })).map(
      (t) => t.name,
    );
    expect(withFlag).toContain("argon_rescan");
    expect(withFlag).toContain("argon_ai_analysis");
  });

  it("HELIUM_TOOLS narrows the set, and the mutation filter still wins even when a mutating tool is named", () => {
    const named = selected(baseEnv({ HELIUM_TOOLS: "argon_api,thesis_read" }))
      .map((t) => t.name)
      .sort();
    expect(named).toEqual(["argon_api", "thesis_read"]);

    // Naming a mutating tool without HELIUM_ALLOW_MUTATIONS=1 drops it: the
    // mutation filter runs first, fail-closed even under an explicit
    // allow-list.
    const namedMutating = selected(
      baseEnv({ HELIUM_TOOLS: "argon_rescan" }),
    ).map((t) => t.name);
    expect(namedMutating).toEqual([]);

    const namedMutatingAllowed = selected(
      baseEnv({ HELIUM_TOOLS: "argon_rescan", HELIUM_ALLOW_MUTATIONS: "1" }),
    ).map((t) => t.name);
    expect(namedMutatingAllowed).toEqual(["argon_rescan"]);
  });

  it("silently drops a HELIUM_TOOLS name that matches no known tool", () => {
    // selected() filters buildTools()'s own output by name -- a typo'd or
    // retired tool name simply never matches anything. No error, no
    // placeholder entry; the rest of a valid allow-list is unaffected.
    const names = selected(
      baseEnv({ HELIUM_TOOLS: "argon_api,not_a_real_tool" }),
    ).map((t) => t.name);
    expect(names).toEqual(["argon_api"]);

    expect(() =>
      selected(baseEnv({ HELIUM_TOOLS: "not_a_real_tool" })),
    ).not.toThrow();
    expect(selected(baseEnv({ HELIUM_TOOLS: "not_a_real_tool" }))).toEqual([]);
  });
});
