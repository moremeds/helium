import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProviders,
  loadRenderer,
  loadTenantTools,
  tenantToolGaps,
  pluginsDir,
  tenantsDir,
} from "./discovery.js";

function plugins(entries: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-plugins-"));
  for (const [name, body] of Object.entries(entries)) {
    mkdirSync(join(dir, name, "lib"), { recursive: true });
    if (body !== null) writeFileSync(join(dir, name, "lib", "provider.js"), body);
  }
  return dir;
}

const RUN = `run: async () => ({ text: "", events: [] })`;
const LIVE = `export default { id: "live", capabilities: ["tool.use"], models: [],
  overheadTokens: 0, probe: async () => true, ${RUN},
  select: () => ({ targetId: "live:m", model: "m" }) };`;
const DEAD = `export default { id: "dead", capabilities: [], models: [],
  overheadTokens: 0, probe: async () => false, probeReason: () => "no credential", ${RUN},
  select: () => ({ targetId: "dead:m", model: "m" }) };`;
/** Routes but cannot execute: the shape provider-dsh has until its host is wired. */
const ROUTE_ONLY = `export default { id: "route-only", capabilities: [], models: [],
  overheadTokens: 0, probe: async () => true,
  select: () => ({ targetId: "route-only:m", model: "m" }) };`;

describe("discoverProviders", () => {
  it("finds providers by glob with no registry to edit", async () => {
    const { live } = await discoverProviders(plugins({ "provider-live": LIVE }));
    expect(live.map((p) => p.id)).toEqual(["live"]);
  });

  it("skips a dead provider with its reason instead of failing the load", async () => {
    const { live, skipped } = await discoverProviders(
      plugins({ "provider-dead": DEAD, "provider-live": LIVE }),
    );
    expect(live.map((p) => p.id)).toEqual(["live"]);
    expect(skipped).toEqual([{ id: "dead", reason: "no credential" }]);
  });

  it("skips a throwing module and an unbuilt one, keeping the rest", async () => {
    const { live, skipped } = await discoverProviders(
      plugins({
        "provider-boom": "throw new Error('boom');",
        "provider-unbuilt": null,
        "provider-live": LIVE,
      }),
    );
    expect(live.map((p) => p.id)).toEqual(["live"]);
    expect(skipped.map((s) => s.id).sort()).toEqual(["provider-boom", "provider-unbuilt"]);
    expect(skipped.find((s) => s.id === "provider-boom")?.reason).toContain("boom");
  });

  it("skips a provider that can route but not execute, before probing it", async () => {
    // Keeping it would put a target in the catalog that fails every step it
    // wins -- and being unpriced-or-cheap, it would win.
    const { live, skipped } = await discoverProviders(
      plugins({ "provider-route-only": ROUTE_ONLY, "provider-live": LIVE }),
    );
    expect(live.map((p) => p.id)).toEqual(["live"]);
    expect(skipped).toEqual([
      { id: "route-only", reason: "no run(): this provider can route a step but not execute one" },
    ]);
  });

  it("ignores a directory that is not a provider", async () => {
    const dir = plugins({ "provider-live": LIVE });
    mkdirSync(join(dir, "some-tenant"));
    expect((await discoverProviders(dir)).live).toHaveLength(1);
  });

  it("returns no tools for a tenant that ships none", async () => {
    await expect(
      loadTenantTools(mkdtempSync(join(tmpdir(), "t-")), { stateRoot: "/tmp", env: {} }),
    ).resolves.toEqual([]);
  });
});

