# Claude Code Handover: Helium Multi-Agent Phase 0

> **Status: RESYNCED 2026-08-28 after the adjudicated program review.**
> This handover matches the **Revision 2** plan set
> (`Revision 2 — 2026-08-28`, master plan). The Phase 0 handoff was formally
> **paused** by
> `docs/reviews/2026-08-28-plan-review-adjudication.md` until the docs-only
> revision landed and this handover was resynced. It is now resynced; execution
> may resume once the precondition below is satisfied.
>
> **Precondition — rebase before executing.** The revised plan docs land on
> `master` via a **docs-only PR**. This branch was cut before that PR. Before
> doing any Phase 0 work, rebase this branch on (or merge it with) `master`
> once that PR merges, then verify:
>
> ```bash
> grep -n "Revision 2 — 2026-08-28" docs/plans/2026-08-25-helium-multi-agent-master-plan.md
> ```
>
> If `docs/plans/2026-08-25-helium-multi-agent-master-plan.md` **on this branch**
> does not contain the `Revision 2 — 2026-08-28` changelog, **STOP**. Do not
> implement from the older plan text. Rebase first, then re-read the plans, then
> execute.

> We are continuing from this handoff. Read this document first, inspect the
> current repository state, verify what still applies, and continue from the
> next steps without assuming the old chat context is available.

## Mission

Execute **Phase 0 only** of Helium's approved multi-agent program: certify the
existing v1 senior execution and delivery boundary so it is safe to become one
provider behind the future model-blind harness. Preserve all current v1
behavior, complete the five Phase 0 tasks test-first, produce reviewable
evidence, and open a green pull request. Stop at the Phase 0 review gate; do not
start Phase 1 in this worktree.

Revision 2 sharpened Phase 0's product in three ways that change the work:

1. Phase 0 now ships a **reusable execution-boundary conformance harness**, not
   a one-off isolation test. One suite, parameterized over the boundary under
   test; the senior lane is its first subject and P1's `Executor` inherits the
   contract (master plan, "Phase 0 → Work"; adjudication D2).
2. `quota-exhausted` with an opaque `retryAfter` enters the failure vocabulary
   **at P0**, emitted from the existing `classify()` path (adjudication ARCH-3).
3. Phase 0's exit artifact is a completed **frozen P0 evidence-manifest
   template**, inline in the master plan under "Frozen P0 evidence-manifest
   template" (adjudication ARCH-2).

