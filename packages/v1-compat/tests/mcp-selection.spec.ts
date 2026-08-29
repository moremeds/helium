import { readFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selected } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  catalogFromEnv,
  TOOL_VOCABULARY,
  validateToolSelection,
  type CatalogEnv,
} from "../src/tools/index.js";

// The v1 half of what used to be one suite in core. Core keeps the generic
// filter and tests it against a synthetic catalog; everything here needs the
// real domain toolkit, which is exactly why it lives in this package.
describe("v1 catalog through core's filter", () => {
  const env = (overrides: Partial<CatalogEnv> = {}): CatalogEnv => ({
    HELIUM_ARGON_BASE: "http://127.0.0.1:1",
    HELIUM_APEX_BASE: "http://127.0.0.1:1",
    HELIUM_STATE_ROOT: mkdtempSync(join(tmpdir(), "helium-mcp-select-")),
    ...overrides,
  });

  it("defaults to every non-mutating tool, with livewire_sql absent when no lake is configured", () => {
    const names = selected(catalogFromEnv(env()), {})
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
      catalogFromEnv(env({ HELIUM_LIVEWIRE_DB: "/nonexistent.duckdb" })),
      {},
    ).tools.map((t) => t.name);
    expect(names).toContain("livewire_sql");
  });

  it("reports a declared-but-unconfigured lake tool as degraded, and still serves the rest", () => {
    const result = selected(catalogFromEnv(env()), {
      HELIUM_TOOLS: "argon_api,apex_api,livewire_sql,thesis_read,thesis_write",
      HELIUM_ALLOW_MUTATIONS: "0",
      // HELIUM_LIVEWIRE_DB deliberately absent
    });
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

  it("admits the mutating tools only under HELIUM_ALLOW_MUTATIONS=1", () => {
    expect(
      selected(catalogFromEnv(env()), {}).tools.map((t) => t.name),
    ).not.toContain("argon_rescan");
    const withFlag = selected(catalogFromEnv(env()), {
      HELIUM_ALLOW_MUTATIONS: "1",
    }).tools.map((t) => t.name);
    expect(withFlag).toContain("argon_rescan");
    expect(withFlag).toContain("argon_ai_analysis");
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
//
// This assertion moved here with the server itself in Task 6. It kept passing
// in core against a STALE `packages/core/lib/mcp/server.js` that `tsc` had no
// reason to delete — a build product outliving its source is a false pass a
// clean checkout would not reproduce.
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
