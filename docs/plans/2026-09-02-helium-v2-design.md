# Helium v2 — design

**Date:** 2026-09-02 · **Status:** design of record for v2 · **Supersedes:**
the v1 plans and spec, deleted with v1 in PR #60 (git history has them).

`CLAUDE.md` §Doctrine is this document's acceptance criterion; every section
traces to a doctrine point (table at the end). Claims not verifiable from a repo
file are tagged `[INFERRED]`.

Audit facts cited as given `[COMPUTED 2026-09-02]`: 57.6k TS lines, ~6.4k on
the run path, ~2.3k worth keeping; ~14k lines of authority/lease/evidence
machinery authorizing an empty set (`authority-manifest.json` `entries: []`);
zero production tenants; 6 release tags in 2 days all fixing `deploy.sh`; 4,972
lines of contract tests; CI repeats a race suite 20×.

---

## 0. Prior art and what we borrow

v2's first rule: Helium writes only what nobody has written for it. dsh is the
runtime floor; the rest contribute one design idea each.

| Source                                       | Adopt                                                                                                                                                                                                                                      | Do **not** adopt                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **dsh** `@deepseek-ai/dsh-*` (runtime floor) | sessions (append-only log, fork/resume), subagents (`toolFilter`/`persona`/`outputSchema`/`depthLimit`), `defineTool` + validation, compaction, `ctx.approval`, same-world sandbox modes, skills, MCP, profiles/presets under `$DSH_HOME`  | `ctx.tokenMeter` (4-chars/token heuristic, not billing — §5); its model selection (route-level, not capability-level)   |
| **FrontierAgent** (ApodexAI)                 | the `AgentDefinition`/`PipelineSpec`/`ContextPolicy` split (declare topology once, bind roles into nodes); Observer→`Intervention` as the audit tap and budget short-circuit; the `inputs`-RO / `workspace`-RW / `outputs` convention (§4) | its explicit tool allowlist (we glob), its single OpenAI-compatible endpoint, `SpawnGuard` as the only budget surface   |
| **CrewAI**                                   | YAML role declaration (`agents.yaml`/`tasks.yaml`) as precedent for `team.yaml` beside the tenant                                                                                                                                          | Python decorators; LLM bound in code (v2 binds by capability tag)                                                       |
| **OpenAI Agents SDK**                        | trace-span field names as the literal audit schema (`span_id`, `parent_span_id`, `input_tokens`, `output_tokens`, `latency_ms`, §5); guardrails as first-class objects short-circuiting **before** budget is spent (§3)                    | trace export to a hosted sink; handoffs-in-code as the team primitive                                                   |
| **LangGraph**                                | checkpoint at every step, not at task boundaries — cheap rollback for an agent editing a repo                                                                                                                                              | the graph/LangChain runtime and its tool interface                                                                      |
| **Temporal**                                 | the **idea only**: deterministic orchestration (the reducer, replayable) split from non-deterministic activity (LLM/tool calls, retryable); v2's reducer adopts the split explicitly.                                                      | the product. No Temporal dependency, no worker fleet.                                                                   |
| **`NanmiCoder/dsh-agent-teams`**             | the only public multi-agent-on-dsh example: a captain session spawning durable sub-agents over a dependency DAG, atomic scheduler, quality gates. Read before §6's scheduler.                                                              | wholesale adoption — open question (§11.5): session-scoped, not trigger-driven, and pinned to a dsh build we do not run |
| **pi** (`badlogic/pi-mono`, `@earendil-works/pi-*`, MIT; installed locally at 0.79.3) | the provider layer: `pi-ai` gives 30+ providers with OAuth for Claude Pro/Max, ChatGPT Codex and Copilot subscriptions; dsh itself ships `dsh-llm-pi-ai`, so this is a supported dsh backend, not a fork. Its extension-event API is a reference for our hook table (§3). | pi as the runtime: no first-party subagents (docs say so; ≥4 competing community extensions) and no sandbox or permission model (docs disclaim it). Replacing dsh would mean rebuilding both — weeks, not days. Decided 2026-09-02, **revised the same day** after measuring the CLI providers (§3.1): take pi's *transport design*, not the package. `pi-ai`'s OAuth request shapes for Anthropic and ChatGPT-Codex are the reference implementation we copy into our own providers — a dependency we would have to track through pi's release cadence buys us nothing we cannot write in ~150 lines and must maintain anyway. pi as the *runtime* stays rejected for the reasons above. |

**No surveyed framework has** glob tenant discovery (all use explicit
registration), a queryable local token table (all export to a sink or do
nothing), blast radius keyed to _location_, or a self-improvement loop over its
own repo. Those four are Helium's own.

## 1. Goal and non-goals

**Goal.** A small harness that runs a declared team of agents against a
declared job, inside a declared sandbox, records every token it spends, and
delivers a result — including against its own repo. Every decision is measured
by doctrine 1. Concretely: a new tenant is a directory; a new model vendor is a
directory; deploy is `git pull && pnpm build && launchctl kickstart`; and "where
did the tokens go for run X" is one SQL query.

**Non-goals.** v2 does **not** build, and deletes where it exists: signed
authority manifests; executor sha256 certification; component
leases/handoff/rollback; the accepted-claim ledger and `claims.yaml`; the ops
SOP lane in its current form. Per doctrine 5, blast radius is _where_ an agent
runs, not what was signed — a worktree that can be `rm -rf`'d beats a signature
over an argv schema and costs three lines, not ~14k `[COMPUTED]`. Per doctrine 6, that machinery has caught zero defects
because it authorizes an empty set; it never earned its keep. Recovery
procedures come back as _tenant tools_ — a shell script a livewire role may
call inside a sandbox — which is where domain knowledge belongs. Also a
non-goal: reimplementing anything in §0's dsh row.

## 2. Core model

Nouns are dsh's wherever dsh has one; Helium adds four and no more.

