# Claude Code Handover: Helium Multi-Agent Phase 0

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
multi-agent system with Macro and Ops reference teams.

## Exact workspace state

- Repository: `/Users/chenxi/projects/helium`
- Worktree: `/Users/chenxi/projects/helium/.worktrees/multi-agent-phase0`
- Branch: `feat/multi-agent-phase0`
- Starting commit: `a1801ec70e863e34c1d49cd6cc2aa10b7fe1123f`
- Starting commit identity: merge of PR #10, canonical topology in README and
  design
- At handoff preparation, `master`, `origin/master`, and the new branch all
  pointed to that starting commit.
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
```

If the branch has changes beyond this committed handoff note, inspect and
preserve them. Do not reset or overwrite work that appeared after this note.

## Source-of-truth order

Read these before implementation, in this order:

1. `AGENTS.md`, if present, and the repository/global Git workflow rules.
2. `docs/plans/2026-08-25-helium-multi-agent-master-plan.md`, especially the
   program rules, Phase 0 objective, exit gate, and deployment rule.
3. `docs/plans/2026-08-25-helium-multi-agent-design.md`, especially Section
   5.5's canonical topology and the model-blind boundary.
4. `docs/plans/2026-08-25-helium-multi-agent-implementation.md`, execution
   rules and Phase 0 Tasks 1-5. This is the task-by-task implementation plan.
5. `docs/reviews/2026-08-25-helium-v1-review.md`, which records the source and
   production-derived reasons Phase 0 exists.
6. This handoff, which fixes the worktree, scope, current baseline, and
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
2. Do not deploy, install, restart, repair, run recovery drills, or otherwise
   mutate the Mac mini during the AC#1 observation window. Local fixtures and
   local processes are allowed. Do not claim the production window is complete
   unless its evidence has actually been recorded.
3. Do not begin provider contracts, model catalogs, capability routing,
   subagent coordination, Macro shadow execution, or Ops implementation. Those
   begin behind later phase gates.
4. Preserve the canonical topology. Phase 0 must not introduce a
   sensor-to-provider, agent-to-delivery, or agent-to-authority shortcut.
5. Do not add new provider/model branching to `packages/core`. Existing v1
   provider-specific types remain a compatibility surface until Phase 1 moves
   them.
6. Never expose a generic shell tool or weaken tool isolation to make a test
   pass.
7. Never read, print, copy, commit, or expose subscription tokens, SMTP secrets,
   proxy credentials, environment files, host addresses, or production logs.
   Use fake CLIs, fake transports, temporary directories, and sanitized data.
8. Do not treat a command exit or several agreeing agents as proof. Phase 0
   assertions require deterministic tests and reproducible evidence.
9. Keep each planned task in its own green commit. Run the task's focused
   failing test before production code, then the focused passing tests before
   committing.
10. Open a PR only after the complete Phase 0 gate is green. Do not merge the PR
    until the isolation proof and delivery crash matrix receive review.

## Verified baseline

These checks ran from this worktree before the handoff note was written:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS; 501 packages reused from the content-addressable store |
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 24 files, 161/161 tests |
| `pnpm test:contracts` | PASS; 5 passed, one live opt-in test skipped |
| `pnpm test:e2e-local` | PASS; 1/1 test |

The skipped live agent contract is intentionally opt-in and is not permission
to exercise a subscription or production path during Phase 0.

## Current gaps confirmed in source

- `plugins/helium/src/claude.ts` uses `--allowedTools`, omits a restrictive
  empty `--tools` set, omits strict MCP and setting-source isolation, and kills
  only the direct child rather than a verified process group.
- `plugins/helium/src/index.ts` runs the senior process in `process.cwd()` and
  writes one static, all-tools MCP config at startup.
- `packages/core/src/mcp/selection.ts` silently drops unknown or mutation-
  forbidden tool names.
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

Follow Phase 0 Task 1 in the implementation plan.

Required outcome:

- restrictive tools behavior is present even for an empty tool list;
- only the declared MCP config and no ambient setting sources are visible;
- the child receives a deliberately narrowed environment;
- each attempt owns a unique workspace under the configured state root;
- timeout terminates and drains the whole process tree;
- workspace/config cleanup occurs only after child quiescence; and
- focused tests and typecheck pass.

Do not share an attempt workspace or mutable MCP file between concurrent jobs.
Use unique attempt identity and paths. Preserve enough failure evidence for
audit without persisting secrets or unrestricted environment values.

Commit target: `fix: isolate senior execution capabilities`.

### 2. Task 2: prove the boundary adversarially

Add the planned contract fixture and make it call the production adapter, not a
duplicate test-only argument builder.

The proof must cover at least:

- one declared tool and zero declared tools;
- strict MCP and setting isolation;
- owned working directory;
- forbidden ambient secret absence;
- undeclared path/tool denial; and
- descendant-process termination after timeout.

The test should fail for the original implementation and pass only through the
same adapter used by `buildSeniorLane()`.

Commit target: `test: prove senior execution isolation`.

### 3. Task 3: make tool and mutation policy truthful

Implement fail-loud catalog validation. An unknown tool or a mutating tool
without permission must not disappear silently. A bad job must fail only that
tenant and must remain visible to the health path.

Replace the static all-tools MCP config with a per-attempt config derived from
the exact job tool list. Because no mutating provider boundary is certified in
Phase 0, reject `allowMutations: true` during job validation/loading. Do not
claim mutation support and do not set `HELIUM_ALLOW_MUTATIONS=1`.

Test concurrency and cleanup so one job cannot observe another job's MCP
configuration.

Commit target: `fix: validate execution tool contracts`.

### 4. Task 4: make delivery write-ahead and crash-reconcilable

Append a durable intent with one stable `deliveryId` before report/email side
effects, then append a distinct outcome using the same ID. Rate-limit counts
must use successful outcome records, not intents. Dead letters must reference
the same ID.

Exercise failure injection at these boundaries:

1. before intent append;
2. after intent append but before SMTP;
3. after SMTP returns success but before outcome append; and
4. after outcome append.

SMTP does not by itself prove exactly-once delivery after an ambiguous crash.
Represent the unresolved third case as `unknown` and make it reconcilable; do
not blindly resend and do not claim exactly-once without transport evidence.
Ensure the JSONL file date and row timestamp come from the same injected clock.

Commit target: `fix: write delivery intent before side effects`.

### 5. Task 5: add expected-tenant and per-tenant liveness

Inventory every `*.yaml` file before parsing. Preserve `loaded`, `invalid`,
`disabled`, and runtime-heartbeat states so a malformed or disabled tenant does
not vanish. Extend the dead-man path to evaluate both global process freshness
and every expected tenant independently while preserving existing drill and
alert-dedup semantics.

Test at least healthy, stale, missing, malformed, disabled, and mixed-tenant
cases. One healthy tenant must never mask another stale or invalid tenant.

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

Also run the adversarial isolation contract and delivery crash matrix directly
and report their exact counts. Confirm no descendant test process remains.

The typed `EvidenceManifest` schema is scheduled for Phase 1 Task 7, creating a
bootstrap issue for the Master Plan's Phase 0 manifest requirement. Do not
invent a competing core schema in Phase 0. Instead, attach a versioned Phase 0
evidence packet to the PR using the Master Plan's required fields: assertion
and bound, policy version, raw artifact/test references, reproduction command,
baseline commit, verifier/tool version, failures and bad cases, local scope,
status vocabulary, limitations, and next unopened gate. Mark formal migration
to the canonical typed manifest as a Phase 1 obligation.

### 7. PR and handback

- Review the full diff against the five tasks and the Phase 0 exit gate.
- Confirm no production/provider/model feature work leaked in.
- Push `feat/multi-agent-phase0` and open one Phase 0 PR.
- Put the evidence packet, exact verification results, known limitations, and
  rollback statement in the PR description.
- Request review specifically for process-tree isolation, per-attempt MCP/tool
  isolation, ambiguous delivery recovery, and tenant-liveness failure modes.
- Stop. Do not merge or begin Phase 1 until review and direction are received.

## Phase 0 definition of done

Phase 0 is not complete merely because the test suite is green. It is ready for
review only when all of the following are true:

- [ ] All five planned tasks are implemented in order with focused red/green
      evidence.
- [ ] The real senior adapter, not only a fixture helper, is isolated.
- [ ] An empty declared tool list cannot fall back to provider defaults.
- [ ] No undeclared MCP server, setting source, environment secret, or workspace
      path is available to the execution attempt.
- [ ] Timeout leaves no child or descendant process running.
- [ ] A bad tool or malformed tenant is isolated and remains operator-visible.
- [ ] Delivery has intent before side effect and an explicit ambiguous state.
- [ ] Existing v1 behavior, build, typecheck, unit, contract, and E2E suites
      remain green.
- [ ] The PR contains a reproducible Phase 0 evidence packet and honest
      `PLANNED` / `PARTIAL` / `PROVEN` / `FAILED` / `BLOCKED` statuses.
- [ ] No mini or production state was changed.
- [ ] A green PR is open and awaiting the required review.

## Explicit non-goals for this branch

- Provider catalog probing or adding DeepSeek, Claude, or Codex adapters.
- Model or effort selection.
- Capability routing or scoring.
- Durable team DAG, mailbox, spawning, or cross-reference implementation.
- Macro team or Ops Agent implementation.
- Any deployment, release tag, watchdog change, SOP execution, or production
  drill on the mini.
- Refactoring unrelated v1 modules for style.
- Merging the Phase 0 PR without review.

## Handback format

When returning control, report:

1. branch, worktree, head commit, PR URL/state, and clean/dirty status;
2. each Phase 0 task with `PROVEN`, `PARTIAL`, `FAILED`, or `BLOCKED` status;
3. files and contracts changed;
4. exact tests run and numerical results;
5. adversarial cases exercised and raw evidence locations;
6. deviations from the implementation plan and why they preserve the goal;
7. anything not verified, especially production claims; and
8. the single next unopened gate.

Before claiming completion, re-check the live branch state, rerun the full gate,
and distinguish local test evidence from production evidence.
