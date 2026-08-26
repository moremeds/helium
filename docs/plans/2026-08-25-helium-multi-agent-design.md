# Helium Multi-Agent Design

**Date:** 2026-08-25

**Last revised:** 2026-08-26 — canonical topology and verification evidence

**Status:** Approved architecture direction

**Scope:** Helium v2 control plane, provider boundary, capability routing, and
multi-agent execution

## 1. Decision

Helium will evolve from a configurable two-lane runner into a durable,
pluggable multi-agent control plane.

The central invariant is:

> **Helium core is model-blind.** Core code does not know provider names, model
> names, model families, authentication methods, or transport protocols.

Core describes work as capabilities, constraints, budgets, evidence contracts,
and acceptance criteria. Provider plugins maintain the execution inventory and
translate an opaque execution lease into a concrete model invocation.

This is model-blind decision-making, not model-blind auditing. Every completed
run must still record the exact provider, model version, configuration, cost,
and capability snapshot supplied by the provider so it can be reproduced and
investigated.

## 2. Why this design

Helium v1 proved the operational foundation:

- unattended execution on the mini;
- tagged release and rollback;
- heartbeat, canary, and dead-man monitoring;
- tenant isolation;
- append-only state and report delivery;
- low-cost triage with selective senior escalation; and
- contract and end-to-end verification.

It is not yet a true multi-agent system. A v1 job selects two hard-coded engine
types and passes one prompt through a fixed sequence. It has no durable agent
identity, task graph, mailbox, cross-agent cancellation, team budget, or
restart-safe coordination.

The v2 design preserves the working operational substrate while replacing the
fixed engine path with provider-neutral team execution.

## 3. Design principles

1. **Roles describe work; capabilities describe executors.** A role never names
   a vendor or model.
2. **Providers live at the edge.** Adding or removing a provider does not change
   core packages or team definitions.
3. **Isolation is the default.** Agents do not inherit another agent's full
   context, tools, settings, or mutable workspace.
4. **Communication is explicit.** Teams exchange structured messages and
   immutable artifact references.
5. **Agents propose; deterministic gates commit.** Models cannot authorize
   delivery, mutation, budget escalation, or state transitions by prompt alone.
6. **Cross-reference is evidence work, not voting.** Agreement among models is
   not proof. Important contradictions are resolved against fresh evidence.
7. **Routing is measured.** Provider marketing and operator preferences may
   seed metadata, but representative Helium evaluations determine capability
   scores.
8. **Durability precedes autonomy.** A team must survive restart and cancellation
   without duplicate tasks, messages, deliveries, or orphan processes.
9. **Compatibility is explicit.** Existing v1 jobs continue through a versioned
   adapter until their behavior is deliberately retired.

## 4. Scope and non-goals

### In scope

- provider-neutral agent and team definitions;
- capability catalog and routing;
- durable cases, rosters, tasks, messages, and artifacts;
- DSH-native subagent execution;
- configurable cross-reference and adjudication;
- per-case, team, and agent budgets;
- cancellation, recovery, replay, and observability;
- the macro team as the first shadow-mode pilot; and
- migration of v1 jobs through a compatibility adapter.

### Not in scope for the first release

- multi-host scheduling;
- autonomous trading mutations;
- unbounded peer-to-peer agent spawning;
- online self-modification of routing or safety policy;
- a general-purpose workflow language;
- dependence on the unpublished DSH experimental Agent Teams package; or
- replacing the current release, rollback, heartbeat, and dead-man machinery.

## 5. System architecture

```text
External systems and schedules
             |
             v
        Event plane
      immutable CaseEvent
             |
             v
     Helium team controller
  Case / roster / task DAG / mailbox
             |
             v
      Capability router
   WorkOrder -> ExecutionLease
             |
             v
      Executor registry
       opaque target ref
             |
             v
       Provider plugin
 concrete model / transport / sandbox
             |
             v
   AgentResult + evidence artifacts
             |
             v
  Verification and delivery gates
```

