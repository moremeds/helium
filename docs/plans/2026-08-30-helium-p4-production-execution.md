# Helium P4 Controlled Promotion Execution Record

**Status:** working system active; elapsed evidence gate accruing
**Authority:** execution of Phase 4 in
`2026-08-25-helium-multi-agent-master-plan.md`; this document does not replace
or broaden that plan.  
**Starting production release:** `v0.1.5`  
**Starting master:** `9604ae0`
**Current production release:** `v0.1.11`
**Current release merge:** `70d35ab`

## Fixed boundaries

- The first Macro canary is review-only. It writes a durable review item and
  cannot email or mutate from the team path.
- The canary is allow-listed by tenant and durably capped per UTC day.
- Codex `gpt-5.6-sol/high` is the only currently certified team target.
  DeepSeek has no development credential and Claude quota is unavailable; they
  receive no live canary traffic.
- The existing single-agent lane starts first and remains the immediate Macro
  fallback while its selected target is healthy.
- Ops analysis remains optional. Deterministic `opsd`, dead-man, and operator
  takeover do not depend on any provider or team admission decision.
- No standing Ops authority change or component mutation is part of this
  canary. Suggest-only certification metadata does not transfer the live
  mutation owner or create an executor.

## Execution sequence

### P4.1 — Review-only bounded canary

- Add explicit `off`, `shadow`, and `review-only` runtime modes.
- Require a non-empty tenant allow-list and positive daily cap before
  `review-only` can start.
- Preserve the v1 path first on every trigger.
- Persist canary admission/skips and pending human-review items.
- Require an attributable human accept/reject decision; never turn that
  decision into automatic delivery during this phase.
- Surface team, task, attempt, artifact, budget, and review state from the same
  durable projection.

### P4.2 — Production routing and provider health

- Give the certified Codex target the exact Macro role capabilities used by
  `teams/macro.yaml`; configure each role through the normal opaque selector.
- Keep absent or exhausted providers out of fallback ordering.
- Add provider-owned failure circuit breakers in the plugin layer and publish
  their state through the existing durable availability surface.
- Restore a provider only through its explicit availability probe.

### P4.3 — Pre-canary proof

- Run the fake quota matrix: preferred target exhausted with fallback,
  shared-domain exhaustion, exact-target refusal, all-provider durable wait,
  and exactly-one resume.
- Prove the deterministic Ops controller reaches the same result with every
  provider unavailable.
- Prove review-only produces no team email and no mutation.
- Prove the new review/canary state is separate from and readable alongside
  the retained v1 state so rollback does not reinterpret it.
- Run build, typecheck, unit, contract, and local E2E gates.

### P4.4 — Tagged Mac mini canary

- Merge through a PR, align local master, cut the next patch release, and deploy
  through the existing atomic release script.
- Enable `review-only` only for `macro-watch`, capped at one case per UTC day.
- Run a controlled review-only case using Codex; verify exact execution and
  artifact lineage, a pending review item, continuous DSH/opsd/tenant
  heartbeats, and no team delivery or mutation.
- Exercise the tagged rollback and record laptop-observed time; require less
  than 60 seconds, then restore the canary release if the rollback proof passes.

### P4.5 — Evidence that accrues after the working canary exists

- Accumulate five uninterrupted trading days and at least one real material
  Macro case before claiming the full P4 live exit gate.
- Continue the independent Ops observe-only and suggest-only evidence windows;
  elapsed-day targets are evidence gates, not prerequisites for installing the
  working collector or review-only Macro canary.
- Do not credit automatic Colima recovery or Livewire repair without their
  controlled drills and policy-complete evidence bundles.

## Stop and rollback conditions

Rollback immediately on a missing heartbeat, duplicate delivery, orphan
process, unbounded canary start, provider downgrade, invalid evidence lineage,
team-side email/mutation, or deterministic Ops interruption. A provider
failure opens only that provider's circuit; it does not authorize a weaker
model or an Ops mutation.

