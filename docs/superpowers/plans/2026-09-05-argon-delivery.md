# Argon Delivery Implementation Plan (helium)

> **For agentic workers:** execute with `/execute-plan` — linear, straight-through, in this worktree. Do NOT use subagent-driven-development or parallel dispatch (forbidden by the operator's global rules). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant-agnostic delivery channel that POSTs one structured run into argon, wired up for option-wizard — plus the version stamp that makes a stored view readable later, and the fix for the candidate-id collision that made two phases of one day name the same id for different structures.

**Architecture:** `renderReport` already builds a typed `BriefView`. Core gains one **opaque** field on `RenderedReport` (`data`) and one on `DeliveryPayload` (`codeVersion`); `plugins/delivery-argon` reads `payload.tenant`, `payload.day`, `payload.phase`, `payload.codeVersion` and `payload.rendered.data` and POSTs them to `/api/agent-runs`. It names no tenant and no business word. option-wizard declares the channel in `tenant.yaml`.

**Tech Stack:** TypeScript ESM, pnpm workspace, Node 22.19+, vitest. DSH pinned at `0.1.1-rc.2` with a patch in `patches/`.

**Companion plan:** `argon: docs/superpowers/plans/2026-09-05-flash.md` (branch `feat/flash`) — the table, the endpoint and the Flash page. **That plan merges and deploys FIRST.** Merging this one first would ship a channel whose every attempt is a 404, recorded as a delivery fault on five runs a day until argon catches up.

**Branch:** `feat/argon-delivery`, worktree `.worktrees/argon-delivery/`. Remove the worktree when done.

## Doctrine — the acceptance criteria for every task

Quoted verbatim from `/Users/chenxi/projects/helium/AGENTS.md`, because that file is gitignored and does not travel to a worktree, a fresh clone, the mini, or a dispatched subagent. Reject returned work that violates one; a subagent's own recommendation does not override this.

1. **Recursive self-improvement is the soul.** Helium must be able to run an agent team against its own repo, in a sandbox, and land the result. Every design decision is judged by one question: does it make the *next* iteration of Helium faster, cheaper, or safer to attempt? A feature that only helps one tenant and not the loop is a tenant plugin, never core.
2. **Multipurpose.** Core knows no domain, no provider, no business word. Options, market data, ops, Helium-itself are all tenants under `plugins/<name>/`, discovered by glob, no registry. First two tenants: option-wizard (daily candidate orders by email) and livewire build/heal (agents that find gaps and fix the pipeline). Third: helium-self.
3. **Pluggable multi-agent from day one.** Agents, providers, tools, tenants, gates are all plugins with one small interface each. A role declares capabilities (`requires: [...]`), never a model. Adding an agent kind or a model vendor must be a new directory, not a core edit.
4. **Context and token sense is built in, not bolted on.** Every run records, per agent per step: model, tokens in/out, context size, wall time, cost. The audit is a queryable table, not a log line. Agents are given a budget and know how much of it is left; the harness picks the cheapest model the capability allows; large tool outputs are summarised before they enter a context. "Where did the tokens go" must be answerable in one query.
5. **Fast iteration; destructive experiments are allowed.** Blast radius is defined by *where* an agent runs (git worktree, throwaway `$DSH_HOME`, scratch dirs), not by signatures, leases, or authority manifests. Inside a sandbox an agent may do anything. Outside it, two rules: never write the production data lake, never place an order. (Whether an agent may push to master is an open question, not yet decided.) Deploy is `git pull && pnpm build && launchctl kickstart` — minutes, not days.
6. **Ceremony must earn its keep.** A gate, review pass, contract test, or release step stays only if it has caught a real defect. Measure where the wall time goes on every change; when the process takes longer than the change itself, the process is the bug. Prefer deleting over certifying.

**How this plan is judged against them.** Point 2: the channel is a plugin under `plugins/`, is tenant-agnostic, and adds exactly two *opaque* fields to core — `contracts/tests/core-neutrality.contract.spec.ts` is the enforcement and must stay green. Point 6: no write-ahead log, no dead-letter queue, no reconciliation pass, no local mirror of what was posted; argon's ingest is idempotent on `(tenant, run_id)`, and that one property replaces all of it. Point 4: the run's audit rows must still answer "where did the tokens go" after a new channel is in the delivery list. Point 5: the channel is `external`, so the operator's `HELIUM_TENANT_DELIVERY` brake governs it, and it must be removable from `tenant.yaml` without breaking mail or the markdown artifact.

## Global constraints

- **`plugins/delivery-argon` may not contain** `option-wizard`, `premarket`, `intraday`, `close`, `weekly`, `frank`, a ticker, or any options word. If you find yourself writing `if (payload.tenant === "option-wizard")`, stop — the design is wrong. Half its tests use a tenant that does not exist, and that symmetry is the test that it stayed generic.
- **Key NAMES only in `tenant.yaml`.** No value ever appears in that file. Deployment facts live in `~/.config/helium/helium.env` on the mini.
- **`lib/` is build output and is not committed.** `pnpm build` before contracts or deploy. `rm plugins/option-wizard/tsconfig.tsbuildinfo` first if a build comes back clean while `lib/` is stale.
- **No synthetic market data.** Test fixtures carry the recorded 2026-09-03 numbers from the mini transcripts: premarket QQQ 716/722, SPY 772/778, SLV 61/64 bull call debit spreads; close SLV 60/61. (An earlier draft of this plan named a QQQ 710/665 put debit spread; that structure is not in the recorded transcripts and was corrected during execution.)

---

## Task 0: Does the `frank` phase already produce a usable review?

**Read-only. No code changes. Do this first — decision 3's `weekKey` rule for the `frank` kind is worth building only if a frank row is worth storing.**

`tenant.yaml` already declares a `frank` phase at `0 21 * * 1` Asia/Hong_Kong (= Monday 09:00 ET), and `receive-deploy.sh` already installs its plist — `PHASES=(premarket frank intraday close weekly)` at `scripts/receive-deploy.sh:33`. The reader binary is `OW_OPENCLI_BIN` (declared separately from `OPENCLI_BIN` precisely so the Substack/web reader can be pointed at a different build). So the machinery exists; what is unverified is whether it currently yields anything a reader would want.

Reports live under `$HELIUM_STATE_ROOT/reports/`, which `receive-deploy.sh:29` defaults to `$HOME/.helium/state` — confirm against the mini's own `~/.config/helium/helium.env`, which may override it.

- [ ] **Step 1: Find the most recent frank report on the mini.**

```bash
ssh macmini
STATE_ROOT="$(grep -m1 '^HELIUM_STATE_ROOT=' ~/.config/helium/helium.env | cut -d= -f2- )"
STATE_ROOT="${STATE_ROOT:-$HOME/.helium/state}"
ls -lt "$STATE_ROOT"/reports/option-wizard-*-frank.md | head -5
```

If that glob is empty, say so and stop — the phase has never produced a report, and that alone answers the question.

- [ ] **Step 2: Read the newest one and judge it.** Report, in the PR body or back to the operator, four things: (a) does it contain Frank's actual review text, or only an error / an empty shell; (b) which tool produced it and whether that tool reported a fault; (c) roughly how long the review is, and whether it reads as a week-in-review rather than a fetch log; (d) the ET date the file is named for, and which week that review is *about* (they differ by design — Monday's post reviews the week that just ended, which is what decision 3 exists to file correctly).

