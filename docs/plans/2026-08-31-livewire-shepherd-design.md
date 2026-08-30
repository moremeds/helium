# Livewire Shepherd: Autonomous PIT Data Recovery Design

**Date:** 2026-08-31

**Status:** Approved design; implementation not yet started

**Priority:** Highest-priority continuation from the current P4 substrate

**Decision owner:** Operator

**Related plans:**

- [Helium Multi-Agent Master Plan](2026-08-25-helium-multi-agent-master-plan.md)
- [Helium Ops Agent Design](2026-08-25-helium-ops-agent-design.md)
- [Helium P4 Production Execution](2026-08-30-helium-p4-production-execution.md)

## 1. Decision

Build **Livewire Shepherd** as the first end-to-end example of unattended,
evidence-backed operations on top of Helium's existing Ops and durable team
kernel.

The Shepherd continuously measures data coverage, investigates ambiguous gaps,
performs exact-scope repairs, independently verifies the result, and keeps
working when one source, model, symbol, partition, or operator interaction is
unavailable. It uses agents only where deterministic code cannot settle the
question. It is not a permanently running eight-agent conversation.

The program's long-term outcome is:

> For every historical day, reconstruct the S&P 500 and Nasdaq-100 membership
> that was effective and knowable on that day, including later removals,
> delistings, renames, mergers, spinoffs, and ticker reuse, and publish the
> corresponding point-in-time Silver daily OHLCV with replayable evidence.

Delivery starts with **current members**, then expands backward only when each
new interval is evidenced. The system never silently narrows the final goal to
the subset that is easy to source.

## 2. Relationship to the existing Master Plan

This document is an additive successor workstream from the current P4
substrate. It does not rewrite or renumber the historical P0-P4 record, and it
does not reopen the cancelled P3 macro evaluation work. For forward execution,
however, it **does replace** P4's remaining Livewire checklist and calendar
waiting periods with the `LS-*` tasks and evidence gates in this document. This
is therefore an integration of work already landed in the Master Plan, not an
unrelated greenfield plan.

The existing work already supplies the safety substrate:

- typed observations, incidents, dependency graphs, and alert grouping;
- append-only event storage and replay;
- action leases, OS-level component locks, write-ahead intent, and restart
  reconciliation;
- signed SOP authority, mutation-owner checks, exact executor receipts,
  postconditions, and durable recovery evidence;
- observe-only and suggest-only deployment, provider availability, and
  resource-pressure admission control; and
- a durable team kernel with provider-neutral roles and work orders.

The current P4 evidence proves that the production substrate can observe,
suggest, attribute, replay, and roll back. It does **not** prove unattended
Livewire repair or historical PIT correctness. Livewire Shepherd is the focused
work required to close that operational gap.

The former seven-day observe-only and suggest-only durations are not hard gates
for this program. Time alone does not prove correctness. Promotion is based on
the working-system gates in section 20.

The remaining Colima automatic-recovery certification, complete resource-alert
live window, and other component-specific automation are retained as separate
Ops backlog. They are not discarded, but they follow the Livewire Shepherd
example rather than delaying it.

## 3. Scope

### 3.1 In scope

- Current and historical S&P 500 and Nasdaq-100 membership.
- Stable security identity across symbol changes, ticker reuse, exchange
  changes, merger consideration, spinoffs, and delisting.
- Bronze raw-source capture and Silver PIT daily OHLCV.
- Current-member equity intraday ingestion and coverage using the source matrix
  in section 9.
- Splits, dividends, and other corporate-action evidence required to explain or
  transform price history.
- Exact partition repair, Silver revision, DuckDB rebuild, quarantine, and
  rollback.
- Periodic deterministic verification plus bounded agent investigation.
- IB-only recovery when safe, without bouncing the rest of the trading stack.
- Autonomous creation and follow-through of typed issues in a target repository
  when the problem is code rather than data.

