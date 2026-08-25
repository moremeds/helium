# Helium Multi-Agent Master Plan

**Date:** 2026-08-25

**Status:** Approved program direction

**Production constraint:** Do not change the mini during the active AC#1
observation window

## Executive summary

Helium v1 has proven the operational substrate required for an unattended agent
harness: release, rollback, retention, tenant isolation, heartbeats, dead-man
monitoring, selective escalation, append-only state, and delivery. The next
program will preserve that substrate while replacing the fixed two-engine path
with a durable, provider-neutral multi-agent system.

The target is not a swarm of named models. Helium core will not know whether an
execution target is DeepSeek, Claude, Codex, a local model, or a future
provider. Teams declare roles and capability requirements. Provider plugins
register measured execution targets. A capability router selects an eligible
target using safety constraints, task evaluations, budget, latency, reliability,
and bounded operator preferences.

The team controller will own durable cases, identities, task DAGs, messages,
artifacts, budgets, cancellation, recovery, verification, and delivery. Agents
will run in isolated contexts and exchange structured evidence. Cross-reference
will compare claims and re-check evidence; it will not treat model majority as
truth.

The macro system is the first pilot. It will preserve the causal sequence from
inflation through rates and USD to gold, run in shadow mode against the existing
single-senior lane, and be promoted only when it demonstrates better evidence
quality without violating safety, recovery, latency, or cost gates.

## Program outcome

The program is complete when Helium can:

- install or remove an execution provider without editing core;
- run the same team definition against different model catalogs;
- dynamically route work by measured capability;
- coordinate multiple isolated agents through durable tasks and messages;
- survive process restart without duplicate work or delivery;
- cross-check material claims using fresh evidence;
- audit every decision back to an exact execution snapshot;
- bound cost, time, tools, spawning, and mutations;
- preserve the v1 compatibility path and rollback; and
- add a new ecosystem team without changing core.

## Program rules

1. No direct push to `master`; every phase lands through a green pull request.
2. No deployment to the mini during the AC#1 observation window.
3. No multi-agent expansion before the senior execution boundary is certified.
4. No production dependency on unpublished DSH experimental packages.
5. No provider or model names in core schemas or branching logic.
6. No model majority vote as an acceptance mechanism.
7. No externally material mutation without deterministic policy and approval.
8. No promotion based only on unit tests; restart, failure, and live shadow
   evidence are required.

## Delivery strategy

Each phase is independently mergeable and preserves a usable system. V1 remains
the production path until the shadow team passes its promotion gate.

```text
P0 hardening
   -> P1 provider-neutral contracts
   -> P2 durable team kernel
   -> P3 macro shadow team
   -> P4 controlled production promotion
   -> P5 ecosystem plugin expansion
   -> P6 evaluated evolution
```

## Phase 0: certify the existing boundary

### Objective

Make the current senior lane safe enough to become one possible execution
provider in a multi-agent system.

### Work

- Replace approval-only tool flags with actual tool restriction.
- Isolate provider settings, MCP configuration, instructions, environment, and
  working directory.
- Give each execution an owned workspace.
- Unify timeout, process-tree termination, drain, and orphan detection.
- Convert delivery to write-ahead intent plus outcome records.
- Implement or remove the non-functional mutation option.
- Validate tool names against the installed catalog.
- Add expected-tenant and per-tenant liveness checks.
- Add adversarial tests for undeclared tools, paths, settings, and MCP servers.

### Exit gate

- An execution target cannot access anything outside its declared contract.
- A forced timeout leaves no process or task running.
- A crash at every delivery boundary leaves a reconciliable ledger.
- A misspelled capability rejects only the affected tenant and raises its
  health state.
- Existing v1 tests and behavior remain green.

### Deployment rule

Development and review may proceed on an isolated branch. Release or mini
deployment waits until AC#1 closes and its evidence is recorded.

## Phase 1: provider-neutral contracts

### Objective

Remove model knowledge from core and introduce stable plugin seams without
changing production behavior.

### Work

- Define `WorkOrder`, `CapabilityContract`, `RoutingPolicy`, `ExecutionLease`,
  `AgentResult`, and normalized failure schemas.
- Define provider registration and executor services on DSH/Cordis seams.
- Define the versioned capability ontology and catalog schema.
- Implement a fake provider as the core contract reference.
- Implement a v1 compatibility adapter that reproduces the current certified
  path.