- [ ] **Step 3: Cross-check the run itself.**

```bash
helium audit <the run id for that frank report>
```
A `DEGRADED` outcome with an `OW_OPENCLI_BIN`-shaped fault means the phase runs but cannot reach the source; a clean `completed` with thin content means it reaches the source and the prompt is the problem. Those need different fixes and the audit is what tells them apart.

**Then decide, and only then:** if the phase yields a usable review, nothing more is needed — Task 3 posts it and Task 2's `weekKey` rule files it under the right week. If it does not, choose between a manual paste into argon and a scheduled fetch in argon, and open that as its own piece of work. Do not build either on speculation.

---

## Task 1: Version the view; give core an opaque data slot and a code version

**Files:** modify `packages/core/src/plugins.ts` (`RenderedReport`, `DeliveryPayload`), `packages/cli/src/runner.ts` (pass `codeVersion` into the delivery payload — it already imports it at :59), `plugins/option-wizard/render/index.ts` (`BriefView` at :123, `buildView` at :1271, `renderReport` at :1282); create `plugins/option-wizard/tests/render-schema-version.spec.ts`.

**Produces:**

```ts
// packages/core/src/plugins.ts
interface RenderedReport {
  // ...existing text/html/subject
  /** The structured document the tenant's renderer built, for a channel that
   *  wants the DATA rather than the prose. Opaque: core never reads inside it,
   *  never validates it, never learns a key name from it — the same rule that
   *  keeps `toolOutputs` a string. A channel that writes to a database needs
   *  the shape, not the rendering; the alternative is a channel parsing the
   *  HTML the email channel sends, which makes every renderer change a silent
   *  data corruption somewhere else. */
  data?: Record<string, unknown>;
}

interface DeliveryPayload {
  // ...existing tenant/runId/subject/body/day/artifacts/rendered/phase
  /** Which build produced this run. The runner already resolves it once (it is
   *  what `helium audit` prints as `code: <sha>` and what every audit row
   *  carries as `code_version`), so a channel that re-derived it could disagree
   *  with the audit table about the same run — which is the one thing a
   *  provenance field must never do. Same reasoning as `day`. */
  codeVersion?: string;
}

// plugins/option-wizard/render/index.ts
export const BRIEF_VIEW_SCHEMA_VERSION = 1;
interface BriefView { schemaVersion: number; /* ...existing */ }
export default function renderReport(report, cfg): RenderedReport;  // now returns { text, html, data: view }
```

