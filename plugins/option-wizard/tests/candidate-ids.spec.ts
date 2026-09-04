/**
 * A candidate id names ONE proposal from ONE phase.
 *
 * Both review JSONs below are lifted from the recorded runs of 2026-09-03:
 * premarket (`run-9be0ec9f`) shipped three bull call debit spreads, and close
 * (`run-a1`) shipped one SLV call debit spread of its own. Legs, strikes,
 * expiries, mids, entries and invalidations are verbatim; the rationale prose
 * is trimmed, the way `render.spec.ts`'s fixture trims it. No number here is
 * invented.
 *
 * `design` and `review` both declare `phases: [premarket, close]`, so the close
 * run generates a FRESH proposal list for the same ET day and the mint runs
 * over it from 1 again. Without a phase segment the two lists overlap by
 * position: on a day whose close list happens to lead with the same ticker as
 * the premarket one, `QQQ-2026-09-03-1` names one structure in the morning and
 * a different one in the afternoon — and the ledger gate checks id membership
 * and nothing else, so the collision passes validation and the settlement
 * settles the wrong structure. The index alone cannot fix it: the mint runs
 * over the SURVIVING proposals, so two lists that drop different members both
 * start at `-1`.
 */
import { describe, expect, it } from "vitest";
import { candidatesFrom } from "../render/index.js";

const DAY = "2026-09-03";

const PREMARKET_REVIEW = `Keeping all three.

\`\`\`json
{"proposals":[{"ticker":"QQQ","strategy":"bull call debit spread","legs":[{"right":"call","expiry":"2026-09-09","strike":716,"action":"buy","mid":5.29},{"right":"call","expiry":"2026-09-09","strike":722,"action":"sell","mid":2.5}],"entry":{"level":716,"side":"above"},"addLevel":715,"invalidation":[{"level":710,"side":"below"}],"target":722,"rationale":"Spot 716.50; long 716 is 0.07% ITM, short 722 is 0.77% OTM."},{"ticker":"SPY","strategy":"bull call debit spread","legs":[{"right":"call","expiry":"2026-09-09","strike":772,"action":"buy","mid":4.03},{"right":"call","expiry":"2026-09-09","strike":778,"action":"sell","mid":1.29}],"entry":{"level":772,"side":"above"},"addLevel":770,"invalidation":[{"level":765,"side":"below"}],"target":778,"rationale":"Spot 772.42; long 772 is 0.05% ITM, short 778 is 0.72% OTM."},{"ticker":"SLV","strategy":"bull call debit spread","legs":[{"right":"call","expiry":"2026-09-18","strike":61,"action":"buy","mid":1.93},{"right":"call","expiry":"2026-09-18","strike":64,"action":"sell","mid":1.01}],"entry":{"level":61,"side":"above"},"addLevel":60,"invalidation":[{"level":60,"side":"below"}],"target":64,"rationale":"Spot 60.56: long 61 is 0.73% OTM, short 64 is 5.68% OTM."}]}
\`\`\``;

const CLOSE_REVIEW = `Keeping it.

\`\`\`json
{"proposals":[{"ticker":"SLV","strategy":"call debit spread","legs":[{"right":"call","expiry":"2026-09-30","strike":60,"action":"buy","ratio":1,"mid":3.15},{"right":"call","expiry":"2026-09-30","strike":61,"action":"sell","ratio":1,"mid":2.72}],"entry":{"level":61,"side":"above"},"addLevel":60.5,"invalidation":[{"level":60,"side":"below"}],"target":63,"rationale":"SLV spot 60.55. Net debit 0.43/share, breakeven 60.43."}]}
\`\`\``;

describe("candidate ids are scoped by phase", () => {
  it("mints the phase into every id", () => {
    expect(
      candidatesFrom(PREMARKET_REVIEW, DAY, "premarket").candidates.map(
        (candidate) => candidate.id,
      ),
    ).toEqual([
      "QQQ-2026-09-03-premarket-1",
      "SPY-2026-09-03-premarket-2",
      "SLV-2026-09-03-premarket-3",
    ]);
    expect(
      candidatesFrom(CLOSE_REVIEW, DAY, "close").candidates.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["SLV-2026-09-03-close-1"]);
  });

  it("keeps two runs of the same ET day apart", () => {
    const premarket = new Set(
      candidatesFrom(PREMARKET_REVIEW, DAY, "premarket").candidates.map(
        (candidate) => candidate.id,
      ),
    );
    const close = candidatesFrom(CLOSE_REVIEW, DAY, "close").candidates.map(
      (candidate) => candidate.id,
    );
    expect(close.filter((id) => premarket.has(id))).toEqual([]);
    // The same ticker on the same day, two phases, two structures: the ids
    // differ, and each still says which structure it names.
    const morning = candidatesFrom(
      PREMARKET_REVIEW,
      DAY,
      "premarket",
    ).candidates.find((candidate) => candidate.ticker === "SLV")!;
    const afternoon = candidatesFrom(CLOSE_REVIEW, DAY, "close").candidates[0]!;
    expect(morning.id).not.toBe(afternoon.id);
    expect(morning.expiry).toBe("2026-09-18");
    expect(afternoon.expiry).toBe("2026-09-30");
  });

  it("mints the same ids every time the stored step is parsed again", () => {
    // Every reader re-derives ids by re-parsing the stored `review` step —
    // nothing persists them — so an unstable mint would rename a proposal
    // between the run that made it and the run that settles it.
    const once = candidatesFrom(PREMARKET_REVIEW, DAY, "premarket").candidates;
    const twice = candidatesFrom(PREMARKET_REVIEW, DAY, "premarket").candidates;
    expect(twice.map((candidate) => candidate.id)).toEqual(
      once.map((candidate) => candidate.id),
    );
  });
});
