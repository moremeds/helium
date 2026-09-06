import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettler } from "../src/discovery.js";

function tenantWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-settler-"));
  mkdirSync(join(dir, "lib", "tools"), { recursive: true });
  writeFileSync(join(dir, "lib", "tools", "index.js"), body, "utf8");
  return dir;
}

const CFG = {
  stateRoot: "/state",
  env: { OW_APEX_API_BASE: "http://apex.invalid" },
  variant: "live",
  calendar: { weekdaysOnly: true, closed: ["2026-09-03"] },
};

describe("loadSettler", () => {
  it("returns null with no skip when the tenant is not built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-settler-"));
    expect(await loadSettler(dir, CFG)).toEqual({ settler: null, skipped: [] });
  });

  it("returns null with no skip when the tenant exports no buildSettler", async () => {
    const dir = tenantWith("export const VOCABULARY = new Map();\n");
    expect(await loadSettler(dir, CFG)).toEqual({ settler: null, skipped: [] });
  });

  it("calls buildSettler with the same config buildTools gets", async () => {
    const dir = tenantWith(
      "export function buildSettler(cfg) { return { async settle(open) { return open.map((c) => ({ commitmentId: c.id, runId: '', settledAt: 'now', status: cfg.env.OW_APEX_API_BASE, scores: { closed: cfg.calendar.closed.length } })); } }; }\n",
    );
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(skipped).toEqual([]);
    const receipts = await settler!.settle(
      [
        {
          id: "x",
          runId: "r0",
          tenant: "t",
          issuedAt: "2026-09-04T00:00:00Z",
          deployment: "test",
          variant: "live",
          payload: {},
        },
      ],
      new Date("2026-09-05T00:00:00Z"),
    );
    expect(receipts[0]!.commitmentId).toBe("x");
    // The factory really received the config, not an empty object: this is the
    // whole reason it is a factory.
    expect(receipts[0]!.status).toBe("http://apex.invalid");
    expect(receipts[0]!.scores.closed).toBe(1);
  });

  it("a buildSettler that is not a function is a SKIP with a reason", async () => {
    const dir = tenantWith("export const buildSettler = { nope: 1 };\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped).toEqual([
      { id: "settler", reason: "buildSettler is not a function" },
    ]);
  });

  it("a settler with no settle() is a SKIP with a reason, never a silent pass", async () => {
    const dir = tenantWith(
      "export function buildSettler() { return { nope: 1 }; }\n",
    );
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped).toEqual([
      { id: "settler", reason: "buildSettler returned no settle()" },
    ]);
  });

  it("a factory that THROWS is a SKIP with its message", async () => {
    const dir = tenantWith(
      "export function buildSettler() { throw new Error('no key'); }\n",
    );
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped[0]!.reason).toContain("no key");
  });

  it("a module that throws on import is a SKIP with its message", async () => {
    const dir = tenantWith("throw new Error('boom');\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped[0]!.reason).toContain("boom");
  });
});