This phase boundary is sequencing, not a reduction of the program goal. The
approved end state remains a provider-neutral, capability-routed, durable true
multi-agent system with Macro and Ops reference teams. Program status is
`not-ready` until this revision lands; the model-blind capability seam is
explicitly **not** part of any scope reduction (master plan, "Deferred scope and
the near-term subset").

## Exact workspace state

- Repository: `/Users/chenxi/projects/helium`
- Worktree: `/Users/chenxi/projects/helium/.worktrees/multi-agent-phase0`
- Branch: `feat/multi-agent-phase0`
- Original starting commit: `a1801ec70e863e34c1d49cd6cc2aa10b7fe1123f`
- Starting commit identity: merge of PR #10, canonical topology in README and
  design
- At the original handoff preparation, `master`, `origin/master`, and the new
  branch all pointed to that starting commit.
- **This is no longer the intended base.** The Revision 2 plan docs and the two
  review documents land on `master` in a separate docs-only PR; this branch must
  be rebased onto (or merged with) the post-docs-PR `master` before Phase 0
  implementation starts. After the rebase, the baseline commit recorded in the
  P0 evidence manifest is the new base, not `a1801ec`.
- The branch had no code changes before this handoff note was added.
- Dependencies were installed from the unchanged lockfile with pnpm 11.23.0.
- Local runtime used for the verified baseline: Node v26.7.0. The repository
  declares Node `^22.19.0 || >=24.0.0`.
- A read-only local compatibility probe found Claude Code 2.1.231 at
  `/opt/homebrew/bin/claude`; no model request was made.
- No upstream branch and no Phase 0 pull request existed at handoff time.
- No Mac mini or production action was performed while preparing this handoff.

Before editing, run:

```bash
cd /Users/chenxi/projects/helium/.worktrees/multi-agent-phase0
git status --short --branch
git log -3 --oneline --decorate
grep -n "Revision 2 — 2026-08-28" docs/plans/2026-08-25-helium-multi-agent-master-plan.md
```

If the branch has changes beyond this committed handoff note, inspect and
preserve them. Do not reset or overwrite work that appeared after this note. If
the `grep` finds nothing, stop and rebase as described in the status banner.

## Claude Code dispatch status

Dispatch was attempted twice at 2026-08-26 22:14 WITA. Neither attempt read or
modified the Phase 0 code:

1. The inherited `ANTHROPIC_API_KEY` took precedence over the Claude
   subscription and the API route rejected the request for low credit. That
   attempt was stopped; no fallback to paid API is authorized.
2. Relaunching with `ANTHROPIC_API_KEY` removed correctly selected the
   subscription path, which returned `You've hit your session limit · resets
   1:30am (Asia/Makassar)`.

That second failure is exactly the condition Task 1 Step 3b now makes
first-class: session-window exhaustion is `quota-exhausted` with a `retryAfter`
hint, not a generic `error`.

After the subscription window resets, start Claude Code from this worktree with
the API key removed from only the child process:

```bash
cd /Users/chenxi/projects/helium/.worktrees/multi-agent-phase0
env -u ANTHROPIC_API_KEY claude --effort max --permission-mode acceptEdits
```

Then send: `Read docs/codex-handoffs/2026-08-26-helium-multi-agent-phase0-claude.md in full and execute it exactly.`

Do not omit `env -u ANTHROPIC_API_KEY`: the current parent environment contains
that variable, and leaving it set silently changes the requested subscription
transport into the API transport.

## Source-of-truth order

Read these before implementation, in this order:

1. `AGENTS.md`, if present, and the repository/global Git workflow rules.
2. `docs/reviews/2026-08-28-plan-review-adjudication.md` — **required.** The
   owner's decision record. It is authoritative for Revision 2 and wins wherever
   it conflicts with the review below.
3. `docs/reviews/2026-08-28-multi-agent-program-plan-review.md` — **required.**
   The program review the adjudication rules on. Read it for the finding text
   (ARCH-1/2/3, IMPL-1/2/3), not for verdicts the adjudication overturned.
4. `docs/plans/2026-08-25-helium-multi-agent-master-plan.md`, especially
   "Revision 2 — 2026-08-28", "Frozen P0 evidence-manifest template", the
   Phase 0 objective, work list, and exit gate, and the deployment rule.
5. `docs/plans/2026-08-25-helium-multi-agent-design.md`, especially Section
   5.5's canonical topology and the model-blind boundary.
6. `docs/plans/2026-08-25-helium-multi-agent-implementation.md`, execution
   rules and Phase 0 Tasks 1-5 plus the Phase 0 gate. This is the task-by-task
   implementation plan.
7. `docs/reviews/2026-08-25-helium-v1-review.md`, which records the source and
   production-derived reasons Phase 0 exists.
8. This handoff, which fixes the worktree, scope, current baseline, and
   execution boundary. It does not override the approved design.

Items 2 and 3 arrive on this branch with the same docs-only PR as the revised
plans. If they are absent, the rebase has not happened — stop.

Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and
`superpowers:verification-before-completion`. Treat code snippets in the plan
as intended contracts, not as permission to ignore actual APIs. If a minor
source/API drift is found, make the smallest plan-conformant adaptation and
explain it in the PR. Stop and escalate only if the necessary adaptation would
change the safety boundary, phase objective, or external authority.

## Non-negotiable constraints

1. Work only in the Phase 0 worktree and branch. Never push directly to
   `master`.
2. Do not deploy, install, restart, repair, run recovery drills, or otherwise
   mutate the Mac mini during the AC#1 observation window (through
   2026-08-31). Local fixtures and local processes are allowed. Do not claim the
   production window is complete unless its evidence has actually been recorded.
3. Do not begin provider contracts, model catalogs, capability routing,
   subagent coordination, Macro shadow execution, or Ops implementation. Those
   begin behind later phase gates. **Carve-out:** adding `quota-exhausted` and
   `retryAfter` to the `classify()` failure vocabulary in
   `plugins/helium/src/claude.ts` **is** Phase 0 work (Task 1 Step 3b) and is
   not a provider catalog or a selector.
