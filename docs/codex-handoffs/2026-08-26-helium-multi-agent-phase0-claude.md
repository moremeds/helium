# Claude Code Handover: Helium Multi-Agent Phase 0

> **Status: REGENERATED 2026-08-28 for the Revision 3 plan set.**
> The previous version of this document matched **Revision 2** and declared
> itself stale if the plan set were revised again. It was: Revision 3 — the
> round-2 adjudication plus a pre-execution readiness pass — landed on `master`
> as PR #11, so that clause fired. This regeneration folds Revision 3 in.
> Nothing below is inherited unread from the Revision 2 text.
>
> **Hard gate — run this first, before reading further or touching any file:**
>
> ```bash
> cd /Users/chenxi/projects/helium/.worktrees/multi-agent-phase0
> grep -n "## Revision 3 — 2026-08-28" docs/plans/2026-08-25-helium-multi-agent-master-plan.md
> test -f docs/reviews/2026-08-28-adjudication-round-2.md && echo "round-2 record present"
> ```
>
> Expected: the `grep` prints `15:## Revision 3 — 2026-08-28`, and the `test`
> prints `round-2 record present`. If either fails, **STOP**. A tree that
> satisfies the old `Revision 2 — 2026-08-28` marker but not this one is the
> **older plan text** — the Revision 2 marker is still present at `:78` and
> cannot distinguish the two revisions, which is precisely why this gate now
> requires Revision 3. Do not implement from the older text. Rebase onto
> `master`, re-read the plans, then execute.

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

This phase boundary is sequencing, not a reduction of the program goal. The
approved end state remains a provider-neutral, capability-routed, durable true
multi-agent system with Macro and Ops reference teams. The model-blind
capability seam is explicitly **not** part of any scope reduction (master plan,
"Deferred scope and the near-term subset", `master-plan:405`).

## What Revisions 2 and 3 changed about Phase 0's work

Read this section as the delta. Everything in it is already folded into the
plans; the plans are what you implement.

**From Revision 2 — still in force, unchanged:**

1. Phase 0 ships a **reusable execution-boundary conformance harness**, not a
   one-off isolation test. One suite, parameterized over the boundary under
   test; the senior lane is its first subject and P1's `Executor` inherits the
   contract (`master-plan:479-484`; round-1 adjudication D2).
2. `quota-exhausted` with an opaque `retryAfter` enters the failure vocabulary
   **at P0**, emitted from the existing `classify()` path (`master-plan:485-490`;
   review finding ARCH-3).
3. Phase 0's exit artifact is a completed **frozen P0 evidence-manifest
   template**, frozen inline in the master plan at
   `master-plan:321` ("Frozen P0 evidence-manifest template"), `manifestVersion:
   p0-1` (review finding ARCH-2).

**New in Revision 3 — this is what an executor working from the old text will
get wrong:**

- **R5 / EX-1 does not relieve Task 4.** `master-plan:36-42` rescopes program
  rule 13 to WorkOrder-carrying execution paths and records the v1 legacy
  direct-delivery lane's real exposure as a named, versioned, expiring
  exemption, **EX-1** (`master-plan:232`). EX-1 covers the `legacy-direct`
  runtime mode and exempts **acceptance criterion 16 only** — evidence
  provenance. `master-plan:248-252` states the rest explicitly: "the write-ahead
  JSONL record before the SMTP side effect, per-tenant liveness, the tool
  allow-list, and the isolation boundary" **all still bind**, EX-1 "grants no
  relief from any safety, isolation, or durability rule", and it never extends
  to a mutating action. If you find EX-1 while reading and conclude delivery
  evidence is now optional, you have misread it: **Task 4 and Task 5 are
  untouched by EX-1.** EX-1's standing status is `PARTIAL`; nothing may report
  criterion 16 as `PROVEN` while it stands.
- **R6 — the neutrality word list.** `master-plan:43-47` collapses five
  disagreeing word lists into **one contract test with exported constants**,
  scanning for the bare token `claude`. `claude-max` was a permanently-green
  trap: after Task 6 moves `job.ts` out of core it matches nothing in
  `packages/core/src` forever, while the live leak (`claude -p` in the doc
  comment at `packages/core/src/mcp/server.ts:3`) sails past it. **Phase 0 does
  not create that test** — MA Task 6 does, in P1. Phase 0's obligation is
  narrower and absolute: **do not introduce a new provider-name leak into
  `packages/core`.** No file or line allow-list is permitted anywhere; an
  allow-list is how `mcp/server.ts:3` survived four reviewers.
- **R7 — P0's exit evidence is a real file.** `master-plan:48-54` replaces four
  unfalsifiable exit gates with commands and hashes. For Phase 0 the concrete
  consequence is at `master-plan:505-512`: the exit artifact is
  **`docs/evidence/p0-manifest.yaml`**, committed, created by MA Task 5. It is
  **no longer a PR-description paragraph** — "a PR description is not hashable,
  not diffable, and not reproducible". `docs/evidence/` does not exist in the
  repo today; Task 5 creates it, and P1 Task 7's `docs/evidence/claims.yaml`
  lands beside it.
- **R8 — the freeze boundary is a presence test with a date.**
  `master-plan:55-59` restates the AC#1 boundary as **presence**, not mutation,
  and pins the freeze end at **2026-08-31** — a date no plan document previously
  carried. The two observation windows are enumerated as verb lists in
  `docs/plans/2026-08-25-helium-ops-agent-design.md:885` (§13.4). See
  "Non-negotiable constraints" item 2 and the definition of done.
- **R1 and R4 are P1+ concerns and change no Phase 0 work.** R1
  (`master-plan:26-30`) extracts the generic append-only event store into P1 MA
  Task 7. R4 (`master-plan:31-35`) splits the topology guard, with its
  structural half landing in P1 as MA Task 10b. Neither adds, removes, or
  reshapes anything in Phase 0 Tasks 1-5. Do not pull either forward.