### 3.2 Not in scope

- Purchasing an official index-history or delisted-security dataset.
- Treating Wikipedia, Yahoo, DuckDB, a model answer, or any single vendor as
  unquestioned truth.
- Restarting the whole trading stack to recover an IB session.
- Making IB two-factor authentication an overall system blocker.
- Letting an agent invent a repair command, edit production bytes in place, or
  widen a repair beyond an approved manifest.
- Running an expensive reasoning model on every healthy partition.
- Direct pushes to a target repository's `main` or `master` branch.

## 4. Operating principles

1. **Deterministic first.** Parsers, hashes, SQL, calendars, coverage rules, and
   state machines do the normal work. Agents receive only unresolved cases.
2. **No global blocker.** A failed source or task changes the state of its own
   work unit; unrelated work continues.
3. **Evidence before mutation.** A claim must identify the bytes and times that
   support it. A repair must identify the claim it resolves.
4. **Independent verification.** The planner cannot certify its own output.
5. **Exact scope.** Every write is bounded by a typed scope. Identified-security
   writes name security identity and symbol interval; whole-market writes name
   provider/asset/date partition; unresolved candidates cannot mutate Silver.
6. **Append, do not rewrite history.** Corrections create revisions with lineage.
7. **Query convenience is not authority.** DuckDB is the sole Shepherd query
   interface, while immutable Parquet and manifests remain canonical evidence.
8. **Cost follows uncertainty.** Expensive reasoning is reserved for conflicts,
   PIT adjudication, and ambiguous corporate actions.

## 5. Unit of work and local state

A work unit is the smallest independently schedulable and recoverable typed
scope. It is one of:

```text
security interval: stable security_id + symbol interval + date/timeframe/layer
candidate identity: candidate_id + observed symbol + index/source revision
index revision: index_id + exact source revision refs
market partition: provider + asset class + date + timeframe/layer
```

Examples include one symbol-day Bronze bar partition, one security's Silver
revision interval, one whole-market Massive date, or one unresolved membership
candidate. A ticker string alone is never a stable work-unit identity.

Each execution attempt has a durable lease, write-ahead intent, and typed
outcome in the event log. Process-local capacity leases are secondary. Startup
expires safe read-only leases exactly once and sends any persisted mutation
intent through recovery instead of blindly retrying it.

The canonical work-unit states are:

| State | Meaning |
| --- | --- |
| `DISCOVERED` | A deterministic scanner found a candidate gap or conflict. |
| `EVIDENCE_PENDING` | Required read-only evidence has not yet been collected. |
| `ADJUDICATING` | Deterministic rules cannot resolve the evidence. |
| `REPAIR_READY` | An exact repair manifest and rollback plan have passed policy. |
| `REPAIRING` | One leased mutation is in progress. |
| `VERIFYING` | Independent postconditions are being sampled. |
| `VERIFIED` | The scoped claim and published revision are proven. |
| `AWAITING_PROVIDER` | A required source or model is unavailable; retry is scheduled. |
| `AWAITING_USER` | A bounded operator interaction such as IB 2FA is pending. |
| `QUARANTINED` | Unsafe or contradictory output is isolated from the query snapshot. |
| `ENGINEERING_ESCALATED` | The defect belongs in code and has a tracked issue/PR loop. |
| `UNRESOLVED` | Evidence is insufficient or irreconcilable; the limitation is explicit. |
| `RETRY_SCHEDULED` | A retry has a durable trigger or time, with no busy loop. |

There is deliberately no global `BLOCKED` state. `AWAITING_USER` for IB must
not prevent Massive ingestion, Wikipedia evidence capture, Silver verification,
or another symbol's repair.

## 6. Truth, storage, and query model

### 6.1 Canonical layers

The storage hierarchy is:

```text
raw response / document bytes
        -> immutable Bronze Parquet + raw manifest
        -> revisioned Silver Parquet + derivation manifest
        -> reconciled DuckDB query snapshot
```