| Noun          | Is                                                                                                                                                                           | Owner                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Tenant**    | a directory rendering **a dsh profile + preset**: `tenant.yaml` → `cordis.patch.yml` + preset dir under `$DSH_HOME/profiles/<tenant>` (identity, triggers, budget, delivery) | Helium (dsh has nothing multi-tenant)  |
| **Team**      | the role set and their handoff; CrewAI-style YAML beside the tenant                                                                                                          | manifest in plugin, reducer in core    |
| **Role**      | **a dsh subagent definition** — `toolFilter`, `persona`, `outputSchema`, `depthLimit` — plus Helium's `requires:` and sandbox kind                                           | manifest in plugin, validation in core |
| **Tool**      | **`defineTool` from `@deepseek-ai/dsh-tools`**; schema, validation, hooks are dsh's                                                                                          | plugin (`plugins/*/tools/index.ts`)    |
| **Run**       | **a dsh session**; the append-only log is truth and a run id is a `SessionId`                                                                                                | dsh                                    |
| **Step**      | one dsh turn or tool call, as logged                                                                                                                                         | dsh                                    |
| **Sandbox**   | the filesystem/process boundary a run executes inside (§4)                                                                                                                   | Helium, above dsh's same-world modes   |
| **Audit row** | a **projection folded from the session log** (§5)                                                                                                                            | Helium                                 |
| **Delivery**  | a result off the machine (email, PR, file)                                                                                                                                   | plugin (`plugins/delivery-*`)          |

**Removed because dsh has it:** the v1 `Agent` noun (`ctx.agents` owns live
identity; binding a role to a provider is `installModelSelection` on a subagent)
and Helium's own `Run`/`Step` records. Helium's originals are exactly four:
**Tenant**, **capability routing**, **Sandbox kinds beyond same-world**,
**audit projection**.

Core vocabulary contains no `claude`, `deepseek`, `codex`, `option`, `market`,
`livewire`, `ib`; `core-neutrality.contract.spec.ts` keeps that honest, and only
`plugins/provider-dsh/` names `@deepseek-ai/*`.

## 3. Plugin interfaces

Glob discovery, no registry (doctrine 2, 3). **Cut because dsh exposes them:**
the `Tool` interface (`defineTool`), session/run storage (`ctx.sessions`),
subagent spawning (`ctx.subagents`), approval (`ctx.approval`). Five remain,
all things dsh has no opinion on.

| Kind             | Glob                             | Entry                          |
| ---------------- | -------------------------------- | ------------------------------ |
| tenant           | `plugins/*/tenant.yaml`          | `+ team.yaml + tools/index.ts` |
| provider         | `plugins/provider-*/provider.ts` | `export default Provider`      |
| gate (guardrail) | `plugins/*/gates/*.ts`           | `export default Gate`          |
| delivery channel | `plugins/delivery-*/channel.ts`  | `export default Channel`       |
| sandbox kind     | `plugins/sandbox-*/sandbox.ts`   | `export default SandboxKind`   |

```ts
export interface Provider {
  id: string; // "dsh", "claude-subscription", "codex-subscription"
  capabilities: string[]; // what roles may require
  models: Array<{ id: string; caps: string[]; usdIn: number; usdOut: number }>;
  // Tokens this provider spends before our prompt is counted. MEASURED, never
  // estimated: the router adds it to every candidate, so a cheap per-token
  // model with a fat preamble must lose to a dearer one without (§3.1).
  overheadTokens: number;
  // HTTP egress arrives as the `HELIUM_PROXY` key of the provider's declared
  // env, not as a separate argument — one channel, so there is no second place
  // for a route to be decided. Explicit because macOS system-proxy settings
  // reach neither curl nor a launchd-spawned Node process, and because a
  // provider is handed a curated env, which an ambient https_proxy would not
  // survive. See the HELIUM_PROXY post-mortem in §3.1.
  probe(): Promise<boolean>; // liveness; a dead provider is skipped, not fatal
  select(req: AgentRequest): ModelSelection; // dsh: installModelSelection args
}
// Gate: OpenAI-SDK-style guardrail. Its own audited step, BEFORE the LLM call
// it guards, so it can short-circuit the run before budget is spent.
export interface Gate {
  id: string;
  appliesTo: string[]; // role names
  phase: "input" | "output";
  check(i: unknown, c: GateCtx): Promise<{ pass: boolean; reason: string }>;
}
// Channel: id ("email" | "github-pr" | "file") + deliver(payload, cfg).
export interface SandboxKind {
  id: "worktree" | "dsh-home" | "scratch" | "none" | string;
  create(spec: SandboxSpec): Promise<SandboxHandle>; // root + writeRoots
  destroy(h: SandboxHandle): Promise<void>;
}
```

**Where Helium attaches** — dsh's Cordis waterfall events, not new machinery:

| dsh seam                 | Helium attaches                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `agent/pre-step`         | budget check + input gates, shaped as FrontierAgent's Observer→`Intervention`: stop/replace/continue before spend |
| `tools/pre-execute`      | sandbox write-boundary guard (§4); `mutating` refusal                                                             |
| `tools/post-execute`     | large-output summarisation (§5) and `tool_output_bytes` capture                                                   |
| `approval/request`       | non-interactive policy for cron runs (fail closed)                                                                |
| `system-prompt/assemble` | the remaining-budget line injected per turn (§5)                                                                  |

**Capability tags** (closed set; extend by editing one array, never by naming a
vendor): `reason.deep`, `reason.fast`, `code.edit`, `code.review`, `tool.use`,
`long.context`, `cheap.bulk`, `structured.output`. A role writes
`requires: [code.edit, tool.use]`; the router intersects that with live
providers' capabilities and picks the cheapest satisfying model (§5). A new
vendor — or a new agent kind, e.g. a reviewer shelling out to `codex` — is one
directory and no core edit; CI's add/remove-a-package drill proves the seam
`[COMPUTED]`.