**And a pre-execution readiness pass**, recorded at
`docs/reviews/2026-08-28-adjudication-round-2.md:172` ("Execution-readiness
findings"), changed Phase 0's actual work in ways the Revision 2 handover got
wrong. Those are folded into the task sections below; the two `[HIGH]` items
(B-1, B-2) would have failed at execution time, not at review time.

## Exact workspace state

- Repository: `/Users/chenxi/projects/helium`
- Worktree: `/Users/chenxi/projects/helium/.worktrees/multi-agent-phase0`
- Branch: `feat/multi-agent-phase0`
- **Base commit: `3e6c028b4485ff646c51c4fb557029bdad0dc3d8`** — `master`, the
  merge of PR #11 (`docs/multi-agent-plan-revision`), which carries the
  Revision 3 plan set and the round-2 decision record. This branch is rebased
  onto it. This is the baseline commit the P0 evidence manifest cites.
- The branch carries no code changes — only the successive versions of this
  handoff note.
- No upstream branch and no Phase 0 pull request exist yet.
- Nothing on the Mac mini was read, written, started, probed, or deployed while
  preparing this handoff.

Before editing, run:

```bash
cd /Users/chenxi/projects/helium/.worktrees/multi-agent-phase0
git status --short --branch
git log -3 --oneline --decorate
grep -n "## Revision 3 — 2026-08-28" docs/plans/2026-08-25-helium-multi-agent-master-plan.md
```

If the branch has changes beyond this committed handoff note, inspect and
preserve them. Do not reset or overwrite work that appeared after this note. If
the `grep` finds nothing, stop — see the hard gate in the status banner.

## Claude Code dispatch status

Dispatch was attempted twice at 2026-08-26 22:14 WITA. Neither attempt read or
modified the Phase 0 code:

1. The inherited `ANTHROPIC_API_KEY` took precedence over the Claude
   subscription and the API route rejected the request for low credit. That
   attempt was stopped; no fallback to paid API is authorized.
2. Relaunching with `ANTHROPIC_API_KEY` removed correctly selected the
   subscription path, which returned `You've hit your session limit · resets
   1:30am (Asia/Makassar)`.

That second failure is exactly the condition Task 1 Step 3b makes first-class:
session-window exhaustion is `quota-exhausted` with a `retryAfter` hint, not a
generic `error`.

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

**Precedence rule, stated before the reading order because they are not the same
thing.** The plans are the applied text and win — they already have every
ruling folded in. Behind them, `master-plan:17-22` fixes the record order: the
**round-2** decision record is authoritative for Revision 3 and wins wherever it
conflicts with the program review; where it conflicts with the **round-1**
record, round 1 still stands **except where round 2 states a ruling and its
reason**. The program review supplies finding text only, never a verdict. So:
**plans > round 2 (where it rules) > round 1 > review.**

Read these before implementation, in this order:

1. `AGENTS.md`, if present, and the repository/global Git workflow rules. (No
   `AGENTS.md` exists at the base commit; check again before assuming.)
2. `docs/plans/2026-08-25-helium-multi-agent-master-plan.md` — the applied
   Revision 3 text. Read `:15` (Revision 3 changelog), `:232` (EX-1), `:321`
   (frozen P0 evidence-manifest template) with the recording rules at `:369`,
   and the Phase 0 objective, work list, and exit gate at `:460-517`, plus the
   deployment rule at `:519-522`.
3. `docs/plans/2026-08-25-helium-multi-agent-implementation.md` — execution
   rules and **Phase 0 Tasks 1-5 plus the Phase 0 gate** (`:35`, `:52`, `:294`,
   `:430`, `:659`, `:748`, `:844`). This is the task-by-task implementation plan
   and **its task numbering is the execution order of record** (readiness
   finding B-9).
4. `docs/plans/2026-08-25-helium-multi-agent-design.md`, especially §5.5's
   canonical topology and the model-blind boundary (`:224`).
5. `docs/plans/2026-08-25-helium-ops-agent-design.md` **§13.4** (`:885`) — the
   two observation windows, stated as verb lists. Window 1 (`:900`) is the one
   that binds Phase 0. This section governs wherever any other document's prose
   is looser.
6. `docs/reviews/2026-08-28-adjudication-round-2.md` — **required, and new since
   the previous handover.** The owner's Revision 3 decision record (R1-R8), plus
   its "Post-verification fixes" (`:158`) and "Execution-readiness findings"
   (`:172`) sections. The readiness findings are the highest-value part for this
   executor: they are the corrections that keep Phase 0 from failing at
   execution time.
7. `docs/reviews/2026-08-28-plan-review-adjudication.md` — **required.** The
   round-1 decision record (D1-D5). Still binding where round 2 does not rule.
8. `docs/reviews/2026-08-28-multi-agent-program-plan-review.md` — **required.**
   The program review both records rule on. Read it for the finding text
   (ARCH-1/2/3, IMPL-1/2/3), never for verdicts the adjudications overturned.
9. `docs/reviews/2026-08-25-helium-v1-review.md`, which records the source and
   production-derived reasons Phase 0 exists.
10. This handoff, which fixes the worktree, scope, current baseline, and
    execution boundary. It does not override the approved design.

Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and
`superpowers:verification-before-completion`. Treat code snippets in the plan
as intended contracts, not as permission to ignore actual APIs. If a minor
source/API drift is found, make the smallest plan-conformant adaptation and
explain it in the PR. Stop and escalate only if the necessary adaptation would
change the safety boundary, phase objective, or external authority.

## Non-negotiable constraints

1. Work only in the Phase 0 worktree and branch. Never push directly to
   `master`.
2. **The AC#1 freeze is a presence test on the mini, and it ends 2026-08-31.**
   Per `ops-design:885` §13.4 Window 1 and `master-plan:194-196`: if it puts a
   byte on the mini or starts a process there, it is forbidden. Concretely, and
   without exception, until 2026-08-31 has passed and the AC#1 evidence is
   recorded — **no file written, copied, or rendered anywhere on the mini's
   filesystem** (plist, script, binary, configuration, log, state directory);
   **no process started there**, including a single manual one-shot run "just to
   see the output"; **no `launchctl load` / `bootstrap` / `enable`** of a
   `com.helium.opsd*` label (§13.4's exact wording — Phase 0 has business
   loading no `com.helium.*` label at all); **no package installed or upgraded**
   there; **no probe executed against the mini from another host**; and **no
   Helium deploy to the mini**, including one whose only change is docs.
   "No production component or host mutation" is **not** the test — installing a
   LaunchAgent mutates no production component and is still forbidden. Local
   fixtures and local test processes on the developer machine are permitted.
   **Phase 0 is freeze-compatible** (round-2 `:189`): Tasks 1-5 were checked one
   at a time against the Window 1 verb list and none of them writes to the mini,
   starts a process there, or deploys anything. Phase 0 does not have to wait
   for the freeze to close.
   **Authoring versus effect (round-2 `:191`).** Task 1 and Task 5 nevertheless
   author files that are eventually deployed to the mini —
   `profile/cordis.patch.yml`, `plugins/helium/cordis.patch.yml`, and
   `scripts/deadman/check-heartbeat.sh`. Window 1's test is presence, not
   authorship: **editing and merging them in the repo is permitted.** The change
   simply does not take effect until a post-freeze deploy carries it there, and
   **nothing in Phase 0 may perform that deploy.**
3. Do not begin provider contracts, model catalogs, capability routing, subagent
   coordination, Macro shadow execution, or Ops implementation. Those begin
   behind later phase gates. **Carve-out:** adding `quota-exhausted` and
   `retryAfter` to the `classify()` failure vocabulary in
   `plugins/helium/src/claude.ts` **is** Phase 0 work (Task 1 Step 3b) and is
   not a provider catalog or a selector.
4. Preserve the canonical topology. Phase 0 must not introduce a
   sensor-to-provider, agent-to-delivery, or agent-to-authority shortcut.
5. Do not add new provider/model branching to `packages/core`, and **introduce
   no new provider-name leak** there (R6). Existing v1 provider-specific types
   remain a compatibility surface until Phase 1 moves them. The
   `quota-exhausted` classification lives in the plugin, not in core.
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
9. **"Exactly once" is forbidden vocabulary** program-wide (round-1
   adjudication D4.2). Do not write it in code, comments, tests, the manifest,
   or the PR.
10. Keep each planned task in its own green commit. Run the task's focused
    failing test before production code, then the focused passing tests before
    committing.
11. Open a PR only after the complete Phase 0 gate is green. Do not merge the PR
    until the isolation proof and delivery crash matrix receive review.

## Verified baseline

Re-captured on **2026-08-28** from this worktree at base `3e6c028`, replacing
the stale Revision 2 block (which recorded pnpm 11.23.0, Node v26.7.0, and
Claude Code 2.1.231 — all three are wrong for this machine now).

| Tool | Verified version |
|---|---|
| Node | `v25.1.0` (repository declares `^22.19.0 \|\| >=24.0.0`) |
| pnpm | `11.24.0` |
| Claude Code | `2.1.250`, first on `PATH` at `~/.local/bin/claude` |
| git | `2.55.0` |
| vitest | `3.2.7` |
| tsc | `5.9.3` |

**Claude Code path trap.** `/opt/homebrew/bin/claude` is a *different, older*
install — Homebrew cask `2.1.231`. The previous handover probed that path and
recorded 2.1.231 as the baseline. `command -v claude` resolves to
`~/.local/bin/claude` at `2.1.250`, which is the version the readiness pass
verified the flag semantics against. Probe the binary that is actually first on
`PATH`, and record which one you probed.

Suite results, observed fresh in this worktree on 2026-08-28 at `3e6c028`:

| Check | Result |
|---|---|
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 24 files, 161/161 tests |
| `pnpm test:contracts` | PASS; 5 passed, 1 skipped (live opt-in) |
| `pnpm test:e2e-local` | PASS; 1 file, 1 test — **from this worktree** |
| `bash scripts/deadman/check-heartbeat.test.sh` | PASS (`ALL PASS`) |

The skipped live agent contract is intentionally opt-in and is not permission to
exercise a subscription or production path during Phase 0.

**Read the e2e row carefully — it is the B-7 defect in the flesh.** The same
command recorded **2** e2e tests in the readiness pass (round-2 `:174`) and
**1** here. Neither run is wrong: the readiness pass ran from the primary
checkout, where `vitest.e2e.config.ts`'s unbounded `include` also collects
`.worktrees/multi-agent-phase0/plugins/helium/test/e2e/harness.e2e.test.ts`.
One command, two counts, depending on whether a worktree happens to be checked
out. Until Task 1 Step 3c lands the exclusion, `pnpm test:e2e-local` is not a
reproducible command and **no e2e row may be recorded in the manifest**
(`ma-impl:864`).

**Manifest recording rule — do not paste local hashes.** `master-plan:369-383`:
every `outputHash` in an evidence manifest is recorded **from the CI
environment, at the Node version pinned in `.github/workflows/ci.yml`**, which
is **`22.19.0`** (`.github/workflows/ci.yml:21,41` — verified). Three runtimes
exist in this program right now and the same command hashes differently under
each; an unpinned recording environment makes `outputHash` unfalsifiable,
because a re-run disagrees with the record and neither side is wrong. So
`toolVersion` names the CI-pinned version and `outputHash` is the hash of that
CI run's captured output. **A hash captured on this developer machine is not
admissible** and does not open the gate. The table above is a sanity baseline
for you, not manifest input.

## Current gaps confirmed in source

Every anchor below was re-read at `3e6c028`:

- `plugins/helium/src/claude.ts:61-63` builds argv with **no** `--tools`, **no**
  `--strict-mcp-config`, and **no** `--setting-sources`; it pushes
  `--allowedTools` only when the declared list is non-empty (`:63`), so an
  empty declared list silently becomes the provider default. Timeout kills only
  the direct child, not a verified process group.
- `plugins/helium/src/claude.ts`'s `classify()` buckets subscription
  session-window exhaustion as a generic `error`, with no `quota-exhausted`
  class and no `retryAfter` passthrough. This is the highest-frequency real
  failure this system sees; it has already broken two live dispatches.
- `plugins/helium/src/index.ts:53` runs the senior process in `process.cwd()`,
  and `:56` maps `job.tools` to `mcp__helium__*` names passed through the
  `allowedTools` field — **which is correct and must be preserved** (see Task 1,
  B-2).
- `plugins/helium/src/index.ts:93-94` writes a static, hardcoded
  `HELIUM_TOOLS: "argon_api,apex_api,livewire_sql,thesis_read,thesis_write"`
  while `:98-100` omits `HELIUM_LIVEWIRE_DB` whenever `config.livewireDb` is
  unset. `packages/core/src/tools/livewire.ts:56-57` then returns `[]`, and
  `packages/core/src/mcp/selection.ts:42-44` filters on `names.includes(t.name)`
  — so `livewire_sql` is **silently dropped on the shipped default path**.
- `packages/core/src/mcp/server.ts:21` calls `selected()` at **module top
  level**. Anything that throws there kills the MCP server at import and takes
  every tool with it. This single fact is why Task 3 splits into two behaviors.
- `packages/core/tests/mcp-selection.spec.ts:70` contains
  `it("silently drops a HELIUM_TOOLS name that matches no known tool", ...)`,
  which asserts `.not.toThrow()` and locks in exactly that behavior.
- `packages/core/src/tools/thesis.ts:21,33` declares `thesis_read` and
  `thesis_write` as `mutating: false` by explicit design. The genuinely mutating
  tools are `argon_rescan` (`packages/core/src/tools/argon.ts:210`) and
  `argon_ai_analysis` (`:218`), both registered `mutating: true`.
- All three shipped jobs declare `allowMutations: false`
  (`packages/core/src/job.ts:62,200,243`;
  `packages/core/tests/job.spec.ts:30,50`). Phase 0 rejects
  `allowMutations: true` at job load until a real mutating execution boundary is
  certified; do not preserve a misleading no-op option.
- `plugins/helium/src/delivery.ts:179-181` carries the comment "Append FIRST,
  always", but the append it guards lands at `:182` — **after** the SMTP call at
  `:245`. The comment describes the intended order; the code does the opposite.
- `loadJobs()` can isolate a malformed YAML file, but the runtime omits that
  tenant from heartbeats, so global liveness can hide the missing tenant.
- `vitest.e2e.config.ts:9-10` declares `include: ["**/*.e2e.test.ts"]` with **no
  `exclude`**.
- `pnpm-workspace.yaml:5-7` registers the three existing fixtures one per line;
  there is no `contracts/fixtures/*` glob.
- `contracts/harness/` does not exist. Neither does `docs/evidence/`, nor
  `scripts/deadman/check-tenant-heartbeats.mjs`.

**One plan-vs-source drift you will hit, and its resolution.** MA Task 5's Files
list marks `scripts/deadman/check-heartbeat.test.sh` as a `Create:` and states
at `ma-impl:772-774` that "it does not exist today". **It does exist**, at
`3e6c028`, added by commit `1c7dfa3` and last touched by `847b8cf`; it passes
today (`ALL PASS`). Treat that entry as a **Modify**, extend the existing drill
rather than replacing it, and record the deviation in the PR. This is the
"minor source drift → smallest plan-conformant adaptation, explained" case, not
an escalation.

### Claude Code flag semantics — verified, not assumed

Confirmed against the installed **2.1.250** help output and restated in
`ma-impl:65-99`:

- `--allowedTools, --allowed-tools <tools...>` — "Comma or space-separated list
  of tool names to allow". This is the **permission allow-list**, and it is the
  **only** flag that accepts `mcp__helium__*` names.
- `--tools <tools...>` — "Specify the list of available tools **from the
  built-in set**. Use `""` to disable all tools, `default` to use all tools, or
  specify tool names." MCP names are not in the built-in set.
- `--strict-mcp-config` — "Only use MCP servers from `--mcp-config`, ignoring
  all other MCP configurations."
- `--restricted` — removes built-in command/code-running tools and ignores
  settings files. **Considered and rejected as a substitute:** it places no
  constraint on MCP tools, which is the surface Task 1 exists to gate.
- `--bare` is not a solution for this subscription path: its help states OAuth
  and keychain authentication are never read.

Re-check the installed CLI's help immediately before coding in case it changes.
This is a read-only compatibility check. If current semantics contradict the
plan, preserve the isolation objective, add a failing contract for the observed
behavior, and document the deviation; do not silently fall back to
approval-only flags.

## Execution sequence and stopping conditions

**Order of record (readiness finding B-9).** Task 1 red test → Task 2 red
contract → Task 1 implementation → Task 2 green. `ma-impl`'s task numbering is
the execution order of record; any prose elsewhere claiming the conformance
harness is the first Phase 0 code change is superseded. Task 2's contract
depends on Task 1's implementation, which is why the two interleave.

### 1. Task 1: restrict and isolate the senior CLI process

Follow `ma-impl:52` ("Task 1: Restrict and isolate the senior CLI process").

**The `--tools` swap in the old handover was WRONG. Do not do it.**
Readiness finding B-2 `[HIGH]` (round-2 `:177`; restated at `ma-impl:65-99`):
the earlier instruction to replace `--allowedTools` with `--tools` rested on the
belief that `--allowedTools` is approval-only. Claude Code 2.1.250 defines
`--tools` as selecting from the **built-in set**, so `mcp__helium__*` names
routed through it are **dropped — along with the permission gate**, in one edit.
Production already puts its MCP names in `allowedTools`
(`plugins/helium/src/index.ts:56` → `plugins/helium/src/claude.ts:63`).

The correct composition is all three flags together:

- `--tools ""` — disable the entire **built-in** tool set; that is what `--tools`
  is for.
- `--allowedTools <declared mcp__helium__* names>` — the permission allow-list,
  carrying exactly the declared tools and nothing else. **Emit it even when the
  declared set is empty**, so an empty list stays empty rather than becoming the
  provider default.
- `--strict-mcp-config` beside the per-attempt `--mcp-config` — so no ambient
  MCP server from a user, project, or local configuration is inherited.

Plus `--setting-sources ""`.

**The red test asserts argv composition, never absence.** The fixture only
echoes argv — it can show which argv the harness composed, never what the CLI
did with it. An earlier draft asserted the allow-list flag was *not present*; a
negative assertion of that shape is satisfied by a build that emits no
permission gate at all, which is exactly the regression it let through. Assert
what the argv **contains**, positively and exactly: `valuesOf("--tools")` equals
`[""]`, `valuesOf("--allowedTools")` equals the declared set in order,
`--strict-mcp-config` present, `valuesOf("--mcp-config")` equals the per-attempt
path, `valuesOf("--setting-sources")` equals `[""]`. Add the companion
empty-declared-set case.

**Frozen interface.** `runClaude()`'s option field keeps the name
`allowedTools`, frozen by round-1 adjudication D3 and restated at
`ma-impl:101-106`. It is not a naming defect to re-file later. Do **not** rename
it to `tools`; the provider-effort-selection plan resumes at exactly this seam
and must extend this signature, not redefine it. Any snippet anywhere passing
`tools:` to `runClaude()` is wrong and must be corrected to `allowedTools:`.
Note that the emitted flag `--tools` and the option field `allowedTools` now
mean **different things** — that is intended, not a mismatch to "fix".

Required outcome:

- built-ins disabled via `--tools ""`, the declared MCP allow-list emitted
  exactly, and an empty declared list staying empty;
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

**Step 3b — `quota-exhausted`.** Extend the classification vocabulary to
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

**Step 3c — stop the e2e gate from scanning `.worktrees/` (readiness finding
B-7).** Add `exclude: [".worktrees/**"]` to `vitest.e2e.config.ts` beside the
existing `include`. **This matters to you specifically.** You are working inside
`.worktrees/multi-agent-phase0`. Without the exclusion, a gate run from the
primary checkout collects *this worktree's own copy* of
`plugins/helium/test/e2e/harness.e2e.test.ts`, at whatever commit you happen to
be sitting on, and folds it into the evidence hash — contaminating the very
evidence you are producing. That is not hypothetical: it is why the baseline
above shows 1 e2e test and the readiness pass showed 2. The exclusion lands in
Task 1 because Task 1 is first and every later gate run depends on it.

Do not share an attempt workspace or mutable MCP file between concurrent jobs.
Use unique attempt identity and paths. Preserve enough failure evidence for
audit without persisting secrets or unrestricted environment values.

Files touched (`ma-impl:56-63`): `plugins/helium/src/claude.ts`,
`claude.test.ts`, `index.ts`, `config.ts`, `index.test.ts`,
`profile/cordis.patch.yml`, `plugins/helium/cordis.patch.yml`,
`vitest.e2e.config.ts`. The two `cordis.patch.yml` files are deployed to the
mini eventually — authoring them is permitted, deploying them is not (see
constraint 2).

Commit target: `fix: isolate senior execution capabilities`.

### 2. Task 2: build the reusable execution-boundary conformance harness

Follow `ma-impl:294` ("Task 2: Build the reusable execution-boundary
conformance harness").

It delivers a _reusable_ harness, not a one-off adversarial test for the senior
lane. Create `contracts/harness/execution-boundary.ts` exporting an
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
**inherits** this contract; it does not fork a second suite (round-1
adjudication D2).

**Step 0 — register the fixture as a workspace package, and refresh the lockfile
in the same commit (readiness finding F-2).** The fixture carries its own
`package.json`, which makes it a workspace package, and
`pnpm-workspace.yaml:5-7` lists the three existing fixtures explicitly rather
than globbing. **CI runs `pnpm install --frozen-lockfile`**, so an unregistered
fixture or a stale lockfile fails CI, not the local run. Add
`contracts/fixtures/senior-isolation` to `pnpm-workspace.yaml`, run
`pnpm install` to refresh `pnpm-lock.yaml`, verify with
`pnpm install --frozen-lockfile`, and commit **both files in the same commit as
the fixture — never as a follow-up.** Task 2's Files list names
`pnpm-workspace.yaml` and `pnpm-lock.yaml` for exactly this reason
(`ma-impl:303-304`).

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

Commit target: `test: add reusable execution-boundary conformance harness`.

### 3. Task 3: make tool and mutation policy truthful

Follow `ma-impl:430` ("Task 3: Validate tool selections and make mutation policy
truthful").

**Two conditions, two behaviors — do not collapse them (readiness finding B-1
`[HIGH]`, round-2 `:176`; restated at `ma-impl:471-503`).** "Fail loud" is not
one rule here, and collapsing the two turns a one-capability rejection into a
total outage:

1. **Unknown capability name** — a name not in the tool vocabulary at all, i.e.
   a typo. Fail loud at **job load / config validation** time: reject the
   affected tenant and raise its health state. This is the P0 exit gate's own
   requirement — "a misspelled capability rejects only the affected tenant and
   raises its health state".
2. **Declared but unconfigured** — a real tool name whose backing configuration
   is absent. `livewire_sql` with `HELIUM_LIVEWIRE_DB` unset is the shipped
   instance. This must **never throw**: degrade that tenant's health with a
   **named** reason, omit the tool, and let the server start with the rest.

The distinction is load-bearing because of *where the code runs*.
`packages/core/src/mcp/server.ts:21` calls `selected()` at module top level, so a
throw from `selected()` happens during module initialization: **the MCP server
never starts and the senior lane loses every tool rather than the one tenant
that was misconfigured.** And condition 2 is not hypothetical — it is the
shipped `macro-watch` shape today. Requirement: whatever
`packages/core/src/mcp/server.ts` calls at import time **must never throw for
condition 2**. Unknown-name rejection belongs to the job-load validator, which
runs before the server process is spawned.

**Derive `HELIUM_TOOLS` from the job spec.** It is hardcoded as a static
five-name string at `plugins/helium/src/index.ts:93-94`, so a job declaring a bad
name never produces a bad `HELIUM_TOOLS` and **condition 1 can never fire**.
Derive it from the job spec's declared `tools` — the same list already used at
`index.ts:56` — so a misspelled capability in the job YAML is exactly what trips
the job-load validator and rejects that tenant.

**IMPL-2 — the "silently drops" test is REPLACED, not extended.** Delete
`packages/core/tests/mcp-selection.spec.ts:70` and write the fail-loud
expectations in its place. Leaving the old case in would make the suite assert
both behaviors at once and fail.

**IMPL-1 — use genuinely mutating tools in the red tests.** Not `thesis_write`,
which is `mutating: false` by explicit design with a locked-in test. Use
`argon_rescan` and `argon_ai_analysis`. Expected shapes:

- `validateToolSelection(["argon_api","typo_tool"], { allowMutations: false })`
  throws `/unknown tools: typo_tool/`;
- `validateToolSelection(["argon_rescan"], { allowMutations: false })` throws
  `/requires mutation permission/`;
- same for `argon_ai_analysis`;
- `validateToolSelection(["livewire_sql"], { allowMutations: false })` does
  **not** throw — a real name is never an unknown-tool error, regardless of
  whether `HELIUM_LIVEWIRE_DB` is set; and
- `selected(env)` with the shipped five-name `HELIUM_TOOLS` and
  `HELIUM_LIVEWIRE_DB` absent does not throw, returns the other four tools, and
  reports `degraded: [{ tool: "livewire_sql", reason: "unconfigured:
  HELIUM_LIVEWIRE_DB" }]`. Never an empty tool set, never a crash, and the
  degradation carries a **named** reason rather than a bare boolean — the tenant
  health row has to say which capability is missing and why.

Keep the existing positive cases (`HELIUM_ALLOW_MUTATIONS: "1"` admits
`argon_rescan`) unchanged — only the silent-drop assertions are inverted.

Implement the split: export a tool **vocabulary** (names, not instances) from
`packages/core/src/tools/index.ts` so `livewire_sql` is known even when
`livewireTools()` returns `[]`; validate against it at job load; and have
`selected()` return `{ tools, degraded }` with no throw on the import path.

Replace the static all-tools MCP config with a per-attempt config derived from
the exact job tool list and `allowMutations` value; delete the static config.
Because no mutating provider boundary is certified in Phase 0, reject
`allowMutations: true` during job validation/loading. Do not claim mutation
support and do not set `HELIUM_ALLOW_MUTATIONS=1` in production paths.

**Files (readiness finding F-1 corrected the list, `ma-impl:434-444`):** in
addition to `packages/core/src/mcp/selection.ts`, its spec,
`tools/types.ts`, `tools/index.ts`, `mcp/server.ts`, and the plugin's `index.ts`
/ `index.test.ts`, the task now explicitly names **`packages/core/src/job.ts`**,
**`packages/core/tests/job.spec.ts`**, and **`plugins/helium/src/runtime.ts`**
alongside `runtime.test.ts` — its own steps require changing all of them, and
runtime behavior cannot be changed by editing only a test.

**Task 6 collision caution (`ma-impl:455-460`).** `packages/core/src/job.ts` and
`packages/core/tests/job.spec.ts` are **moved** to `packages/v1-compat/` by
Task 6 in P1. Keep Task 3's edit to them small and behavior-preserving for the
shipped snake_case-YAML / camelCase-TypeScript field contract that round-2 R2
confirmed is intentional: add the `allowMutations: true` rejection and nothing
else. Do not restructure the schema here.

Test concurrency and cleanup so one job cannot observe another job's MCP
configuration.

Commit target: `fix: validate execution tool contracts`.

### 4. Task 4: make delivery write-ahead and crash-reconcilable

Follow `ma-impl:659` ("Task 4: Make delivery a write-ahead state machine").

**EX-1 does not touch this task.** The exemption relieves evidence provenance
under acceptance criterion 16 for the `legacy-direct` lane and nothing else;
`master-plan:248-249` names "the write-ahead JSONL record before the SMTP side
effect" first in the list of what still binds.

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
correct property set (`ma-impl:715-726`) is: a durable write-ahead intent before
any external side effect; **at most one active (unresolved) delivery intent per
`deliveryId`** — this lane **issues no lease object of its own**, and neither
`ExecutionLease` nor `ActionLease` exists at P0; no blind retry of an intent
whose outcome is unknown; idempotent or effectively-once completion where the
transport supports a dedup key; and, where it does not, a durable `uncertain`
outcome that a human or a reconciliation pass resolves.

The previous handover said "at-most-one active delivery **lease** per
`deliveryId`". That word is wrong and was removed deliberately: it implies a
lease object this lane does not have and P0 does not define. The word is
**intent**. (Round-2's "One name is deliberately not restored" note, `:170`,
fixes the lease inventory at exactly two — `ExecutionLease` and `ActionLease`,
both P1+ — and forbids a third.)

**`uncertain` is a real terminal row, not a missing one** — the crash-point
tests must assert it is written. The status word is `uncertain`, not `unknown`;
this matches `ma-impl:725-726` verbatim. Never describe any of this as
exactly-once (round-1 adjudication D4.2).

Add `appendAt()` or injectable clock support to `JsonlWriter` so the JSONL file
date and the row timestamp come from the same clock; remove the fake-timer
workaround from the delivery tests.

Commit target: `fix: write delivery intent before side effects`.

### 5. Task 5: add expected-tenant and per-tenant liveness, and write the P0 manifest

Follow `ma-impl:748` ("Task 5: Add expected-tenant and per-tenant liveness").

Inventory every `*.yaml` file before parsing. Emit `tenant-health` rows and
preserve `loaded`, `invalid`, `disabled`, and runtime-heartbeat states so a
malformed or disabled tenant does not vanish — a malformed tenant stays in the
expected inventory with state `invalid`. Extend the dead-man path to evaluate
both global process freshness and every expected tenant independently while
preserving existing deliberate-drill and alert-dedup semantics.

Test at least healthy, stale, missing, malformed, disabled, and mixed-tenant
cases. One healthy tenant must never mask another stale or invalid tenant, and
health must never be inferred from another tenant's heartbeat.

**Step 4b — create `docs/evidence/` and write the manifest (readiness finding
B-3).** Task 5 is the last P0 task, so it is the task that produces the
filled-in P0 evidence manifest at **`docs/evidence/p0-manifest.yaml`** and
creates the `docs/evidence/` directory that holds it. Neither exists in the repo
today. P1 Task 7's `docs/evidence/claims.yaml` lands in the same directory and
takes this manifest's deterministic claims as its first rows; the directory is
created **once, here**.

**Files (`ma-impl:752-761`), with two corrections:**
`packages/core/src/tenant-health.ts` and its spec (Create),
`packages/core/src/index.ts`, `plugins/helium/src/runtime.ts` and
`runtime.test.ts` (Modify), `scripts/deadman/check-tenant-heartbeats.mjs` and
`check-tenant-heartbeats.test.mjs` (Create — neither exists),
`scripts/deadman/check-heartbeat.sh` (Modify),
`scripts/deadman/check-heartbeat.test.sh` (**listed as Create; it already
exists — treat as Modify**, see "Current gaps"), and
`docs/evidence/p0-manifest.yaml` (Create).

Commit target: `feat: monitor liveness per tenant`.

### 6. Phase 0 integration and evidence gate

Run the complete gate from a clean branch (`ma-impl:844-857`):

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

**The last two test commands are not optional and not reachable any other way
(readiness finding B-10).** Neither `scripts/deadman/check-tenant-heartbeats.test.mjs`
nor `scripts/deadman/check-heartbeat.test.sh` is wired into a `package.json`
script or into CI — verified: `package.json` defines only `build`, `typecheck`,
`test`, `test:contracts`, `test:e2e-local`. **`pnpm test` does not reach them**,
so a gate that runs only the `pnpm` commands never executes two of the tests
Task 5 creates. Run them by hand until they are wired up.

**The gate's evidence is invalid until Task 1 Step 3c has landed**
(`ma-impl:864-869`). Without `exclude: [".worktrees/**"]` in
`vitest.e2e.config.ts`, `pnpm test:e2e-local` is not a reproducible command and
its output hash does not describe this tree. Confirm the exclusion is present
before recording any e2e row in the manifest.

Also run the execution-boundary conformance suite and the delivery crash matrix
directly and report their exact counts. Confirm no descendant test process
remains.

**Exit evidence — `docs/evidence/p0-manifest.yaml`.** Phase 0 exit requires an
`EvidenceManifest` conforming to the **frozen P0 evidence-manifest template**
recorded at `master-plan:321` (`manifestVersion: p0-1`,
`evidencePolicyVersion: p0-1`), **committed at `docs/evidence/p0-manifest.yaml`**.
The path is part of the gate. The typed schema is a Phase 1 Task 7 deliverable;
the template is hand-written and hand-checked and needs no P1 code. **Fill it in
— do not redesign it, do not invent a competing core schema, and do not defer
P0's exit evidence to Phase 1.** P1's schema inherits this template: a P0
manifest must validate against it without being rewritten.

For **every deterministic assertion**, the verifier is a **command plus its
exact tool version plus the hash of its output**. Never a model. Never the
plan's author signing off as a second pretend human — Helium is a
single-operator project, so **the operator authors the manifest and the command
verifies it**; a manifest implying independent human review is a false evidence
record. Per assertion record: `assertion`, `acceptanceBound`,
`assertionClass: deterministic`, `evidencePolicyVersion`, `verification`
(`verifier: command`, `command`, `toolVersion`, `outputHash: sha256:…`,
`decision`), `artifacts` with hashes, `baseline` (v1 behavior at `3e6c028`),
`reproduction`, `failures`, `status`, `limitation`, and `nextGate`. A reviewer
must be able to re-run the command and compare hashes without re-reading the
plan.

**Every `outputHash` comes from CI at Node `22.19.0`** — the version pinned in
`.github/workflows/ci.yml:21,41` — and `toolVersion` names that version
(`master-plan:369-383`, `:513-517`). **A hash captured on the developer machine
is inadmissible** and does not open this gate. Do not paste the local baseline
numbers from this document into the manifest.

Every P0 exit assertion is deterministic — test-suite results,
execution-boundary conformance output, delivery crash-matrix replay,
`quota-exhausted` classification, per-tenant liveness exit codes — so no P0
assertion needs a model verifier at all. Assertions that are not
deterministically checkable are recorded as `PARTIAL` with the missing proof
named, never as `PROVEN` on human assurance. `scope: offline`.

Minimum claims to record (`master-plan` P0 row of the evidence ladder):
adversarial isolation, execution-boundary conformance harness,
`quota-exhausted` classification, delivery-boundary crash replay, and v1
behavior comparison.

### 7. PR and handback

- Review the full diff against the five tasks and the Phase 0 exit gate.
- Confirm no production/provider/model feature work leaked in, and that no new
  provider-name token entered `packages/core`.
- Push `feat/multi-agent-phase0` and open one Phase 0 PR.
- Reference the committed `docs/evidence/p0-manifest.yaml` from the PR
  description, with exact verification results, known limitations, and a
  rollback statement. The manifest is the artifact; the PR body points at it.
- Request review specifically for process-tree isolation, per-attempt MCP/tool
  isolation, conformance-harness reusability, `quota-exhausted` classification,
  ambiguous delivery recovery, and tenant-liveness failure modes.
- Stop. Do not merge or begin Phase 1 until review and direction are received.

## Phase 0 definition of done

Phase 0 is not complete merely because the test suite is green. It is ready for
review only when every one of the following is true and checkable:

- [ ] `grep -n "## Revision 3 — 2026-08-28" docs/plans/2026-08-25-helium-multi-agent-master-plan.md`
      prints a match on this branch, and
      `docs/reviews/2026-08-28-adjudication-round-2.md` exists.
- [ ] The branch is based on `3e6c028` or a later `master` that still satisfies
      the line above.
- [ ] All five planned tasks are implemented in the `ma-impl` task order, with
      focused red/green evidence per task, in one green commit each.
- [ ] The real senior adapter, not only a fixture helper, is isolated.
- [ ] argv composition is asserted positively: `--tools ""`, `--allowedTools`
      carrying exactly the declared `mcp__helium__*` names, `--strict-mcp-config`
      beside the per-attempt `--mcp-config`, and `--setting-sources ""`. No test
      asserts the mere absence of a flag name.
- [ ] An empty declared tool list emits an empty `--allowedTools` rather than
      falling back to provider defaults.
- [ ] No undeclared MCP server, setting source, environment secret, or workspace
      path is available to the execution attempt.
- [ ] Each attempt owns a unique workspace under the configured state root;
      `process.cwd()` is not used for senior execution.
- [ ] Timeout leaves no child or descendant process running.
- [ ] `vitest.e2e.config.ts` contains `exclude: [".worktrees/**"]`, and
      `pnpm test:e2e-local` collects only files from the checkout it was run in.
- [ ] The conformance harness runs against the senior lane as a **named
      boundary** and can be pointed at a second boundary without rewriting its
      assertions, and it is not written generically over `Executor`.
- [ ] `contracts/fixtures/senior-isolation` is registered in
      `pnpm-workspace.yaml`, `pnpm-lock.yaml` is refreshed in the **same
      commit**, and `pnpm install --frozen-lockfile` passes.
- [ ] Session-window exhaustion classifies as `quota-exhausted` with an opaque
      `retryAfter`, never as a generic `error`, never as a capability change,
      and never folded into `budget-exhausted`.
- [ ] `runClaude()`'s `allowedTools` option field name is unchanged.
- [ ] An unknown capability name rejects **only that tenant** at job load and
      raises its health state; a declared-but-unconfigured tool
      (`livewire_sql` without `HELIUM_LIVEWIRE_DB`) degrades health with a named
      reason, omits the tool, and **does not throw**; the import-time path in
      `packages/core/src/mcp/server.ts` cannot throw for that case.
- [ ] `HELIUM_TOOLS` is derived from the job spec, not a hardcoded string.
- [ ] The old "silently drops" test at `packages/core/tests/mcp-selection.spec.ts:70`
      is deleted, not extended.
- [ ] Delivery has a durable intent row before any side effect and an explicit
      durable `uncertain` outcome row; the invariant is stated as **at most one
      active (unresolved) intent per `deliveryId`**, with no "lease" wording and
      no new lease type; nothing anywhere claims exactly-once.
- [ ] No new provider-name token was introduced into `packages/core`, and no
      file or line allow-list was added to any scan.
- [ ] Existing v1 behavior, build, typecheck, unit, contract, and E2E suites
      remain green, and both `scripts/deadman/` tests were run **by hand** —
      `node --test scripts/deadman/check-tenant-heartbeats.test.mjs` and
      `bash scripts/deadman/check-heartbeat.test.sh` — because `pnpm test` does
      not reach them.
- [ ] `git diff --check` is clean.
- [ ] **`docs/evidence/p0-manifest.yaml` exists**, is committed, uses
      `manifestVersion: p0-1` with the frozen field set unchanged, and every
      deterministic claim names a command, its `toolVersion`, and its
      `outputHash`, with honest `PLANNED` / `PARTIAL` / `PROVEN` / `FAILED` /
      `BLOCKED` statuses and `baseline: "v1 behavior at 3e6c028"`.
- [ ] Every `outputHash` in that manifest was recorded from a **CI** run at Node
      `22.19.0`; no developer-machine hash appears anywhere in it.
- [ ] **The mini freeze held as a presence test through 2026-08-31**: no byte
      was written to the mini, no process was started there, no
      `launchctl load` / `bootstrap` / `enable` of a `com.helium.*` label was
      issued, no probe was executed against the mini from another host, and no
      deploy occurred. Files that are *eventually* deployed there
      (`profile/cordis.patch.yml`, `plugins/helium/cordis.patch.yml`,
      `scripts/deadman/check-heartbeat.sh`) were authored and merged only — they
      remain inert on the mini until a post-freeze deploy, which Phase 0 does
      not perform.
- [ ] A green PR is open and awaiting the required review.

## Explicit non-goals for this branch

- Provider catalog probing or adding DeepSeek, Claude, or Codex adapters. (The
  `quota-exhausted` classification in the existing plugin `classify()` path is
  in scope; a provider catalog or availability registry is not.)
- Model or effort selection. The provider-effort-selection plan is deferred
  program-wide until real usage data exists.
- Capability routing, the capability ontology, scoring, confidence intervals, or
  automatic learning — all deferred by round-1 adjudication D3.
- Defining the formal `Executor` interface or writing the conformance harness
  generically over it. That type arrives in Phase 1 Task 10 and inherits this
  contract.
- Creating the neutrality contract test or its exported word-list constants.
  That is MA Task 6 in P1 (R6). Phase 0's only obligation is to introduce no new
  leak.
- The generic append-only event store (R1) and the structural topology guard
  (R4). Both are P1 MA Tasks 7 and 10b.
- Building the typed `EvidenceManifest` schema in core. Phase 0 fills in the
  frozen template only.
- Adding a third lease type. The inventory is fixed at `ExecutionLease` and
  `ActionLease`, both P1+; neither exists at P0.
- Durable team DAG, artifact store, spawning, or cross-reference implementation.
  The general durable mailbox is deferred outright.
- Macro team or Ops Agent implementation.
- Any deployment, release tag, watchdog change, SOP execution, or production
  drill on the mini.
- Refactoring unrelated v1 modules for style.
- Merging the Phase 0 PR without review.

## Handback format

When returning control, report:

1. branch, worktree, head commit, base commit, PR URL/state, and clean/dirty
   status;
2. each Phase 0 task with `PROVEN`, `PARTIAL`, `FAILED`, or `BLOCKED` status;
3. files and contracts changed;
4. exact tests run and numerical results, including the two `scripts/deadman/`
   tests that no `pnpm` script reaches;
5. adversarial cases exercised and raw evidence locations, with the command,
   tool version, and output hash for each deterministic claim, plus where each
   hash was recorded (CI run, not this machine);
6. deviations from the implementation plan and why they preserve the goal —
   including the `check-heartbeat.test.sh` Create-vs-Modify drift;
7. anything not verified, especially production claims; and
8. the single next unopened gate.

Before claiming completion, re-check the live branch state, rerun the full gate,
and distinguish local test evidence from production evidence.

---

_The plan documents cited above are authoritative as of **Revision 3
(2026-08-28)**, the merge of PR #11 at `3e6c028`. This handover is bound to that
revision: **if the plan set is revised again — a `Revision 4` heading appearing
in the master plan, a new adjudication record landing in `docs/reviews/`, or any
change to Phase 0 Tasks 1-5 or the Phase 0 gate in the implementation plan —
this handover is stale and must be regenerated before execution.** The hard gate
at the top of this document is the tripwire; update it to the new revision
marker when regenerating, so it keeps failing closed rather than passing on a
stale tree._
