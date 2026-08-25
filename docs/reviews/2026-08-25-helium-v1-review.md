# Helium v1 Architecture and Production Review

**Review date:** 2026-08-25

**Repository baseline:** `d82e45c` on `master`

**Production release observed:** `v0.1.5`

**Review type:** repository, tests, read-only production state, and external
architecture comparison

## Executive verdict

Helium v1 is a strong operational foundation and a good first harness. Its
release engineering, failure detection, tenant isolation, evidence trails, and
two-lane cost control are more mature than its agent abstraction.

The current system is configurable but not fully pluggable. Jobs can select
triggers and tools, but the core job contract hard-codes two engine types,
limited memory modes, a fixed escalation topology, and one delivery shape. It
is a reliable single-agent runner, not yet a true multi-agent system.

Helium should be evolved rather than rewritten. The highest-value next step is
to secure the existing senior execution boundary, then introduce a model-blind
core with provider-neutral capability routing and a durable team control plane.

## Evidence reviewed

- source under `packages/core`, `plugins/helium`, `jobs`, `scripts`, `profile`,
  and `contracts`;
- `docs/specs/2026-08-23-helium-design.md`;
- `docs/superpowers/plans/2026-08-23-helium-v1.md`;
- release history and tags `v0.1.0` through `v0.1.5`;
- a read-only mini check performed on 2026-08-24 at approximately 15:32 UTC;
- the local `ai-agent-book` repository;
- official DeepSeek Harness architecture, subagent, workflow, and Agent Teams
  documentation; and
- current Claude CLI and OpenAI model documentation.

No production mutation was performed during the review.

## What is good

### Production operations

- Tagged release directories with `current` and `previous` rollback pointers
- Retention exercised in production
- Loopback-only UI
- Launchd supervision
- Continuous heartbeat, canary, and dead-man paths
- Tested rollback well inside the acceptance bound
- Tenant failure isolation
- Deterministic one-file tenant onboarding

These are genuine production qualities. The phase produced failures that local
testing would not have exposed, including package-manager override behavior and
a malformed tenant taking down the runtime. The resulting controls are valuable
assets for the multi-agent program.

### V1 agent shape

The low-cost triage and selective senior escalation pattern is appropriate for
an always-on research harness. It prevents every unchanged heartbeat from
consuming the most expensive lane and creates a clear place for materiality
policy.

### Verification culture

At review time the following local checks passed:

- build;
- typecheck;
- 161 unit tests;
- contract suite, with the live-agent test correctly opt-in;
- local end-to-end suite.

The repository also preserves release drills and production evidence instead
of treating a green unit suite as proof of unattended behavior.

## Production snapshot

The read-only check found:

- `current -> v0.1.5` and `previous -> v0.1.4`;
- the DSH process running;
- the UI returning HTTP 200;
- dead-man's latest exit equal to 0;
- continuous current-day heartbeats;
- three loaded jobs: `macro-watch`, `apex-health`, and `dsh-canary`.

AC#1 was not yet complete. The observation window began on 2026-08-25, and the
recent senior/email row seen in the check belonged to the acceptance fixture,
not a real macro analysis. This document does not promote that pending gate to
PASS.

Raw log tails contained historical drill failures and deliberate alert text.
Operational health must therefore be evaluated from time-correlated structured
records, not from an unqualified tail of stderr.

## Findings

### P0: the senior tool boundary is not restrictive

`plugins/helium/src/claude.ts` passes `--allowedTools` only when the configured
list is non-empty. In the installed Claude CLI, `--allowedTools` controls tools
that may run without prompting; it does not remove other tools. The restrictive
flag is `--tools`.

The child also lacks strict MCP and setting-source isolation, and
`plugins/helium/src/index.ts` uses the parent process working directory for
every senior job. The process may therefore inherit built-in tools, settings,
MCP servers, instructions, and repository context outside the job contract.

This must be fixed before a senior agent can spawn other agents. Multiplying an
uncertified capability boundary multiplies the risk.

**Required proof:** an adversarial contract demonstrates that an execution
target cannot call any undeclared tool, see any undeclared MCP server or setting
source, or read outside its mounted workspace.