- Raw bytes are stored before normalization and named by content hash.
- Bronze preserves provider observations without pretending they agree.
- Silver records the chosen identity, adjustment, membership, and PIT decision
  plus every input hash.
- DuckDB contains only revisions admitted by the reconciler. It may be rebuilt
  from canonical manifests and Parquet at any time.

The Shepherd reads operational truth through DuckDB, but every periodic cycle
checks its catalog, row counts, partition hashes, revision heads, and manifest
lineage against Parquet. A mismatch marks only affected work units
`QUARANTINED`, rebuilds a new candidate snapshot, and atomically advances the
query pointer only after verification.

### 6.2 Point-in-time clocks

Every material fact carries distinct clocks:

- `event_time`: when the market or corporate event occurred;
- `effective_time`: when membership, identity, or adjustment took effect;
- `publication_time`: when the source first made the fact public;
- `retrieval_time`: when Shepherd captured the evidence;
- `revision_time`: when a new internal revision was published.

A historical query with `as_of=T` may use only evidence with a defensible
`publication_time <= T`, even if later evidence describes an earlier effective
date. Current retrospective pages are useful discovery seeds, not proof of what
was knowable on a past date.

### 6.3 Stable identity

Symbols are intervals, not identities. Silver membership and bars join through
a stable `security_id`. Every mapping includes exchange, currency, effective
interval, evidence, and a confidence/adjudication state. Reuse of the same
ticker for a different security creates a new identity; it never splices price
history. The internal identity is generated and linked to versioned external
identifier intervals; it is never derived from ticker alone. CIK, composite or
share-class FIGI, exchange, issuer history, and corporate-action evidence are
used under a frozen priority/collision policy. Insufficient or conflicting
identity evidence remains unresolved and cannot enter PIT Silver.

## 7. Claims and verification ledgers

Every non-trivial assertion is a typed claim containing:

```text
claim_id
claim_type
subject/security_id
effective interval
publication/retrieval/revision clocks
source and raw content hash
normalized value
derivation or decision version
verification policy
verifier evidence refs
status and limitations
```

Every evidence reference is stored as a logical reference plus an immutable
SHA-256 content identity; neither field substitutes for the other. PIT-capable
claim contracts require event/effective/publication/retrieval/revision clocks
as structured fields, not prose. Provider-neutral team execution gains an
injectable output-contract registry so these Shepherd schemas remain domain
owned while unknown schema IDs stay fail-closed.

Typical claim types include `index-membership-added`,
`index-membership-removed`, `security-identity-mapped`, `split-declared`,
`dividend-observed`, `bar-partition-complete`, `silver-adjustment-valid`, and
`duckdb-parquet-reconciled`.

The verification ledger reports separate dimensions rather than one flattering
percentage:

- universe-event coverage;
- security-identity coverage;
- raw-bar coverage;
- corporate-action coverage;
- PIT publication-time coverage;
- Silver derivation and revision-lineage coverage;
- DuckDB-to-Parquet reconciliation coverage; and
- repair, rollback, and independent-verification coverage.

Canonical coverage states are `seeded`, `evidenced`, `adjudicated`, `published`,
`verified`, `quarantined`, and `unresolved`. A later capability does not promote
an earlier unevidenced interval.

## 8. Dynamic Shepherd team

The deterministic scheduler creates a team only for a bounded incident or
research batch. It selects the minimum roles needed:

1. **Incident Lead** defines the exact security, date, timeframe, Bronze/Silver
   revision, acceptance conditions, and budget.
2. **IB Investigator** obtains IB observations and connection evidence when IB
   is relevant and available.
3. **Massive Investigator** obtains Massive bars, reference data, and corporate
   actions with raw-response evidence.
4. **Corporate Action & Universe Researcher** searches publisher announcements,
   issuer/SEC/exchange material, Wikipedia citations, and archived pages.