4. Preserve the canonical topology. Phase 0 must not introduce a
   sensor-to-provider, agent-to-delivery, or agent-to-authority shortcut.
5. Do not add new provider/model branching to `packages/core`. Existing v1
   provider-specific types remain a compatibility surface until Phase 1 moves
   them. The `quota-exhausted` classification lives in the plugin, not in core.
6. Never expose a generic shell tool or weaken tool isolation to make a test
   pass.
7. Never read, print, copy, commit, or expose subscription tokens, SMTP secrets,
   proxy credentials, environment files, host addresses, or production logs.
   Use fake CLIs, fake transports, temporary directories, and sanitized data.
8. Do not treat a command exit or several agreeing agents as proof. Phase 0
   assertions require deterministic tests and reproducible evidence. For a
   deterministic assertion the verifier is a **command plus its exact version
   plus the hash of its output** — never a model, never a second human who does
   not exist.
9. **"Exactly once" is forbidden vocabulary** program-wide (adjudication D4.2).
   Do not write it in code, comments, tests, the manifest, or the PR.
10. Keep each planned task in its own green commit. Run the task's focused
    failing test before production code, then the focused passing tests before
    committing.
11. Open a PR only after the complete Phase 0 gate is green. Do not merge the PR
    until the isolation proof and delivery crash matrix receive review.

## Verified baseline

These checks ran from this worktree before the handoff note was written, at the
pre-rebase base commit. Re-run them after the rebase to re-establish the
baseline the evidence manifest will cite:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS; 501 packages reused from the content-addressable store |
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 24 files, 161/161 tests |
| `pnpm test:contracts` | PASS; 5 passed, one live opt-in test skipped |
| `pnpm test:e2e-local` | PASS; 1/1 test |

The skipped live agent contract is intentionally opt-in and is not permission
to exercise a subscription or production path during Phase 0. The docs-only PR
changes no code, so these results should reproduce unchanged after the rebase.

## Current gaps confirmed in source

- `plugins/helium/src/claude.ts` uses `--allowedTools`, omits a restrictive
  empty `--tools` set, omits strict MCP and setting-source isolation, and kills
  only the direct child rather than a verified process group.
- `plugins/helium/src/claude.ts`'s `classify()` buckets subscription
  session-window exhaustion as a generic `error`, with no `quota-exhausted`
  class and no `retryAfter` passthrough. This is the highest-frequency real
  failure this system sees; it has already broken two live dispatches.
- `plugins/helium/src/index.ts` runs the senior process in `process.cwd()` and
  writes one static, all-tools MCP config at startup.
- `packages/core/src/mcp/selection.ts` silently drops unknown or mutation-
  forbidden tool names, and
  `packages/core/tests/mcp-selection.spec.ts` contains
  `it("silently drops a HELIUM_TOOLS name that matches no known tool", ...)`,
  which asserts `.not.toThrow()` and locks in exactly that behavior.
- `packages/core/src/tools/thesis.ts` declares `thesis_write` as
  `mutating: false` by explicit design. The genuinely mutating tools are
  `argon_rescan` and `argon_ai_analysis` in `packages/core/src/tools/argon.ts`,
  both registered `mutating: true`.
- All three shipped jobs currently declare `allowMutations: false`. Phase 0
  should reject `allowMutations: true` at job load until a real mutating
  execution boundary is certified; do not preserve a misleading no-op option.
- `plugins/helium/src/delivery.ts` sends SMTP before appending the first
  delivery row even though its comment says append first.
- `loadJobs()` can isolate a malformed YAML file, but the runtime omits that
  tenant from heartbeats, so global liveness can hide the missing tenant.

The read-only `claude --help` probe on Claude Code 2.1.231 confirms:

- `--tools <tools...>` defines the available built-in tool set and explicitly
  documents `--tools ""` as disabling all tools;
- `--allowedTools` / `--allowed-tools` is a separate allow-without-prompt
  surface and is not the replacement for `--tools`;
- `--strict-mcp-config` ignores MCP configurations other than the explicitly
  supplied `--mcp-config`;
- `--setting-sources <sources>` controls user/project/local setting sources;
  and