### 3.1 Provider transport: direct HTTP, never the vendor CLI

Measured 2026-09-02, one minimal call (`"Reply with exactly READY"`) per row:

| transport | latency | input tokens for our 5-token prompt |
| --- | --- | --- |
| `codex exec` (spawn the CLI) | 9.7s | **18,241** |
| `claude -p` (spawn the CLI) | 8.0s | not reported |
| **Anthropic via `provider-claude-subscription`** | **1.47s** | **32** |
| **ChatGPT-Codex via `provider-codex-subscription`** | **2.2s** | **26** |
| DeepSeek direct (control) | 0.75s | 15 |

The last three rows are measured through the shipped provider code, not a
scratch script. 570x less input for the same question.

A vendor CLI is an agent in its own right: it prepends its own system prompt,
tool schemas and environment description before it will carry ours. That is the
18,241 tokens — a floor paid on every call, including a routing decision or a
one-line tool result. Under doctrine 4 that is disqualifying, and it is
invisible in a per-token price list, which is why `overheadTokens` is part of
the interface and the router's cost function is
`overheadTokens + expectedTokens`, not `expectedTokens`.

So each subscription provider owns its HTTP call. The request shapes are copied
from `pi-ai` (§0) and verified against live endpoints:

**Anthropic** — plain Node `fetch` to `api.anthropic.com/v1/messages`:
`authorization: Bearer <sk-ant-oat…>`,
`anthropic-beta: claude-code-20250219,oauth-2025-04-20`,
`user-agent: claude-cli/<version>`, `x-app: cli`; and `system[0]` **must** be
the literal `"You are Claude Code, Anthropic's official CLI for Claude."`, with
our own system prompt appended as `system[1]`. That identity string is the
entitlement check — omit it and the subscription token is refused.

**ChatGPT-Codex** — `chatgpt.com/backend-api/codex/responses`:
`authorization: Bearer <access_token>`, `ChatGPT-Account-Id` (read from the
JWT claim `https://api.openai.com/auth.chatgpt_account_id`), `originator`,
`OpenAI-Beta: responses=experimental`, SSE response; body takes `store: false`
and `instructions` for the system prompt.

**Both must be spoken by `curl`, not by Node.** Each vendor sits behind bot
management that fingerprints the TLS ClientHello. From one machine, one token
and one set of headers: `curl` → 200 (on HTTP/1.1 and h2 alike), Node `fetch`
**and** `node:https` → 403. Reordering ciphers does not help — JA3 also covers
the extension and curve ordering, which Node's TLS API does not expose.

This corrects a claim made earlier the same day: Anthropic was recorded as
working in-process on `fetch`, but that measurement had in fact been taken with
`curl`. Node is blocked there too. The spawn is ~10ms and carries only our
prompt; what was worth eliminating is the CLI's preamble, not the subprocess.

`packages/provider-sdk/src/curl.ts` is the one place that speaks it, and it
carries two properties the retired process-boundary contract used to assert:
curl is given an environment containing **only** the secret-header variables —
no PATH, no ambient proxy — and credentials are passed as curl `--variable`
expansions so no token ever appears in argv, where any local `ps` would read
it.

**Post-mortem: `HELIUM_PROXY`, a config that was set and never read.** The mini
egresses from a Hong Kong IP that Anthropic and OpenAI refuse — 403 *before*
auth is evaluated (an unauthenticated control request gets the same 403; the
laptop correctly gets 401). Clash Verge listens on `127.0.0.1:7897` and macOS
system-proxy is enabled, but that setting reaches neither `curl` nor a
launchd-spawned Node process. `com.helium.dsh.plist` sets
`HELIUM_PROXY=http://127.0.0.1:7897`; **no code in the repo has ever read it**
(`git grep` on `master` and this branch: zero hits). With `https_proxy` set by
hand, every call above succeeds from the mini. Claude therefore never worked in
production, and the failure surfaced as `"Not logged in"` because `classify()`
maps 403 to `auth`.

**Resolved.** The value is now read from `~/.config/helium/helium.env`, the
0600 operator config the launchd wrapper already sources, via
`loadOperatorEnv()` (`packages/core/src/config.ts`) — one line of
`process.loadEnvFile`, which fills the environment without overwriting a
variable already set, so `HELIUM_PROXY=… helium run` still beats the file. The
plist variable is not the source of truth and can go. Proven from the mini
2026-09-02: unauthenticated `POST https://api.anthropic.com/v1/messages`
returns **401 through the proxy** and **403 direct** — rule 2's exact
signature, from the machine that has the fault.

Three rules follow, and they are acceptance criteria for the provider
milestone:

1. `proxy` is passed explicitly (`curl --proxy`), read from configuration
   (`HELIUM_PROXY` in `~/.config/helium/helium.env`, overridable per run).
   Never inherited: the helper hands curl an environment with no proxy variable
   in it, so an ambient one cannot quietly decide the route. This is exactly the
   difference that hid the fault — the laptop's shell exported `HTTPS_PROXY`
   and the mini's launchd jobs did not, so the same code appeared to work on one
   machine and fail on the other. Both machines share one HK egress; neither
   reaches a vendor unproxied.
2. A provider's `probe()` distinguishes *blocked* from *unauthenticated* by
   sending an unauthenticated control request: a 403 where 401 is expected is a
   network fault, and must not be reported as an auth fault.
3. `overheadTokens` is measured by a live test, not declared by hand.
   Landed as `contracts/tests/provider-overhead.live.contract.spec.ts`
   (`HELIUM_EVAL_LIVE=1`), which sends a one-character prompt and compares what
   the wire bills against the constant the plugin declares. Measured 2026-09-02:
   **Claude 21**, **Codex 16**. A subscription is registered UNPRICED, so the
   router ranks it last rather than reading 0/token as the cheapest thing on the
   menu; the overhead is added to the projected input of every *metered*
   candidate.

---