## Evidence log

Measured commands, release/tag identity, canary records, human decisions,
rollback time, and every still-open elapsed-time gate are appended here only
after they actually occur.

### 2026-08-30 pre-canary evidence

- Mac mini Codex preflight: `gpt-5.6-sol/high`, read-only, no tools, exact JSON
  response `HELIUM_PROVIDER_AVAILABLE`; CLI `0.148.0-alpha.9` used HTTPS
  fallback after the WebSocket endpoint returned 403. Claude was not invoked.
- Live Ops input: `memory_pressure` normal with 35% free memory, no service
  impact, pageout rate about 15 pages/s, CPU busy about 58%, while historical
  swap allocation kept the planning observation `degraded`. The P4 admission
  projection preserves that Ops observation but treats only normal pressure,
  at least 25% free memory, pageout rate below 100, and no service impact as
  safe for the daily bounded serial canary.
- Local pre-merge gate: build passed; typecheck passed across 18 workspace
  projects; 124 unit files / 1040 tests passed; 17 contract files / 113 tests
  passed with the one credentialed live-provider contract explicitly skipped;
  local E2E 2/2 passed; redirected macOS packaging and reversible canary switch
  tests passed.
- Still open: tagged deployment, controlled review case, human decision,
  rollback timing, five trading days, and one real material Macro case.

### 2026-08-30 deployment findings and safe recovery

- `v0.1.6` stopped before its release flip because the deployment validator
  still imported the job loader from the removed core boundary. Production
  remained on v0.1.5. PR #36 moved validation to `v1-compat`, added a clean
  archive regression, and released that fix as v0.1.7.
- `v0.1.7` passed its clean build, job validation, DSH pin, and live Codex
  preflight, then flipped back automatically because the installed Ops daemon
  continued to report its separately commissioned immutable candidate rather
  than v0.1.7. DSH and Ops were both running after the flip-back; no Ops state
  or evidence was removed and no team canary had started.
- Read-only inspection confirmed that the selected v0.1.5 release contains no
  Ops Agent binary or bundle, while the installed launchd/config package is
  intentionally pinned to `helium-ops-candidates/71f7a23`. The normal release
  scripts correctly require a same-release collector/plugin pair, but the
  documented one-time candidate-to-`current` migration had not happened.
- The corrective path is a reversible packaging rebind with both Ops labels
  explicitly unloaded. It retains the event/evidence tree, writes a hashed
  backup of the old config and two plists, validates the new current-bound
  package before replacement, and supports hash-checked restoration. The first
  normal release transition is kept separate from the later normal tagged
  rollback drill because v0.1.5 cannot host `opsd`.

### 2026-08-30 working-system evidence

- PR #38 added the reversible candidate-to-`current` Ops packaging rebind. With
  both Ops labels unloaded, production moved to v0.1.8, retained the prior
  package in a hash-backed backup, rebound the collector to the selected release,
  and then bootstrapped `opsd` and its independent dead-man. A fresh v0.1.8
  controller cycle and `opsd fresh` dead-man result both passed without changing
  the retained event or evidence state.
- A normal deploy from v0.1.8 to v0.1.7 proved that DSH and Ops now move as one
  release pair. The tagged rollback to v0.1.8 completed in 18 seconds, below the
  60-second limit, with both daemons healthy. PR #39 recorded v0.1.8.
- The first review-only request was refused before provider execution while the
  host-pressure admission window recovered. That refusal was durable and left
  deterministic collection running. A later request reached Codex but failed
  because the installed MCP path named the removed core server rather than the
  v1 compatibility boundary. It produced no review, email, or mutation.
- PR #40 changed the canary switch to a real launchd unload/reload, migrated the
  active and rollback MCP paths to `packages/v1-compat/lib/mcp/server.js`, and
  allowed a bounded infrastructure retry of the same logical case without
  spending a second daily-budget slot. PR #41 tagged the result as v0.1.9.
