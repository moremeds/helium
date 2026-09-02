# option-wizard sub-project A: deterministic renderer + HTML email

Date: 2026-09-02. Status: approved in chat, awaiting plan.
Parent: option-wizard briefing rewrite, split A (render) → C (prompt re-port) → B (data tools).
Research inputs (scratchpad, not tracked): research-retro.md, research-email.md, research-frank.md, research-events.md.

## Problem

`packages/cli/src/runner.ts::deliveryBody()` is a generic run transcript. The
option-wizard spec §2 says render+deliver is a deterministic template over
accepted proposals; nobody wrote it. Consequences seen in the 2026-09-02 runs:

- the email is four agents' raw text concatenated ("Actually, let me simplify…", reviewer re-printing designer JSON);
- arithmetic errors reach the reader: max loss computed as max gain (6× in one report), put spread direction inverted, limitPrice ≠ rationale in 5/5, reviewer's own percentages wrong;
- header says `ow_spot` unconfigured while the body quotes its numbers;
- every `quantity` is a guess (no NLV source exists).

## Decisions (user, 2026-09-02)

- Order A → C → B, one PR each.
- No `quantity` on cards; every number is per contract. Position size is the reader's.
- Commodities via TradingView on the mini + opencli — B, not here.
- Deploy to the mini must reset the email daily cap so no manual counter edit is needed.
- No run metadata in the email body. Store it, do not show it.

## Design

### 1. Core seam (domain-neutral, ~30 lines)

- A tenant MAY ship `plugins/<tenant>/render/index.ts` with
  `export default function renderReport(report: RunReport, cfg: TenantSpec): { subject: string; text: string; html?: string }`.
  Discovered the same way `tools/` and `gates/` are — which is `packages/cli/src/discovery.ts`, beside `loadTenantTools` and `loadGates`, NOT `packages/core/src/tenant.ts` (that file only parses `tenant.yaml`/`team.yaml`). A throwing module skips the renderer with a recorded reason and falls back to `deliveryBody()`.
  Core's whole share of this seam is two things: the report types below, and `rendered?` on `DeliveryPayload`.
- `DeliveryPayload` gains optional `rendered?: { subject: string; text: string; html?: string }`. `subject`/`body` stay the generic transcript (`deliverySubject/deliveryBody`) — that is the durable record and keeps every piece of run metadata.
- runner: renderer present → fills `rendered`; absent → leaves it undefined.
- `delivery-email`: uses `rendered` when present (subject, text part, html part), else `subject`/`body` as today. `delivery-markdown` ignores `rendered` and writes `body`, so the stored report is unchanged.
- `RunReport` and `StepReport` move (or are re-exported) from `packages/cli` to `packages/core` so a plugin can import the type without depending on the CLI.
- `RunReport` gains `rendererSkipped?: { reason: string }` — its own field, never a row in `gatesSkipped`. A gate that stops loading stops GUARDING; a renderer that stops loading only costs the reader the pretty form, and folding them together would make a formatting bug read like a missing safety check. `deliveryBody()` prints one line for it, `- **renderer failed to load:** <reason>`, on the transcript branch only.
- Core never parses the report body. Doctrine 2 holds: core learns only that a tenant may render its own delivery.

### 2. Tenant renderer `plugins/option-wizard/render/`

Files: `index.ts` (entry + parse), `math.ts` (pure), `html.ts` (template), `text.ts` (plain-text part).

**Parse.** From the `review` step: `{proposals, riskList, reason?}`. From the `regime` step: the role's prose (first paragraph = verdict). Designer JSON schema gains one field per leg — `mid`, the NBBO mid the designer read from `ow_uw_chain` — and LOSES `quantity` and `limitPrice`: the renderer computes the net from the mids, and position size is the reader's. The parser ignores both fields when an older proposal still carries them. A proposal missing `mid` on any leg renders as "未定价" — never estimated.
Parse failure, `outcome: failed`, or `mode: tool-only` → a short "今日无候选" email stating the reason, not a transcript.

**math.ts.** Per contract, from legs `{right, action, strike, expiry, ratio, mid}`:
net debit/credit, max loss, max gain, breakeven(s), expiry P&L at spot ±5/10/20 %. Defined-risk only: an uncovered short leg makes the proposal render as "结构不合规" with the reason (this duplicates the preflight gate on purpose; the renderer is the last reader-facing check). Multiplier 100. No quantity anywhere.

**html.ts.** Template literal, table layout, inline styles, no dependency, no images. Colours mid-tone so Gmail's inversion leaves them legible; `@media (prefers-color-scheme: dark)` for Apple Mail; `[data-ogsc]` for Outlook. Single column at ≤359 px. Sections, in order:

1. header: date (HKT + ET), tenant, outcome badge (`completed` / `DEGRADED` / `FAILED`)
2. verdict: regime paragraph, direction / vol / hedge stance as a badge line
3. candidates (≤5): ticker + strategy + DTE, legs table (action / right / strike / expiry / mid), max gain / max loss / breakeven(s), credit-vs-width bar (table-cell background), rationale, ±5/10/20 % row
4. risk list: ticker + reason each
5. degradation line: ONE line, only when a tool actually failed, a gate refused, or a provider fell back (e.g. "数据降级：ow_macro_rates 不可用"). `toolsUnconfigured` is NOT shown (known false positive; its root fix is B's).

No footer. Run id, tokens, cost, step count, audit command never appear in the email (user, 2026-09-02); they live in the audit table and the markdown report already.

Chinese headings, English terms. No charts beyond the bar; no events, levels, sparklines, yesterday-markout — those need B/C data.

**text.ts.** Same sections as the html, as plain text; this is the email's `text` part only. The markdown channel keeps writing the generic transcript.

### 3. Deploy reset (`scripts/deploy-v2.sh`)

Laptop-side script that re-execs on the mini over ssh (same trick as the v1 `deploy.sh`): `cd ~/projects/helium-v2 && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build && rm -f "$HELIUM_STATE_ROOT/reports/email-counters.json" && launchctl kickstart -k gui/$(id -u)/com.helium.option-wizard`. Deleting the counter file IS the reset; no version keying.

## Testing

- `math.spec.ts`: table-driven; put credit spread, call debit spread, iron condor, one uncovered short (must be flagged); expected values hand-computed and written in the test.
- `render.spec.ts`: fixture `RunReport` built from a real 2026-09-02 successful run (JSON kept, prose trimmed) → html contains every computed number, contains no `Actually, let me`, no `quantity`; failed-run fixture → "今日无候选" body. `mid`-less leg → "未定价".
- Core: one unit test that a tenant with `render/` gets its html into the payload and one without falls back.
- Existing `contracts/tests/core-neutrality` must stay green (no business word enters core).
- Acceptance: one live send from the mini to the user; checked in iOS Mail and Gmail app. Playwright at 390 px is self-check only.

## Out of scope

Prompt rewrite (C). Calendar, news, IV term structure, commodities, NLV, yesterday-markout, levels ladder, sparklines (B). Fixing `toolsUnconfigured` in core (B). Quantity/sizing (needs NLV).