### 5.1 Event plane

Sensors normalize filesystem changes, calendars, cron schedules, webhooks, and
future streams into immutable `CaseEvent` records. A sensor does not call a
model directly. Deduplication and materiality rules decide whether an event
opens, updates, or closes a case.

### 5.2 Team control plane

The Helium-owned controller maintains:

- `Case` lifecycle;
- `TeamRun` identity and roster;
- versioned task DAG;
- durable mailbox;
- artifact manifest;
- token, time, tool, and monetary budgets;
- cancellation tree;
- delivery state; and
- restart recovery.

The controller is deterministic. An agent may propose tasks or dependencies,
but schema validation, budgets, cycle detection, permissions, and compare-and-
swap revisions govern whether the proposal becomes state.

### 5.3 Agent execution plane

DSH subagents provide isolated execution, named providers, follow-up,
interrupt, list, drain, and cold-resume primitives. Helium does not build a
second model loop. It adds domain-specific durability and policy around the DSH
execution seam.

The experimental DSH Agent Teams design is useful as a semantic reference for
rosters, mailboxes, and task ownership, but Helium will not require an
unpublished package for production.

### 5.4 Evidence plane

DSH session events remain the model-trajectory record. Helium owns the business
record:

- cases;
- tasks and revisions;
- message envelopes;
- artifact manifests and hashes;
- claim sets;
- verification decisions;
- budget charges; and
- delivery attempts and outcomes.

Business records are append-only JSONL in the first implementation, with
snapshots for faster recovery. External side effects use write-ahead intent and
append-only outcome rows.

### 5.5 Canonical agent and verification-evidence topology

This section is normative. The master plan and reference-team plans may
summarize it, but they must link back here and may not define a competing
topology.

The canonical agent topology is:

```text
CaseEvent
  -> deterministic Team Controller
  -> WorkOrder + CapabilityContract
  -> Capability Router
  -> opaque ExecutionLease
  -> Provider Edge
  -> isolated Agent identity
  -> AgentResult + ClaimSet + ArtifactManifest
  -> deterministic Verification Gates
  -> AcceptedClaimLedger
  -> DeliveryIntent -> DeliveryOutcome
```

Provider and model names are not stable topology roles. The provider edge may
resolve a lease to any installed, eligible execution target. Team manifests
may add, remove, or reorder capability-defined agent tasks, but sensors,
controller state transitions, routing eligibility, evidence acceptance,
authority, and delivery remain deterministic control-plane responsibilities.

A run qualifies as multi-agent only when the requirements in Section 10 are
met. Calling several providers for three similar answers is neither required
nor sufficient. Independence must come from distinct identities, isolated
context, explicit task ownership, durable messages, and verification that can
introduce fresh evidence.

The canonical verification-evidence topology is:

```text
Claim, capability assertion, or incident assertion
  -> raw evidence
  -> reproduction or replay
  -> root-cause record, when applicable
  -> fix, control, or disposition
  -> regression or adversarial proof
  -> production or bounded-shadow verification
  -> remaining limitations
  -> accepted evidence decision
```

An evidence policy declares which stages are required for each assertion
class. A non-applicable stage requires an explicit reason; it is never silently
omitted. Evidence decisions use only these durable statuses:

| Status | Meaning |
|---|---|
| `PLANNED` | work or proof is specified but has not run |
| `PARTIAL` | some required proof exists and the missing proof is named |
| `PROVEN` | every required proof is present, fresh enough, and accepted by its verifier |
| `FAILED` | a required assertion or acceptance bound was disproved |
| `BLOCKED` | the next proof cannot currently run and the external blocker is named |

