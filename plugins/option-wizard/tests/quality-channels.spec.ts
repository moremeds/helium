/**
 * `extractChannels` is the one place a tool payload becomes a number. Every
 * value asserted here comes from `tests/fixtures/review/` — a recorded
 * response of the 2026-09-03 close as-of replay — and nothing is rounded on
 * the way in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractChannels, seriesHistory } from "../quality/channels.js";

const FIX = join(__dirname, "fixtures", "review");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8"));

const macro = load("macro-2026-09-03-close.json");
const policy = load("policy-2026-09-03-close.json");
const gex = load("gex-2026-09-03-close.json");
const tide = load("tide-2026-09-03-close.json");

const DAY = "2026-09-03";
const inputs = { macro, policy, gex, tide, day: DAY };

function byId(channels: ReturnType<typeof extractChannels>, id: string) {
  return channels.find((c) => c.id === id)!;
}

describe("extractChannels over the recorded 2026-09-03 close payloads", () => {
  const channels = extractChannels(inputs);

  it("reads VIX from the daily series when there is no live level", () => {
    const vol = byId(channels, "vol");
    expect(vol.series).toBe("VIXCLS");
    expect(vol.level).toBe("15.2");
    expect(vol.prior).toBe("16.34");
    expect(vol.move).toBe("-1.14 pts");
    expect(vol.magnitude).toBe(1.14);
    expect(vol.asOf).toBe("2026-09-02");
  });

  it("treats a zero move as a real move, not an exclusion", () => {
    // DGS10 printed 4.79 two sessions running. A channel that drops a flat
    // series cannot tell "nothing happened" from "we did not look".
    const rates = byId(channels, "rates");
    expect(rates.level).toBe("4.79");
    expect(rates.prior).toBe("4.79");
    expect(rates.move).toBe("+0.0 bp");
    expect(rates.magnitude).toBe(0);
    expect(rates.excluded).toBeUndefined();
  });

  it("falls through to series.rows when fredDirect answered nothing", () => {
    const credit = byId(channels, "credit");
    expect(credit.series).toBe("BAMLH0A0HYM2");
    expect(credit.level).toBe("2.66");
    expect(credit.prior).toBe("2.65");
    expect(credit.move).toBe("+1.0 bp");
  });

  it("excludes the curve, naming the series argon does not ingest", () => {
    const curve = byId(channels, "curve");
    expect(curve.excluded).toContain("DGS2");
    expect(curve.magnitude).toBeUndefined();
  });

  it("excludes the dealer channel with the source's own as-of reason", () => {
    const dealer = byId(channels, "dealer");
    expect(dealer.excluded).toContain("as-of");
  });

  it("excludes the policy channel with no prior observation, and scores it with one", () => {
    const none = byId(extractChannels({ ...inputs, priorMetrics: {} }), "policy");
    expect(none.excluded).toContain("no prior observation");
    const scored = byId(
      extractChannels({
        ...inputs,
        priorMetrics: { "channel.policy.prob_pp": 55 },
      }),
      "policy",
    );
    expect(scored.level).toBe("60");
    expect(scored.move).toBe("+5.0 pp");
    expect(scored.magnitude).toBe(5);
  });

  it("hands back the channel's own series history, newest first", () => {
    const history = seriesHistory(inputs, "vol");
    expect(history).toHaveLength(22);
    expect(history.slice(0, 2)).toEqual([15.2, 16.34]);
  });

  it("is sorted by order and carries no divergence channel", () => {
    // Divergence pairs were dropped from V0: min(score_a, score_b) over an
    // unstored sign convention is a number nobody can check.
    expect(channels.map((c) => c.order)).toEqual(
      [...channels.map((c) => c.order)].sort((a, b) => a - b),
    );
    expect(channels.map((c) => c.id)).not.toContain("divergence");
  });
});

describe("extractChannels with nothing to read", () => {
  it("returns every channel, all excluded, and never throws", () => {
    const channels = extractChannels({ day: DAY });
    expect(channels).toHaveLength(8);
    for (const channel of channels) {
      expect(channel.excluded, channel.id).toBeTruthy();
      expect(channel.magnitude, channel.id).toBeUndefined();
    }
  });
});

describe("the `unavailable` key is a KIND, never a per-ticker list", () => {
  // THE 2026-09-06 DEFECT. `ow_uw_gex` returns `{levels, unavailable}` where
  // `unavailable` is the array of tickers that did NOT answer — `[]` on a
  // completely successful call. `String([])` is `""`, so every healthy gex
  // payload read as "unavailable, reason blank" and `dealer.positioning`
  // printed UNTESTED with an empty reason on every run since.
  const levels = [
    {
      ticker: "SPY",
      gammaFlip: "766.0",
      callWall: "770.0",
      putWall: "760.0",
      asOf: "2026-09-03",
    },
  ];
  const spot = {
    fetchedAt: "2026-09-03T20:15:00.000Z",
    quotes: [{ ticker: "SPY", last: 768.86, changeAbs: "+1.20" }],
  };

  it("computes the gamma-flip distance when the failed-ticker list is empty", () => {
    const dealer = byId(
      extractChannels({
        ...inputs,
        gex: { levels, unavailable: [] },
        spot,
      }),
      "dealer",
    );
    expect(dealer.excluded).toBeUndefined();
    expect(dealer.series).toBe("SPY gamma flip");
    expect(dealer.level).toBe("766.0");
    expect(dealer.move).toBe("+2.86 pts");
  });

  it("still honours the string marker a source sets on itself", () => {
    const dealer = byId(
      extractChannels({ ...inputs, gex: { unavailable: "as-of" }, spot }),
      "dealer",
    );
    expect(dealer.excluded).toContain("as-of");
  });
});

describe("the three channels whose prior lives in the audit table", () => {
  // Nothing wrote `channel.policy.prob_pp` or `channel.flow.net_premium_usd`
  // and nothing supplied `priorMetrics`, so `policy.path` and `flow` printed a
  // level and never a move — which the weekly analyst read as "no datum" and
  // called untested, on a run whose footer said both tools answered ok.
  it("differences the policy probability against the stored one", () => {
    const none = byId(extractChannels(inputs), "policy");
    expect(none.level).toBe("60");
    expect(none.move).toBeUndefined();
    expect(none.excluded).toBe("no prior observation for the policy path");

    const withPrior = byId(
      extractChannels({
        ...inputs,
        priorMetrics: { "channel.policy.prob_pp": 55.7 },
      }),
      "policy",
    );
    expect(withPrior.level).toBe("60");
    expect(withPrior.prior).toBe("55.7");
    expect(withPrior.move).toBe("+4.3 pp");
    expect(withPrior.excluded).toBeUndefined();
  });

  it("differences the market tide net premium against the stored one", () => {
    const none = byId(extractChannels(inputs), "flow");
    expect(none.level).toBeDefined();
    expect(none.move).toBeUndefined();
    const level = Number(none.level);
    const withPrior = byId(
      extractChannels({
        ...inputs,
        priorMetrics: { "channel.flow.net_premium_usd": level - 1_000_000 },
      }),
      "flow",
    );
    expect(withPrior.move).toBe("+1000000 USD");
    expect(withPrior.excluded).toBeUndefined();
  });
});