5. **PIT Adjudicator** separates effective, publication, retrieval, and revision
   times and rejects future-information leakage.
6. **Repair Planner** can select only policy-eligible, exact-scope repair
   manifests.
7. **Independent Verifier** re-runs source, continuity, coverage, adjustment,
   lineage, and PIT checks without reusing the planner's conclusion.
8. **Reporter** writes the evidence bundle, unresolved disagreements, and final
   state without adding facts.

Not every run uses all eight roles. A missing Parquet footer with intact source
bytes may need only Lead, Planner, and Verifier. Conflicting historical
membership and ticker reuse may need the full research and PIT team.

### 8.1 Model and token policy

- SQL, hashes, API calls, parsers, comparison, and ordinary reporting use no
  model.
- Broad search, citation extraction, and candidate classification use a
  low-cost target such as Luna, Sonnet, or another provider-certified basic
  model.
- Senior models are reserved for conflicting primary sources, identity
  ambiguity, PIT adjudication, and repair-plan challenge.
- Duplicate full reports are forbidden. Investigators return typed findings and
  evidence refs to a single lead.
- Provider quota exhaustion persists the work unit, releases capacity, enters
  `AWAITING_PROVIDER`, and resumes after a provider availability event. It
  never busy-loops or changes a settled data claim.
- Each configured provider owns one bounded, persisted-backoff availability
  probe using its cheapest certified target and no tools. Tests inject fakes;
  a quota-domain probe is single-flight and cannot create an independent retry
  loop per sub-model.
- Model output is a proposal or extraction, never primary evidence.

## 9. Data-source authority matrix

The matrix is an operating policy, not a claim that one source is always right.

| Need | Primary path | Supplement / challenge | Limitation |
| --- | --- | --- | --- |
| Equity intraday | Massive whole-market minute data, then deterministic 5m/30m/1h aggregation | IB for selected gaps and checks | Current Massive entitlement is approximately 2021 onward; entitlement depth is distinct from request limits. |
| Deep equity daily for current members | IB | Yahoo disagreement detection; recent Massive overlap | IB is session-sensitive and is not sufficient by itself for delisted identity/history. |
| Other asset classes | IB | Source-specific future adapters | IB may require delayed 2FA and remains an optional work-unit branch. |
| Current index membership | Wikipedia snapshot plus existing Livewire preset as competing seeds | Official index announcements and issuer/exchange sources | Neither seed wins by count or recency alone. |
| Historical membership | Wikipedia historical change tables and their citations | Official announcements, issuer/SEC/exchange notices, archived official pages, historical ETF holdings | Free history is incomplete; unevidenced intervals remain explicit. |
| Splits/dividends | Massive structured corporate-action endpoints | Unusual Whales structured corporate actions, official issuer/exchange/SEC sources | Each event still needs identity and revision reconciliation. |
| Broad research | AnySearch | OpenCLI, direct official-site adapters, Internet Archive | Search ranking and snippets are discovery, not evidence. |
| Tertiary price challenge | Yahoo chart data | IB/Massive | Undocumented behavior and corporate-action adjustment make Yahoo unsuitable as sole mutation authority. |

Unusual Whales is not a bar source in this design. Although a live probe may
return an OHLC-shaped response, the observed request/response semantics were
not reliable enough to admit it. Its corporate-action endpoints are optional;
the current configured key returning `403` affects only those work units.