describe("tenantToolGaps", () => {
  /** A tenant whose module exports the VOCABULARY shape `buildTools` ships with. */
  function tenant(): string {
    const dir = mkdtempSync(join(tmpdir(), "helium-tenant-"));
    mkdirSync(join(dir, "lib", "tools"), { recursive: true });
    writeFileSync(
      join(dir, "lib", "tools", "index.js"),
      `export const VOCABULARY = new Map([
         ["ow_spot", { mutating: false }],
         ["ow_uw_chain", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
       ]);`,
    );
    return dir;
  }

  it("names the tool AND the key when the key is unset", async () => {
    // The failure this pins: with the key missing every tool still BUILDS, so
    // the run completes and the designer returns an empty proposal list that
    // reads exactly like a considered "no trades today".
    await expect(tenantToolGaps(tenant(), {})).resolves.toEqual([
      "ow_uw_chain (OW_UW_API_KEY unset)",
    ]);
  });

  it("reports nothing once the key is set", async () => {
    await expect(
      tenantToolGaps(tenant(), { OW_UW_API_KEY: "set" } as NodeJS.ProcessEnv),
    ).resolves.toEqual([]);
  });

  it("treats an empty string as unset, because an empty credential is not one", async () => {
    await expect(
      tenantToolGaps(tenant(), { OW_UW_API_KEY: "" } as NodeJS.ProcessEnv),
    ).resolves.toEqual(["ow_uw_chain (OW_UW_API_KEY unset)"]);
  });

  it("returns nothing for a tenant that ships no tools", async () => {
    await expect(tenantToolGaps(mkdtempSync(join(tmpdir(), "t-")), {})).resolves.toEqual([]);
  });
});

describe("tenant and plugin roots are separate knobs", () => {
  it("HELIUM_TENANTS_DIR moves tenants without moving providers", () => {
    const env = { HELIUM_TENANTS_DIR: "/elsewhere/tenants" } as NodeJS.ProcessEnv;
    // The bug this pins: one variable used to move both, so pointing it at a
    // scratch tenant left the run with zero providers and no error saying so.
    expect(tenantsDir(env)).toBe("/elsewhere/tenants");
    expect(pluginsDir(env)).toBe(resolve(process.cwd(), "plugins"));
  });

  it("finds a provider reached through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-symlink-"));
    const real = join(root, "real");
    mkdirSync(join(real, "lib"), { recursive: true });
    writeFileSync(
      join(real, "lib", "provider.js"),
      LIVE.replace('id: "live"', 'id: "linked"'),
    );
    symlinkSync(real, join(root, "provider-linked"));
    const found = await discoverProviders(root);
    expect(found.live.map((p) => p.id)).toContain("linked");
  });
});

describe("loadRenderer", () => {
  /** A tenant directory with a built `lib/render/index.js` holding `body`. */
  function tenantWithRender(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "helium-render-"));
    mkdirSync(join(dir, "lib", "render"), { recursive: true });
    writeFileSync(join(dir, "lib", "render", "index.js"), body);
    return dir;
  }

  it("returns null for a tenant that ships no renderer", async () => {
    const found = await loadRenderer(mkdtempSync(join(tmpdir(), "t-")));
    expect(found).toEqual({ renderer: null, skipped: [] });
  });

  it("loads a default-exported render function", async () => {
    const dir = tenantWithRender(
      `export default (report) => ({ subject: "s:" + report.tenant, text: "t" });`,
    );
    const { renderer, skipped } = await loadRenderer(dir);
    expect(skipped).toEqual([]);
    expect(renderer?.({ tenant: "demo" } as never, {} as never)).toEqual({
      subject: "s:demo",
      text: "t",
    });
  });

  it("skips a module that throws on import, with its reason", async () => {
    const { renderer, skipped } = await loadRenderer(
      tenantWithRender("throw new Error('bad render');"),
    );
    // A renderer that cannot load must not take the run down and must not go
    // unmentioned: the run falls back to the generic transcript and says why.
    expect(renderer).toBeNull();
    expect(skipped[0]?.id).toBe("render");
    expect(skipped[0]?.reason).toContain("bad render");
  });

  it("skips a module whose default export is not a function", async () => {
    const { renderer, skipped } = await loadRenderer(
      tenantWithRender("export default { subject: 'oops' };"),
    );
    expect(renderer).toBeNull();
    expect(skipped).toEqual([
      { id: "render", reason: "default export is not a render function" },
    ]);
  });
});
