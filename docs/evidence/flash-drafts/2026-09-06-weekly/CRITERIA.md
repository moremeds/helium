# 2026-09-06 weekly — acceptance criteria

Written 2026-09-07, before any A/B/C draft existed. This is the sample with
the most direct user critique; almost nothing here is derived.

**Must report** — OUR review of OUR OWN week: which of the calls we published
held, which broke, and why, one item at a time. And an outlook that answers,
per item that happened this week, whether it continues, reverses or
strengthens — with a reason. Coverage stays complete: terseness is in the
wording, never in dropping rows.
Source: user, 2026-09-06 — "你总结的是一周市场发生的事情，而不是对一周你做review的
总结… 挑选有价值的说但是只是一小部分"; "下周展望是对于这周发生的事情会不会延续会不会
反转 还是加强。cpi/fomc 完全不够"; "简略是让你言辞简略而不是省略coverage".
Writing guide (weekly and premarket only): "30% 持仓重点关注，30%变化 40%展望";
"tracked items" means focus names, themes and prior calls — never real
positions or PnL (user, 仓位 is a separate private project).

**Must not claim** — a mechanical Focus reason. The `why` column must be the
analyst's own judgement, of the shape "tsm因为距离财报非常远iv低。但是那么远是不是
还有其他的catalyst？" — a rule that maps IV rank to a sentence is not judgement.
Nor the ledger before the market, nor a restated row, nor a repeated Focus
block, nor an unsourced gamma mechanism.
Source: user, 2026-09-07 on the rendered page — "全部都是无效信息", "这他妈的是人话？";
the themes card and the focus `why` column were the only parts called good, and
the focus `why` must be the analyst's own judgement. Plan failure table
(`derived`): "ledger first, restated rows, repeated Focus, unsourced gamma
story".

**What the reader takes away** — how his own week went and what he does
differently next week, in language a person would speak.
Source: user, 2026-09-07 — "这他妈的是人话？" is a complaint about the sentences
themselves; per-item sentence clarity was the one thing praised, so keep it.

## Input reality

The weekly-analyst role has **no news tool at all** under variants A and B —
`tools: [ow_reports, ow_session_frame, ow_rotation]`. That is the condition
this sample was written under and it is the thing variant C changes.

The weekly drafts recorded here were LIVE runs: at the time they were made the
weekly ran with no `--as-of`, so `--replay-from` was inert. That is no longer
true of the sample — since `18a953a` a weekly replays from its recordings under
its recorded clock (see `docs/evidence/flash-samples/README.md`, "the weekly
replays now") — but it is still true of THESE drafts, which were never re-made. Two consequences: the numbers differ between
variants by however much the world moved between the runs, and any news the C
variant sees is 2026-09-07 news, not week-of-2026-09-06 news. Both are
recorded per run in `docs/evidence/flash-drafts/README.md`.

Data present in the frozen recording: `ow_session_frame`, `ow_rotation`,
`ow_macro_rates`, `ow_uw_market_state`, `ow_reports`, `ow_review_window`.