Massive's documented `/stocks/v1/splits` and `/stocks/v1/dividends` endpoints
are the preferred structured corporate-action path. Livewire issue
[#89](https://github.com/moremeds/livewire/issues/89) tracks migration from the
deprecated `/v3/reference/*` calls. The deprecated calls still return data, so
the migration runs as a non-blocking dual-read and parity program.

## 10. Tool contracts

Tools are capability-scoped and return typed receipts. No agent receives a raw
shell or unrestricted database connection.

### 10.1 Deterministic storage and verification

- `shepherd.coverage.scan`: enumerate missing, duplicate, corrupt, stale, and
  contradictory work units.
- `shepherd.parquet.inspect`: hash schemas, footers, row groups, time ranges,
  and partition boundaries.
- `shepherd.duckdb.reconcile`: compare a candidate DuckDB snapshot with
  canonical manifests and Parquet.
- `shepherd.silver.verify`: recompute continuity, adjustments, membership joins,
  and revision lineage.
- `shepherd.evidence.read`: retrieve immutable evidence by ref and verify its
  hash.

### 10.2 Source tools

- `shepherd.massive.bars` and `shepherd.massive.corporate_actions` preserve raw
  responses, pagination lineage, entitlement metadata, and normalized output.
- `shepherd.ib.bars` records contract identity, session state, request bounds,
  and raw observations. It can report `AWAITING_USER` without stopping the run.
- `shepherd.ib.restart` performs only the narrowly certified IB restart steps
  learned from the existing full-bounce script; it never bounces the stack.
- `shepherd.yahoo.challenge` is read-only and cannot authorize a repair alone.
- `shepherd.uw.corporate_actions` uses the Argon budget governor and persists
  remaining-quota evidence.
- `shepherd.wikipedia.snapshot` captures MediaWiki revision ID, revision time,
  exact page bytes, parsed rows, citations, and a content hash.
- `shepherd.anysearch` is the default general and vertical search/extraction
  tool. `shepherd.opencli` covers authenticated or source-specific adapters and
  fallback paths.

### 10.3 Mutation and engineering tools

- `shepherd.repair.stage` writes only to a new staged revision.
- `shepherd.repair.publish` atomically advances an exact revision pointer after
  all preconditions pass.
- `shepherd.repair.rollback` restores the prior immutable revision pointer.
- `shepherd.duckdb.publish` advances a verified query snapshot; direct ad hoc
  edits to the serving snapshot are forbidden.
- `shepherd.github.issue` creates or updates a deduplicated typed issue with
  evidence refs, affected scope, expected behavior, and acceptance tests.

Secrets are referenced by configured capability and are never placed in work
orders, prompts, event logs, issues, or evidence payloads.

## 11. Source verification rules

Every assertion produced from research must pass all applicable checks:

1. Capture the exact source bytes and content hash.
2. Record source URL/provider plus retrieval time.
3. Extract publication and effective dates separately.
4. Bind the claim to a stable security identity and symbol interval.
5. Prefer the responsible publisher; label Wikipedia/Yahoo/search results as
   secondary or discovery evidence.
6. For a material conflict, preserve both claims rather than overwriting one.
7. Require an independent verifier to reproduce the decisive fact from the raw
   evidence or a separately captured source.
8. Reject model-only citations, snippet-only claims, future-dated evidence in a
   historical `as_of`, and sources whose identity cannot be established.

## 12. Current-universe first live example

The first live batch reconciles current S&P 500 and Nasdaq-100 members. A
read-only research snapshot on 2026-08-31 found:

| Universe | Wikipedia securities | Existing Mac mini preset | Result |
| --- | ---: | ---: | --- |
| S&P 500 | 503 | 501 | Divergent; count alone cannot adjudicate. |
| Nasdaq-100 | 102 | 101 | Divergent; count alone cannot adjudicate. |

The observed symbol differences are candidates, not accepted truth:

- S&P Wikipedia-only: `BNY`, `CASY`, `COHR`, `ECHO`, `FDXF`, `FERG`, `FLEX`,
  `HONA`, `LITE`, `MRVL`, `RDDT`, `VEEV`, `VMRK`, `VRT`.
- S&P preset-only: `AVB`, `BK`, `CAG`, `CPB`, `EA`, `EPAM`, `EQR`, `LW`,
  `MOH`, `MTCH`, `PAYC`, `POOL`.
- Nasdaq-100 Wikipedia-only: `ALAB`, `CRWV`, `HONA`, `LITE`, `NBIS`, `RKLB`,
  `SNDK`, `SPCX`, `TER`.
- Nasdaq-100 preset-only: `CHTR`, `CSGP`, `CTSH`, `EA`, `INSM`, `TEAM`,
  `VRSK`, `ZS`.

For each difference the Shepherd captures the Wikipedia revision, opens the
row's citations, searches the responsible publisher, resolves the security
identity, records announcement and effective dates, and has an independent
verifier reproduce the conclusion. Only then may it publish a current-universe
revision to Silver and the reconciled DuckDB snapshot.

This batch is deliberately a useful disagreement, not a hand-picked easy
success. It exercises source conflict, research, PIT clocks, identity,
verification, revision publish, and coverage reporting without requiring a
dangerous production repair.

## 13. Historical membership strategy without paid datasets

Wikipedia is a seed and citation graph, not the historical database. The
current free starting points are:

- the S&P 500 historical-components page, with useful cited changes but a large
  early discontinuity before the late 1990s; and
- the Nasdaq-100 historical-components page, with a more continuous candidate
  history from roughly 2007 onward but not a complete 1985-2006 record.

The Shepherd works backward in evidence-bounded intervals:

1. Capture the current membership snapshot and official evidence.
2. Reverse verified addition/removal events to derive the prior interval.
3. Validate every boundary using its cited announcement or another responsible
   publisher.
4. Resolve old symbols to stable identities, including delisted and acquired
   securities.
5. Publish only intervals whose membership and knowledge time are supported.
6. Queue gaps for archived official announcements, issuer/SEC/exchange research,
   historical ETF holdings, and Internet Archive recovery.

A missing free source does not disappear from the denominator. It remains an
`UNRESOLVED` interval with a next research action. This preserves the full goal
without claiming unsupported completeness.

## 14. Bars, corporate actions, and Silver construction

### 14.1 Current-member daily history

The first bar program retrieves the deepest available IB daily history for the
verified current universe. Massive provides recent overlap; Yahoo challenges
large gaps and adjustment disagreements. The output retains raw per-source
observations before any chosen Silver series.

Acceptance is based on calendar-aware coverage, OHLC consistency, volume
validity, duplicate/conflict checks, identity interval, and corporate-action
explainability. A plausible-looking price series is not sufficient.

### 14.2 Current-member intraday

Massive is the primary current-member equity intraday source for the entitled
window. One-minute Bronze bars are canonical source observations; 5m, 30m, and
1h bars are deterministic aggregates with session and calendar rules. IB is a
supplementary check or targeted gap source, not a prerequisite for each batch.

### 14.3 Corporate actions

Massive and Unusual Whales structured events, plus responsible-publisher
evidence, are preserved separately. Events are reconciled by security identity,
event type, ex/effective date, ratio or amount, currency, provider event ID,
and payload hash. Changed events append a revision. Missing or cancelled events
follow an explicit policy and never vanish silently.

Silver adjustment factors are recomputed deterministically from admitted event
revisions. Both raw and adjusted representations remain queryable, with the
exact adjustment policy and inputs in the derivation manifest.

## 15. Exact-scope repair and rollback

A repair manifest must bind:

- work-unit identity and prior revision;
- the incident and claims it is allowed to resolve;
- input evidence hashes;
- exact target files/partitions and maximum rows, bytes, and duration;
- selected deterministic repair operation;
- preconditions and mutation owner;
- required integrity, freshness, coverage, continuity, adjustment, lineage, and
  PIT postconditions;
- rollback pointer and rollback postconditions; and
- expiry, attempt limit of one, and idempotency key.

The publish sequence is:

```text
lease -> baseline -> staged write -> staged verification -> write-ahead intent
-> atomic revision publish -> DuckDB candidate rebuild -> independent verify
-> query snapshot publish -> terminal evidence
```

A crash at any boundary resumes from durable state without blindly repeating a
side effect. A failed postcondition rolls back the revision and query pointers,
quarantines the candidate bytes, records the limitation, and schedules a new
investigation. Script exit zero is never recovery proof.

## 16. IB disconnect and delayed 2FA

The common IB failure is session displacement when the operator connects on a
phone. Shepherd must first classify connection refusal, displaced session,
expired authentication, process failure, or provider maintenance.

It may run a certified **IB-only** restart. If mobile confirmation is required,
the affected IB work units enter `AWAITING_USER` and retain their durable
deadline and evidence. Massive, Wikipedia, corporate-action, DuckDB, and other
asset-independent work continues. A late confirmation resumes only the still
valid work unit; an expired request is recreated rather than reused.

## 17. Engineering escalation loop

When evidence shows a code defect rather than a data incident, Shepherd:

1. computes a deduplication key from target repo, component, defect class, and
   affected contract;
2. creates or updates an issue containing sanitized evidence refs, reproducible
   behavior, scope, safety notes, and acceptance tests;
3. marks only affected work units `ENGINEERING_ESCALATED` and continues other
   work;
4. lets a target-repository coding agent create a branch, test, and open a PR;
5. requires PR review and merge through the repository workflow; and
6. independently verifies the deployed behavior before closing the issue and
   resuming quarantined work.

An open issue, including Livewire #89, is never by itself a system blocker. Old
and new implementations may run in dual-read mode until parity is proven.

## 18. Periodic operation

The steady-state loop is intentionally cheap:

1. **Frequent deterministic scan:** source freshness, partition integrity,
   calendar-aware coverage, DuckDB/Parquet parity, and queued retry triggers.
2. **Scheduled source sync:** Massive, available IB work, corporate actions,
   membership-source revisions, and existing unresolved evidence requests.
3. **Adjudication queue:** create the minimum agent team only for contradictions
   or PIT/identity ambiguity.
4. **Repair queue:** execute one exact, eligible repair per component under the
   existing Ops lease, authority, and evidence boundary.
5. **Independent verification:** periodically resample published revisions and
   randomly verify healthy strata, not only known failures.
6. **Engineering watcher:** follow open issues and PRs, then verify deployed
   fixes before closure.

Resource pressure reduces agent concurrency before it affects deterministic
collection or recovery. Provider/model outages never stop the scanner,
reconciler, repair executor, verifier, or evidence store.

## 19. New task sequence

The Shepherd program uses its own task IDs and does not reuse P3/P4 labels:

| Task | Outcome |
| --- | --- |
| `LS-01 Shepherd Kernel` | Durable work-unit state, claims, evidence, coverage ledger, retries, and no-global-blocker scheduling. |
| `LS-02 Current Universe Reconciliation` | Verified current S&P 500 and Nasdaq-100 identities and membership revisions. |
| `LS-03 Current-Member Daily History` | Deep daily Bronze coverage and verified source disagreement handling for the current universe. |
| `LS-04 Current-Member Intraday` | Massive-led minute ingestion and deterministic higher-timeframe coverage for the entitled window. |
| `LS-05 Corporate Actions and PIT Silver` | Revisioned structured events, deterministic adjustment, and Silver lineage. |
| `LS-06 Autonomous Targeted Repair` | Exact-scope repair, independent postconditions, crash recovery, quarantine, and rollback. |
| `LS-07 Periodic Agent Verification` | Cost-bounded research/adjudication teams, sampling, issue escalation, and resume behavior. |
| `LS-08 Historical PIT Expansion` | Evidence-bounded backward reconstruction toward full historical S&P 500/NDX-100 daily Silver. |

The first working path is `LS-01 -> LS-02 source/identity foundations`, then the
minimum `LS-07` source-conflict team, followed by `LS-02` reconciliation,
`LS-03 -> LS-05 -> LS-06`. This puts research/adjudication in place before the
first real Wikipedia-versus-preset disagreement instead of pretending that
reconciliation is purely deterministic. `LS-04` can proceed in parallel once
the current universe is verified. `LS-08` is a rolling coverage expansion, not
a reason to delay useful current-member operation.

## 20. Working-system completion gates

There is no mandatory seven-day waiting period. The first Shepherd release is a
working system only when all of the following are demonstrated:

1. It starts periodically without operator attendance and resumes after a cold
   restart.
2. It reconciles the current S&P 500 and Nasdaq-100 candidates into verified,
   identity-bound membership revisions or explicit unresolved entries.
3. It measures and publishes current-member daily coverage through the verified
   DuckDB query snapshot while preserving Parquet/manifests as canonical.
4. Corporate-action evidence feeds a deterministic, revisioned Silver build.
5. At least one real, exact-scope Livewire data defect is repaired without
   operator help and passes integrity, freshness, coverage, and scope
   postconditions.
6. At least one injected or controlled failed repair automatically rolls back
   and leaves serving queries on the prior verified snapshot.
7. IB unavailability or delayed 2FA affects only IB-dependent work.
8. Provider quota exhaustion checkpoints work, releases capacity, avoids a busy
   loop, and resumes from the incomplete unit.
9. A code defect creates or updates a deduplicated target-repository issue and
   remains non-blocking; a merged fix is not credited until production is
   independently verified.
10. The coverage ledger can answer, for every in-scope interval, what is
    verified, quarantined, awaiting evidence, or unresolved and why.
11. No agent, tool, or repair can write outside its exact capability and
    manifest scope.
12. Every terminal repair assertion replays from immutable evidence after a
    process crash.

After these gates, coverage and automatic-repair breadth expand continuously.
Completion of the full historical objective is reported by verified interval
coverage, not by declaring a calendar phase finished.

## 21. Required adversarial drills

- IB displaced by a phone session; delayed and expired 2FA.
- Massive, Unusual Whales, AnySearch, OpenCLI, and model quota/unavailability.
- Wikipedia revision change or vandalism after a prior snapshot.
- Current preset and Wikipedia disagree while neither has decisive evidence.
- Ticker reuse, rename, merger, spinoff, removal, re-addition, and delisting.
- Split and dividend sources disagree or revise an event.
- DuckDB row counts match while Parquet hashes differ.
- Corrupt footer, missing partition, duplicate bars, stale status, and an
  out-of-session timestamp.
- Crash before staged write, after staged write, after intent, after publish,
  during DuckDB rebuild, and before terminal evidence.
- Two Shepherd processes race for the same work unit.
- Repair command succeeds but a postcondition fails.
- Planner proposes a wider date range than the incident.
- Target-repo issue is duplicated, PR merges without deployment, or deployment
  does not fix the production symptom.
- Senior model unavailable while deterministic work and low-cost research
  continue.

## 22. Research snapshot and references

The source observations in this design were researched read-only on
2026-08-30/31 and must be rechecked by implementation preflight rather than
treated as permanent entitlement facts.

- [Massive splits documentation](https://massive.com/docs/rest/stocks/corporate-actions/splits)
- [Massive dividends documentation](https://massive.com/docs/rest/stocks/corporate-actions/dividends)
- [Livewire issue #89](https://github.com/moremeds/livewire/issues/89)
- [Current S&P 500 constituents](https://en.wikipedia.org/wiki/List_of_S%26P_500_companies)
- [Historical S&P 500 components](https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500)
- [Current Nasdaq-100 constituents](https://en.wikipedia.org/wiki/Nasdaq-100)
- [Historical Nasdaq-100 components](https://en.wikipedia.org/wiki/Historical_components_of_the_Nasdaq-100)
- [OpenCLI](https://github.com/jackwener/opencli)
