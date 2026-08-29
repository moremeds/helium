# Codex Handover: Helium multi-agent program, resuming at Ops Phase C Task 10

> **Written 2026-08-29** from the tail of a Claude Code session that executed
> MA Phase 0, MA Phase 1, Ops Phase A and Ops Phase B end to end and stopped
> partway through Ops Phase C. Nothing here is inherited unread; every claim
> below was checked against the tree at commit `153793e`.

---

## 0. Hard gate — run this before reading further or touching a file

```bash
cd /Users/chenxi/projects/helium/.worktrees/multi-agent-phase0
git branch --show-current                      # expect: feat/ops-phase-c
git log --oneline -2                            # expect 153793e on top of f12bf52
git status -s                                   # expect: clean
pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts
```

Expected on a clean resume:

| Check | Expected |
|---|---|
| `pnpm test` (unit) | **64 files, 700 tests, 0 failures** |
| `pnpm test:contracts` | **10 files passed + 1 skipped, 54 tests + 1 skipped** |
| `pnpm build` | 11 workspace projects, all Done |
| `pnpm typecheck` | all Done |

The skipped contract is `agent-dispatch.live.contract.spec.ts` — it is
network-gated by design, not broken.

If the counts differ, **stop and reconcile before writing code.** They are the
baseline every claim in section 5 is measured against.

---

## 1. What this program is

`helium` is a reactive agent harness built as dsh plugins
(`@deepseek-ai/dsh@0.1.1-rc.2`), pnpm monorepo, running 24/7 on a Mac mini. The
approved program turns it into a provider-neutral, capability-routed, durable
multi-agent system with two reference teams: **Macro** (analysis) and **Ops**
(operations).

Four plan documents govern. Read them; do not implement from this note.

| Plan | Path |
|---|---|
| Multi-agent design | `docs/plans/2026-08-25-helium-multi-agent-design.md` |
| Multi-agent implementation (MA Tasks 1–20) | `docs/plans/2026-08-25-helium-multi-agent-implementation.md` |
| Master plan (phase sequencing, revisions) | `docs/plans/2026-08-25-helium-multi-agent-master-plan.md` |
| Ops design (incl. §3.1–3.6 audit) | `docs/plans/2026-08-25-helium-ops-agent-design.md` |
| Ops implementation (Ops Tasks 1–18) | `docs/plans/2026-08-25-helium-ops-agent-implementation.md` |

The predecessor handoff, which covers Phase 0's framing in depth, is
`docs/codex-handoffs/2026-08-26-helium-multi-agent-phase0-claude.md`. It is
still accurate about *why*; it is now stale about *what has shipped*.

---

## 2. Where the program actually is

```
MA Phase 0   Tasks 1–5              ✅ MERGED   PR #13
MA Phase 1   Tasks 6–11 + 10b       ✅ MERGED   PR #14
Ops Phase A  Tasks 1–4              ✅ MERGED   PR #15
Ops Phase B  Tasks 5–8 + 7b         ✅ MERGED   PR #16
Ops Phase C  Task 9                 🟡 committed on feat/ops-phase-c  (f12bf52)
             Task 10                🟡 PARTIAL — probes done, collector NOT  (153793e)
             Tasks 11, 12, 13a      ⬜ NOT STARTED
             Phase C gate + PR      ⬜ NOT STARTED
Ops Phase D  Tasks 14, 16, 17, 18   ⬜ NOT STARTED
MA Phase 2   Tasks 12–16            ⬜ NOT STARTED
MA Phase 3   Tasks 17–20            ⬜ NOT STARTED
Ops Phase E  Tasks 13b, 15 (P3.5)   ⬜ NOT STARTED
Production promotion                ⬜ OUT OF SCOPE — a separate plan, unwritten
```

**Production promotion is explicitly not in this program's scope.** Ops plan
§"Post-AC#1 production promotion plan" describes the gates; the plan that
executes them has not been written and must not be improvised.

---

## 3. What is done, precisely

### MA Phase 0 (PR #13) — certify the v1 boundary

The existing senior CLI lane was made safe to become one provider behind a
model-blind harness: restricted + isolated senior process, a **reusable
execution-boundary conformance harness** (not a one-off test), truthful mutation
policy at job load, delivery as a write-ahead state machine, per-tenant
liveness. `quota-exhausted` with an opaque `retryAfter` entered the failure
vocabulary here.