`AgentResult` success does not imply `PROVEN`. The accepted ledger stores the
assertion, assertion class, evidence policy and version, raw artifact hashes,
reproduction command or procedure, verifier identity and version, decision,
freshness, limitations, and exact execution snapshot. Material factual claims
cannot reach delivery without accepted provenance. A renderer may report a
clearly labelled `PARTIAL`, `FAILED`, or `BLOCKED` conclusion, but cannot
promote its status or add a fact outside the accepted ledger.

Every topology node has a testable contract:

| Node | Required durable output | Fail-closed state |
|---|---|---|
| Sensor | immutable, freshness-bounded event or observation | `unknown`, never a model call |
| Controller | case, roster, DAG, mailbox, budgets, revision | no task advance |
| Router | candidates, exclusions, policy snapshot, lease | capability shortage |
| Provider edge | result plus adapter-attested execution snapshot | normalized execution failure |
| Agent task | schema-valid result, artifacts, claims, limitations | schema invalid |
| Comparator | agreement, contradiction, unique and missing evidence | verification task required |
| Verifier | independently acquired proof and decision | not accepted |
| Delivery gate | accepted-ledger and intent references | no delivery |

Every edge carries provenance, content hash, schema version, producer,
consumer, creation time, freshness or expiry, authorization when applicable,
and replay/idempotency identity. A test must prove that no sensor can bypass the
controller to call a provider and that no agent can bypass verification,
authority, or delivery gates.

Operations specialize the same topology without putting a model in the safety
path:

```text
Observation -> Incident -> SOP eligibility -> Authority decision
  -> Action lease -> Write-ahead intent -> exact-argv executor -> Receipt
  -> Postconditions -> Attribution -> Incident closure
```

`helium-opsd` owns this deterministic chain and is not an agent. Optional Ops
agents may diagnose, challenge evidence, or render a report, but cannot create
eligibility, authority, action, recovery, or attribution facts.

Finally, each agent-capable node must carry an `AutonomyDecisionRecord` with
the deterministic-baseline coverage, ambiguity, measured agent lift, failure
cost, verification strength, latency and cost delta, and human-takeover rule.
Use a workflow when the deterministic baseline satisfies the acceptance bound;
use an agent only when a versioned evaluation shows material lift and the
result can be independently verified; require a human when the risk or
remaining uncertainty exceeds the configured authority.

## 6. Model-blind core contracts

### 6.1 WorkOrder

A `WorkOrder` describes the work without identifying an executor:

```yaml
role: final-document-producer
task_class: documentation.executive-summary

requires:
  writing.executive: high
  evidence.synthesis: high
  instruction_following: high

constraints:
  tools: [artifact_read]
  mutations: forbidden
  max_cost: 2.00
  max_latency_ms: 180000

inputs:
  artifacts: [claim-ledger-ref]

acceptance:
  output_schema: executive-document-v1
  verifier: factual-claims-required
```

Core-owned schemas must not contain fields such as `engine`, `provider`,
`model`, `model_family`, API endpoint, CLI name, or authentication method.

### 6.2 ExecutionLease

The router resolves a work order into an opaque, expiring lease:

```text
CapabilityRouter.resolve(workOrder, policy) -> ExecutionLease
Executor.run(executionLease, workOrder)      -> AgentResult
```

Core may inspect the lease ID, expiry, reserved budget, and declared capability
contract. It may not branch on the execution target's implementation identity.

### 6.3 AgentResult

The provider returns:

- schema-validated result content;
- structured evidence and artifact references;
- usage and timing;
- normalized completion or failure classification;
- opaque provider runtime metadata; and
- a provider-adapter-attested execution snapshot for audit, cryptographically
  signed only when the transport supports a trustworthy signature.

Core persists the runtime metadata without interpreting provider-specific
fields.

## 7. Provider and execution catalog

A provider plugin is responsible for:

- authentication and entitlement;
- discovering or configuring execution targets;
- exact model and transport selection;
- prompt and tool adaptation;
- sandbox, setting, workspace, and MCP isolation;
- timeout and process-tree cancellation;
- usage normalization;
- provider-specific retries; and
- audit metadata.