**Why a version at all:** argon stores the document and renders it days later, from a build that may be older than the one that wrote it. Without a version a renamed field shows up there as a silently *missing section* — a shorter page, with no way for the reader to know something was dropped. With one, the consumer says "I was written for version N, this is N+1" and the fix is a deploy rather than an investigation. **Bump only on a breaking change** — a removed field, a renamed field, or a changed meaning. Adding an optional field is not breaking.

- [ ] **Step 1: Write the failing test.** `buildView(...).schemaVersion === BRIEF_VIEW_SCHEMA_VERSION`; `renderReport(...).data.date === "2026-09-03"` and `.data.schemaVersion === 1`; `text` and `html` are still strings — the slot is additive. Reuse whatever `RunReport` fixture builder `plugins/option-wizard/tests/` already has; do not write a second. If none exists, trim a real transcript from `~/.helium/state/reports/` for 2026-09-03.
- [ ] **Step 2:** Run, watch fail, implement. `renderReport` keeps having **no subject** — `render.spec.ts` forbids the renderer naming a phase, and the runner is what builds `[TEST] intraday 2026-09-03`.
- [ ] **Step 3: Verify the neutrality seam did not move.**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts
```
`contracts/tests/core-neutrality.contract.spec.ts` must stay green — both new fields are opaque and must not trip it. Also grep every `buildView(` call site and confirm each still typechecks.

- [ ] **Step 4: Commit** — `feat(core): opaque data slot and code version on delivery; version the option-wizard view`

---

## Task 2: `plugins/delivery-argon` — the generic channel

**Files:** create `plugins/delivery-argon/{package.json,tsconfig.json,src/channel.ts,src/channel.test.ts}`. `package.json` and `tsconfig.json` are copies of `plugins/delivery-email/`'s with the name changed to `dsh-plugin-delivery-argon` and `nodemailer` dropped; `main`/`exports` stay `./lib/channel.js`.

**Produces** a default-exported **instance** (discovery imports the default and calls `.deliver` on it — exporting the class satisfies `typeof === "function"` and then fails on `.deliver`, which is how delivery-email shipped tested-but-never-loaded until 2026-09-02):

```ts
export class ArgonChannel implements Channel {
  readonly id = "argon";
  readonly external = true;
  constructor(deps?: { env?; fetch?; sleep? });
  deliver(payload: DeliveryPayload, config: Record<string, unknown>): Promise<DeliveryOutcome>;
}
export default new ArgonChannel();
```

`external = true` **is a decision, not a default.** The row does not leave the building, but it leaves the process and lands where a person reads it as a briefing. `external` gates on `HELIUM_TENANT_DELIVERY`, and the hazard that brake exists for — a laptop run publishing something that looks like the real thing — is exactly this one. Absent would default to external anyway; stating it keeps the decision visible.

**Resolution order and outcomes:**

| Condition | Outcome | Why |
| --- | --- | --- |
| no base URL (`env.ARGON_BASE_URL` → `config.baseUrl`) | `skipped` | |
| no `env.ARGON_INGEST_TOKEN` | `skipped` | an unauthenticated POST is not a degraded mode, it is a different request |
| `payload.phase` absent, or not in `config.kinds` when that array is given | `skipped` | |
| `payload.rendered.data` absent | `skipped` | the tenant ships no renderer, or it produced nothing. Not an error. |
| `config.weekKeyRule` names a rule this channel does not implement | **`failed`** | a misspelled rule would silently file every run under the wrong week |
| `data.schemaVersion` is not an integer | **`failed`** | the tenant DID produce a document and forgot to version it. Storing it unversioned makes it unreadable the first time its shape changes — the one failure that field prevents. |
| HTTP 201 | `sent` (`"created"`) | |
| HTTP 200 | `sent` (`"already stored; ingest is idempotent"`) | a retry after an ambiguous timeout must not read as a failure |
| HTTP 4xx | `failed`, **no retry** | a rejected payload is rejected again; retrying wastes the window and hides the reason behind a timeout |
| HTTP 5xx or a network throw | retry at 5s then 25s, then `failed` | two retries, then the audit records it and the next scheduled run posts again. A channel retrying for an hour would hold a run open past the point its numbers were current. |

The request body maps straight across, with no interpretation:

```ts
{
  tenant: payload.tenant,
  kind: payload.phase,
  run_day: payload.day,
  week_key: weekKey,           // ALWAYS sent — see below. argon uses it verbatim.

  run_id: payload.runId,
  code_sha: payload.codeVersion ?? "unknown",
  schema_version: data.schemaVersion,
  outcome: typeof data.outcome === "string" ? data.outcome : "completed",
  headline: typeof data.headline === "string" ? data.headline : "",
  view: data,
  // The transcript, kept BESIDE the view and never merged into it: the view is
  // what a page renders, the transcript is the record of the run that produced
  // it, and a reader must be able to tell them apart.
  report: { subject: payload.subject, body: payload.body, artifacts: payload.artifacts ?? [] },
}
```

POSTs to `${baseUrl.replace(/\/+$/, "")}/api/agent-runs` with `Content-Type: application/json` and `Authorization: Bearer ${token}`. Every dep (`env`, `fetch`, `sleep`) is optional so the module can default-export a working instance; tests inject all three.

**`week_key` is computed here and always sent** (decision 3). helium is the only side that knows a run is *backward-looking*: a review published on Monday is about the week that just ended, and argon defaulting to the ISO week of `run_day` would file it under the wrong week. The channel therefore ships two rules and the manifest says which kind uses which — the channel knows the rule names, never the kind names, so it stays generic:

```ts
/** UTC throughout: a report day is a LABEL, not an instant, and running it
 *  through a local timezone turns a Monday into the previous Sunday west of
 *  UTC. `isoWeekOf` uses the ISO year, not the calendar year — 2026-12-31 is
 *  2027-W01, and filing it under 2026 puts it in a week no navigation reaches. */
export function isoWeekOf(day: string): string;                 // "2026-09-03" -> "2026-W36"
export function previousIsoWeek(weekKey: string): string;       // "2026-W37"   -> "2026-W36"

type WeekKeyRule = "iso-week-of-day" | "previous-iso-week";     // default: iso-week-of-day
// resolved per kind from config.weekKeyRules?: Record<string, WeekKeyRule>
const weekKey = rule === "previous-iso-week"
  ? previousIsoWeek(isoWeekOf(payload.day))
  : isoWeekOf(payload.day);
```

`previousIsoWeek` subtracts seven days from the week's Monday and re-derives, rather than decrementing the week number — decrementing breaks at every year boundary, where W01 is preceded by W52 or W53 depending on the year.

Add to the test list: with no `weekKeyRules`, a `run_day` of `2026-09-03` sends `week_key: "2026-W36"`; with `weekKeyRules: { frank: "previous-iso-week" }` and `phase: "frank"`, a `run_day` of `2026-09-07` (Monday) sends `"2026-W36"` and not `"2026-W37"`; `isoWeekOf("2026-12-31") === "2026-W53"` and `isoWeekOf("2027-01-01") === "2026-W53"` (2026-12-31 is a Thursday, so it is still ISO 2026); `previousIsoWeek("2027-W01") === "2026-W53"`; an unknown rule name is `failed` without a fetch.

**What was deliberately not built** (doctrine 6): no write-ahead log, no dead-letter queue, no reconciliation pass, no local mirror of what was posted. The audit table already records every step of a run, and argon's ingest is idempotent on `(tenant, run_id)` — so a blind retry is safe, and that one property replaces all of it. Say this in the module docstring; it is the reason a later reader will not add them back.

- [ ] **Step 1: Write the failing tests.** Fourteen cases, one per row of that table plus: the POST body matches the mapping above by value; the transcript lands in `report` and not in `view`; **the same payload with `tenant: "livewire-shepherd"`, `phase: "heal"` and a `{schemaVersion:1, gapsClosed:3}` view behaves identically and posts `kind: "heal"`**; a 5xx retries exactly three times with sleeps `[5000, 25000]`; a network throw on the first attempt then a 201 is `sent` after two calls; `JSON.stringify(outcome)` never contains the token; the default export has a `.deliver` function and `id === "argon"`.
- [ ] **Step 2:** Run, watch fail, write the channel.
- [ ] **Step 3: Verify.**

```bash
pnpm install && pnpm build && pnpm typecheck
pnpm vitest run --project unit plugins/delivery-argon/src/channel.test.ts
pnpm test:contracts
```

- [ ] **Step 4: Commit** — `feat(delivery): argon channel — POST a structured run to /api/agent-runs`

---

## Task 3: Wire the channel into option-wizard

**Files:** modify `plugins/option-wizard/tenant.yaml` (the `env:` list and the `delivery:` list).

```yaml
env:
  # ...existing
  # argon's ingest for structured runs. Separate from OW_ARGON_API_BASE, which
  # is a TOOL's read endpoint: this one is a WRITE and it is authenticated.
  # Reusing one key for both is how a laptop ends up publishing to the mini.
  - ARGON_BASE_URL
  - ARGON_INGEST_TOKEN

delivery:
  # ...existing markdown and email entries
  # The flash page. External like mail — the row does not leave the building
  # but a person reads it as a briefing — so this entry alone sends nothing: it
  # also needs HELIUM_TENANT_DELIVERY=1 and a reachable ARGON_BASE_URL. Three
  # independent conditions: intent here, authority in the brake, capability in
  # the environment.
  #
  # `kinds` is not a filter anyone wants today. It exists so that adding a
  # SIXTH phase is a deliberate line here rather than a page that silently
  # gains a tab.
  - channel: argon
    config:
      kinds: [premarket, intraday, close, weekly, frank]
      # Which ISO week each kind's row is FILED under (decision 3). Frank posts
      # on Monday about the week that just ended, so his review belongs to that
      # earlier week and not to the day it was published. Every other kind is
      # about the day it ran. The channel knows the rule names and never the
      # kind names, so this mapping is the tenant's word, not the channel's.
      weekKeyRules:
        frank: previous-iso-week
```

No `baseUrl` in the manifest: the environment is the only place it is set, so the manifest cannot commit a machine's URL to the repo.

- [ ] **Step 1: Edit, then validate.**

```bash
pnpm build && node scripts/validate-tenants.mjs .
```
Expected: option-wizard validates with **three** delivery channels resolved — `markdown`, `email`, `argon`.

- [ ] **Step 2: Commit** — `feat(option-wizard): declare the argon delivery channel`

---

## Task 4: Fix the candidate-id collision between phases

**Files:** modify `plugins/option-wizard/render/index.ts` (the mint at **:881**, inside `candidatesFrom` defined at **:840**; the call site at **:1184**), `plugins/option-wizard/tools/index.ts` (**:1971**, the `ow_reports` re-derivation), `plugins/option-wizard/team.yaml` (the `markout` prompt ~:416-447 and the `drift` prompt ~:691-706); create `plugins/option-wizard/tests/candidate-ids.spec.ts`.

> Line numbers verified against `feat/argon-delivery` at `619b89d` (master, which includes PR #86 — the editor / Design 04 work). They are unchanged from the pre-#86 tree.

### What the investigation found

- **The mint**, `render/index.ts:881`:
  ```ts
  id: `${proposal.ticker}-${dateEtDay}-${String(candidates.length + 1)}`,
  ```
  Positional, and carrying **ticker + ET day only — no phase**. The model never writes one (`team.yaml:542`, `:559`: *"Do NOT write an id; the harness mints it."*).
- **Ids are never persisted.** `candidatesFrom` has exactly two callers — the renderer (`:1184`) and `ow_reports` (`tools/index.ts:1971`, `candidatesFrom(byStep.get("review") ?? "", date).candidates`). Every read re-derives them by re-parsing the stored `review` step.
- **`ow_prior_brief` is not implicated.** `tools/index.ts:2031-2085` returns `{dir, prior:{day,phase,file,text}, note}`, where `text` is prose through `pickBriefProse` (`:875`) — headline, decision, section bodies truncated to 240 chars — then cut to 2000 chars by `PRIOR_BRIEF_CEILING_CHARS` (`:859`). Its own comment: *"the PROSE half … never the numbers."* Structure reaches a later phase only through `ow_reports`.
- **`design` and `review` both declare `phases: [premarket, close]`** (`team.yaml:522`, `:546`).

**Cause [INFERRED, strongly supported by the code].** Because `design`/`review` also run in the **close** phase, the close run generates a *fresh* proposal list for the *same* `dateEtDay`, and `candidatesFrom` mints `QQQ-2026-09-03-1`, `SPY-2026-09-03-2`, … over that new list. Nothing in the id encodes the phase and nothing dedupes against the premarket file. The close output therefore prints a candidate table where `QQQ-2026-09-03-1` is a bull call spread, while its settlement section (`settlementSections`, `render/index.ts:444`, gated by `ledgerIds` at `:582`) uses the same string to mean premarket's put debit spread. The ledger gate checks id membership **only** — its comment at `:437` says *"The check is the id and nothing else"* — so a colliding id passes validation silently.

**Contributing [INFERRED].** The index runs over the *surviving* list (`candidatesFrom` drops proposals with unparseable legs at `:858` and unsettleable `invalidation` at `:863`), so two lists that drop different members both start at `-1`.

**Not settled from code [GUESS].** Intraday has no `design`/`review` step and therefore cannot mint colliding ids. Its mislabelling is most likely the drift model paraphrasing structure it was never asked to carry (its prompt asks only for a state and a price), or a premarket bull-call candidate at the same index being read for the put-debit one. **This half is unresolved.** Step 4 below is what would settle it.

### The fix

`candidatesFrom` takes a required third argument, and the mint becomes `${ticker}-${dateEtDay}-${phase}-${n}`. Cross-phase settlement still works, because a settling role gets its ids from `ow_reports` — which already filters by phase and so hands back the premarket ids under their own names. Making the parameter **required** is deliberate: a default would let a future call site silently reintroduce the collision.

```ts
export function candidatesFrom(
  text: string,
  dateEtDay: string,
  /** The phase this proposal list belongs to. REQUIRED — leaving it out is
   *  exactly the 2026-09-03 defect: `design` and `review` declare
   *  `phases: [premarket, close]`, so the close run mints a FRESH list for the
   *  same ET day, and without a phase segment `QQQ-2026-09-03-1` names a put
   *  debit spread in the morning and a bull call spread in the afternoon. The
   *  ledger gate checks id membership and nothing else, so the collision passed
   *  validation and the settlement section settled the wrong structure.
   *  The index alone cannot fix this: it runs over the SURVIVING proposals, so
   *  two different lists that drop different members both start at `-1`. */
  phase: string,
): { candidates: CandidateView[]; /* ...existing */ };
```

**Acceptance criteria:** (a) two runs on the same ET day in different phases produce disjoint id sets; (b) a settlement naming an id that is not in the premarket ledger is refused rather than rendered; (c) the recorded 2026-09-03 transcripts, replayed, no longer collide.

- [ ] **Step 1: Write the failing tests** (`candidate-ids.spec.ts`), with the two `review` step JSONs taken verbatim from the recorded runs — premarket's QQQ 710/665 put debit spread and close's QQQ 719/740 call debit spread. Assert: the two id sets are disjoint; `…-premarket-1` and `…-close-1` are the exact ids minted; repeated parses of the same stored step are stable. Then add one case to whichever spec already covers `settlementSections` / `ledgerIds` (grep `ledgerIds` under `plugins/option-wizard/tests/`): a close run settling `QQQ-2026-09-03-close-1` against a premarket ledger holding only `QQQ-2026-09-03-premarket-1` must drop the row and record why. Before the phase went into the id, both strings were `QQQ-2026-09-03-1` and that assertion was unreachable.
- [ ] **Step 2:** Run, watch fail, implement. Update both call sites: `render/index.ts:1184` passes the report's phase; `tools/index.ts:1971` passes the phase of the report it is reading, which `ow_reports` already knows because it filters by it.
- [ ] **Step 3: Tell the settling roles the ids are phase-scoped.** One line into the `markout` and `drift` prompts in `team.yaml`:

> An id names one proposal from one phase: `<TICKER>-<day>-<phase>-<n>`. Settle only ids that `ow_reports` returned to you. If a structure you are looking at is not under one of those ids, say so — never re-use an id for a different structure.

- [ ] **Step 4: Replay the recorded day.**

```bash
ls ~/.helium/state/reports/option-wizard-2026-09-03-*.md
```
Extract the `review` step from the premarket and close files, run `candidatesFrom` over each with its own phase, and confirm the two id sets are disjoint and each id's structure matches the file it came from. Then read the intraday file's `drift` step raw text and its recorded `ow_reports` output, and check whether the legs it was handed were puts or calls. **Record both results in the PR body.** If the intraday half is still unexplained, say so there rather than closing it silently — it is a separate defect.

- [ ] **Step 5:** `pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts`
- [ ] **Step 6: Commit** — `fix(option-wizard): scope candidate ids by phase — close no longer collides with premarket`

---

## Task 5: Shrink the email to a notification

**Do this only after Flash has run in production for a full trading week** and the page has actually been read in place of the mail. Shrinking first leaves the reader with neither.

**Files:** modify `plugins/option-wizard/render/html.ts`, `render/text.ts`, `tenant.yaml` (one env key name: `ARGON_APP_BASE`); extend the existing render specs.

The notification is three things and nothing else: the price-tile row (the snapshot), `view.headline` (one sentence), and one link, `${appBase}/flash/${isoWeekOf(view.date)}/${view.date}?phase=${phase}`. When `ARGON_APP_BASE` is unset the full brief still renders — a machine with nowhere to link to must not send a mail that says "read it elsewhere".

`isoWeekOf` goes in `plugins/option-wizard/render/` (a new `week.ts`, or beside the date helpers in `math.ts`). **argon keeps its own copy** in `web/lib/flash/kinds.ts`: the two repos deploy independently, and twelve lines of ISO arithmetic with the same test cases on both sides — including `2026-12-31 → 2027-W01`, where the ISO year and the calendar year differ — is cheaper than a shared package that has to version-lock them.

`HELIUM_DEPLOYMENT=production` remains the only thing that removes the `[TEST] ` subject prefix. That is not this task's business; do not touch it.

- [ ] **Step 1: Write the failing test** — with an `appBase`, the HTML contains the headline and the exact link and does NOT contain `"Payoff at expiry"` or a candidate's rationale; without one, it still contains the rationale.
- [ ] **Step 2-3:** Implement, `pnpm test`, commit — `feat(option-wizard): email becomes a notification that links to Flash`

---

## Decisions

All three are settled. Implement as written.

1. **The `weekly` phase stays at Sunday 08:00 ET.** `tenant.yaml` declares it at `0 20 * * 0` Asia/Hong_Kong; the plists under `launchd/` are where the time actually lives and the two are kept in step **by hand**. Sunday is after Friday's close by every measure that matters, it gives the writer the weekend's news, and moving a live trigger has only downside. **Nothing changes in this repo** — argon's Outlook empty state changes to `Generated Sunday morning` instead.
2. **The Frank source is verified before it is decided.** Task 0 inspects the newest `option-wizard-*-frank.md` on the mini and the audit row behind it, and reports whether the existing `frank` phase yields a usable review. Only then is manual-paste-vs-fetch on the table, and only if the answer is no. Building either on speculation is exactly the ceremony doctrine 6 forbids.
3. **helium computes `week_key` and argon uses it verbatim.** The channel always sends it, per-kind rules come from `tenant.yaml`, and the `frank` kind uses `previous-iso-week`. Implemented in Tasks 2 and 3.

---

## Deploy to the mini

Production is the Mac mini (`macmini`, user `moremeds`). Design of record: `docs/superpowers/plans/2026-09-04-release-process.md`. There is no semver, no CHANGELOG step and no tag — the deployed tree's `RELEASE` file is the provenance, and it is what `helium audit <run>` prints as `code: <sha>`.

**Deploy argon first.** This channel POSTs to `/api/agent-runs`; until that endpoint answers, every attempt is a 404 recorded as a delivery fault.

### 1. Add the environment on the mini

Both keys go in **`~/.config/helium/helium.env`** on the mini — not in a launchd plist (`HELIUM_PROXY` was already lost once by living in a plist variable nothing read) and not in either repo.

```bash
ssh macmini
# The token must be the SAME value as argon's UW_SCAN_AGENT_INGEST_TOKEN in
# /opt/argon/.env. Generate it once, on either side.
cat >> ~/.config/helium/helium.env <<'EOF'
ARGON_BASE_URL=http://127.0.0.1:8400
ARGON_INGEST_TOKEN=<the value already in /opt/argon/.env>
EOF
# Confirm the two pre-existing brakes are still set — without them this channel
# resolves and then declines, silently:
grep -c HELIUM_DEPLOYMENT ~/.config/helium/helium.env      # want 1 (=production)
grep -c HELIUM_TENANT_DELIVERY ~/.config/helium/helium.env # want 1 (=1)
# Print counts, never values.
```

`ARGON_BASE_URL` is `127.0.0.1:8400` because argon's FastAPI listens there on the same host — see the argon plan's deploy section. `code_sha` needs no new variable: the runner already resolves `codeVersion()` from the deployed tree's `RELEASE` file (`packages/cli/src/code-version.ts`, honouring a `HELIUM_CODE_VERSION` override), and Task 1 passes it through the delivery payload so the row cannot disagree with the audit table.

### 2. Ship

From the **laptop**, on a clean tree, with both PRs merged and argon already deployed:

```bash
cd /Users/chenxi/projects/helium
git checkout master && git pull
scripts/deploy.sh premarket
```

`deploy.sh` refuses a dirty tree (an uncommitted edit would make the audit table's `code_version` a lie), runs `pnpm build` and `pnpm test`, writes `RELEASE` with the short sha, tars the built tree — `node_modules` included; both machines are arm64 macOS — and pipes it over ssh into `~/.config/helium/receive-deploy.sh` on the mini. The receiver extracts to `~/projects/helium-releases/<sha>`, points `current` at it, **deletes the email counter (that IS the daily-cap reset)**, reinstalls the five `com.helium.option-wizard-<phase>.plist` files, and `launchctl kickstart -k`s the phase named on the command line. The same sha twice is a no-op. Keeps the newest 5 releases.

Override the host with `HELIUM_DEPLOY_HOST=<host>` if it is not `macmini`.

### 3. Prove one real premarket run landed a row in argon

```bash
ssh macmini
# a) run one real premarket phase by hand (real tools, real numbers) and let it finish
~/.config/helium/run-option-wizard.sh premarket

# b) read the outcome from the AUDIT, not from a log line
helium audit <run-id>
#    want, in order:
#      - `code: <sha>` matching the sha deploy.sh just sent
#      - a delivery row for channel `argon` in state `sent`
#      - the per-step token/cost rows still present (doctrine 4: "where did the
#        tokens go" must be answerable in one query, and a new channel must not
#        have broken that)
#    a `skipped` here names its own reason, and every one of them is a step-1
#    configuration fault.

# c) confirm the row is in argon, with the right identity
curl -s 'http://127.0.0.1:8400/api/agent-runs/latest?tenant=option-wizard' \
  | jq '{tenant, kind, run_day, week_key, version_no, code_sha, schema_version, outcome,
         headline: .headline[0:60]}'
