import { describe, expect, it } from "vitest";
import { z } from "zod";
import { selected, type SelectionEnv } from "../src/mcp/selection.js";
import type {
  EcosystemTool,
  ToolCatalog,
  ToolVocabularyEntry,
} from "../src/index.js";

// Extracted out of the MCP server module (Task 2.7 post-merge hardening item
// 5/6): that module's own top-level code connects a real StdioServerTransport
// on import, so selected()'s env-driven filtering had never had a unit test of
// its own.
//
// The catalog here is deliberately synthetic. Task 6 moved catalog
// construction into the host (`plugins/helium`) because building a tool means naming a
// business domain; this suite tests the generic filter, so it must not name
// one either. The v1 catalog's own wiring is covered in that package.
const tool = (name: string, mutating = false): EcosystemTool => ({
  name,
  description: name,
  mutating,
  paramsSchema: z.object({}),
  run: async () => "{}",
});

/** Every name this fictional build knows, configured here or not. */
const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["alpha_read", { mutating: false }],
  ["alpha_write", { mutating: true }],
  ["beta_read", { mutating: false, requiresEnv: "HELIUM_BETA_STORE" }],
]);

/** `beta_read` is in the vocabulary but absent here: its store is unconfigured. */
const catalog = (
  tools: EcosystemTool[] = [tool("alpha_read"), tool("alpha_write", true)],
): ToolCatalog => ({ tools, vocabulary: VOCABULARY });

describe("mcp selection", () => {
  const env = (overrides: Partial<SelectionEnv> = {}): SelectionEnv => ({
    ...overrides,
  });

  it("defaults to every non-mutating tool in the injected catalog", () => {
    const names = selected(catalog(), env())
      .tools.map((t) => t.name)
      .sort();
    expect(names).toEqual(["alpha_read"]);
  });

  it("admits mutating tools only under HELIUM_ALLOW_MUTATIONS=1", () => {
    expect(
      selected(catalog(), env()).tools.map((t) => t.name),
    ).not.toContain("alpha_write");
    expect(
      selected(catalog(), env({ HELIUM_ALLOW_MUTATIONS: "1" })).tools.map(
        (t) => t.name,
      ),
    ).toContain("alpha_write");
  });

  it("HELIUM_TOOLS narrows the set, and the mutation filter still wins even when a mutating tool is named", () => {
    expect(
      selected(catalog(), env({ HELIUM_TOOLS: "alpha_read" })).tools.map(
        (t) => t.name,
      ),
    ).toEqual(["alpha_read"]);

    // Naming a mutating tool without HELIUM_ALLOW_MUTATIONS=1 drops it: the
    // mutation filter runs first, fail-closed even under an explicit
    // allow-list. That is policy, not a configuration gap, so it is NOT
    // reported as a degradation.
    const namedMutating = selected(
      catalog(),
      env({ HELIUM_TOOLS: "alpha_write" }),
    );
    expect(namedMutating.tools).toEqual([]);
    expect(namedMutating.degraded).toEqual([]);

    expect(
      selected(
        catalog(),
        env({ HELIUM_TOOLS: "alpha_write", HELIUM_ALLOW_MUTATIONS: "1" }),
      ).tools.map((t) => t.name),
    ).toEqual(["alpha_write"]);
  });

  // Replaces "silently drops a HELIUM_TOOLS name that matches no known tool".
  // That test asserted `.not.toThrow()` around a silent drop and locked in
  // exactly the behaviour Task 3 removed. The two conditions below are
  // deliberately NOT collapsed into one rule: see selection.ts's own comment.
  it("starts with the remaining tools when a declared tool is unconfigured", () => {
    const e = env({ HELIUM_TOOLS: "alpha_read,beta_read" });
    expect(() => selected(catalog(), e)).not.toThrow();
    const result = selected(catalog(), e);

    expect(result.tools.map((t) => t.name)).toEqual(["alpha_read"]);
    expect(result.degraded).toEqual([
      { tool: "beta_read", reason: "unconfigured: HELIUM_BETA_STORE" },
    ]);
  });

  it("treats an EMPTY HELIUM_TOOLS as an explicit allow-list of nothing", () => {
    // A role declaring `tools: []` writes the empty string. Serving the whole
    // catalog for it would hand a no-tool role every tool there is.
    expect(selected(catalog(), env({ HELIUM_TOOLS: "" })).tools).toEqual([]);
  });

  it("serves the whole non-mutating catalog when HELIUM_TOOLS is UNSET", () => {
    expect(selected(catalog(), env({})).tools.map((t) => t.name)).toEqual([
      "alpha_read",
    ]);
  });

  it("never throws for an unknown name either — the job-load validator is that gate, and the server calls this at import time", () => {
    const e = env({ HELIUM_TOOLS: "alpha_read,not_a_real_tool" });
    expect(() => selected(catalog(), e)).not.toThrow();
    const result = selected(catalog(), e);
    expect(result.tools.map((t) => t.name)).toEqual(["alpha_read"]);
    expect(result.degraded).toEqual([
      { tool: "not_a_real_tool", reason: "unknown tool name" },
    ]);
  });
});
