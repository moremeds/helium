import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTools, isSelectOnly } from "../src/tools/index.js";
import {
  json,
  startFixture,
  type Fixture,
} from "../src/testing/http-fixture.js";

describe("isSelectOnly", () => {
  it("accepts SELECT and WITH, rejects everything else and multi-statement input", () => {
    expect(isSelectOnly("SELECT 1")).toBe(true);
    expect(isSelectOnly("-- note\nWITH x AS (SELECT 1) SELECT * FROM x")).toBe(
      true,
    );
    expect(isSelectOnly("SELECT 1;")).toBe(true);
    expect(isSelectOnly("DELETE FROM bars")).toBe(false);
    expect(isSelectOnly("SELECT 1; DROP TABLE bars")).toBe(false);
    expect(isSelectOnly("/* SELECT */ ATTACH 'x'")).toBe(false);
  });
});

describe("ecosystem tools", () => {
  let fixture: Fixture;
  let seen: { url: string; method: string; body: string }[];

  beforeEach(async () => {
    seen = [];
    fixture = await startFixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          url: req.url ?? "",
          method: req.method ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        json(res, { ok: true, path: req.url });
      });
    });
  });
  afterEach(async () => {
    await fixture.close();
  });

  // livewireDb is set (to a path nothing here actually reads) so livewire_sql
  // appears in buildTools()'s output; livewireTools() omits the tool entirely
  // when it is unset (see tools/livewire.ts), which the "expects exactly the
  // expected tool set" assertion below depends on.
  const tools = () =>
    buildTools({
      argonBase: fixture.url,
      apexBase: fixture.url,
      livewireDb: "/nonexistent.duckdb",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-tools-")),
    });
  const byName = (n: string) => tools().find((t) => t.name === n)!;

  it("exposes exactly the expected tool set with the right mutation flags", () => {
    expect(
      tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "apex_api",
      "apex_compute",
      "argon_ai_analysis",
      "argon_api",
      "argon_rescan",
      "livewire_sql",
      "thesis_read",
      "thesis_write",
    ]);
    expect(byName("argon_api").mutating).toBe(false);
    expect(byName("argon_rescan").mutating).toBe(true);
    expect(byName("argon_ai_analysis").mutating).toBe(true);
    expect(byName("apex_compute").mutating).toBe(false);
    expect(byName("thesis_write").mutating).toBe(false);
  });

  it("argon_api GETs an allow-listed path and refuses anything else", async () => {
    const out = JSON.parse(
      await byName("argon_api").run({ path: "/api/rates/snapshot" }),
    );
    expect(out.status).toBe(200);
    expect(seen[0]).toEqual({
      url: "/api/rates/snapshot",
      method: "GET",
      body: "",
    });
    await expect(
      byName("argon_api").run({ path: "/api/admin/wipe" }),
    ).rejects.toThrow(/not an allow-listed/);
    await expect(
      byName("argon_api").run({ path: "https://evil.example.com/x" }),
    ).rejects.toThrow(/must start with/);
  });

  it("argon_api rejects a path-traversal or double-slash path before the allow-list check", async () => {
    // "/api/macro/../../../etc/passwd" starts with the allow-listed prefix
    // "/api/macro/" as a RAW string; only buildUrl()'s new URL(...) would
    // later collapse the ".." segments (RFC 3986 dot-segment removal),
    // turning it into a request to "/etc/passwd" — a route the allow-list
    // never approved. Must be rejected before that prefix check runs, and
    // must never reach the upstream server.
    await expect(
      byName("argon_api").run({ path: "/api/macro/../../../etc/passwd" }),
    ).rejects.toThrow(/traversal/);
    await expect(
      byName("argon_api").run({ path: "//evil.example.com/x" }),
    ).rejects.toThrow(/traversal/);
    expect(seen).toHaveLength(0);
  });

  it("argon_api appends query parameters", async () => {
    await byName("argon_api").run({
      path: "/api/macro/rates",
      query: { window: "30d" },
    });
    expect(seen[0]?.url).toBe("/api/macro/rates?window=30d");
  });

  it("apex_api allows /health and /v1/* only", async () => {
    await byName("apex_api").run({
      path: "/v1/bars",
      query: { symbol: "SPY" },
    });
    expect(seen[0]?.url).toBe("/v1/bars?symbol=SPY");
    // "/api/v1/bars" is a well-formed path (starts with "/"), just outside
    // apex's allow-listed prefixes — it fails the same way argon_api's
    // "/api/admin/wipe" does above, not the absolute-URL "must start with"
    // case (the brief's literal regex here paired the wrong rejection
    // reason with this input; "https://..." is what exercises that path).
    await expect(
      byName("apex_api").run({ path: "/api/v1/bars" }),
    ).rejects.toThrow(/not an allow-listed/);
  });

  it("apex_api also allows GET /screener/results/{run_id}", async () => {
    // apex's real GET /screener/results/{run_id} reads back a screener run
    // apex_compute enqueued; without this prefix an agent could kick off a
    // screener job but never fetch its result.
    await byName("apex_api").run({ path: "/screener/results/run-42" });
    expect(seen[0]).toEqual({
      url: "/screener/results/run-42",
      method: "GET",
      body: "",
    });
  });

  it("argon_rescan and apex_compute POST only to their own allow-lists", async () => {
    for (const name of ["argon_rescan", "argon_ai_analysis", "apex_compute"]) {
      await expect(byName(name).run({ path: "/api/anything" })).rejects.toThrow(
        /not an allow-listed/,
      );
    }
  });

  it("argon_rescan POSTs to its one verified allow-listed route with the required body", async () => {
    // argon's real POST /api/watchlist/rescan-all returns 400 without a
    // {"confirmed": true} JSON body (verified against the live route).
    const out = JSON.parse(
      await byName("argon_rescan").run({ path: "/api/watchlist/rescan-all" }),
    );
    expect(out.status).toBe(200);
    expect(seen[0]).toEqual({
      url: "/api/watchlist/rescan-all",
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
  });

  it("apex_compute POSTs to each of its verified allow-listed routes", async () => {
    // "/backtest/run" is deliberately absent: apex's real route requires a
    // body with no defaults (422 bodyless) and macro v1 has no use for
    // backtest — see the dedicated rejection test below.
    for (const path of ["/screener/momentum", "/screener/pead"]) {
      seen.length = 0;
      const out = JSON.parse(await byName("apex_compute").run({ path }));
      expect(out.status).toBe(200);
      expect(seen[0]).toEqual({ url: path, method: "POST", body: "" });
    }
  });

  it("apex_compute refuses /backtest/run: apex's real route requires a body this allow-list can't supply", async () => {
    await expect(
      byName("apex_compute").run({ path: "/backtest/run" }),
    ).rejects.toThrow(/not an allow-listed/);
    expect(seen).toHaveLength(0);
  });

  it("thesis_write versions through ThesisStore and returns the diff", async () => {
    const t = tools();
    const write = t.find((x) => x.name === "thesis_write")!;
    const read = t.find((x) => x.name === "thesis_read")!;
    const first = JSON.parse(
      await write.run({ job: "macro-watch", content: "v1\n" }),
    );
    expect(first.diff).toContain("+v1");
    expect(JSON.parse(await read.run({ job: "macro-watch" })).content).toBe(
      "v1\n",
    );
  });

  it("livewire_sql refuses a non-SELECT before touching DuckDB", async () => {
    const t = buildTools({
      argonBase: fixture.url,
      apexBase: fixture.url,
      livewireDb: "/nonexistent.duckdb",
      stateRoot: mkdtempSync(join(tmpdir(), "helium-tools-")),
    }).find((x) => x.name === "livewire_sql")!;
    await expect(t.run({ sql: "DROP TABLE bars" })).rejects.toThrow(/SELECT/);
  });
});