Provider plugins register targets with the catalog. Example providers may use
DeepSeek APIs, Anthropic APIs or CLI entitlements, OpenAI Responses, Codex CLI,
local inference, or future runtimes. These examples never appear in core
branching logic.

The initial Mac mini entitlement and model-name observations are versioned in
the [model-selection probe](../reviews/2026-08-25-model-selection-probe.md).
That file is a provider-catalog seed, not a core routing table.

Provider-native reasoning levels follow the separate
[effort-selection design](2026-08-25-provider-effort-selection-design.md).
Normal work orders and team manifests cannot name an effort level.

Removing every production provider and installing a fake provider must leave
all core tests runnable.

## 8. Capability model

Capabilities use a versioned ontology rather than a flat list of roles. The
initial ontology covers:

- reasoning: decomposition, causal reasoning, long-horizon planning;
- research: discovery, retrieval, tool use, source diversity;
- coding: repository understanding, implementation, debugging, review;
- verification: claim checking, test interpretation, contradiction detection;
- writing: executive, technical, concise, long-form, editing;
- modalities: text, image, document, structured data;
- operations: latency, throughput, context, cost, availability; and
- safety: tool-boundary support, sandbox strength, structured-output fidelity.

Each catalog target has a capability profile with:

- score or level;
- confidence interval;
- evaluation suite and version;
- sample count;
- evaluation timestamp;
- supported constraints; and
- known failure modes.

Provider-declared metadata is marked separately from Helium-measured evidence.
Unmeasured capabilities remain unknown; they do not receive optimistic defaults.

## 9. Routing policy

The router performs six steps:

1. Validate the task and capability contract.
2. Remove targets that fail hard requirements such as tool isolation,
   structured output, mutation policy, context, availability, or budget.
3. Score eligible targets against capability weights, evaluation confidence,
   cost, latency, and reliability.
4. Apply bounded, tenant-scoped preferences.
5. Reserve budget and issue an execution lease.
6. Record the candidate set, scores, exclusions, selected lease, and fallback.

Operator preferences are boosts, not hard-coded assignments. For example, a
tenant may prefer one target's writing style for final documents. A task's hard
requirements, current availability, or measured regression may override that
preference.

### 9.1 Exact-target override

Normal jobs and team manifests cannot name an execution target. A privileged
administrator may pin an exact target only for:

- deterministic replay;
- evaluation;
- provider certification;
- incident diagnosis; or
- emergency failover.

The override lives outside the core task schema, requires a reason and operator
identity, is written to the audit log, and cannot expand tool or mutation
permissions.

## 10. True multi-agent semantics

A Helium team run is multi-agent only when it has:

- two or more independently addressable agent identities;
- distinct roles, capability contracts, and tool policies;
- isolated context by default;
- explicit task assignment and message passing;
- durable task and message state;
- status, follow-up, interruption, and cascading cancellation;
- restart recovery;
- bounded budgets; and
- independent verification that can introduce fresh information.

Sequential role labels inside one shared trajectory do not satisfy this
definition.

### 10.1 Roster

The roster records stable agent IDs, role definitions, capability contracts,
tool policies, workspace policies, budget shares, and current state. Provider
identity is attached only to execution attempts, not to the role.

### 10.2 Task DAG

Tasks have owners, dependencies, acceptance criteria, revision numbers, leases,
and terminal states. Updates use compare-and-swap revisions. The controller
rejects dependency cycles, ownership conflicts, stale writes, and budget
expansion.

### 10.3 Durable mailbox

Messages use a structured envelope:

```text
message_id, case_id, team_run_id, sender, target, type, task_id,
artifact_refs, payload_schema, created_at, acknowledged_at
```

Delivery is queue-then-acknowledge. Restart reconstructs unacknowledged messages
without duplicating acknowledged work.