#    want: kind == "premarket", code_sha == the sha from (b), schema_version == 1.
#    `code_sha: "unknown"` means Task 1's codeVersion pass-through is not wired.

# d) confirm ingest is idempotent — re-POST the same run
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8400/api/agent-runs \
  -H "Authorization: Bearer $(grep '^ARGON_INGEST_TOKEN=' ~/.config/helium/helium.env | cut -d= -f2-)" \
  -H 'Content-Type: application/json' --data-binary @<the same body>
#    want: 200 with "created": false and the SAME version_no. A 201 with
#    version_no 2 means the idempotency key is not working and every retried
#    timeout has been publishing a duplicate.

# e) cross-check one number against its source
#    Take a spot printed on a candidate card in argon and compare it to the
#    ow_spot output recorded in that run's transcript:
grep -m1 'ow_spot' ~/.helium/state/reports/option-wizard-<day>-premarket.md
#    They must be identical. A rounded or reformatted value means a renderer is
#    deriving something it should be passing through.
```

Then let the day complete on its own schedule and reopen the day in argon: three pips lit, both supplement tabs enabled, each supplement naming and linking the premarket report.

### 4. Rollback, and the independence check

```bash
ssh macmini
ls ~/projects/helium-releases            # the newest 5 shas
ln -sfn ~/projects/helium-releases/<previous sha> ~/projects/helium-releases/current
launchctl kickstart -k "gui/$(id -u)/com.helium.option-wizard-premarket"
```

Neither half may be load-bearing for the other, and this must be checked, not assumed:

- comment the `argon` entry out of `tenant.yaml`, redeploy → the run still mails and still writes its markdown artifact;
- roll argon back to the previous release → this channel records `failed` (a 404) and the run still completes.

**Do not push to `master` and do not change the mini during an active acceptance window.**
