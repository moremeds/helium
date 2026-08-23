# Helium — Reactive Agent Harness (Design Spec)

> Status: approved design, pre-implementation. Owner: chenxi. Date: 2026-08-23.
> **Helium** is the harness the masterplan names as the stack's sixth component
> (livewire → signal-lab → apex → argon → xenon + harness; radon legacy).
> Design tenets inherited from `argon/docs/masterplan/2026-07-12-stack-master-plan.md`:
> *the harness is the product, not the brain; own only scheduling + context + delivery;
> silence discipline first; JSONL audit trail; agents propose, a gate disposes.*

## 1. What Helium is

An always-on, **reactive** agent harness running on the Mac mini. It watches the
ecosystem (argon macro/rates/gold state, economic-calendar windows, later: health
endpoints, UW options flow, xenon WS shocks), and when a trigger fires it dispatches
an LLM agent to analyze the event and delivers the result within minutes. Cron is
just one trigger type, not the center.

Helium's core product is the **extensibility contract**: any agent can be spawned
— triggered (sensors), scheduled (cron), or ad-hoc (an interactive dsh UI session
or manual run) — with deep, first-class bindings to **argon, livewire, signal-lab,
and apex** (§6). Macro (§11) is the first tenant, not the product.

Explicit non-goals: no in-house agent loop, no web UI of our own, no database
(files + JSONL are all state), no trading writes, no auto-upgrades of dependencies.

Data egress is by design: ecosystem-derived data (argon macro state, livewire
aggregates) is sent to the DeepSeek and Anthropic APIs; secrets and credentials
never are.

Latency model (honest): event detection is seconds (pure code); agent analysis is
1–5 minutes (LLM inference); alert-in-inbox is minutes after the event. The LLM is
never in the tick loop.

## 2. Substrate decision (record)

**Helium is built as dsh plugins** (`deepseek-ai/deepseek-harness`, "everything is
a plugin", Cordis-based). Decision history:

- Thin-Python-daemon and dsh-Python-SDK paths were evaluated and spiked; both work.
- Plugin mode chosen by the owner for its long-term value: in-process interception
  points (`tools/pre-execute` for future approval gates), durable append-only
  session logs with replay, sandboxing, compaction, and the dsh Web UI as a free
  inspection surface ("what did my agents do overnight").
- Spike evidence (2026-08-23, dsh 0.1.1-rc.2): sensor plugin ~135 lines TS polled
  the real argon `/api/health`, detected changes, dispatched `deepseek-v4-flash`
  via `ctx.agents.create()` + `followup()` + `whenIdle()`, captured final text via
  session-event watermark. 11/11 runs completed, 2.0–3.2 s per analysis, zero errors.

**Escape hatch**: sensor/trigger/delivery logic must stay small, config-driven and
self-contained, so that logic alone can be ported to the dsh Python SDK (spiked:
73 lines, `session.run()` → `final_response`) or pi within days if dsh's RC
evolution breaks us. What a port would lose is the dsh-specific value — the durable
session store, the web UI, the interception points, and in-process tool registration
— so the hatch buys survival, not an equivalent substrate.

## 3. Architecture

```
launchd LaunchAgent (KeepAlive, GUI session, ~moremeds)
  └── dsh --profile helium --port 3080 --no-open   # single long-lived process
        ├── helium-toolkit     ecosystem tools + context injected into every
        │                      agent (argon/apex/livewire/signal-lab bindings)
        ├── helium-sensor      poll HTTP endpoints, hash-diff, trigger rules,
        │                      dedup / cooldown / budgets, calendar windows
        ├── helium-dispatch    per-job engine routing + session strategy +
        │                      persona/tool restriction + result capture
        └── helium-delivery    JSONL append (first, always) → email (best effort),
                               heartbeat (dead-man check is external, §8)
```

- One repo: `~/projects/helium` (GitHub `moremeds/helium`, private). pnpm workspace
  of plugin packages + a dsh profile + contract tests + deploy scripts.
- Deployed on the mini at `/Users/moremeds/projects/helium`; the dsh profile lives
  in a dedicated `$DSH_HOME` owned by helium (never the default `~/.dsh`).
- Runtime roots on the mini: `$DSH_HOME = /Users/moremeds/.helium/dsh-home`, harness
  state root `/Users/moremeds/.helium/state/`. Both live outside release checkouts.

### Tracking & UI

Agent-level tracking uses **dsh's own Web UI** (default `127.0.0.1:3080`) — every
run helium dispatches lives in dsh's durable session store, so transcripts, tool
calls, and per-turn history are inspectable with zero UI work of ours.
**dsh's SQLite session index is enabled** (full-text search / session query in the
UI); the append-only JSONL session log remains the canonical audit record. This
does not touch the §1 no-database rule, which governs helium's own harness state
(triggers, heartbeats, budgets — plain files), not dsh's internal index. Harness-level state (trigger history,
heartbeats, dedup/cooldown decisions, budgets, delivery status, canary results)
stays in helium's JSONL + the daily email for v1; if a status page is ever wanted,
helium registers a small route via `ctx.webServer.register()` in the same process.