### 3.2 Model tiers, effort, and quota domains

A vendor's menu is not flat, and the difference is what the capability tags are
for. Three tiers, one meaning each, verified live 2026-09-02:

| tier | requires | Claude | Codex | effort |
| --- | --- | --- | --- | --- |
| chore | `cheap.bulk` | `haiku-4-5` | `gpt-5.3-codex-spark` | none / `low` |
| labour | `code.edit`, `code.review` | `sonnet-5` | `gpt-5.6-luna` | `medium` |
| reasoning | `reason.deep` | `opus-5` | `gpt-5.6-sol` | `high` |

**A tag may appear on only the tier it is the right answer for.** `select`
takes the FIRST covering model, so an overlapping tag silently hides everything
below it — the first cut of this table gave `sonnet` `reason.deep` and made
`opus` unreachable, and did the same to `terra` behind `sol`. `gpt-5.4-mini`
and `gpt-5.6-terra` are not in the menu: operator call, they add a tier nobody
asked for.

Effort is a within-model dial billed in thinking tokens, so it is derived from
the same request shape and never defaulted upward. A chore spends none at all.

**Quota domains.** Models sharing a `quotaDomain` run out TOGETHER, so a 429 on
one retires all of them for the rest of the run (`retireQuotaDomain`) and the
step re-routes once. Re-offering a sibling on the same spent allowance would
cost a call to learn what we already know; a vendor's reset hint is opaque, so
a retired pool stays retired for the run rather than being probed again.

`gpt-5.3-codex-spark` draws on its **own** allowance, which is the only reason
it is in the menu — it is still there when the main subscription session is
spent. Declared by the operator, not measured: proving it would mean
deliberately exhausting the main pool. Operator feedback on its quality is
negative ("cheap is its only advantage"), and the live check is consistent —
it spent 17 output tokens where `luna` spent 5 on the same one-word answer. It
is kept as the thing to burn while wiring a flow up, and is under review.

**Deferred, deliberately.** DeepSeek-as-backup-when-the-subscription-is-spent
needs the opposite of the router's current rank (unpriced sorts last, so a
metered DeepSeek would out-rank a paid-for subscription). `SelectionPolicy`
already expresses it as an ordered walk and needs no router change, but
DeepSeek's peak/off-peak pricing means the rank is time-dependent too. Both
wait for real workload rather than being guessed at now.

---

## 4. Sandbox and blast radius

Doctrine 5: the boundary is _where_, not _what was signed_. dsh's sandbox is
**same-world only** (`read-only` / `workspace-write` / `danger-full-access`;
containers, microVMs and remote executors are out of scope for that seam), so
its mode is the innermost setting and the worktree / dsh-home / scratch
isolation below is Helium's own layer above it.

| Kind | What it is | Writable | Used by |
| ---------- | ----------------- | ------------------------- |
| `worktree` | `git worktree add .worktrees/<run-id>` in the target repo | the worktree only | livewire fix, helium-self |
| `dsh-home` | throwaway `$DSH_HOME` under `~/.helium/runs/<run-id>/dsh` | that dir only | any agent run (always) |
| `scratch` | `~/.helium/runs/<run-id>/scratch` | that dir only | report builders |
| `none` | no filesystem write capability; mutating tools dropped | nothing | option-wizard |