### P1: delivery is not write-ahead

`plugins/helium/src/delivery.ts` attempts SMTP before appending the first
delivery row, despite the adjacent comment saying "Append FIRST." A crash or
hung transport between the side effect and the append can produce an email with
no corresponding attempt record.

**Required fix:** append immutable delivery intent first, perform the side
effect with an idempotency key, then append outcome or reconciliation state.

### P1: `allowMutations` is not connected to execution

The job schema accepts `allowMutations`, and comments describe a per-job
mutating senior boundary. The generated MCP configuration always sets
`HELIUM_ALLOW_MUTATIONS` to `0`; the flag cannot enable the documented behavior.

**Required fix:** either implement an isolated per-execution mutation boundary
or remove the option until it is real. A configuration field must not imply a
permission the runtime cannot enforce.

### P1: tool names are not validated against the installed catalog

The job schema accepts arbitrary strings. The MCP selection layer filters the
catalog, allowing a misspelled tool to disappear silently instead of rejecting
the tenant.

**Required fix:** validate requested capabilities during tenant loading and
report the unknown name as a tenant-specific health failure.

### P1: global liveness can hide a dead tenant

A malformed tenant is correctly skipped without stopping healthy tenants, but
healthy heartbeats may keep global dead-man state fresh. A user can therefore
lose one important job without a structural missing-tenant alert.

**Required fix:** maintain expected-tenant manifests and per-tenant liveness
deadlines in addition to global process health.

### P1: v1 is job-configurable, not harness-pluggable

`JobSpec` hard-codes:

- the supported trigger union;
- a DeepSeek triage engine;
- a Claude Max senior engine;
- fresh sessions;
- two memory modes; and
- JSONL plus optional email delivery.

The monolithic Helium Cordis plugin is internally organized but does not expose
provider contracts for triggers, execution targets, artifact stores,
verification, or delivery.

**Required redesign:** core task contracts express capabilities and constraints;
provider plugins register implementations at service seams.

### P2: timeout and process-tree behavior needs one contract

Script execution kills a process group, while the Claude child path targets the
direct process. A timed-out in-process promise may also continue working after
the scheduler has classified the attempt as finished.

**Required fix:** all execution providers implement the same cancellation,
drain, orphan detection, and timeout contract.

## Comparison with strong harness practice

The *AI Agent Book* frames production harness engineering as context, tools,
constraints, verification, and correction. Helium v1 is strongest in correction
and operational recovery, partially complete in verification, and currently
weakest at enforcing the declared execution constraints.

The book's multi-agent design emphasizes isolated contexts, explicit messages,
durable artifacts, task control, cancellation, budgets, and new information.
Helium v1 has durable job evidence but none of the team coordination primitives
yet.

DSH already supplies the correct lower-level direction: plugin service seams,
durable sessions, and subagent lifecycle operations. Helium should consume
those primitives and own only domain cases, team policy, evidence, delivery,
and production recovery. It should not build a competing agent loop.

The experimental DSH Agent Teams documentation provides useful semantics for
rosters, mailboxes, task revisions, and replay, but its current packaging and
limitations make it unsuitable as a production dependency for this release.

## Final recommendation

Preserve the v1 runtime as a compatibility lane and control group. Sequence the
program as follows:

1. close the P0 execution boundary and write-ahead gaps;
2. introduce provider-neutral contracts and capability routing;
3. build durable case, task, mailbox, budget, cancellation, and recovery state;
4. run a causal macro team in shadow mode against the existing senior lane;
5. promote only after evidence quality, safety, cost, and recovery gates pass;
6. open the same plugin contracts to the rest of the ecosystem.

The detailed architecture and delivery gates are defined in:

- `docs/plans/2026-08-25-helium-multi-agent-design.md`
- `docs/plans/2026-08-25-helium-multi-agent-master-plan.md`

## References

- <https://github.com/bojieli/ai-agent-book>
- <https://deepseek.com/harness/en/>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md>
- <https://code.claude.com/docs/en/cli-reference>
- <https://developers.openai.com/api/docs/guides/latest-model>