Security: dsh's web server has no TLS/auth/origin policy (upstream-documented).
Bind loopback only; remote viewing goes through `ssh -L 3080:127.0.0.1:3080
macmini`. Never bind non-loopback, including the tailnet.

To verify in implementation phase 1: the web UI is provided by listing the
`@deepseek-ai/dsh-web-app` bundle in the helium profile (source-verified
2026-08-23: `web` is a hardcoded profile alias in the dsh CLI, not a subcommand —
`dsh --profile helium web` is not a valid form). Remaining empirical check:
that bundle serving 127.0.0.1:3080 while helium's plugins run in the same
process.

## 4. Engines (both verified end-to-end on 2026-08-23)

| engine id      | path | use | verified mechanics |
|---|---|---|---|
| `deepseek`     | in-process dsh (`llm-deepseek`) | triage, high-frequency monitors, change-diff intel | `DEEPSEEK_API_KEY` env; models `deepseek-v4-flash` (triage) / `deepseek-v4-pro` |
| `claude-max`   | child process `claude -p` spawned by helium-dispatch | senior analysis (macro thesis) | `CLAUDE_CODE_OAUTH_TOKEN` from `~/.config/helium/claude-token.env` (0600, 1-year token via `claude setup-token`); `HTTPS_PROXY=http://127.0.0.1:7897` (Clash Verge, routes anthropic via SG); `--output-format json --max-turns N`; keychain is never touched |

**Senior-lane hardening:**

- claude-max children run with an explicit `--allowedTools` allow-list, a per-job
  `--max-turns`, and a job-owned cwd — one spike run showed the operator's global
  `CLAUDE.md` interfering with an unrestricted run.
- Ecosystem tools (§6) reach the claude-max child via an MCP stdio server exposing
  helium-toolkit (`--mcp-config`); in-process dsh tool registration cannot reach a
  child process. MCP exposure is a phase-1 verification item, and until it is
  verified the senior prompt carries sensor-fetched context inline.
- Senior-lane failures are classified: 403 / connect-fail = proxy (Clash) issue,
  401 = token issue. The token's issue date is recorded so its age shows up in
  reports (it is a 1-year token).

Two-tier flow: triggers land on **triage** (deepseek-v4-flash, seconds, ~cents);
only material events escalate to **senior** (claude-max). Triage output is a
structured verdict — JSON `{escalate, severity, reason}`, prompt-enforced and parsed
with one retry — which the job's `escalate_when` consumes; escalation is never
inferred from prose. Degradation is graceful and must be reported, not hidden:
Clash down → senior lane pauses, triage continues; argon down → sensor reports
`unknown` (a timeout is not proof of death — never `down`).