- Add a source/contract guard that rejects provider names from core schemas and
  logic.
- Record provider runtime metadata as opaque audit data.
- Define the privileged exact-target override for replay, evaluation,
  certification, incident diagnosis, and emergency failover.

### Exit gate

- The full core suite runs with only the fake provider installed.
- Adding a provider changes no core or team code.
- Removing every production provider does not prevent core boot or tests.
- The same work order resolves against at least two different test catalogs.
- V1 compatibility tests remain behaviorally unchanged.

## Phase 2: durable team kernel

### Objective

Create the control plane required for true multi-agent execution.

### Work

- Add append-only `Case` and `TeamRun` state.
- Add stable roster identities and role contracts.
- Add a versioned, compare-and-swap task DAG.
- Add durable queue-then-acknowledge mailboxes.
- Add immutable artifact manifests, hashes, and provenance.
- Add case, team, and agent budget ledgers.
- Add bounded spawn, follow-up, status, interrupt, list, cancel, and drain.
- Integrate DSH subagents through named provider plugins.
- Add snapshots and deterministic replay from JSONL.
- Add cascading cancellation and restart reconciliation.
- Detect dependency cycles, stale task writes, duplicate messages, expired
  leases, and orphan attempts.

### Exit gate

Run a deterministic failure matrix that kills the controller:

- before and after task assignment;
- before and after message acknowledgement;
- during provider execution;
- during artifact publication;
- during cancellation; and
- before and after delivery intent.

Every restart must converge without duplicate tasks, messages, artifacts,
budget charges, or external delivery. Cancellation must leave no descendant
agent or provider process alive.

## Phase 3: capability routing and macro shadow team

### Objective

Prove that capability-routed multi-agent work adds information and quality over
the v1 single-senior control.

### Capability-routing work

- Register multiple provider adapters behind the same executor contract.
- Seed capability metadata from provider documentation.
- Build Helium evaluations for research, causal reasoning, coding,
  verification, executive writing, structured output, latency, cost, and tool
  isolation.
- Store score confidence, sample count, evaluation version, and timestamp.
- Implement hard filtering, weighted scoring, bounded preferences, fallback,
  reservation, and routing audit.
- Detect capability shortage without silently relaxing requirements.
- Support task-scoped cross-reference and adjudication policy.

### Macro team

Use a deterministic causal DAG:

1. inflation evidence;
2. policy evidence;
3. rates path;
4. USD transmission;
5. gold impact;
6. optional portfolio implications;
7. independent evidence verification;
8. lead synthesis; and
9. final rendering.

Roles declare capabilities only. The router may select different execution
targets for the same role on different runs.

### Shadow constraints

- No production email.
- No trading or ecosystem mutation.
- No replacement of the v1 senior lane.
- The same source event feeds control and shadow runs.
- Every claim carries provenance or is explicitly marked as judgment.

### Evaluation set

Include:

- frozen historical macro cases;
- production events with known follow-up outcomes;
- conflicting-source cases;
- stale-source and missing-source cases;
- prompt-injection fixtures;
- provider timeout and degradation drills;
- restart and cancellation drills; and
- real material events observed during the shadow period.

### Metrics

- task acceptance rate;
- verified-claim rate;
- unsupported-claim rate;
- contradictions discovered and correctly resolved;
- unique evidence introduced;
- source diversity and freshness;
- false escalation and missed materiality;
- structured-output fidelity;
- unauthorized tool attempts;
- latency, token use, and cost;
- restart recovery; and
- human preference by artifact type.

### Exit gate

- Zero unauthorized capability calls.
- All material factual claims have traceable provenance.
- Restart and cancellation contracts pass.
- The multi-agent path provides a measured quality or information advantage
  over the control on the predefined evaluation set.
- The accepted cost and latency envelopes are documented before promotion.
- No criterion is passed solely because several models agree.

## Phase 4: controlled production promotion

### Objective

Promote the macro team without losing the v1 fallback or operational controls.

### Work

- Release behind a runtime flag.
- Start with review-only artifacts and human approval.
- Canary a bounded subset of material macro cases.
- Keep v1 as immediate fallback.
- Add team, agent, task, mailbox, budget, and provider health surfaces.
- Add provider-specific circuit breakers without leaking provider identity into
  core policy.
- Exercise tagged rollback and state-schema compatibility.

