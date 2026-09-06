/**
 * `ow_argon_watchlist` — the sector rail, its members, and the operator's
 * TICKERS OF INTEREST. Nothing here reaches the network: the tool gets a
 * `fetchImpl`, the way `tools-macro.spec.ts` does.
 *
 * The fixtures were transcribed from argon's own router, model and taxonomy
 * source because argon was not running on 2026-09-06 —
 * `tests/fixtures/review/README.md` says exactly which fields that leaves
 * unverified.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTenantYaml } from "@helium/core";
import { buildTools } from "../tools/index.js";

const FIX = join(__dirname, "fixtures", "review");
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const CHAINS = read("watchlist-chains.json");
const BY_CHAIN: Record<string, unknown> = {
  "Computer/GPU": read("watchlist-Computer-GPU.json"),
  Cybersecurity: read("watchlist-Cybersecurity.json"),
  Beta: read("watchlist-Beta.json"),
};

const TENANT = join(__dirname, "..", "tenant.yaml");
const extensions = parseTenantYaml(readFileSync(TENANT, "utf8"), TENANT)
  .extensions as Record<string, unknown>;

const BASE = "http://argon.test";
const ENV = { OW_ARGON_API_BASE: BASE };

function tool(env: Record<string, string | undefined> = ENV) {
  const found = buildTools({
    stateRoot: "/nonexistent",
    env,
    extensions,
  }).find((t) => t.name === "ow_argon_watchlist");
  if (found === undefined) throw new Error("no tool ow_argon_watchlist");
  return found;
}

/** Serves the recorded rail and the recorded chains; `fail` names chains that
 *  answer 500 instead. */
function serve(fail: string[] = []) {
  return async (input: URL | string): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(input);
    if (url.pathname === "/api/watchlist/chains") {
      return new Response(JSON.stringify(CHAINS), { status: 200 });
    }
    const chain = url.searchParams.get("chain") ?? "";
    if (fail.includes(chain)) {
      return new Response("boom", { status: 500, statusText: "Server Error" });
    }
    const body = BY_CHAIN[chain];
    if (body === undefined) {
      return new Response("no such chain", { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

const ctx = (fail: string[] = []) => ({ fetchImpl: serve(fail) }) as never;

interface Out {
  source: string;
  chains: Array<{
    chain: string;
    layer?: string;
    count?: number;
    members: string[];
  }>;
  unknown: string[];
  ofInterest: string[];
  ivRank: Record<string, number>;
}

describe("ow_argon_watchlist", () => {
  it("takes no arguments at all — a deterministic step calls it with {}", () => {
    expect(() => tool().paramsSchema?.parse({})).not.toThrow();
  });

  it("returns each requested chain with the members argon's rail serves", async () => {
    const out = JSON.parse(
      await tool().run({ chains: ["Computer/GPU", "Cybersecurity"] }, ctx()),
    ) as Out;
    expect(out.source).toBe("argon");
    expect(out.chains.map((c) => c.chain)).toEqual([
      "Computer/GPU",
      "Cybersecurity",
    ]);
    const gpu = out.chains[0]!;
    expect(gpu.members).toEqual([
      "NVDA",
      "AMD",
      "ARM",
      "SMCI",
      "DELL",
      "HPE",
      "HPQ",
    ]);
    expect(gpu.layer).toBe("L1");
    expect(out.chains[1]!.members).toHaveLength(13);
  });

  it("reads the declared sector list when no chains are passed", async () => {
    const out = JSON.parse(await tool().run({}, ctx())) as Out;
    // Ten declared chains: two have a recorded body, the other eight 404 in
    // this fixture set, and all eight come back NAMED — with the reason —
    // rather than silently absent.
    expect(out.chains.map((c) => c.chain)).toEqual([
      "Computer/GPU",
      "Cybersecurity",
    ]);
    expect(out.unknown).toHaveLength(8);
    expect(out.unknown.join(" ")).toContain("Foundry");
    expect(out.unknown.join(" ")).toContain("404");
  });

  it("collects the pinned rows as the operator's tickers of interest, deduplicated, in argon order", async () => {
    const out = JSON.parse(
      await tool().run({ chains: ["Computer/GPU", "Cybersecurity"] }, ctx()),
    ) as Out;
    expect(out.ofInterest).toEqual(["NVDA", "AMD", "CRWD"]);
  });

  it("copies argon's own iv_rank and computes none", async () => {
    const out = JSON.parse(await tool().run({ chains: ["Beta"] }, ctx())) as Out;
    expect(out.ivRank).toEqual({ SPY: 8.0306, QQQ: 20.6943, IWM: 7.1784 });
  });

  it("names a chain argon's rail does not carry rather than throwing", async () => {
    const out = JSON.parse(
      await tool().run(
        { chains: ["Computer/GPU", "Not-A-Chain"] },
        ctx(),
      ),
    ) as Out;
    expect(out.unknown).toEqual(["Not-A-Chain"]);
    expect(out.chains).toHaveLength(1);
  });

  it("leaves the other chains intact when one answers 500", async () => {
    const out = JSON.parse(
      await tool().run(
        { chains: ["Computer/GPU", "Cybersecurity"] },
        ctx(["Computer/GPU"]),
      ),
    ) as Out;
    expect(out.chains.map((c) => c.chain)).toEqual(["Cybersecurity"]);
    expect(out.chains[0]!.members).toHaveLength(13);
    expect(out.unknown.join(" ")).toContain("Computer/GPU");
  });

  it("throws its own name when OW_ARGON_API_BASE is unset", async () => {
    await expect(tool({}).run({ chains: ["Beta"] }, ctx())).rejects.toThrow(
      /OW_ARGON_API_BASE is unset; ow_argon_watchlist has no live route/u,
    );
  });
});