Note: `subagent-claude-code` (dsh's official-SDK backend) exists but is NOT relied
on — subscription entitlement through it is unverified. Do not use it without a
dedicated verification first.

## 5. Job contract

`jobs/<name>.yaml` — one file per job, git-diffable. Shape (final schema at impl);
the semantics defined here — timeout scope, budget windows, `escalate_when`,
coalescing — are normative, the field names illustrative:

```yaml
name: macro-watch
enabled: true
triggers:
  - kind: state-change
    url: http://127.0.0.1:8400/api/rates/snapshot   # a real route, not a family
    fields: [regime.state, direction, confidence]   # explicit dot-paths; volatile fields excluded
    interval: 30s
  - kind: calendar-window      # source: calendars/us-macro.yaml in-repo, ET-anchored
    window: { before: 30m, after: 2h }
    interval_during: 10s
  - kind: cron
    schedule: "0 17 * * 1-5"
    tz: America/New_York
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material   # consumes the structured triage verdict (§4)
session: fresh                        # monitors: fresh per trigger
memory: thesis-file                   # see §7
tools: [argon_api, livewire_sql]      # per-job allow-list from §6
allowMutations: false
max_turns: { triage: 2, senior: 8 }
timeout: 10m        # per-dispatch wall clock; overrun -> timed_out (SIGTERM, then SIGKILL)
budget: { max_triage_per_hour: 30, max_senior_per_day: 12 }   # rolling windows, persisted
delivery:
  jsonl: true
  email: { to: operator, subject_prefix: "[helium/macro]", max_per_hour: 4 }
prompt: |
  (verbatim prompt template; receives trigger context + previous/current state)
```

Budget semantics: rolling windows, counters persisted with sensor state; exhaustion
suppresses the dispatch, writes one `budget-exhausted` JSONL row, and is mentioned in
the daily synthesis. Count caps are the v1 cost control — no USD accounting.

## 6. Ecosystem binding layer (helium-toolkit)

The moat. A plugin that registers typed tools onto **every** dispatched agent and
into interactive dsh UI sessions, so a new agent needs a job file, never plumbing:

| tool | system | surface | writes |
|---|---|---|---|
| `argon_api` | argon | REST `127.0.0.1:8400` — `/api/macro/*` (policy, inflation, rates, usd, gold), `/api/rates/snapshot`, `/api/gold/*`, `/api/regime`, `/api/health`, `/api/stock/{ticker}/trade-insights` | read-only; `rescan` / `ai-analysis` POSTs behind the per-job mutation gate |
| `apex_api` | apex | REST `127.0.0.1:8322`, root-mounted (no `/api` prefix) — `/health`, `/v1/*` (bars, indicators, signals, confluence) | read GETs free; screener/backtest are POST-to-enqueue compute jobs — permitted but budget-capped (they mutate no domain state) |
| `livewire_sql` | livewire | DuckDB directly over the Parquet lake (local disk on the mini) + quality/telemetry surfaces | read-only |
| `signal_lab_run` | signal-lab | gated invocation of its `scripts/` research entry points via uv | gated; later phase |

DuckDB here is a read-only query engine over livewire's Parquet lake on the mini's
local disk — helium owns no database; §1's rule is untouched.

Rules:

- **Read-only by default.** Every mutation tool exists only behind an explicit
  per-job `allowMutations` flag and writes an audit record — agents propose,
  a gate disposes. Trading writes stay out of helium entirely (xenon's domain).
- **Three-layer context injection** (pattern proven in OpenAlice): a maintained
  `context/ecosystem.md` (what the four systems are, their surfaces, their data
  semantics) → the job's own prompt → the trigger event payload.
- **Spawning an agent is a one-file change**: job file only. Jobs live in the repo
  (git-diffable provenance) and activate via an ordinary release deploy — zero
  core-code edits, no hot reload in v1. The toolkit changes only when a genuinely
  new system surface is needed, and is shared by all agents.
- The toolkit reaches in-process dsh agents natively, and the claude-max child
  process via the MCP stdio server (§4).
- The same toolkit serves ad-hoc use: open the dsh Web UI, start a session, and
  the ecosystem tools are already there.

## 7. Session & memory strategy

- Monitor-type jobs: **fresh session per trigger** (bounded transcripts).
- Thesis memory (macro): NOT an ever-growing resident transcript. The senior agent
  maintains a thesis (rate path, confidence, what would falsify it), rewriting it at
  the end of each material run; the next run injects the current version. Memory
  lives in a reviewable file, not in a transcript; provenance and replay stay clean.
- The thesis has a **protected write path**: the senior agent never writes the file
  directly, but through a helium-owned tool that versions each rewrite
  (`state/theses/<job>/<ts>.md` + a `current` symlink), caps size, and puts the diff
  versus the previous thesis into the delivery email — so a poisoned or truncated
  rewrite is visible and revertible.

## 8. Dispatch discipline (from spike findings — mandatory)

- dsh's default agent is a full coding agent (complete toolbelt, high reasoning
  effort, 256k max tokens, plus a per-session title LLM call). helium-dispatch MUST
  restrict tools and reasoning per job class; a JSON-diff triage run carries no
  file-edit toolbelt.
- `followup()` has no completion handle: dispatch owns a busy/interval watermark
  (capture `session.seq` before followup, `whenIdle()` + flush, then scan
  `assistant/message` above the watermark). Overlapping dispatches on one agent
  are forbidden.
- Sensor state (hashes, dedup keys, budget counters) persists in
  `state/sensors/<job>.json`. The first poll after a cold start establishes the
  baseline and never fires a trigger; dedup carries an explicit key + TTL.
- Per-job single-flight: triggers arriving while a dispatch is in flight coalesce to
  latest-state (queue depth 1); a global cap (2) bounds concurrent claude-max
  children across all jobs.
- Rate-limit answers ("resets at …") are retry-after signals, not failures.
- Run accounting distinguishes `interrupted` (machine slept, process restarted)
  from `failed` (real error). A successful run may legitimately be silent.
- Run records are two-phase: `run_started` → `run_completed | run_failed |
  timed_out`; startup reconciliation marks dangling `run_started` rows `interrupted`.
  This is what makes the §13 kill-test mechanically possible.
- Heartbeat row is written every sensor cycle, even no-op cycles.
- All persisted timestamps are UTC ISO-8601; schedules and calendar windows carry an
  explicit IANA tz (default `America/New_York`).
- JSONL rotates daily with a 90-day retention; dsh's session-store retention is a
  phase-1 check.
- Email delivery uses bounded retry with backoff; a final failure writes a
  dead-letter JSONL row and surfaces in the heartbeat + daily synthesis. Per-job
  email rate cap applies.
- **The liveness check is external to the process**: a minimal separate launchd
  agent (StartCalendarInterval + script) checks heartbeat freshness and emails on
  staleness. The v2 in-process patrol job supplements it, never replaces it.

## 9. dsh packaging clauses (from spike findings — mandatory)

1. **Pin `dsh@0.1.1-rc.2` exactly.** Upgrades are explicit, human-approved events.
2. Plugins install into the profile with **`file:` semantics and compiled JS**
   (`link:` breaks module resolution; TS under node_modules cannot be type-stripped).
   A `deploy-profile` script owns build → remove → add; the dev loop is documented
   in the repo README.
3. No scaffold exists upstream: our first plugin IS the scaffold; new plugins copy it.
4. Never touch the default `~/.dsh`; all runtime state under helium's own
   `$DSH_HOME` and `state/` dirs.

## 10. dsh upgrade canary (the watch-for-breakage mechanism)

dsh is a developer preview: RC-only releases, breaking changes promised, no issue
tracker, no changelog (one-way mirror repo). Helium therefore ships its own canary.
The sentinel is a normal helium sensor; the isolated install, compile, contract suite
and repo diff (steps 2–3) run as `scripts/canary/`, invoked through a gated script
action of the cron-triggered canary job rather than through the four ecosystem tools.
Delivery reuses helium-delivery.

1. **Version sentinel** — sensor polls the npm registry's full `versions` list for
   `@deepseek-ai/dsh` (plus PyPI `deepseek-harness-sdk` for drift) and compares
   semver-newer-than-pin → trigger. Dist-tag equality is the wrong test: an RC-only
   package may never move `latest`.
2. **Contract test suite** (`contracts/` package) — encodes exactly the API surface
   helium uses: profile mount, `plugin add file:`, `ctx.effect` timer, `ctx.agents
   .create/followup/whenIdle`, session-event watermark capture, headless smoke.
   The candidate version installs into a **throwaway isolated $DSH_HOME**, our
   plugins compile against it, the suite runs (one real deepseek-v4-flash one-shot;
   cost: cents). Output: PASS/FAIL per contract.
3. **Change intel** — a deepseek agent diffs the mirror repo between the pinned and
   new tags (focus: packages/core/agent, bundle READMEs, commit log) and summarizes
   what touches our seams.
4. **Report** — via helium delivery: "dsh X.Y.Z released: contracts PASS/FAIL,
   change summary, upgrade recommendation." **Never auto-upgrade** — a human
   promotes the pin, then the canary's isolated profile becomes the smoke test.

## 11. v1 scope — macro use case end-to-end

Sensors poll argon (`/api/macro/*`, `/api/rates/snapshot`, `/api/gold/*`,
`/api/regime`; loopback :8400 on the mini) for state/direction/confidence changes and
new policy evidence (MC1–MC3 shipped, MC3 merged 2026-08-22; MC4 surfaces are a
one-line job-file addition when argon ships them — hashed field lists stay explicit).
Calendar windows arm around FOMC/CPI/NFP. On material events the senior agent
answers: did this move the rate-path thesis (short vs long end), what does it mean
for gold and tech exposure, what changed vs the standing thesis. Quiet periods stay
quiet; an optional daily synthesis email is the floor, not the product.
Helium produces narrative analysis only — no numbers flow back into argon
(argon MC6 owns quantitative promotion; helium sits exactly at the documented
"Fundamental PM Agent can consume" boundary).

Delivery v1: JSONL + markdown report on disk, email via SMTP (nodemailer; livewire's
SMTP credentials are copied into `~/.config/helium/helium.env`, never a repo-local
`.env` — no code coupling with livewire).

## 12. Deployment & secrets

- Mini paths: repo `/Users/moremeds/projects/helium`; launchd plist
  `~/Library/LaunchAgents/com.helium.dsh.plist` (KeepAlive, GUI context,
  absolute paths, explicit EnvironmentVariables — launchd PATH is bare).
- Secrets: `~/.config/helium/claude-token.env` (exists, 0600),
  `~/.config/helium/helium.env` (DEEPSEEK_API_KEY, SMTP creds; 0600).
  Secrets never enter the repo, logs, JSONL records, prompts, or PR bodies.
- Clash Verge must be running (mixed port 7897) for the senior lane; helium injects
  proxy env only into `claude-max` child processes, never globally.
- **Mini prerequisites** (one-time documented setup, checked once, not per deploy):
  system sleep disabled (`pmset -a sleep 0`), and auto-login enabled so the GUI
  LaunchAgent loads after reboot — the FileVault trade-off is acknowledged.
- Dev on laptop: SSH tunnel to argon (`ssh -L 18400:127.0.0.1:8400 macmini`).

### Release process

Releases follow livewire's promoted-checkout pattern — a promoted immutable checkout
plus an atomic `current` symlink flip (livewire promotes SHAs for batch jobs that
`cd` into `current`; it has no restart step) — not argon/apex's Docker+Watchtower
(helium spawns the host `claude` binary, reads host token env files, and uses
localhost Clash — containerizing adds friction, no isolation benefit on a
single-operator box). Helium extends that pattern with version tags `vX.Y.Z` and
`launchctl kickstart -k`, both needed because helium is a long-lived daemon rather
than a batch job.

- **Release unit**: git tag `vX.Y.Z` → immutable checkout at
  `/Users/moremeds/projects/helium-releases/vX.Y.Z/` (own `node_modules`, own
  built profile) → atomic `current` symlink flip → `launchctl kickstart -k`.
- **Scripts** (in-repo, human-initiated from the laptop):
  `scripts/release/cut.sh` (VERSION + CHANGELOG + tag + push, argon-style),
  `scripts/release/deploy.sh` (fetch tag → frozen-lockfile install + build +
  profile deploy → contract-suite smoke with one real deepseek-flash call, abort
  before flip on failure → drain in-flight dispatches under a bounded grace of
  ~2 min → symlink flip + `kickstart -k` → post-flip health window of at least two
  heartbeat intervals before success is declared, with automatic flip-back on
  failure), `scripts/release/rollback.sh` (flip to previous release + kickstart;
  seconds, no rebuild).
- **Gates**: feature branch → PR → CI green (typecheck, unit, and the *same*
  contract suite the canary runs, in mocked-LLM mode) → merge → only then cut a tag.
  The live-only contracts are the agent-loop seams (`create`/`followup`/`whenIdle`,
  session-event watermark). Releases are always human-initiated.
- **Security**: CI never holds mini SSH keys or any secret; deploy runs only from
  the operator's laptop. `/Users/moremeds/.helium/state/`, `$DSH_HOME`
  (`/Users/moremeds/.helium/dsh-home`), and `~/.config/helium/*` live outside
  release dirs — a release swaps code only. Keep the last 5 releases.
- **dsh pin**: travels in the lockfile, so every release reproducibly binds its
  dsh version; canary-approved pin bumps ship as ordinary releases.

## 13. Acceptance criteria (v1)

1. Five consecutive unattended trading days on the mini: sensors polling, triage
   firing, JSONL/heartbeat records continuous, at least one senior analysis email
   delivered end-to-end.
2. Kill the process mid-run: next run records `interrupted` (not silence, not
   `failed`); launchd restarts the daemon; no duplicate alerts on recovery.
3. Simulated state change via a fixture endpoint → email accepted by SMTP within
   10 minutes (honest upper bound: ≤30 s detection + ≤5 min analysis + delivery).
4. Canary drill: point the sentinel at a synthetic "new version" → isolated install
   + contract suite runs → report email arrives; production profile untouched.
5. Secrets scan of repo + state dir is clean.
6. Release drill: one full `cut.sh` + `deploy.sh` cycle ships a tagged version to
   the mini, and `rollback.sh` restores the previous release within one minute.
7. Extensibility drill: agent #2 (e.g. a trivial apex-health summarizer) goes live
   as a one-file job with zero core-code edits, in under 30 minutes; the ecosystem
   tools are callable from an interactive dsh UI session.

## 14. Roadmap after v1

- v2: ops/health patrol job (argon /api/health + freshness + gap-healer, apex
  /health, livewire telemetry JSONL, Prometheus/Loki queries) — masterplan Stage 1.
- v3: UW options-flow alert job (real-time flow triage → senior escalation).
- Continuous: DeepSeek vs Max A/B on real jobs; deepen into dsh interception
  points (approval gates) when a job first needs a mutation.
