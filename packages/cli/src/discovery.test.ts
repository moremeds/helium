import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProviders, loadTenantTools } from "./discovery.js";

function plugins(entries: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-plugins-"));
  for (const [name, body] of Object.entries(entries)) {
    mkdirSync(join(dir, name, "lib"), { recursive: true });
    if (body !== null) writeFileSync(join(dir, name, "lib", "provider.js"), body);
  }
  return dir;
}

const LIVE = `export default { id: "live", capabilities: ["tool.use"], models: [],
  probe: async () => true, select: () => ({ targetId: "live:m", model: "m" }) };`;
const DEAD = `export default { id: "dead", capabilities: [], models: [],
  probe: async () => false, probeReason: () => "no credential",
  select: () => ({ targetId: "dead:m", model: "m" }) };`;

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