### 10.4 Handoff envelope

An agent receives only what its role needs:

- goal and acceptance criteria;
- current task and dependencies;
- explicit constraints;
- accepted facts with provenance;
- unresolved questions;
- immutable artifact references and hashes;
- remaining budget; and
- visited-agent/cycle information.

Complete upstream trajectories are not forwarded by default.

## 11. Cross-reference and adjudication

Cross-reference is configured by risk, uncertainty, task type, and budget. It
does not mean calling every installed provider.

The protocol is:

1. Primary and reviewer work independently when independence is valuable.
2. Each emits a normalized `ClaimSet` containing claims, evidence references,
   assumptions, confidence, and open questions.
3. A deterministic comparator identifies agreement, contradiction, unique
   evidence, and missing evidence.
4. Material contradictions open verification tasks.
5. A verifier re-fetches or re-runs the underlying evidence.
6. An adjudicator produces a decision record from verified evidence.
7. A final renderer may improve presentation but cannot introduce new factual
   claims outside the adjudicated ledger.

Provider diversity may be a routing constraint when it improves independence,
but majority vote is never sufficient evidence.

## 12. Workspace and tool isolation

Each agent receives:

- private writable scratch space;
- explicit read-only mounted inputs;
- immutable shared artifacts;
- narrowly granted output locations; and
- a role-specific tool allow-list.

Shared mutable checkouts are forbidden by default. Coding agents use isolated
worktrees or equivalent working copies with explicit ownership.

Provider adapters must prove that an execution target cannot inherit undeclared
tools, global settings, MCP servers, instructions, environment secrets, or
filesystem access. A declared allow-list is not accepted unless the provider's
actual restriction semantics have been tested.

## 13. Safety and mutation policy

Read-only execution is the default. Mutation requires all of:

- an explicit task-level mutation capability;
- a provider target certified for the required isolation;
- deterministic policy authorization;
- a narrow tool and resource scope;
- a write-ahead audit intent;
- idempotency or compensation behavior; and
- a versioned authority decision for the exact action definition.

Externally material actions are approval-required unless a reviewed,
versioned SOP grants that exact action `auto` authority. Automatic authority is
not a generic task flag: it is scoped to a certified executable identity,
typed arguments, preconditions, postconditions, attempt limit, cooldown,
recovery budget, and owner. Agents cannot generate shell commands or promote
their own authority.

The generic operations action, lease, attribution, and verification contracts
are defined in the
[Ops Agent design](2026-08-25-helium-ops-agent-design.md). They remain core
safety primitives when another team uses them.

The first multi-agent macro release remains read-only and cannot place trades.

## 14. Failure handling

Failures are normalized into stable classes such as unavailable, timeout,
cancelled, budget-exhausted, capability-shortage, schema-invalid,
tool-boundary-violation, provider-error, and verification-failed.

Fallback occurs only when another target satisfies the original capability and
safety contract. The router cannot relax requirements merely to obtain a
result.

Cascading cancellation stops descendants and provider process trees. Recovery
marks uncertain external side effects for reconciliation rather than retrying
blindly.

An executor exit code never establishes recovery on its own. A mutating action
reaches a successful terminal state only after its independent postconditions
pass. Operator and external interventions are durable events so the controller
does not claim another actor's recovery.

Per-tenant liveness detects a missing or invalid team even while other teams
continue to emit global heartbeats.

## 15. Macro pilot

The macro team preserves the causal chain:

```text
inflation -> rates -> USD -> gold -> optional portfolio implications
```

The task graph, not a fixed model assignment, defines the team:

1. Inflation and policy evidence collection may run in parallel.
2. Rates-path analysis consumes both artifacts.
3. USD transmission consumes the rates path.
4. Gold impact consumes rates and USD.
5. Portfolio implications run only when material.
6. An independent verifier re-fetches important evidence.
7. A lead synthesizes the adjudicated claim ledger.
8. A renderer produces the final report without adding facts.