### MA Phase 1 (PR #14) — model-blind core

- **`contracts/tests/core-neutrality.contract.spec.ts`** is now the *single*
  definition of forbidden vocabulary. `packages/core/src` may name no provider
  (`deepseek`, `claude`, `anthropic`, `codex`, `openai`, `gpt-`, `gemini`) and
  no business domain (`livewire`, `argon`, `apex`, `colima`, `postgres`).
  Word-boundary match over camelCase-split identifiers. **There is no file
  allow-list and no comment exemption** — a doc comment that names Colima fails
  the build. This bit me once; see §7.
- **`packages/v1-compat/`** (new) holds everything that knows about v1: job
  YAML, the tool catalog, the MCP server, and `adaptV1Job`/`restoreV1Job`,
  whose round trip deep-equals the original for every shipped tenant.
- **`packages/core/src/`** gained `work.ts` (WorkOrder / ExecutionSnapshot /
  AgentResult, all `z.strictObject`), `event-store.ts`, `evidence/{bundle,
  ledger,manifest}.ts`, `capabilities.ts`, `router.ts`, `execution.ts`.
- **`packages/fake-metered/`** and **`packages/fake-flat-rate/`** are the two
  deliberately different fake executors: `process` + token-priced vs
  `in-process` + no cost or tokens at all.
- **`contracts/tests/topology-structure.contract.spec.ts`** — MA Task 10b, the
  structural half of the topology guard.

### Ops Phase A (PR #15) — contracts and fixtures

`packages/core/src/operations/`: `component.ts`, `observation.ts`,
`dependency-graph.ts`, `incident.ts`, `correlate.ts`, `check.ts`, `sop.ts`,
`action.ts`, `authority.ts`, `authority-manifest.ts`. Six fixtures in
`evals/fixtures/ops/`, all derived from the **documented read-only audit** in
Ops design §3.1–3.6.

### Ops Phase B (PR #16) — durable execution and reconciliation

`operations/`: `events.ts` (11 event schemas), `reducer.ts`, `store.ts`,
`lease.ts`, `recovery-budget.ts`, `component-lock.ts`, `mutation-owner.ts`,
`verify.ts`, `reconcile.ts`, `recovery-evidence.ts`. Plus the new
**`plugins/ops-agent/`** package with `script-registry.ts` (path + pinned
identity + argv schema, rehashed immediately before spawn) and
`script-executor.ts` (`spawn` with `shell:false`, process-group TERM→KILL,
returns a **receipt, never a verdict**).

`packages/core/tests/operations-crash-matrix.spec.ts` drives 8 crash points ×
invariants + torn-write variants (44 tests).

### Ops Phase C so far

**Task 9 — `f12bf52` "feat: load pluggable operations components"**
`plugins/ops-agent/src/config.ts` (bounded limits), `authority-manifest-loader.ts`,
`component-registry.ts` (atomic `install`), plus `ops/components/fixture.yaml`,
`ops/sops/fixture-observe.yaml`, `ops/authority-manifest.json` (empty entries,
signed by a throwaway key whose private half was never written to disk) and
`ops/authority-manifest.pub.pem`.

**Task 10 — `153793e` "feat: probe host memory, volumes and process liveness"
— STEPS 1, 2 AND THE PROBE HALF OF STEP 4 ONLY.**

Delivered:

| File | What it does |
|---|---|
| `probes/macos-resource.ts` + `.test.ts` | swap / `vm_stat` / load parsing; `pageoutRate` is `undefined` across a counter reset; `SUSTAINED_PAGEOUT_RATE = 500`; `classifyMemory` cannot reach `failed` without a computable rate |
| `probes/disk.ts` + `.test.ts` | `parseDf` (all-or-nothing), `classifyDisk` per volume, `checkMountIdentity` |
| `probes/process.ts` + `.test.ts` | liveness only; timeout or non-zero exit ⇒ `unknown`, never `failed` |

Also in that commit: `DECLARED_SENSOR_ROOTS` in the topology guard went from
`[]` to `["plugins/ops-agent/src/probes"]`, so the import-graph half walks a
real graph **for the first time in the program**. The guard's own assertion pins
the declared list, so the day it changes the change is visible.