**Path convention inside a `worktree` sandbox** (FrontierAgent's three tiers):
`inputs/` read-only, `workspace/` read-write (the edit target), `outputs/` the
only persistent deliverable path — a run's artifacts are whatever landed in
`outputs/`, and nothing else survives `destroy()`. Fail-closed, no unisolated
host fallback. Inside a sandbox an agent may do anything; cleanup is `rm -rf`
plus `git worktree remove`.

**Two hard rules, enforced outside any sandbox:** (1) never write the
production data lake `~/market-warehouse/` — livewire's own cron owns detection
and repair `[INFERRED — PR #92 unreadable from this repo; the invariant comes
from the task brief and matches livewire's CLAUDE.md repo/data split]`; (2)
never place an order — no tool with order-placement semantics is ever
registered, so option-wizard's output is a _proposal_ in an email.

Both live in **one file**, `packages/core/src/guard.ts` — the v2 descendant of
`mcp/selection.ts`, attached at `tools/pre-execute`, **failing closed**. dsh's
scope restriction is documented as "live visibility composition, not an
authority boundary", so it cannot replace this file. A write whose realpath is
not under `SandboxHandle.writeRoots` is refused, and the deny-list
(`~/market-warehouse/`, any broker endpoint) is checked _after_ the allow-list
so a bug there cannot open it. Contract test #3 (§8) is this.

**Open: may an agent push to master?** Not decided here. PR + human merge is
safest but the human is the rate limiter, killing the "minutes not days" loop;
merge-after-CI-green keeps the loop fast with CI as the gate, but a
green-but-wrong change lands and helium-self can then edit that gate; direct
push has no gate at all, and a bad push breaks the harness that would fix it.

## 5. Token and context audit

Doctrine 4. The audit table is a **projection folded from the dsh session log**
(per-step `assistant/chunk {type:'usage'}` plus `turn/*` boundaries), never from
`ctx.tokenMeter` — a 4-chars/token pressure heuristic, not billing data. The log
is truth; the table is a derived, rebuildable index over it, using
OpenAI-Agents-SDK span field names.

**Storage: one SQLite file** (`~/.helium/audit.db`): the question is an
aggregation with `WHERE run_id`, and SQLite answers it with zero infrastructure,
indexes, and readers concurrent with a live run. (dsh's
`dsh-session-query-sqlite` is FTS5 text search, not accounting.)

```sql
CREATE TABLE span (
  run_id TEXT NOT NULL,          -- dsh SessionId
  span_id TEXT NOT NULL, parent_span_id TEXT,
  tenant TEXT NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  step_no INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, context_size INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL, cost_usd REAL NOT NULL,
  tool_name TEXT, tool_output_bytes INTEGER, summarised INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL, PRIMARY KEY (run_id, span_id));
CREATE INDEX span_tenant_ts ON span(tenant, ts);
```

**Budget mechanics.**

| Mechanism    | Rule                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Declaration  | `budget: { usd: 2.00, tokens: 400000 }` per run in `tenant.yaml`.                                                                                                                                                                                            |
| Visibility   | At `system-prompt/assemble`, inject remaining USD, tokens, steps used. An agent that knows it is at 10% behaves differently.                                                                                                                                 |
| Model choice | Cheapest model whose `capabilities ⊇ role.requires`; over projected budget it downgrades one tier with a recorded reason; if none fits the run fails `budget_exhausted` (never silently truncates).                                                          |
| Guardrail    | Input gates run at `agent/pre-step`, before the LLM call — a refused step costs a gate span, not a model call (OpenAI SDK pattern).                                                                                                                          |
| Tool output  | Results over `summariseOverBytes` (8 KB default) are summarised by the cheapest `cheap.bulk` model before entering the caller's context; the full output goes to the sandbox and its path is handed over. Row records `tool_output_bytes`, `summarised = 1`. |
| Checkpoint   | A row every step, not per task (LangGraph): runs stay resumable and reviewable mid-flight.                                                                                                                                                                   |

**The one query:**

```sql
SELECT role, provider, model, tool_name,
       COUNT(*) spans, SUM(input_tokens) tin, SUM(output_tokens) tout,
       SUM(cache_read_tokens) cache, SUM(cost_usd) usd, SUM(latency_ms)/1000.0 sec
FROM span WHERE run_id = ?
GROUP BY role, provider, model, tool_name
ORDER BY usd DESC;
```

## 6. The recursive self-improvement loop

Doctrine 1. `plugins/helium-self/` is a tenant like any other; that it targets
Helium's repo is a property of its tools, not of core.

|                    |                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**        | cron nightly, plus on-demand `helium run helium-self`.                                                                                       |
| **Sandbox**        | `worktree` on the helium repo + `dsh-home`.                                                                                                  |
| **Input evidence** | `span` rows from the last N days (cost/latency outliers, most-summarised tools), failed runs' last span, wall-time rows (§9), test failures. |
| **Output**         | a branch in the worktree + a PR, or a "nothing worth changing" report.                                                                       |

| Role        | `requires`                | Does                                                                                              |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `auditor`   | `reason.deep`, `tool.use` | Queries `span` + failed runs, ranks the top 3 costs/defects, writes findings.                     |
| `proposer`  | `code.edit`, `tool.use`   | Picks one finding, edits code in the worktree.                                                    |
| `verifier`  | `tool.use`, `reason.fast` | `pnpm typecheck && test && test:contracts` in the worktree; one retry via `proposer`, then abort. |
| `deliverer` | `structured.output`       | PR via the `github-pr` channel: finding, diff summary, before/after audit numbers.                |

**Degradation guards.** `verifier` green or nothing ships; `CLAUDE.md` and
`guard.ts` are on a read-only path list the edit tool refuses, so helium-self
cannot widen its blast radius or rewrite its constitution; a human merges until
§4 is decided; the three kept contract tests run in `verifier`.

## 7. The two first tenants

### 7.1 option-wizard — read-only, email out

**Superseded by `docs/plans/2026-09-02-option-wizard-tenant-spec.md`**, which
is in the repo and is the source of truth for this tenant. That file replaces
the v1 original (`2026-09-01-option-wizard-team-tenant-design.md`, never
committed and absent from git history), names the seven steps, tags every line
`[RECOVERED]`/`[VERIFIED]`/`[INFERRED]`, and lists in its §8/§9 what could not
be recovered — the numeric thresholds above all. The mapping below is kept
because it records the v1→v2 noun translation; where it and the spec disagree,
the spec wins.

| v1 spec concept                                                       | v2 noun                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `regime-analyst`, `universe-screener`, candidate/risk roles           | dsh subagent definitions in `team.yaml`, each with `requires:`                                          |
| `ow_ib_preflight` (computes all five gates from proposal-only args)   | one `defineTool` tool + one **Gate** calling it, short-circuiting before spend                          |
| `gates/<contentHash>.json` records, `validate()` recomputing the hash | **Dropped.** The hash made a ledger entry tamper-evident; with no ledger the gate result is a span row. |
| accepted-claim ledger, `{acceptedClaimKeys}` membership               | **Dropped** (§1). The email _is_ the artifact; the session log is the record.                           |
| `promotionMode: delivered` + `HELIUM_TENANT_DELIVERY=1` brake         | one `delivery.enabled` + operator env var.                                                              |

Sandbox `none`; every tool is read-only (Unusual Whales, TradingView via
opencli, argon `GET /api/watchlist`, xenon Query API). Output: one daily email of
preflighted candidates. No order tool exists, so §4 rule 2 is structural.

### 7.2 livewire build/heal — worktree, PR out

Tools are livewire's _own_ entrypoints — `livewire_quality.py` (`health`,
`coverage`, `report`, `weekly`, `watchdog`), `livewire_ingest.py`,
`livewire_store.py`, `pytest` — each a `defineTool` wrapper running `uv run`
inside a livewire worktree under `~/projects/livewire/.worktrees/<run-id>/`.

| Role         | `requires`                 | Does                                                                             |
| ------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `gap-finder` | `tool.use`, `long.context` | `coverage`/`health` **read-only** + `logs/quality_audit.jsonl`; ranked gap list. |
| `fixer`      | `code.edit`, `tool.use`    | Edits livewire code/presets in the worktree to close a gap.                      |
| `verifier`   | `tool.use`                 | `uv run pytest` in the worktree.                                                 |
| `reporter`   | `structured.output`        | A PR (fix) or an email/file report (gaps only).                                  |