The capability router may choose different targets for any of these roles on
different runs. The current single-senior job remains the control and fallback
during shadow evaluation.

## 16. Observability and evaluation

Every execution records:

- work-order and policy versions;
- candidate targets and exclusion reasons;
- capability profiles and evaluation versions;
- selected execution lease and fallback path;
- task, message, artifact, and claim lineage;
- provider runtime snapshot;
- token, time, tool, and cost usage;
- verification results;
- delivery intent and outcome; and
- recovery and cancellation events.

Evaluation is task-specific. Metrics include task acceptance, claim provenance,
contradictions caught, external information gain, structured-output fidelity,
unauthorized calls, latency, cost, recovery, and human preference.

For continuous operations, evaluation additionally measures false-green and
false-critical rates, parser-drift classification, dependency inhibition,
time-to-correct-SOP, duplicate actions, postcondition success, recovery
attribution, and resource-pressure behavior. The deterministic observation and
recovery path is evaluated with every model provider disabled.

Production trajectories may generate offline candidate capability scores,
prompts, skills, or policies. Promotion requires a normal pull request and
regression, safety, and retention evaluations. The safety root is not
self-modifiable.

## 17. V1 compatibility

A compatibility adapter translates a v1 job into:

- one case template;
- one triage role;
- one optional senior role;
- equivalent triggers, tools, budgets, memory, and delivery; and
- a routing policy that reproduces the certified v1 execution path.

The adapter, not core, may contain legacy provider knowledge. Its behavior is
frozen by existing unit, contract, and end-to-end tests. New team manifests do
not use the legacy engine fields.

## 18. Acceptance criteria

The architecture is accepted only when:

1. Core source and schemas contain no production provider or model names.
2. A fake provider can run the full core contract suite.
3. Adding a provider or model target requires no core or team-definition edit.
4. The same team definition runs against different catalogs.
5. Every run remains auditable to an exact model and configuration snapshot.
6. Kill-and-restart resumes a team without duplicate tasks, messages, or
   delivery.
7. Cascading cancellation leaves no child process or task lease behind.
8. A provider cannot access an undeclared tool, MCP server, setting source, or
   workspace path.
9. Cross-reference exposes contradictions and provenance rather than returning
   a majority vote.
10. Shadow evaluation demonstrates a measured benefit over the v1 control path
    at an accepted cost and latency envelope.
11. A mutating team cannot execute an action outside a versioned eligible SOP,
    durable authority decision, and exclusive action lease.
12. Recovery requires verified postconditions and is attributed to the actual
    agent, operator, or external actor.
13. A host resource incident reduces optional team concurrency before creating
    additional model fan-out.
14. Component and SOP plugins can be installed without adding domain names to
    core.
15. No sensor can call a provider directly, and no agent result can bypass the
    evidence, authority, or delivery gates.
16. Every delivered material factual claim links to an accepted, hashed,
    freshness-bounded evidence bundle and exact execution snapshot.
17. Planned, partial, failed, blocked, and proven capability states remain
    distinguishable in APIs, reports, and promotion gates.
18. Every agent-capable topology node has a reviewed autonomy decision that
    compares it with a deterministic workflow baseline and defines human
    takeover.

## 19. Research basis

This design follows:

- *AI Agent Book*, especially the harness responsibilities of context, tools,
  constraints, verification, and correction, and its multi-agent treatment of
  isolated context, message passing, task control, and durable artifacts:
  <https://github.com/bojieli/ai-agent-book>;
- DSH's plugin and service architecture:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>;
- DSH subagent lifecycle and recovery primitives:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md>;
- the experimental DSH Agent Teams semantics:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md>; and
- current OpenAI model guidance, used only as provider metadata rather than core
  architecture:
  <https://developers.openai.com/api/docs/guides/latest-model>.