---

## 4. What to do next — in order

### 4.1 Finish Ops Task 10 (Step 3 and the rest of Step 4)

Remaining files, from the plan's own file list:

- `plugins/ops-agent/src/collector.ts`
- `plugins/ops-agent/src/collector.test.ts`
- `ops/components/host.yaml`

Step 3, verbatim from `ops-agent-implementation.md:1341`:

> Run probes with exact argv and individual timeouts. Append observations to an
> **injected sink** owned by the future `helium-opsd` process; **the collector
> must not open a second authoritative event-log writer.** Calculate rates from
> consecutive samples only when counter continuity is valid. Monitor internal
> data, DATA_LAKE, Colima/Docker, backup, and Helium state volumes
> independently.

Two things that are easy to get wrong here:

1. **The sink is injected, not opened.** `OperationsStore` already exists
   (`packages/core/src/operations/store.ts`) and is the authoritative writer.
   The collector takes a sink interface as a constructor argument. If you find
   yourself calling `OperationsStore.open()` inside `collector.ts`, you have
   built the thing the plan forbids.
2. **Then add the collector to `DECLARED_SENSOR_ROOTS`.** `resolveRoots`
   currently only enumerates **directories** (`tsFilesUnder` calls `readdirSync`
   on the resolved path). `collector.ts` is a file at
   `plugins/ops-agent/src/`, whose sibling directory is the whole plugin —
   declaring `plugins/ops-agent/src` would pull `script-executor.ts` into the
   walk, and that module imports `node:child_process`, which the guard's
   `isProviderAdapter` heuristic rejects. **So you must extend `resolveRoots`
   to accept a file path**, or move the collector under a directory of its own.
   Extending `resolveRoots` is the smaller change; keep its "declared but
   missing is a HARD FAILURE" behaviour intact when you do.

Then update the `it("records which roots were declared at this run")` assertion
in the same file — it is deliberately a tripwire, not a formality.

### 4.2 Ops Tasks 11, 12, 13a

- **Task 11** (`:1370`) — Livewire, Argon, Apex observation adapters +
  `ops/components/livewire.yaml`
- **Task 12** (`:1428`) — Colima, PostgreSQL, Helium adapters
- **Task 13a** (`:1488`) — alert grouping + the admission decision function, as
  a **pure function**

Note the neutrality contract only scans `packages/core/src`. Adapters named
`livewire.ts` and `colima.ts` belong in `plugins/ops-agent/src/adapters/` and
are fine there — that separation *is* the design.

### 4.3 Ops Phase C gate, then PR

