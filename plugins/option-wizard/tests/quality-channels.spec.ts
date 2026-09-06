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