**Sample run.** `gap-finder` reports `bronze/asset_class=futures` missing 3
sessions for `NG_202606`; `fixer` patches `presets/futures-energy.json`;
`verifier` runs pytest green; `reporter` opens a livewire PR. The lake is never
written — repair is livewire cron's job once the PR lands (PR #92).

## 8. Salvage / delete plan

Rule from §0: **a file duplicating a dsh capability moves to delete**, even if
v1's version works.

| Path (lines)                                | Verdict             | Reason                                                                                       |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core/src/mcp/selection.ts` (112)  | **keep verbatim**   | Fail-closed allow-list → `guard.ts`; dsh's scope restriction is _not_ an authority boundary. |
| `packages/core/src/capabilities.ts` (166)   | keep-trim           | Capability tags stay (dsh routes by model name); drop `isolationClass`/lease fields.         |
| `packages/core/src/router.ts` (200)         | keep-trim           | Add cheapest-capable-model rule; drop policy versioning.                                     |
| `plugins/helium/src/dsh-team-host.ts` (493) | keep-trim           | → `plugins/provider-dsh/`, the only file naming `@deepseek-ai/*`.                            |
| `plugins/helium/src/tenants.ts` (334)       | keep-trim           | Glob discovery + skip-with-reason stays; drop `promotionMode` triple state.                  |
| `plugins/helium/src/delivery.ts` (395)      | keep-trim           | SMTP + rate cap → `delivery-email/`; drop JSONL state machine.                               |
| `plugins/helium/src/toolkit.ts` (83)        | **delete**          | Duplicates dsh: call `defineTool` directly.                                                  |
| `plugins/helium/src/cron.ts` (71)           | **delete**          | Duplicates `dsh-schedule`/`dsh-jobs` `[INFERRED — not yet exercised]`.                       |
| `packages/core/src/event-store.ts` (260)    | **delete**          | Hash-chained log for a ledger v2 lacks; the dsh session log _is_ that log.                   |
| `packages/core/src/runs.ts` (145)           | **delete**          | Duplicates dsh `SessionId` + turn events; `tier: triage/senior` was a domain leak.           |
| `launchd/*.plist.template` (5 files)        | **delete**          | All five went with v1 (the survivor was a KeepAlive dsh web daemon with no cron path to `helium run`). M2 writes one fresh `com.helium.plist` with `StartCalendarInterval`. |
| `plugins/ops-agent` (17,440)                | **delete**          | The SOP lane is a non-goal.                                                                  |
| `packages/core/src/operations/` (3,532)     | **delete**          | Leases, authority, recovery budget — authorizes an empty set.                                |
| `ops/` (563)                                | **delete**          | Declarations for the deleted lane; useful scripts return as tenant tools.                    |
| `teams/` (71)                               | **delete**          | Teams live inside their tenant directory.                                                    |
| `docs/evidence/` (1,768)                    | **delete**          | Claims register is a non-goal.                                                               |
| `contracts/tests/*` (4,972 w/ fixtures)     | **delete 19 of 22** | Keep exactly three (below).                                                                  |
| `scripts/release/*` (1,490)                 | **delete**          | 6 tags in 2 days all fixing `deploy.sh`; 3 lines of ssh replace them (§9).                   |
| `packages/fake-{flat-rate,metered}` (443)   | keep-trim → 1       | One fake provider proves the add/remove seam.                                                |
| `plugins/fake-tenant` (150)                 | **keep verbatim**   | The seam proof; domain- and network-free.                                                    |
| `plugins/provider-{claude,codex}-subscription` (2,512) | keep-trim | Both work today (8 files / 40 unit tests green, 2026-09-02). No-regression asset: §12. `provider-deepseek-dsh` was deleted as a duplicate of `provider-dsh`. |
| `packages/provider-sdk` (542)               | keep-trim           | The executor/receipt seam the three providers implement; trim only what names v1 nouns.      |
| `plugins/livewire-shepherd` (7,772)         | **delete**          | Never ran; §7.2 replaces it with ~300 lines of wrappers.                                     |

**`dsh-design.md` §6.2 is REJECTED**: it tells core to keep
"verification/claims + evidence" alongside the other three; doctrine 5/6 delete
that machinery, so v2 keeps the three and drops claims/evidence entirely.

**Contract tests kept — four (the fourth is the provider regression guard, §12):** `provider-executor-conformance` plus **three:** `core-neutrality` (nothing under
`packages/core/src` names a provider or a domain — doctrine 2's only mechanical
enforcement); `tool-restriction` (the allow-list drops a tool outside it even
with mutations enabled — fail-closed, and it has caught real defects); and
**new** `sandbox-write-boundary` (no write outside `writeRoots`, and
`~/market-warehouse/` refused under every kind including `none` — doctrine 5's
only mechanical enforcement).

No fourth. `senior-isolation` folds into #2; `topology-boundary` and
`claims-register` guard a ledger v2 does not have.

## 9. Deploy and iteration loop

Doctrine 6.

| Step     | v2                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy   | `ssh macmini 'cd ~/helium && git pull && pnpm install --frozen-lockfile && pnpm build && launchctl kickstart -k gui/$UID/com.helium'`                                                                                                    |
| Rollback | `git checkout <previous tag>`, same line.                                                                                                                                                                                                |
| launchd  | **one** plist, `com.helium.plist`.                                                                                                                                                                                                       |
| CI       | `pnpm typecheck && pnpm test && pnpm vitest run --project contracts` — **once**. No 20× repeat: the races it guarded belonged to the deleted lease machinery. No macOS job until a launchd-dependent test has caught a defect; none has. |

**Wall time per change is measured, as an audit row.** The `helium-self`
deliverer writes a `span` with `role='ci'`, `tool_name='deploy'` and
`latency_ms` = commit→green→kickstart, so "is the process longer than the
change?" is the §5 query with `WHERE role IN ('ci','verifier')`. When ceremony
time exceeds edit time for a month, the next finding is the process itself.

## 10. Build order

| M      | Deliverable (each ends runnable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Size    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **M0** | Delete everything §8 marks delete; one plist; CI down to unit + 4 contracts. v1 is not kept running — it produced no useful output and is not a fallback. Green: `pnpm build`, the 4 contracts, and the §12 provider baseline (25 tests) all pass on the trimmed tree.                                                                                                                                                                                                                                                                                                                       | < 1 day |
| **M1** | ~~First, confirm the dsh version actually installed on the mini~~ — **resolved 2026-09-02: `@deepseek-ai/dsh` `0.1.2-alpha.3` IS installed and resolvable** (`plugins/provider-dsh/node_modules/@deepseek-ai/`), so the claim that those tags "were never published" was wrong; the `dsh-team-host.ts` comments describe the build we actually have. Then core nouns + `provider-dsh` + `fake-tenant` tool + the `span` table folded from the session log + `helium run <tenant>`. Green: `helium run fake-tenant` prints a result and the §5 query returns rows. | < 1 day |
| **M1.5** ✅ | **Provider transport + the routable provider seam (§3.1) — landed 2026-09-02.** Both subscription providers speak HTTP through one `curl` helper; `HELIUM_PROXY` is read from `~/.config/helium/helium.env`; each ships a `provider.ts` the runner discovers, with a MEASURED `overheadTokens` and a `probe()` that tells *blocked* (403 unauthenticated) from *unauthenticated* (401). A provider that can route but not execute is skipped by name rather than left to win and fail. Green (all verified 2026-09-02): `helium run` reaches a real model and writes real token rows; `HELIUM_EVAL_LIVE=1` re-measures the declared overhead against the wire; §12 baseline 40 tests. | < 1 day |
| **M2** ✅ | **option-wizard end-to-end — landed 2026-09-02, PRs #62–#65.** Roles declaring `requires` and never a model, read-only tools, the `ib-preflight` gate, `delivery-email`, and the `HELIUM_TENANT_DELIVERY` operator brake. Deployed to the mini as its own lane — separate checkout `~/projects/helium-v2`, separate `HELIUM_STATE_ROOT=~/.helium/state-v2`, separate launchd label — with the v1 lane untouched. Green (all verified 2026-09-02): `run-ad9c67bc` and `run-84a83ad2` both `completed` on the mini with **`delivery email: sent`**; `com.helium.option-wizard` fires 18:00 HKT daily; 216 unit tests; audit answers "where did the tokens go" in one query ($0.059545 over 16,405 tokens). The three failure shapes M2 actually had to solve were all SILENT, and none of them were in this row: a missing credential deleted a tool and the run still said `completed`, a desktop GUI app sat in the price AND universe paths, and a watchlist's section headers arrived as tradeable tickers. See §10.1.                                                                                                                                                                                                                                                                                                                                                                                                                      | ~3 days |
| **M3** | Sandbox kinds + the inputs/workspace/outputs convention + `guard.ts` + contract #3; livewire read-only **gap report**.                                                                                                                                                                                                                                                                                                                                                                                                                            | ~2 days |
| **M4** | livewire fix-in-worktree + `delivery-github-pr`. Green: one merged livewire PR authored by a run.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ~2 days |
| **M5** | `helium-self`: auditor + proposer + verifier + PR. Green: one merged helium PR authored by helium.                                                                                                                                                                                                                                                                                                                                                                                                                                                | ~3 days |

M0 first, deliberately (doctrine 5/6): deleting v1 before M1 means every later
milestone is written against an empty core, not negotiated with dead code.

M1's dsh-version reconciliation was **dropped** on the day (operator call): the
mini gets rebuilt from scratch later, so pinning a version against the current
install was work with no consumer. M0 and M1 landed 2026-09-02 in PR #60
(57,792 → 8,455 TS lines).

### 10.1 What M2 actually cost, and why none of it was in the row

M2 was budgeted at ~3 days for "roles, tools, gate, email". The roles, tools,
gate and email were the easy part. Every expensive hour went to a failure the
row did not name, and all three have the same shape: **the run reports
`completed` and the output is plausible.** A loud failure is cheap — someone
sees it. These are not seen at all.

| Shape | What the reader sees | Fix |
| ----- | -------------------- | --- |
| **Missing credential** | Tools are BUILT regardless of whether their key is present and throw only when CALLED. A machine without `OW_UW_API_KEY` produces a run that says `completed` with an empty proposal list — indistinguishable from a considered "no trades today". | `tenantToolGaps` reports every tool whose `requiresEnv` is unset, into the report body and the terminal (PR #62). It caught a real gap on its first run — and cried wolf on two working tools on its third, which PR #63 fixed. A gap report is honest only while every line of it still holds. |
| **A GUI app in the data path** | The spot came from TradingView, driven over CDP by `opencli`; so did the universe. Both are desktop facts. Where the app is closed there is no spot, so `ow_uw_chain` correctly refuses to trim strikes around nothing, so the designer correctly proposes nothing — **every day, reporting `completed`.** | Both paths got a second source over a credential the tenant already holds: `/api/stock/{t}/stock-state` for the spot, the operator's `OW_UNIVERSE` for the universe (PRs #62, #64). TradingView stays first where it is live. The fallback names itself in `source`, because a frozen list and today's flags are not the same thing. |
| **A plausible string in a tradeable slot** | Real watchlists hold section headers, futures, forex, crypto and index pseudo-tickers. Taking the bare ticker off every entry put `###BOND` and `ES1!` into the universe handed to the designer. | Filter on the EXCHANGE, not the ticker's shape — no regex tells `SPY` from `SPX`, the venue always does (PR #65). Same failure as the QQQ 420/410 spread on a 707 underlying: a plausible-looking value where a real one belongs. |

Two rules earned the hard way, both about **evidence, not code**:

1. **A machine fact derived from a shell whose PATH you did not print is not a
   fact.** `ssh macmini command -v opencli` returned nothing and became two code
   comments asserting the mini had no `opencli`. It has had it all along, at
   `/usr/local/bin/opencli` — which a non-login `ssh` PATH omits.
2. **`triggers:` in `tenant.yaml` is declarative only.** Nothing in `packages/cli`
   or `packages/core` reads it. The schedule is real only once launchd has it,
   and `plutil -lint` is not sufficient to validate a plist — `plistlib.load`
   catches files `plutil` accepts and launchd rejects.

The `ib-preflight` gate checks a STRUCTURE, not a level. "This strike exists in
today's chain" is still verified out-of-band by the operator, not by the gate —
the single largest known hole left in this tenant.

## 11. Open questions

1. **Push to master** (§4) — three options, none chosen. Decide before M5.
2. ~~**Is dsh the only in-process runtime?**~~ **Answered 2026-09-02 (§3.1).**
   There is no CLI provider: `claude` and `codex` are spoken as HTTP. Anthropic
   runs in-process on `fetch`; ChatGPT-Codex shells out to `curl` only because
   Cloudflare fingerprints Node's TLS. Usage reporting is therefore the API's
   own `usage` object for both, not scraped CLI output.
3. **Audit DB location** — release root (wiped by rollback) vs. `~/.helium`
   (survives, outside the deploy unit). `[INFERRED]` Lean `~/.helium/`; loss is
   recoverable either way since §5 refolds from the session logs.
4. **dsh version divergence and pinning.** npm and GitHub disagree (`latest` =
   `0.1.1-rc.2`; `dsh-v0.1.2-alpha.1/.2` tagged, never published); the README
   promises breaking changes in capitals and issues are disabled, so regressions
   surface only in Discussions/Discord. Stay on the npm pin plus the canary,
   vendor a GitHub tag, or track `latest` — whichever, the seam stays one
   directory wide so an upgrade is one package's problem.
5. **`dsh-agent-teams` as the team scheduler, or our own DAG over dsh
   subagents?** It has the captain/sub-agent DAG, atomic task claiming,
   stale-attempt revocation and cold-restart recovery — but is session-scoped
   rather than trigger-driven and pins itself to host builds we do not run
   (v0.1.15 ↔ host `0.1.2-alpha.2`), which is §11.4 again. ~~Decide at M2.~~
   **Closed 2026-09-02 by M2 shipping without it.** `team.yaml`'s `tasks` with
   `dependsOn` is the DAG, and it is about forty lines of reducer. The claiming,
   revocation and cold-restart recovery `dsh-agent-teams` offers are answers to
   a question a once-daily cron does not ask — and taking it would have pinned
   us to a host build we do not run, to get them. Revisit only when a tenant
   needs concurrent workers on one task, which none does.
6. ~~**pi-ai as model backend from M1?**~~ **Closed 2026-09-02.** Neither
   `pi-ai` nor `dsh-llm-pi-ai` is taken as a dependency. We own the two
   subscription transports outright (§3.1), borrowing pi's request shapes and
   not its release cadence. The OAuth breadth that motivated the question is
   the part we now implement ourselves.

---

## 12. No-regression asset: the two subscription providers

The one thing v1 produced that works is the provider edge. It is now **two**
directories, not three: `provider-deepseek-dsh` was deleted 2026-09-02 as a
duplicate — `plugins/provider-dsh` is the v2 face on the same vendor, and
keeping a second one meant maintaining two answers to "how do we reach
DeepSeek".

**What "working" means, precisely.** Both sets of credentials are valid, and
neither machine reaches a vendor unproxied — the laptop only appeared to,
because its shell exported `HTTPS_PROXY`:

| provider | laptop | mini (prod) | routed by `helium run` |
| --- | --- | --- | --- |
| `claude-subscription` | live-verified | via `HELIUM_PROXY` (401 vs 403 control) | **yes** |
| `codex-subscription` | live-verified | via `HELIUM_PROXY` (401 vs 403 control) | **yes** |
| `dsh` (DeepSeek) | key-gated | key-gated | no — routes but cannot execute yet |

Baseline, 2026-09-02, after the transport rewrite and the `Provider` seam:

```
pnpm vitest run --project unit plugins/provider-claude-subscription \
  plugins/provider-codex-subscription
# 8 files, 40 tests, ~1s   (was 9 files / 25 tests across three directories)
```

Rules for every milestone:

1. These two directories and `packages/provider-sdk` are **not** in the delete
   set, and the baseline command stays green at 40 tests or better.
2. No fourth provider lands before M5, and no provider package is taken as a
   dependency (§0, §11.6). Provider breadth is not a doctrine goal.
3. If a milestone must change `provider-sdk`, run the baseline before and after
   in the same commit and put both counts in the commit message.

## Doctrine trace

| Doctrine point                   | Satisfied by                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 — self-improvement is the soul | §6, §10 M5, §9 (wall-time as an audit row), §0 (no precedent — ours to write)                   |
| 2 — core knows no domain         | §2 (dsh-aligned nouns, four originals), §3 (capability tags), §8 (contract #1), §7              |
| 3 — pluggable multi-agent        | §3 (five kinds after cutting what dsh exposes, glob discovery, hook seams), §0                  |
| 4 — token sense built in         | §5 (session-log projection, OpenAI-SDK span names, budget, checkpointing, the query)            |
| 5 — blast radius by location     | §4 (kinds above dsh's same-world modes, FrontierAgent path tiers, one fail-closed file), §1, §8 |
| 6 — ceremony earns its keep      | §0 (borrow, don't build), §8 (22 → 3 contracts; delete what dsh does), §9 (CI once, one plist)  |

`[RULES I BROKE]`: none. Gaps flagged, not papered over: the option-wizard spec
is absent (§7.1), livewire PR #92 unreadable (§4), dsh's hook packages inferred
from an absence proof over the installed set (§3), and the mini's dsh version
unconfirmed from here (§10 M1, §11.4).