Gate (`:1553`):

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm test:e2e-local
git diff --check
```

Then produce `docs/evidence/p2.5c-manifest.yaml` following the protocol in §6,
open the PR, wait for CI, merge.

### 4.4 Then, in this order

Ops Phase D (Tasks 14, 16, 17, 18) → MA Phase 2 (Tasks 12–16) → MA Phase 3
(Tasks 17–20) → Ops Phase E / P3.5 (Tasks 13b, 15). Each ends at its own gate
with its own evidence manifest and its own PR.

Finally, the deliverable the user asked for at the top of this whole execution:
a summary table of **claim / evidence / how to re-verify**, with an explicit row
for anything that remains unverified and why.

---

## 5. Non-negotiable constraints

These are not style preferences. Several are load-bearing safety properties and
one is a hard external deadline.

### 5.1 The AC#1 observation window — ACTIVE UNTIL 2026-08-31

**Do not put a byte on the Mac mini. Do not start a process there. Not one
manual one-shot probe run.**

Ops design §13.4 Window 1: the boundary is the **host** and the test is
**presence**, not mutation. Merging this code is permitted; touching the machine
is not, until 2026-08-31 has passed and the AC#1 evidence is recorded.

This is why every command-output fixture in `probes/*.test.ts` carries a NOTE
saying it is an **authored shape, not a capture**. Keep that note on anything
you add. The numbers in the memory fixtures (16 GiB total, ~6.67 GiB swap) are
the audited ones; the *shapes* are not evidence about the machine, and the
P2.5a manifest records that limit.

### 5.2 Evidence discipline

- The verifier of a deterministic assertion is **a command + an exact version +
  an output hash**. Never a model. Never a second human.
- **Every `outputHash` must come from CI at the pinned Node version (22.19.0).
  A hash captured on a developer machine is not admissible.**
- `outputHash` is **not** a reproducibility invariant — captured output carries
  wall-clock durations, so the hash pins *that run*, nothing more.
- Composite hash convention: sha256 of artifacts concatenated **in the order the
  command runs them**.
- Status is judged against the claim's own `acceptanceBound`, not its ideal.
  **PROVEN** only when the artifact demonstrates everything the bound names;
  otherwise **PARTIAL**, with the missing half named explicitly.

### 5.3 Vocabulary and safety bans

- Never write **"exactly-once"** about a mutation or a delivery, except inside
  an explicit ban or denial statement.
- Never expose a generic shell tool to an Ops role.
- Never represent a **free-form command string** in a persisted action. Argv
  arrays, pinned scripts, nothing else.
- Treat probe output, logs, status pages and model text as **untrusted data**.
- **No test may invoke the real `launchctl`**, or load, unload or start a real
  job. Use `plugins/ops-agent/src/testing/fake-launchctl.ts`.
- **Time proximity is not action provenance.** This is the central rule the
  audited incident produced, and `operations/verify.ts` implements it.

### 5.4 Git protocol (from the user's global CLAUDE.md — these override defaults)

- **Never add `Co-Authored-By: Claude …`** or any other AI/tool attribution
  trailer. Write the commit message as if the user authored it.
- **Always open a PR before merging.** Never `git push origin master`.
- **Never merge before CI is green.** There is a pre-merge hook
  (`ci-green-before-merge.sh`) that enforces this; when it refuses, it is right.
  Wait for `IN_PROGRESS` checks to finish rather than racing them.
- **One change, one PR.** Follow-on fixes go as extra commits on the existing
  branch, never a new branch or a second PR.
- **No `--no-verify`.** Fix the hook's complaint instead.
- **Stage explicit paths.** Never `git add -A` or `git add .`.
- Worktrees live in `.worktrees/<branch-slug>/`. You are already in one.

---

## 6. The evidence protocol, concretely

Three manifests are already merged and are your worked examples:

```
docs/evidence/p0-manifest.yaml      7 claims — 5 PROVEN, 2 PARTIAL
docs/evidence/p1-manifest.yaml      6 claims — 4 PROVEN, 2 PARTIAL   run 33242395526 @ 5f879d8
docs/evidence/p2.5a-manifest.yaml   7 claims — 5 PROVEN, 1 PARTIAL, 1 BLOCKED   run 33244380149 @ 3b54957
docs/evidence/claims.yaml           20 rows across P0/P1/P2.5a
docs/evidence/{p0,p1,p2.5a}/*.log   captured CI step output
```

Procedure for a new phase:

1. Land the phase's code, get CI green.
2. `gh run view <id> --log` on the **merging tree's** run, extract the step
   output, save under `docs/evidence/<phase>/`.
3. sha256 the artifacts, in command order, into the manifest.
4. `pnpm test:contracts` — `claims-register.contract.spec.ts` re-hashes the
   artifacts and cross-checks them against the manifest.

**Trap that cost two CI cycles:** if you fix anything after capturing evidence,
the recorded run now describes a tree that never merged. Re-record from the tree
that actually merges. This happened twice (P1 and P2.5a) and it is worth an
explicit re-check before every PR.

**Caret notation:** `gh run view --log` emits SGR escapes as the two literal
bytes `^[` (0x5e 0x5b), **not** a real ESC (0x1b), and puts a UTF-8 BOM on line
1. Account for both when hashing or your hash will not reproduce.

---

## 7. Deviations from the plan already baked into merged code

Do not "fix" these back toward the plan text — each was surfaced, reasoned
about, and recorded in its PR.

| # | Deviation | Why |
|---|---|---|
| 1 | `FailureClass` → **`IncidentFailureClass`** in `operations/incident.ts` | TS2308: collided with `work.ts`'s `FailureClass` (why a *run* failed vs which observation state characterizes an *incident*) |
| 2 | `decideAuthority` takes evaluated **`checkResults`**, not raw observations | Authority must not re-derive check semantics |
| 3 | `manifest-entry-missing` (was `sop-not-listed`) | Names the actual condition |
| 4 | `EvidenceManifestSchema`: `outputHash` **optional**; required + ≥1 artifact only for PROVEN/PARTIAL/FAILED; **refused** for PLANNED/BLOCKED | A BLOCKED claim has no run — requiring a hash would force a fabricated value. P0/P1 manifests still validate unchanged |
| 5 | `ConformanceRecord.basis: "floor"` alongside `"execution-boundary-conformance"` | The boundary suite reads a report written by a spawned child, so it structurally cannot grade an **in-process** executor. Sound because the suite catches *over*-claims and `in-process` is the floor |
| 6 | `Executor.run()` takes a third **`ExecutionContext`** argument the plan's sketch omits | The harness grades on workspace/env containment |
| 7 | The claims register **re-hashes artifacts and cross-checks the manifest**; it does not re-run commands and compare output hashes | Re-running is non-reproducible (durations) and would recurse. Documented in the register header, the contract test, the commit and the PR |
| 8 | In-test loops instead of `--repeat` | **`--repeat`/`--repeats` is not a vitest 3.2.7 CLI flag** (`CACError: Unknown option`). In-test loops are strictly stronger — they compare *across* iterations. The merged P1 manifest's `reproduction` for `P1-CATALOG-REPLAY` was corrected for this |
| 9 | `openEventStore(dir, {sync})` — `noSync` injected in semantic tests | Every append did a real `fsync`; across 36 unit files this flaked CI at the 5000 ms timeout. One real-fsync case remains, at a 30 s timeout, plus a spy test |

---

## 8. Landmines that actually bit me

1. **Neutrality fails on comments.** `operations/reducer.ts` had "the audited
   Colima incident taught…" in a module doc comment and went red. There is no
   comment exemption, by design. Say "container-runtime" in core.
2. **`tsc` never deletes removed outputs.** A test passed against
   `packages/core/lib/mcp/server.js` dated *before* the file moved to
   `v1-compat`. Stale `lib/` gives false passes. Note that
   `tsconfig.tsbuildinfo` lives *outside* `lib/`, so adding `rm -rf lib` to the
   build script would make tsc skip emit entirely — deliberately **not** added.
3. **Barrel exports are load-bearing.** A missing re-export in
   `packages/core/src/index.ts` surfaces as
   `(0, canMutate) is not a function` at runtime, not as a type error.
   `contracts/package.json` also needed `@helium/core` and `yaml` added.
4. **Regexes that span statement boundaries.** A DOTALL import-rewriting regex
   swallowed adjacent import statements. Use a character class that cannot cross
   a `;`.
5. **Vacuous assertions.** I wrote, and had to replace,
   `Object.keys({} as Record<string, unknown>)` — it asserts nothing and passes
   forever. Same class of bug as an `expect(x).not.toContain(path)` where `path`
   is absent from the tree. The topology guard's "declared but missing is a HARD
   FAILURE" rule exists specifically to prevent this, and that rule is itself
   under test.
6. **`jobs/macro-watch.yaml` declares 4 triggers, not 3** — the plan text says
   3 and is stale. Assert against the file.
7. **The macro-watch prompt contains the string "IF YOU ARE THE TRIAGE MODEL"**,
   which trips a naive provider-identity scan. The scan excludes
   `inputs.prompt` and separately asserts the prompt is still carried.

---

## 9. Command reference

```bash
pnpm build                 # 11 workspace projects
pnpm typecheck
pnpm test                  # unit — 64 files / 700 tests at 153793e
pnpm test:contracts        # 10 passed + 1 skipped / 54 tests + 1 skipped
pnpm test:e2e-local

# one file
pnpm exec vitest run --project unit plugins/ops-agent/src/collector.test.ts
pnpm exec vitest run --project contracts contracts/tests/topology-structure.contract.spec.ts
```

There is **no `test:unit` script**; the unit project is what bare `pnpm test`
runs. (I tried `pnpm test:unit` and pnpm suggested `test:contracts`.)

---

## 10. One-line summary

Ops Phase C is half-built on `feat/ops-phase-c`: the component registry and all
three host probes are done, tested and committed; **the collector, the three
adapter tasks, the Phase C gate and the PR are not.** Start at §4.1, and
remember §5.1 — the mini is untouchable until 2026-08-31.