- `--bare` is not an automatic solution for this subscription path because its
  help states that OAuth and keychain authentication are never read.

Re-check the locally installed CLI version/help immediately before coding in
case it changes. This is a read-only compatibility check. If current semantics
contradict the plan, preserve the isolation objective, add a failing contract
for the observed behavior, and document the deviation; do not silently fall
back to approval-only flags.

## Execution sequence and stopping conditions

### 1. Task 1: restrict and isolate the senior CLI process

Follow Phase 0 Task 1 in the implementation plan
("Task 1: Restrict and isolate the senior CLI process").

**Frozen interface.** `runClaude()`'s option field keeps the name
`allowedTools`. Only the emitted CLI flag changes — from `--allowedTools` to
`--tools`. Do **not** rename the field to `tools`; the provider-effort-selection
plan resumes at exactly this seam and must extend this signature, not redefine
it. Any snippet anywhere that passes `tools:` to `runClaude()` is wrong and must
be corrected to `allowedTools:` (adjudication D3 / IMPL-3).

Required outcome:

- restrictive tools behavior is present even for an empty tool list, and an
  empty declared list stays empty rather than becoming the provider default;
- only the declared MCP config and no ambient setting sources are visible;
- the child receives a deliberately narrowed environment;
- **each attempt owns a unique workspace under `stateRoot/workspaces/<job>/`**,
  passed as the child's `cwd`, with `workspaces` added to `StatePaths`;
  `process.cwd()` is never used for senior execution;
- timeout terminates and drains the whole process tree — spawn a detached
  process group, TERM then KILL the group, and fall back to direct child
  termination only when no group exists;
- workspace/config cleanup occurs only after child quiescence; and
- focused tests and typecheck pass.

**Step 3b — `quota-exhausted` (new in Revision 2).** Extend the classification
vocabulary to
`"proxy" | "auth" | "timeout" | "quota-exhausted" | "error"` and add an optional
`retryAfter?: string` to `ClaudeResult`. Detect quota exhaustion **ahead of**
the `auth` and `proxy` branches (a `429`, a rate-limit or session-limit
envelope, or an explicit reset timestamp) and carry the provider's reset hint
through as an **opaque** string. Do not parse it into a duration in this task,
and do not invent one when the provider gives none.

`quota-exhausted` is **dynamic provider-availability state — never a capability
score, and distinct from `budget-exhausted`.** The target's capabilities are
unchanged; it is simply unavailable until `retryAfter`. A flat-rate subscription
reports neither dollars nor tokens, so quota must never be folded into budget.
Downstream the class means "filter this target out until `retryAfter`, try the
configured fallback" — never "retry immediately", never "this target is worse
than it was".

Red test first: a fake CLI emitting a rate-limit envelope must produce
`classification: "quota-exhausted"` with `retryAfter` preserved verbatim, and
`plugins/helium/src/index.ts` must not report it as a plain `error`.

Do not share an attempt workspace or mutable MCP file between concurrent jobs.
Use unique attempt identity and paths. Preserve enough failure evidence for
audit without persisting secrets or unrestricted environment values.

Commit target: `fix: isolate senior execution capabilities`.

### 2. Task 2: build the reusable execution-boundary conformance harness

Follow Phase 0 Task 2 in the implementation plan
("Task 2: Build the reusable execution-boundary conformance harness").

**This task is reframed in Revision 2.** It delivers a _reusable_ harness, not a
one-off adversarial test for the senior lane. Create
`contracts/harness/execution-boundary.ts` exporting an
`ExecutionBoundarySubject` interface (`name`, `declaredIsolationClass` of
`"in-process" | "process" | "sandboxed"`, and an `invoke()` taking prompt,
`allowedTools`, optional `mcpConfigPath`, `expectedWorkspace`, and `env`) plus
`runExecutionBoundaryConformance(subject)`, which registers the shared
describe/it block. **The harness owns the assertions; each subject owns only its
`invoke`.**

**Explicitly NOT generic over `Executor`.** The formal `Executor` interface does
not exist until Phase 1 Task 10, so this contract must not be written over that
type — it is unavailable here. Write it over the minimal local subject shape
above. Phase 1 Task 10 adapts its `Executor` to this same subject shape and
**inherits** this contract; it does not fork a second suite (adjudication D2).