- v0.1.9 passed the live Codex preflight at exact target
  `gpt-5.6-sol/high`, the DSH and Ops target-release cycle checks, and a direct
  v1-compat MCP boundary smoke. The loaded DSH environment reports
  `review-only`, allow-listed `macro-watch`, cap 1 per UTC day, and the current
  v1-compat MCP, team, and Ops-event paths.
- Controlled request `canary-1e2a135c377330eb481a9591` completed as team run
  `canary-2013ed4f1c0656d060ee0426:shadow`. All eight tasks completed on
  `codex-subscription / gpt-5.6-sol / high`; the durable case contains 61 team
  events and 18 content-addressed artifacts. Operator `show` resolved every
  artifact and verified every SHA-256 hash.
- The controlled input intentionally contained only canary metadata. The team
  did not invent a Macro view: its accepted ledger and rendered result state
  that the evidence is insufficient to change the rate-path, dollar, gold, or
  inflation thesis. This is operational evidence, not a promoted semantic
  Macro claim.
- Review `review-51c0b61a9c6581232371b688` was accepted by
  `codex-p4-operator` at `2026-08-30T11:53:20.567Z` with the explicit boundary
  “operational acceptance only.” The case has zero `delivery/*` events, no
  `deliveries-2026-08-30.jsonl`, and every execution intent records
  `mutations: forbidden`.
- After the review decision, DSH and `opsd` remained running, the independent
  dead-man remained loaded and idle, and the next Ops cycle recorded 43
  observations with zero collection failures from v0.1.9. Provider availability
  remained `available` and its circuit remained closed.
- The independent Ops ladder already has one scoped approve-only live drill:
  action `act-4ced44c86f68f99b1040634b209e16ef` restored the deliberately stopped
  `trading-cadvisor` container, verified all 20 expected containers, persisted
  and replayed the signed recovery bundle, restored both legacy mutation owners,
  and returned `opsd` to observe mode. This proves only that one drill; it does
  not grant standing approve or automatic authority.

### 2026-08-30 suggest-only evidence

- PR #43 added a reversible production `suggest` mode and an independent signed
  operator-decision ledger. Suggest mode requires the same exact signed
  promotion identity and certified SOP as approve mode, but constructs no
  executor and therefore cannot mutate the component. PR #44 released it as
  v0.1.10.
- The first v0.1.10 controlled stop was observed and projected as an
  action-eligible incident, but produced no new proposal. The incident had the
  same stable identity as the earlier successful approve-only drill, and the
  SOP's one-attempt limit was incorrectly being treated as exhausted forever
  rather than exhausted only for that recovered occurrence. The stopped
  `trading-cadvisor` container was restored by the test harness; all 20 expected
  containers were running and Ops had emitted no mutation event.
- PR #45 made the attempt budget reset after a durable recovered transition,
  while preserving cooldown across occurrences, and made the reversible mode
  switch work through the production `current` symlink. PR #46 released those
  fixes as v0.1.11. Its release gate passed 1,049 unit tests, 113 contract tests
  with one credentialed live test skipped, two local E2E tests, and 20 repeated
  action-boundary runs. A fresh post-merge build plus 124 unit files / 1,050
  tests also passed. The live deployment passed exact Codex
  `gpt-5.6-sol/high`, DSH, and Ops target-release checks.
- A signed v0.1.11 promotion bundle, valid until
  `2026-09-07T12:59:19.871Z`, enabled suggest-only for the exact release commit
  `70d35ab7a29ea9fdd7971eac9a69fecad44ca16b`. The existing Colima watchdogs
  remained loaded as the real mutation owners; `opsd` received no executor.
  The signed manifest SHA-256 is
  `28bb3b132c7634f1b72bf857647fa86c77ca1bb77cb2a09d50cad378f20c0222`.
