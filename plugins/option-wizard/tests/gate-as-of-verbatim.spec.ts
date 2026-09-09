/**
 * The `as-of-verbatim` output gate.
 *
 * The fixtures are the real 2026-09-02 intraday failure, not invented ones:
 * Unusual Whales returned `2026-09-02T12:45:00-04:00` with $48.67M of net call
 * premium, and the briefing wrote a clock four hours off. A timestamp is
 * either a verbatim substring of a tool output or it was computed — and
 * computing one is the bug.
 * @module dsh-plugin-tenant-option-wizard/tests/gate-as-of-verbatim
 */
import { describe, expect, it } from "vitest";
import gate from "../gates/as-of-verbatim.js";

const ctx = { runId: "run-1", role: "regime-analyst" };

describe("as-of-verbatim", () => {
  it("passes when the timestamp is verbatim in a tool output", async () => {
    const result = await gate.check(
      { text: "tide last print 2026-09-02T12:45:00-04:00, +$48.67M" },
      {
        ...ctx,
        toolOutputs: [
          '{"timestamp":"2026-09-02T12:45:00-04:00","net_call_premium":48670000}',
        ],
      },
    );
    expect(result.pass).toBe(true);
  });

  it("fails the four-hour shift that shipped on 2026-09-02", async () => {
    const result = await gate.check(
      { text: "tide into 2026-09-02T16:45:00-04:00" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T16:45:00Z"}'] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("2026-09-02T16:45:00-04:00");
  });

  it("passes text with no zoned timestamp", async () => {
    const result = await gate.check(
      { text: "the 2026-09-02 session carries no clock in this line" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00-04:00"}'] },
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("no explicit timestamp");
  });

  it("fails a timestamp when no tool ran at all", async () => {
    const result = await gate.check(
      { text: "tide last print 2026-09-02T12:45:00-04:00" },
      { ...ctx, toolOutputs: [] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("no tool output in this run");
  });
});

it("accepts a timestamp whose only difference is dropped fractional seconds", async () => {
  // TradingView returned `.075Z`; the briefing's prose wrote the same instant
  // without the milliseconds. Same zone, same second — not the bug this gate
  // exists for. Real strings from the 2026-09-02 close run.
  await expect(
    gate.check(
      { text: "rates fetched 2026-09-02T18:40:17Z" },
      {
        ...ctx,
        toolOutputs: ['{"fetchedAt":"2026-09-02T18:40:17.075Z"}'],
      },
    ),
  ).resolves.toMatchObject({ pass: true });
});

it("still refuses a converted zone even when fractions are dropped", async () => {
  await expect(
    gate.check(
      { text: "as of 2026-09-02T16:45:00Z" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00.000000-04:00"}'] },
    ),
  ).resolves.toMatchObject({ pass: false });
});

it("accepts a timestamp whose only difference is dropped seconds", async () => {
  // The real 2026-09-03 refusal: the clock preamble carried
  // `now (UTC): 2026-09-03T01:12:44Z` and the briefing wrote `2026-09-03T01:12Z`.
  // Same zone, same minute — a truncation, not a conversion.
  await expect(
    gate.check(
      { text: "as of 2026-09-03T01:12Z" },
      { ...ctx, toolOutputs: ["phase: premarket\nnow (UTC): 2026-09-03T01:12:44Z"] },
    ),
  ).resolves.toMatchObject({ pass: true });
});

it("refuses a converted zone that shares the wall-clock minute", async () => {
  // The guarantee that must survive every precision relaxation: 12:45-04:00 and
  // 16:45Z are the same instant, but writing the second when the tool said the
  // first is exactly the 2026-09-02 bug. Same minute digits, different zone.
  await expect(
    gate.check(
      { text: "as of 2026-09-02T16:45Z" },
      { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00-04:00"}'] },
    ),
  ).resolves.toMatchObject({ pass: false });
});

describe("referenceClose", () => {
  const tape = JSON.stringify({
    symbol: "SPY",
    bars: [{ time: "2026-09-03T20:00:00Z", close: 770.19 }],
  });

  // The real run-7cf66c8d (production premarket 2026-09-09, code 13632b1)
  // shapes, quoted from that run's tool-io. SPY's 09-08 close is 765.96: it
  // reaches the run as ow_spot's live `last`, and the pending ledger row
  // inside ow_session_frame is the only place it carries a session DATE.
  // The market-tide print carries the same digits as an intraday
  // `underlying_price`, which is the near-miss the field check must reject.
  const spot = JSON.stringify({
    source: "tradingview",
    quotes: [
      {
        ticker: "SPY",
        source: "tradingview",
        last: 765.96,
        marketTime: "2026-09-09T12:46:27Z",
      },
    ],
  });
  const frame = JSON.stringify({
    ledger: {
      pending: [
        {
          id: "2026-09-08-premarket-spy-t1",
          referenceClose: { date: "2026-09-08", value: 765.96 },
          t1Down: 0.42,
        },
      ],
    },
  });
  const tide = JSON.stringify({
    data: [{ timestamp: "2026-09-09T12:47:00Z", underlying_price: "765.96" }],
  });
  const forecast = (date: string, value: number): { text: string } => ({
    text: JSON.stringify({
      spyForecast: { referenceClose: { date, value }, t1Down: 0.4, t5Down: 0.5 },
    }),
  });

  it("passes a referenceClose value that appears verbatim in this step's tool output", async () => {
    const verdict = await gate.check(forecast("2026-09-03", 770.19), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [tape],
      stepToolOutputs: [tape],
    });
    expect(verdict.pass).toBe(true);
  });

  it("refuses a referenceClose value no tool in this run returned", async () => {
    const verdict = await gate.check(forecast("2026-09-03", 770.2), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [tape],
      stepToolOutputs: [tape],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("770.2");
  });

  it("refuses when the run called no tool at all", async () => {
    const verdict = await gate.check(forecast("2026-09-03", 770.19), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [],
      stepToolOutputs: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("no tool");
  });

  it("says nothing about a step that wrote no referenceClose", async () => {
    const verdict = await gate.check(
      { text: "prose with no forecast" },
      {
        runId: "r",
        role: "scenario-analyst",
        toolOutputs: [tape],
        stepToolOutputs: [tape],
      },
    );
    expect(verdict.pass).toBe(true);
  });

  it("accepts a close an EARLIER step's tool returned — the run-7cf66c8d failure", async () => {
    // The production refusal: scenario-analyst may call only
    // ow_uw_market_state and ow_macro_rates, and on this run it called only
    // ow_macro_rates. 765.96 came from ow_spot two steps earlier, through the
    // handoff text. Step-scoped, this failed three runs on 2026-09-09; the
    // whole-run scan must accept it.
    const verdict = await gate.check(forecast("2026-09-09", 765.96), {
      runId: "run-7cf66c8d",
      role: "scenario-analyst",
      toolOutputs: [spot],
      stepToolOutputs: ['{"quotes":[{"name":"US 10Y","last":4.09}]}'],
    });
    expect(verdict.pass).toBe(true);
  });

  it("refuses a close whose only source is an intraday underlying_price", async () => {
    // run-9fa9f332 "passed" on exactly this: the last tide print's
    // underlying_price happened to equal the close. A bare substring is not a
    // close; the field name has to say so.
    const verdict = await gate.check(forecast("2026-09-09", 765.96), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [tide],
      stepToolOutputs: [tide],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("765.96");
  });

  it("refuses a referenceClose dated one session after the tool's own label", async () => {
    // The second defect in #122: the failing run still committed
    // `2026-09-09-premarket-spy-t1` with referenceClose {2026-09-09, 765.96}.
    // 765.96 is the 09-08 close, so every Brier settlement was one session off.
    const verdict = await gate.check(forecast("2026-09-09", 765.96), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [frame, spot],
      stepToolOutputs: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("2026-09-09");
    expect(verdict.reason).toContain("2026-09-08");
  });

  it("passes when the date matches the tool's label", async () => {
    const verdict = await gate.check(forecast("2026-09-08", 765.96), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [frame, spot],
      stepToolOutputs: [],
    });
    expect(verdict.pass).toBe(true);
  });

  it("leaves the date unchecked when no tool labelled a {date, value} pair", async () => {
    // ow_spot carries a timestamp, not a session date. Refusing here would be
    // guessing which session a live quote belongs to, so the date passes.
    const verdict = await gate.check(forecast("2026-09-09", 765.96), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [spot, tide],
      stepToolOutputs: [],
    });
    expect(verdict.pass).toBe(true);
  });

  it("refuses a value that is in no tool output at all", async () => {
    const verdict = await gate.check(forecast("2026-09-08", 999.99), {
      runId: "r",
      role: "scenario-analyst",
      toolOutputs: [frame, spot, tide],
      stepToolOutputs: [],
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("999.99");
  });
});