Alongside the harness, add the planned fixture files
(`contracts/fixtures/senior-isolation/{package.json,fake-claude.mjs,forbidden.txt}`)
and `contracts/tests/senior-isolation.contract.spec.ts`. The fake CLI inspects
argv, cwd, environment, and the supplied MCP file, and emits a JSON result only
when `strictMcp`, `toolsRestricted`, `settingsIsolated`, `ownedCwd`, and
`secretAbsent` all hold.

The proof must cover at least:

- one declared tool and zero declared tools (run the contract both ways);
- an empty tool list staying empty rather than becoming the provider default;
- strict MCP and setting isolation;
- owned working directory, with no read or write outside `expectedWorkspace`;
- forbidden ambient secret absence;
- undeclared MCP server, setting source, instruction file, path, and tool
  denial;
- descendant-process termination after timeout; and
- the subject's observed boundary being at least as strong as its
  `declaredIsolationClass` — **a declaration the harness cannot demonstrate is a
  failure, not a warning.**

The suite must fail for the original implementation and pass only through the
same adapter used by `buildSeniorLane()`. Export only the minimal adapter entry
the subject needs; do not create a second test-only argument builder.

Commit target: `test: add reusable execution-boundary conformance harness`
(changed from the previous `test: prove senior execution isolation`, to match
the plan's own commit string now that the deliverable is a reusable harness).

### 3. Task 3: make tool and mutation policy truthful

Follow Phase 0 Task 3 in the implementation plan
("Task 3: Validate tool selections and make mutation policy truthful").

**IMPL-2 — the "silently drops" test is REPLACED, not extended.** Delete
`it("silently drops a HELIUM_TOOLS name that matches no known tool", ...)` from
`packages/core/tests/mcp-selection.spec.ts` and write the fail-loud expectations
in its place. Leaving the old case in would make the suite assert both
behaviours at once and fail.

**IMPL-1 — use genuinely mutating tools in the red tests.** Not `thesis_write`,
which is `mutating: false` by explicit design with a locked-in test. Use
`argon_rescan` and `argon_ai_analysis`. Expected shapes:

- `selected({ HELIUM_TOOLS: "argon_api,typo_tool" })` throws
  `/unknown tools: typo_tool/`;
- `selected({ HELIUM_TOOLS: "argon_rescan", HELIUM_ALLOW_MUTATIONS: "0" })`
  throws `/requires mutation permission/`;
- same for `argon_ai_analysis`.

Keep the existing positive cases (`HELIUM_ALLOW_MUTATIONS: "1"` admits
`argon_rescan`) unchanged — only the silent-drop assertions are inverted.

Implement fail-loud catalog validation: build a name map from `buildTools()`
before filtering, throw on unknown names, and throw on mutating names without
permission. An unknown tool or a mutating tool without permission must not
disappear silently. A bad job must fail only that tenant and must remain visible
to the health path.

Replace the static all-tools MCP config with a per-attempt config derived from
the exact job tool list and `allowMutations` value; delete the static config.
Because no mutating provider boundary is certified in Phase 0, reject
`allowMutations: true` during job validation/loading. Do not claim mutation
support and do not set `HELIUM_ALLOW_MUTATIONS=1` in production paths.

Test concurrency and cleanup so one job cannot observe another job's MCP
configuration.

Commit target: `fix: validate execution tool contracts`.

### 4. Task 4: make delivery write-ahead and crash-reconcilable

Follow Phase 0 Task 4 in the implementation plan
("Task 4: Make delivery a write-ahead state machine").

Append a durable `delivery-intent` row with one stable `deliveryId` and
`state: "pending"` before any report/email side effect, then append a distinct
`delivery-outcome` row with the same ID and one of `sent`, `skipped`,
`rate-capped`, `failed`, or `uncertain`. Rate-limit counts must come from
successful outcome rows, not intents. Dead letters are a third row tied to the
same ID.

Exercise failure injection at these boundaries:

1. before intent append;
2. after intent append but before SMTP;
3. after SMTP returns success but before outcome append; and
4. after outcome append.

**State the property this buys and do not overstate it.** SMTP acceptance
followed by a crash before the outcome append is genuinely indeterminate. The
correct property set is: a durable write-ahead intent before any external side
effect; at-most-one active delivery lease per `deliveryId`; no blind retry of an
intent whose outcome is unknown; idempotent or effectively-once completion where
the transport supports a dedup key; and, where it does not, a durable
`uncertain` outcome that a human or a reconciliation pass resolves. **`uncertain`
is a real terminal row, not a missing one** — the crash-point tests must assert
it is written. The status word is `uncertain`, not `unknown`. Never describe any
of this as exactly-once (adjudication D4.2).

Add `appendAt()` or injectable clock support to `JsonlWriter` so the JSONL file
date and the row timestamp come from the same clock; remove the fake-timer
workaround from the delivery tests.

Commit target: `fix: write delivery intent before side effects`.

### 5. Task 5: add expected-tenant and per-tenant liveness

Follow Phase 0 Task 5 in the implementation plan
("Task 5: Add expected-tenant and per-tenant liveness").

Inventory every `*.yaml` file before parsing. Emit `tenant-health` rows and
preserve `loaded`, `invalid`, `disabled`, and runtime-heartbeat states so a
malformed or disabled tenant does not vanish — a malformed tenant stays in the
expected inventory with state `invalid`. Extend the dead-man path to evaluate
both global process freshness and every expected tenant independently while
preserving existing deliberate-drill and alert-dedup semantics.

Test at least healthy, stale, missing, malformed, disabled, and mixed-tenant
cases. One healthy tenant must never mask another stale or invalid tenant, and
health must never be inferred from another tenant's heartbeat.

Commit target: `feat: monitor liveness per tenant`.

### 6. Phase 0 integration and evidence gate

Run the complete gate from a clean branch:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
node --test scripts/deadman/check-tenant-heartbeats.test.mjs
bash scripts/deadman/check-heartbeat.test.sh
git diff --check
git status --short --branch
```

Also run the execution-boundary conformance suite and the delivery crash matrix
directly and report their exact counts. Confirm no descendant test process
remains.

**Exit evidence — the frozen P0 manifest.** Phase 0 exit requires an
`EvidenceManifest` conforming to the **frozen P0 evidence-manifest template**
recorded in the master plan under "Frozen P0 evidence-manifest template"
(`manifestVersion: p0-1`, `evidencePolicyVersion: p0-1`). The typed schema is a
Phase 1 Task 7 deliverable; the template is hand-written and hand-checked and
needs no P1 code. **Fill it in — do not redesign it, do not invent a competing
core schema, and do not defer P0's exit evidence to Phase 1.** P1's schema
inherits this template: a P0 manifest must validate against it without being
rewritten.

For **every deterministic assertion**, the verifier is a **command plus its
exact tool version plus the hash of its output**. Never a model. Never the
plan's author signing off as a second pretend human — Helium is a
single-operator project, so **the operator authors the manifest and the command
verifies it**; a manifest implying independent human review is a false evidence
record. Per assertion record: `assertion`, `acceptanceBound`,
`assertionClass: deterministic`, `evidencePolicyVersion`, `verification`
(`verifier: command`, `command`, `toolVersion`, `outputHash: sha256:…`,
`decision`), `artifacts` with hashes, `baseline` (the v1 behavior at the rebased
base commit), `reproduction`, `failures`, `status`, `limitation`, and
`nextGate`. A reviewer must be able to re-run the command and compare hashes
without re-reading the plan.

Every P0 exit assertion is deterministic — test-suite results, execution-boundary
conformance output, delivery crash-matrix replay, `quota-exhausted`
classification, per-tenant liveness exit codes — so no P0 assertion needs a model
verifier at all. Assertions that are not deterministically checkable are
recorded as `PARTIAL` with the missing proof named, never as `PROVEN` on human
assurance. `scope: offline`.

Minimum claims to record (master plan, P0 row of the evidence ladder):
adversarial isolation, execution-boundary conformance harness,
`quota-exhausted` classification, delivery-boundary crash replay, and v1
behavior comparison.

### 7. PR and handback

- Review the full diff against the five tasks and the Phase 0 exit gate.
- Confirm no production/provider/model feature work leaked in.
- Push `feat/multi-agent-phase0` and open one Phase 0 PR.
- Put the completed frozen P0 evidence manifest, exact verification results,
  known limitations, and rollback statement in the PR description.
- Request review specifically for process-tree isolation, per-attempt MCP/tool
  isolation, conformance-harness reusability, `quota-exhausted` classification,
  ambiguous delivery recovery, and tenant-liveness failure modes.
- Stop. Do not merge or begin Phase 1 until review and direction are received.

## Phase 0 definition of done

Phase 0 is not complete merely because the test suite is green. It is ready for
review only when all of the following are true:

- [ ] The branch is rebased on the `master` that carries Revision 2, and the
      plan docs read on this branch contain `Revision 2 — 2026-08-28`.
- [ ] All five planned tasks are implemented in order with focused red/green
      evidence.
- [ ] The real senior adapter, not only a fixture helper, is isolated.
- [ ] An empty declared tool list cannot fall back to provider defaults.
- [ ] No undeclared MCP server, setting source, environment secret, or workspace
      path is available to the execution attempt.
- [ ] Each attempt owns a unique workspace under the configured state root;
      `process.cwd()` is not used for senior execution.
- [ ] Timeout leaves no child or descendant process running.
- [ ] The conformance harness runs against the senior lane as a **named
      boundary** and can be pointed at a second boundary without rewriting its
      assertions, and it is not written generically over `Executor`.
- [ ] Session-window exhaustion classifies as `quota-exhausted` with an opaque
      `retryAfter`, never as a generic `error`, never as a capability change,
      and never folded into `budget-exhausted`.
- [ ] `runClaude()`'s `allowedTools` option field name is unchanged; only the
      emitted flag became `--tools`.
- [ ] A bad tool or malformed tenant is isolated and remains operator-visible,
      and the old "silently drops" test is deleted rather than extended.
- [ ] Delivery has intent before side effect and an explicit durable
      `uncertain` outcome row; nothing anywhere claims exactly-once.
- [ ] Existing v1 behavior, build, typecheck, unit, contract, and E2E suites
      remain green.
- [ ] The PR contains a completed frozen P0 evidence manifest
      (`manifestVersion: p0-1`) whose deterministic claims each name a command,
      its version, and its output hash, with honest
      `PLANNED` / `PARTIAL` / `PROVEN` / `FAILED` / `BLOCKED` statuses.
- [ ] No mini or production state was changed.
- [ ] A green PR is open and awaiting the required review.

## Explicit non-goals for this branch

- Provider catalog probing or adding DeepSeek, Claude, or Codex adapters. (The
  `quota-exhausted` classification in the existing plugin `classify()` path is
  in scope; a provider catalog or availability registry is not.)
- Model or effort selection. The provider-effort-selection plan is deferred
  program-wide until real usage data exists.
- Capability routing, the capability ontology, scoring, confidence intervals, or
  automatic learning — all deferred by adjudication D3.
- Defining the formal `Executor` interface or writing the conformance harness
  generically over it. That type arrives in Phase 1 Task 10 and inherits this
  contract.
- Building the typed `EvidenceManifest` schema in core. Phase 0 fills in the
  frozen template only.
- Durable team DAG, artifact store, spawning, or cross-reference implementation.
  The general durable mailbox is deferred outright.
- Macro team or Ops Agent implementation.
- Any deployment, release tag, watchdog change, SOP execution, or production
  drill on the mini.
- Refactoring unrelated v1 modules for style.
- Merging the Phase 0 PR without review.

## Handback format

When returning control, report:

1. branch, worktree, head commit, rebase base, PR URL/state, and clean/dirty
   status;
2. each Phase 0 task with `PROVEN`, `PARTIAL`, `FAILED`, or `BLOCKED` status;
3. files and contracts changed;
4. exact tests run and numerical results;
5. adversarial cases exercised and raw evidence locations, with the command,
   tool version, and output hash for each deterministic claim;
6. deviations from the implementation plan and why they preserve the goal;
7. anything not verified, especially production claims; and
8. the single next unopened gate.

Before claiming completion, re-check the live branch state, rerun the full gate,
and distinguish local test evidence from production evidence.

---

_The plan documents cited above are authoritative as of **Revision 2
(2026-08-28)**; if the plan set is revised again, this handover is stale and
must be regenerated before execution._