- A second controlled stop of `trading-cadvisor` produced proposal
  `act-6268a7d73a56dc378c168473b600337c` for incident
  `inc-3a28fb3419d81886e732aec7d6b79689` at
  `2026-08-30T13:00:39.642Z`. The cycle recorded 43 observations, two incident
  updates, one proposal, and zero authorization, intent, receipt, or verified
  action events. The same container identity was restored with restart count
  zero, and all 20 expected containers were running.
- Operator `chenxi` recorded a signed `alternate` decision: retain the existing
  Colima watchdog as recovery owner and do not authorize an `opsd` mutation.
  The signed decision SHA-256 is
  `d912cbbc3463fe5bf5b2cb806b42f1b610457ef233b220b3b10d4c0f44dc39d0`.
  The decision is stored in the separate hash-chained
  `suggestion-decisions/events.jsonl` ledger, so it does not rewrite the main
  operations log; its first record hash is
  `50c2d4c87c8a4e94498b90473bec7f365ef1bc2bf53317a0adb065a4b6f74d6b`.
  A cold `opsd` restart replayed the decision and rejected a duplicate
  submission. Fresh v0.1.11 cycles then completed with zero collection
  failures.

### Ops coverage definition and first production baseline

Ops coverage is measured as a ladder, not one blended percentage. A component
may be observed without having a certified suggestion or recovery, and a
successful collection may report an unhealthy state.

- **Observation inventory coverage:** the denominator is every
  component/dimension pair in the committed standard component bundle. The
  numerator includes only pairs with at least one fresh production observation
  in the measured full cycle; registration alone does not count. The first
  v0.1.11 baseline contains 7 components and 34 declared dimensions. The full
  cycle ending at event sequence 13883 covered 7/7 components and 31/34
  dimensions (91.2%) through 43 observations with zero collection failures.
  The uncovered dimensions were Colima `controller` plus Livewire `liveness`
  and `readiness`.
- **Health is reported separately:** the same cycle contained 37 `ok`, two
  `degraded`, three `failed`, and one `unknown` samples. Coverage therefore
  says that Ops saw the target, not that the target was healthy.
- **Detection coverage:** credit only a controlled or naturally occurring
  failure that becomes a durable incident with the correct component,
  dimension, and failure class. The controlled Colima container stop meets
  this level.
- **Suggestion coverage:** credit only an eligible incident that maps to an
  exact certified SOP, creates a proposal without execution, and receives an
  attributable signed operator decision. The v0.1.11 Colima recurrence meets
  this level with an `alternate` decision.
- **Recovery coverage:** credit only an authorized execution with a durable
  baseline, write-ahead intent, receipt, postconditions, and replayable signed
  evidence. The earlier approve-only Colima container reconcile meets this
  level for that one drill only; suggest-only does not.
- **Authority coverage:** report the live mutation owner for each component
  independently of suggestion certification. In the standard bundle Colima is
  externally owned and the other six components have no Ops mutation owner.
  The signed suggestion bundle's proposed `opsd` ownership is certification
  metadata only while suggest mode has no executor and the legacy Colima
  watchdogs remain loaded.
- **Canonical coverage states:** report `observed`, `detected`, `suggested`,
  `approved-drill`, and `automatic-proven` separately. Never promote one state
  into another merely because the later capability exists in code.

### Current P4 boundary

The working-system portion of P4 is now active: tagged production deployment,
bounded Macro review-only execution, exact Codex identity, durable artifact
lineage, attributable review, no team delivery or mutation, continuous Ops
collection, an independent dead-man, a scoped controlled recovery drill, and an
18-second rollback have all been observed on the Mac mini.

The following are deliberately still open and must not be rewritten as
completed merely because the system is running:

- five uninterrupted trading days and at least one real material Macro case;
- any standing automatic Ops authority, including a controlled automatic drill;
- Colima restart and Livewire targeted-repair certification beyond the one
  container-only reconcile drill; and
- any retirement of the healthy v1 compatibility lane or any automatic team
  email/delivery.