### Exit gate

- Five uninterrupted trading days.
- At least one real end-to-end material macro case.
- Continuous process and per-tenant liveness.
- No unexpected dead-man alert.
- No duplicate delivery or orphan agent.
- Rollback within 60 seconds.
- Exact execution and evidence lineage available for every delivered claim.

## Phase 5: ecosystem plugin expansion

### Objective

Prove that Helium is an ecosystem harness rather than a macro-specific runner.

### Candidate teams

- operations and service health;
- fundamental research;
- options and market-structure research;
- release and compatibility analysis; and
- document production.

### Plugin package contract

Each team package owns:

- event adapters;
- roles and capability requirements;
- task graph templates;
- domain tools;
- artifact and claim schemas;
- verification policy;
- evaluations; and
- delivery policy.

It does not own model selection or modify core.

### Exit gate

- Install or remove a team package without core changes.
- A new one-file team manifest is validated and activated within 30 minutes.
- A bad team remains isolated and raises per-tenant health.
- At least two non-macro teams run through the same durable kernel.

## Phase 6: evaluated evolution

### Objective

Let the harness learn from production without allowing uncontrolled
self-modification.

### Work

- Convert trajectories and outcomes into offline evaluation cases.
- Detect capability regressions and routing drift.
- Generate candidate prompt, skill, model-profile, and routing changes.
- Validate candidates against task, safety, retention, and adversarial suites.
- Promote through normal branches, review, CI, and tagged releases.
- Keep permissions, approval rules, audit policy, and safety gates outside the
  self-modifiable surface.

### Exit gate

- Every promoted change has reproducible before/after evaluation evidence.
- No production run changes the active safety root or routing policy directly.
- Rollback restores both code and compatible policy/catalog snapshots.

## Cross-phase contract suites

### Core neutrality

- no production provider/model names in core source or schemas;
- fake-provider full suite;
- provider install/remove without core edits;
- exact execution audit retained.

### Isolation

- undeclared tool denial;
- undeclared path denial;
- global setting and MCP denial;
- environment-secret isolation;
- mutation fail-closed.

### Durability

- event-log replay;
- task and message idempotency;
- budget idempotency;
- crash matrix;
- cancellation and orphan detection;
- delivery reconciliation.

### Team quality

- evidence provenance;
- contradiction handling;
- new-information measurement;
- schema fidelity;
- control-versus-team comparison;
- provider-degradation fallback.

## Risk register

| Risk | Consequence | Control |
|---|---|---|
| Provider permissions are approval-only | Agents gain undeclared capability | Certified provider isolation contracts |
| Model names leak into core | Plugin architecture collapses into switches | Core neutrality guard and fake-provider suite |
| Capability scores become reputation scores | Router makes unjustified choices | Versioned task evals with confidence and samples |
| Cross-reference becomes majority vote | Shared error appears trustworthy | Claim comparator and fresh-evidence adjudication |
| Shared workspace creates conflicts | Corruption and information leakage | Private workspaces and immutable artifacts |
| Manager becomes bottleneck | Bad decomposition limits the team | Deterministic DAG validation and independent verifier |
| Agent spawning runs away | Cost and latency explosion | Depth, count, time, token, and monetary budgets |
| Restart duplicates work | Duplicate side effects and inconsistent state | Append-only state, leases, idempotency, reconciliation |
| Experimental DSH API changes | Production breakage | Pin, contract suite, adapters, no unpublished dependency |
| V1 and v2 drift | Rollback becomes unsafe | Frozen compatibility adapter and dual-path tests |

## PR and release discipline

Recommended PR sequence:

1. Documentation and accepted architecture
2. P0 execution and audit hardening
3. Provider-neutral contracts and fake provider
4. V1 compatibility adapter
5. Durable case/task/mailbox kernel
6. DSH subagent integration and recovery
7. Capability catalog, evaluations, and router
8. Macro shadow team
9. Production canary and promotion
10. Ecosystem team plugins

Each PR must be independently green and reversible. Merge commits or the
repository's established PR convention preserve drill and release history.
After merge, local `master` is fetched and aligned to the remote merge commit.

## Immediate next action

Do not deploy during AC#1. Land the reviewed design and implementation plan,
then prepare Phase 0 on an isolated feature branch. The first code change must
be an executable failing contract for the current senior isolation gap, not a
new multi-agent feature.
