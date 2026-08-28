# Helium Ops Agent Design

**Date:** 2026-08-25

**Last revised:** 2026-08-28 — signed authority manifest, single mutation
ownership, and pre-action baselines (review blockers OPS-1, OPS-2, OPS-3), per
`docs/reviews/2026-08-28-plan-review-adjudication.md`; attribution names an
actor rather than an action outcome (R3) and the observe boundary is stated as
two windows in section 13.4 (R8), per
`docs/reviews/2026-08-28-adjudication-round-2.md`

**Status:** Approved design direction

**Production constraint:** design and implementation work may proceed, but no
Mac mini deployment or recovery drill may occur during the active AC#1
observation window, which closes 2026-08-31. In that window the test is
presence, not mutation — see section 13.4.

## 1. Decision

Helium will add an Ops Agent as its second reference team. The Ops Agent will
continuously observe ecosystem components, diagnose incidents, select a
versioned and certified standard operating procedure (SOP), execute the SOP's
registered script when policy authorizes it, and verify the resulting business
state.

The Ops Agent is not a model with general shell access. It is a team plugin on
top of a deterministic operations control plane:

```text
host-native collectors
        -> typed observations
        -> incident correlation and dependency inhibition
        -> SOP eligibility and signed authority policy
        -> single mutation ownership check
        -> durable action lease, pre-action baseline, and write-ahead intent
        -> deterministic script executor
        -> postcondition verification and reconciliation
        -> incident state: recovered | failed | uncertain | escalated

optional capability-routed agents
        -> diagnosis, challenge, synthesis, and reporting
        -> may select only from eligible SOP IDs
        -> cannot create new authority or arbitrary commands
```

In production the deterministic path runs as a host-native `helium-opsd`
launchd service, not inside the DSH process and not inside Colima. `opsd` owns
collection, correlation, policy, action leases, script execution, verification,
and the authoritative operations event log. The DSH Ops team is an optional
client: it reads incident artifacts and submits evidence or an eligible SOP
selection through a bounded interface. Losing DSH or every model provider does
not stop `opsd`.

The initial component catalog must cover Livewire, Argon, Apex, Colima,
PostgreSQL, host CPU, host memory, and disk volumes. This list is an acceptance
fixture, not a closed enum. New components, probes, dependencies, SOPs, and
scripts are installed through team/plugin configuration without changing
Helium core.

## 2. Why this is a core harness concern

Adding `ops-agent` only as a Phase 5 team manifest would be unsafe. Operations
work introduces general primitives that any mutating team needs:

- exact and versioned action definitions;
- pre-authorized versus approval-required actions;
- action ownership, single mutation ownership per component, leases, and
  idempotency;
- dependency-aware incident correlation;
- write-ahead intent before side effects;
- postcondition verification over a bounded grace window;
- explicit manual-intervention attribution;
- recovery budgets, cooldowns, and circuit breakers; and
- reconciliation after process restart or uncertain command exit.

Those primitives belong in provider-neutral core contracts. Component-specific
knowledge, including paths, commands, health semantics, market windows, and
SOPs, remains in the Ops team plugin.

## 3. Corrected production evidence

A read-only audit of the Mac mini on 2026-08-25 informed this design. No
production mutation was performed by the audit.

### 3.1 Colima

At approximately 11:01 local time, the existing Colima watchdog attempted an
automatic restart, reached its own failure path, and emitted
`recovery_exhausted`. Docker recovered only after operator intervention. The
20 observed containers were running after that manual action.

The event must therefore be classified as:

```text
automated_attempt = failed_or_exhausted
operator_action   = confirmed
terminal_state    = recovered_by_operator
```

Time proximity is not action provenance. A controller must not claim that its
own action succeeded merely because the target later became healthy. The Ops
Agent needs explicit action IDs and a channel for recording operator or
external interventions.

### 3.2 Livewire

Livewire was not fully healthy:

- the coverage job's latest failure included an invalid Parquet footer;
- the status surface reported coverage four days old and intraday coverage at
  zero;
- daily and intraday source logs were newer than the status parser implied;
  and
- IB Gateway availability remained a manual operational boundary.

This is not a generic restart incident. A certified repair may need to identify
the damaged partition, prove the input source exists, run a targeted repair or
rebuild command, and then verify Parquet integrity, target-date freshness, and
coverage. Until that path is certified, the action is approval-required. Once
the exact script and postconditions pass drills, the same SOP may be promoted
to automatic authority without changing core.

### 3.3 Argon and PostgreSQL

Argon API and workers were serving, but the most recent observed local
`option_wizard` backup was dated 2026-07-23 and the backup LaunchDaemon exposed
an `EX_CONFIG` exit. A listening PostgreSQL port does not prove backup health,
restore viability, or the ownership of the server process.

The checked Argon runbook still described a launchd-centered service topology,
while the current production stack primarily uses Docker Compose. Human prose
is evidence, not an executable contract. An SOP cannot be automated until its
target, command, deployment generation, preconditions, and postconditions match
the live service registry.

### 3.4 Apex

Apex was serving and reported its PostgreSQL connection, Livewire recency, and
revision state as healthy. It nevertheless depends on Colima, PostgreSQL,
DATA_LAKE/Livewire mounts, and related upstream services. Those dependencies
must suppress redundant child incidents when a parent fails.

### 3.5 Host resources

The host has 16 GiB memory. The audit observed substantial compressed memory
and about 6.67 GiB of swap already allocated, but no sustained swap-in/out burst
during the sample and ample idle CPU. The correct classification was chronic
capacity pressure, not an immediate memory outage.

Disk capacity was healthy, including the internal data volume and DATA_LAKE.
Colima was configured with 6 GiB memory. The observed containers had no
per-container CPU, memory, or PID limits.

These facts require trend- and pressure-based alerts, plus Helium admission
control, rather than alerts based only on percentage of RAM used.

### 3.6 Verification interpretation of the observed cases

The observations above are not one binary statement that "Ops works" or "Ops
failed." They are separate assertions with separate evidence decisions:

| Assertion                                                                | Decision                        | Evidence or missing proof                                                                         |
| ------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Existing Colima watchdog detected an unhealthy state                     | `PROVEN`                        | watchdog log reached `recovery_exhausted`                                                         |
| Existing watchdog automatically restored Colima                          | `FAILED`                        | the automated window ended without verified recovery                                              |
| Docker and the expected 20 containers were later healthy                 | `PROVEN`                        | independent post-incident inventory                                                               |
| Automatic action caused that recovery                                    | `FAILED`                        | no complete action-to-postcondition attribution chain                                             |
| Operator intervention caused the final recovery                          | `PROVEN` for this review record | explicit operator correction; future runtime attribution must use a durable signed operator event |
| Livewire detected a Parquet integrity failure                            | `PROVEN`                        | coverage task exit and invalid-footer evidence                                                    |
| Restarting the Livewire process is an eligible repair                    | `FAILED`                        | the failure is data integrity, not process liveness                                               |
| A particular targeted repair restores integrity, freshness, and coverage | `BLOCKED`                       | exact repair fixture and controlled drill have not passed                                         |

These decisions apply to the named assertions, not to the whole component. A
healthy Docker inventory does not erase the failed automation claim, and a
running Livewire process does not close an integrity or coverage incident.

Every future incident follows the canonical chain from the
[multi-agent design](2026-08-25-helium-multi-agent-design.md#55-canonical-agent-and-verification-evidence-topology):

```text
incident claim -> raw observations -> replay/reproduction -> root cause
  -> eligible SOP and authority -> action evidence -> postconditions
  -> attribution -> regression/drill -> remaining limitation -> closure
```

An incident report may expose `PARTIAL`, `FAILED`, or `BLOCKED` assertions, but
neither an agent nor a renderer may relabel them as recovered.

## 4. Design principles

1. **The core is model-blind and domain-blind.** It does not branch on provider,
   model, effort, Livewire, Argon, Apex, Colima, or PostgreSQL names.
2. **Automation is constrained, not absent.** Certified SOP scripts may run
   automatically when their individual authority is `auto` and a signed
   authority manifest entry pins that authority to the exact SOP digest.
3. **No arbitrary shell generation.** Execution uses a registered immutable
   action specification, exact argument schema, controlled environment, and
   pinned script identity.
4. **Business health is not process health.** Liveness, readiness, product
   freshness, data integrity, dependency state, and resource pressure are
   separate observations.
5. **Commands do not define success.** Success requires postconditions observed
   after the action.
6. **One root incident, not an alert storm.** Dependency correlation groups or
   inhibits downstream symptoms.
7. **Manual actions are first-class events.** Recovery attribution must remain
   truthful when an operator intervenes.
8. **The safe path works without an LLM.** Detection, policy, execution, and
   verification remain available when all model providers are unavailable.
9. **Agents add interpretation, not authority.** Cross-reference challenges
   evidence and diagnoses; agreement is never proof.
10. **Pressure reduces agent work first.** The harness must not worsen a memory
    or CPU incident by spawning more analysis.

## 5. Scope and non-goals

### In scope

- a generic component, dependency, observation, incident, SOP, action, and
  verification model;
- host-native observation collection outside Colima;
- durable incident and action histories;
- deterministic correlation, authority, lease, execution, and reconciliation;
- an Ops Agent team for diagnosis, verification, incident synthesis, and
  reporting;
- initial component adapters for Livewire, Argon, Apex, Colima, PostgreSQL,
  CPU, memory, and disks;
- exact integration with existing certified scripts and service registries;
- observe-only, suggest-only, approval, and automatic promotion stages;
- resource-pressure admission control for Helium teams; and
- drills for false health, failure, concurrency, restart, and manual
  intervention.

### Not in the first automatic release

- unconstrained shell or generated remediation commands;
- automatic IB Gateway restart;
- database restore, destructive repair, drop, or migration;
- host reboot;
- Docker image pull or prune;
- broad log or data deletion;
- mount creation, replacement, or filesystem repair;
- unbounded retries or whole-stack bounce;
- self-editing SOP authority; or
- replacing the existing out-of-band dead-man and host watchdog before the new
  system has proven itself.

## 6. Architecture

### 6.1 Observation plane

A small host-native process samples probes and appends typed observations. It
runs independently of Colima and the DSH process. The first implementation uses
append-only JSONL with periodic snapshots; a metrics backend may be added later
through the same interface.

Each observation carries:

```ts
interface Observation {
  id: string;
  componentId: string;
  probeId: string;
  observedAt: string;
  expiresAt: string;
  state: "ok" | "degraded" | "failed" | "unknown";
  dimension:
    | "liveness"
    | "readiness"
    | "freshness"
    | "integrity"
    | "capacity"
    | "dependency"
    | "controller";
  value?: unknown;
  evidenceRefs: string[];
  parserVersion: string;
  sourceVersion?: string;
}
```

`unknown` is not healthy. It is also not permission to restart. A parser
failure, stale collector, schema drift, timeout, or missing artifact produces
an explicit unknown observation.

### 6.2 Incident plane

The correlator consumes observations and a versioned dependency graph. It
creates or updates incidents using stable deduplication keys.

```ts
interface Incident {
  id: string;
  dedupeKey: string;
  rootComponentId: string;
  symptomComponentIds: string[];
  state:
    | "open"
    | "diagnosing"
    | "action-eligible"
    | "recovering"
    | "verifying"
    | "recovered"
    | "failed"
    | "uncertain"
    | "escalated";
  severity: "info" | "warning" | "critical";
  observationIds: string[];
  openedAt: string;
  lastChangedAt: string;
}
```

Parent failures inhibit child pages without hiding their observations. For
example:

- Colima down inhibits Argon, Apex, Xenon, Grafana, Alloy, and container
  process pages;
- DATA_LAKE unavailable blocks Apex and Livewire repair actions;
- PostgreSQL unavailable groups Argon and Apex database symptoms;
- IB unavailable degrades Livewire and requests operator attention without
  granting restart authority.

### 6.3 Policy and SOP plane

An SOP is data, not prompt text:

```ts
interface SopDefinition {
  id: string;
  version: number;
  digest: string;
  priority: number;
  exclusiveGroup: string;
  componentKinds: string[];
  matches: IncidentSelector;
  authority: "observe" | "auto" | "approve" | "forbidden";
  preconditions: CheckRef[];
  action?: ActionSpec;
  postconditions: CheckRef[];
  grace: { initialDelayMs: number; timeoutMs: number; intervalMs: number };
  limits: {
    maxAttemptsPerIncident: number;
    cooldownMs: number;
    maxRunsPerWindow: number;
    windowMs: number;
  };
  maintenance?: WindowPolicy;
  rollback?: ActionRef;
  owner: string;
  reviewedAt: string;
  evidenceRefs: string[];
}
```

A `CheckRef` is the ID of an executable `CheckDefinition` — a registered
read-only probe, its structured arguments, and the expected predicate over the
result — declared as data under `ops/checks/` and loaded at startup. Checks must
be executable, not merely referenced, because the pre-action baseline runs the
whole postcondition set before any side effect. Every mutating SOP carries at
least one business check, not only a process-liveness check.

Automatic arbitration is deterministic. Eligible SOPs are ordered by explicit
priority, match specificity, and stable SOP ID. Two eligible actions in the
same exclusive group at the same effective priority are an ambiguity: the
controller executes neither and escalates. An agent may select only among
eligible approval-required alternatives; it is not required for selecting a
single unambiguous automatic SOP.

The registry rejects:

- unknown component or check references;
- mutable or unpinned executable paths;
- free-form command strings;
- missing timeouts, attempt limits, or postconditions;
- `auto` actions without idempotency and a certified executor;
- conflicting active versions; and
- any authority above `observe` that no valid signed authority manifest entry
  covers (section 6.3.1).

#### 6.3.1 Signed authority manifest

Every other link in the authority chain is cryptographically pinned: the
executable by content hash or signed release identity, the operator decision by
an Ed25519 envelope. The SOP YAML that carries the `authority` field is not.
One file write — a stray script, an unreviewed edit, a bad merge, a generator
bug — turns `approve` into `auto` without touching a key, a binary, or a model.
The registry rule "authority changes require reviewed configuration history"
cannot be enforced by the loader, because the loader sees only the current
file. A signed manifest gives the loader something it can actually check.

The manifest is a canonical-JSON artifact listing one entry per SOP whose
authority is above `observe`:

```ts
interface AuthorityManifestEntry {
  sopId: string;
  version: number;
  digest: string; // digest of the exact SOP definition
  authority: "auto" | "approve";
  certificationState: "fixture-only" | "drilled" | "production-certified";
}

interface AuthorityManifest {
  manifestVersion: number;
  issuedAt: string;
  entries: AuthorityManifestEntry[];
  signature: string; // Ed25519 over the canonical entry list
}
```

It reuses the approval mechanism of section 12 exactly — Ed25519 over canonical
JSON, private key held off the mini on the operator's trusted workstation,
`opsd` configured with the trusted public key only. It is a second signed
artifact, not a second key, algorithm, or trust root.

Loading is fail-closed. When `opsd` loads an SOP whose file declares `auto` or
`approve`, it must find an entry whose `sopId`, `version`, `digest`, and
`authority` all match, inside a manifest whose signature verifies against the
trusted public key. A missing manifest, an unverifiable signature, an unlisted
SOP, a digest or version mismatch, or an entry whose authority differs from the
file makes the SOP load at `observe` regardless of what its file says. The
loader emits a `controller`-dimension observation naming the failing SOP and
reason, and the action plane will not accept the SOP for any mutation. No
runtime path repairs a manifest; repair is a reviewed configuration change
re-signed off the host.

**Threat model.** The manifest prevents **unauthorized configuration
escalation**: any write to an SOP file, or any newly introduced SOP file, that
grants itself `auto` or `approve` authority produces an SOP that cannot
execute. That covers the realistic paths — a stray file write, an unreviewed
edit, a mis-merged branch, a config generator bug, or a tool call influenced by
untrusted probe output.

It does **not** claim to resist a full same-UID host compromise. An attacker
already executing as the operator UID can rewrite `opsd`'s trusted-key
configuration, replace the `opsd` binary, or invoke the certified scripts
directly without Helium at all. What the manifest buys is that escalation now
requires either the off-host private key or replacement of the controller
itself, both of which are louder and separately detectable, instead of a
one-line YAML edit. Consistent with section 12, same-UID access is never by
itself accepted as authority.

### 6.4 Action plane

The action state machine is durable:

```text
proposed
  -> authorized
  -> leased
  -> baseline-captured
       -> not-needed   (every postcondition already held before any action)
  -> intent-recorded
  -> executing
  -> verifying
  -> succeeded | failed | uncertain
     | superseded-by-operator | external-recovery
```

The terminal set of the **action** plane is exactly the six values classified in
[section 6.5](#65-verification-and-reconciliation-plane): `succeeded`, `failed`,
`not-needed`, `uncertain`, `superseded-by-operator`, `external-recovery`.
`not-needed` is reached from `baseline-captured` without execution; the other
five are reached through `verifying`. This set is disjoint from the **incident**
state enum of section 6.2 — `recovered` and `escalated` are incident states and
must never be recorded as an action outcome. Every enumeration of action
outcomes in this plan set uses these six values and no others.

Before execution, the controller must:

1. replay current incident and action state;
2. re-evaluate the exact SOP version and its signed authority manifest entry;
3. re-run preconditions;
4. acquire a compare-and-swap `ActionLease` scoped to component and incident;
5. verify single mutation ownership for the component (section 13.2);
6. reserve the attempt and recovery budget;
7. capture a **pre-action baseline** by running every one of the SOP's
   postconditions before any side effect;
8. append a write-ahead intent that embeds that baseline; and
9. invoke only the registered executor and structured arguments.

The baseline is not optional and not a cached observation. It is a fresh
evaluation of the exact postcondition set that will later decide success,
taken immediately before the intent is written, and stored inside the intent so
that a crash between the baseline and the receipt still leaves the baseline
durable.

If every postcondition already passes at baseline, the action terminates as
`not-needed` and nothing is executed. The component was already healthy, or an
operator or an external process fixed it between incident opening and lease
acquisition. Running the script anyway would produce an exit-0 receipt and a
passing verification, and the controller would credit itself with a recovery it
did not cause — which is precisely the false automation credit that the
promotion gate exists to detect. A `not-needed` action earns no automation
credit in any promotion or acceptance record.

The executor runs with a minimal environment, owned working directory, bounded
stdout/stderr, process-group cancellation, and no inherited agent tools. A
script identity includes the absolute deployment path, expected owner/mode,
content hash or signed release identity, and allowed argument schema.

### 6.5 Verification and reconciliation plane

Command exit is one observation, not the final verdict. The controller waits
through the SOP's grace policy and re-runs postconditions. It classifies the
**action** into exactly one of these six terminal outcomes — this list is
normative for every other enumeration in this plan set, and it is separate from
the incident state enum in section 6.2:

- `succeeded`: the action identity is known, the pre-action baseline showed at
  least one failing postcondition, and all postconditions pass afterwards;
- `failed`: the action terminated and postconditions fail after the grace
  window;
- `not-needed`: the pre-action baseline already satisfied every postcondition,
  so no side effect was attempted; the incident may still close, but the action
  is recorded as superseded before execution and earns no automation credit;
- `uncertain`: execution or attribution cannot be proven;
- `superseded-by-operator`: an operator action was recorded and the component
  subsequently recovered; or
- `external-recovery`: health returned without an attributable Helium or
  operator action.

`succeeded` therefore requires a state change the action can be credited with,
not merely a healthy end state. `uncertain` remains reserved for genuinely
unclear attribution — a missing receipt, a crash between spawn and receipt, a
timeout, a contested operator window — and must not absorb the
already-healthy-at-baseline case, which is deterministic and knowable.

Startup reconciliation never blindly reruns an uncertain side effect. It first
rechecks the lease, process evidence, action receipt, operator events, and
postconditions.

Incident closure writes a `RecoveryEvidenceBundle` containing the raw
observation hashes, incident and dependency snapshot, exact SOP digest, the
signed authority manifest entry, the component's mutation owner and
controller-probe result, eligibility and authority decisions, action lease and
intent including its pre-action baseline, executor receipt, every postcondition
sample, actor attribution, verifier version, replay or drill reference, final
status, and remaining limitations. A no-action recovery still requires
observations and an attribution, and an attribution names an **actor** only:
`operator` or `external`, never Helium, because nothing was executed.
`not-needed` is an action **outcome** from the six-value set above, not an
actor; a `not-needed` action carries whichever actor attribution the evidence
supports, and the two fields are recorded separately and never collapsed into
one. Missing required evidence leaves the assertion `PARTIAL`, `FAILED`, or
`BLOCKED`; it never defaults to automatic success.

### 6.6 Multi-agent analysis plane

The Ops team uses the durable team kernel but does not sit in the mandatory
recovery path.

Roles are capability contracts:

- **diagnostician:** correlate current and historical evidence and propose
  candidate incident classes;
- **independent verifier:** re-run approved read-only probes and challenge the
  diagnosis;
- **incident lead:** synthesize the accepted evidence ledger and choose one SOP
  from the deterministic eligible set, or escalate;
- **reporter:** render the incident, action, verification, and remaining risk
  without adding facts.

The router may choose different provider targets and effort levels per role.
Core and the team manifest contain no provider or model names. Multiple agents
do not each produce a full duplicate answer, and the lead cannot select an SOP
that the deterministic policy engine excluded.

## 7. Component and dependency plugin contract

The component registry is open-ended:

```yaml
id: livewire
kind: data-pipeline
owner: livewire
dependencies:
  - id: data-lake
    relation: storage
  - id: ib-gateway
    relation: upstream
    required_when: market-data-session
probes:
  - livewire.status.v1
  - livewire.coverage.v1
  - livewire.parquet-integrity.v1
sops:
  - livewire.targeted-parquet-repair.v1
  - livewire.coverage-rebuild.v1
```

Installing another component is a configuration and plugin operation. The core
schema validates identities, graph cycles, probe freshness, and SOP references
but does not enumerate component kinds.

The first registry includes at least:

| Component   | Required health dimensions                                                            | Initial recovery boundary                                          |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Livewire    | launchd state, outcome freshness, coverage, Parquet integrity, lake capacity          | targeted data repair may become `auto`; IB restart forbidden       |
| Argon       | HTTP readiness, `.ok`, DB, worker heartbeats, job failures, product freshness, backup | container-only reconcile candidate; backup repair starts `approve` |
| Apex        | HTTP, PostgreSQL, Livewire revision/recency, container state                          | container reconcile candidate after dependency gates               |
| Colima      | host socket, guest runtime, VM state, container inventory                             | reconnect and bounded restart candidates                           |
| PostgreSQL  | listener, SQL latency, connection pressure, locks, growth, backup freshness/integrity | restart and backup initially `approve`; restore forbidden          |
| Host CPU    | busy time, normalized load, process contribution, service impact                      | admission control only; no auto-kill                               |
| Host memory | memory pressure, compression, swap allocation and deltas                              | reduce Helium concurrency; no service kill                         |
| Disk/mounts | identity, capacity, absolute reserve, growth, read/write probe                        | alert and block dependent SOPs; deletion forbidden                 |
| Helium/Ops  | process, expected tenant, per-tenant heartbeat, collector freshness                   | existing out-of-band dead-man remains authority                    |

Backup verification is tiered so monitoring does not become an I/O incident:
freshness, size, naming, and manifest checks run frequently; compressed-stream
integrity runs in a configured low-impact window; restore rehearsal uses an
isolated target under a separately approved SOP. A successful listener probe
never suppresses a backup incident.

## 8. Certified script integration

Existing scripts are valuable because they encode local operational knowledge,
but mere existence is not certification. Each script moves through:

1. **Inventory:** record path, owner, release, inputs, outputs, side effects,
   expected duration, and known failure modes.
2. **Wrap:** replace free-form shell composition with a typed action adapter.
3. **Preflight:** make required state and refusal conditions machine-readable.
4. **Postconditions:** define service and business checks independent of script
   output.
5. **Fixture:** prove behavior in a fake filesystem/process environment.
6. **Drill:** execute in a controlled non-production or maintenance window.
7. **Suggest:** compare the proposed action with an operator's decision.
8. **Auto:** promote the exact SOP version only after the acceptance record is
   reviewed.

The initial inventory includes the trading-stack read-only sweep, bounded
container reconcile, Colima watchdog actions, Livewire status/quality/repair
commands, Argon backup tooling, and component-specific verification scripts.
The design does not assume that every existing script is safe or current.

## 9. Authority model

Authority belongs to an SOP version:

| Authority   | Meaning                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe`   | Read-only probes and diagnosis; no side effect. Also the fail-closed level an SOP loads at when its signed manifest entry is missing or invalid |
| `auto`      | Pre-authorized, bounded, idempotent action may execute without per-incident approval                                                            |
| `approve`   | Action requires an operator approval bound to incident, SOP version, and expiry                                                                 |
| `forbidden` | Controller must reject the action even if an agent or operator prompt requests it                                                               |

Promotion from `approve` to `auto` requires a reviewed configuration change,
normal CI, drill evidence, and a re-signed authority manifest entry for the
exact SOP digest (section 6.3.1). Editing the SOP file alone does not promote
it: an unlisted or digest-mismatched `auto` claim loads at `observe`. No
production trajectory changes its own authority.

Initial automatic candidates are deliberately narrow:

- reconnect a Colima transport when the VM is already healthy;
- run the existing container-only reconcile with no image pull after DATA_LAKE
  and Docker preconditions pass;
- attempt one bounded Colima restart after consecutive failures, lock,
  cooldown, and recovery-budget checks; and
- apply Helium admission control under sustained host pressure.

Initial approval-required actions include targeted Livewire repair/rebuild,
business-service restart, PostgreSQL restart, and a large backup run. These may
be promoted individually after certification.

Forbidden actions include IB Gateway restart, database restore or destructive
repair, host reboot, image pull/prune, data deletion, and mount replacement.

## 10. Resource policy

### 10.1 CPU

Alerting uses sustained windows, normalized load, and service impact. Initial
defaults are configuration seeds, not universal constants:

- warning: CPU busy above 80% for 10 minutes;
- critical: CPU busy above 95% for 5 minutes plus at least one service-impact
  observation; and
- no automatic process termination.

### 10.2 Memory

Use macOS memory-pressure state, compression rate, swap allocation, swap-in/out
deltas, and service latency. Do not page solely because most RAM is allocated.

The first automatic response is internal admission control:

- stop starting optional team runs;
- prevent additional subagent fan-out;
- reduce configured concurrency to the minimum safe lane;
- keep collectors, deterministic recovery, and dead-man paths available; and
- restore concurrency only after a sustained recovery window.

The Ops Agent never kills an ecosystem service merely to free memory.

### 10.3 Disk and mounts

Each volume has independent percentage and absolute-reserve thresholds. Checks
include mount identity and a bounded read/write probe where safe, not just path
existence. Growth-rate alerts warn before fixed thresholds are reached.

Initial monitored storage includes:

- the internal data volume containing PostgreSQL;
- DATA_LAKE and Livewire warehouse paths;
- Colima/Docker storage;
- Argon backup destination; and
- Helium state, release, and log storage.

No disk cleanup is automatic until an exact deletion SOP proves retention,
ownership, minimum age, and rollback/recovery behavior.

## 11. Alert and incident policy

Alerts are state transitions, not periodic restatements. They are grouped by
root incident and include:

- component and dependency root;
- first and latest observation times;
- current business impact;
- exact eligible or executed SOP version;
- action attribution;
- verification state;
- suppressed downstream symptoms; and
- next required decision.

The system uses `for` durations, deduplication, cooldowns, and inhibition. A
critical alert is reserved for actionable conditions. Recovery notifications
must distinguish automatic, operator, and external recovery.

## 12. Security boundaries

- Probe outputs and logs are untrusted data, not instructions.
- Agents never receive a generic shell tool in the Ops team.
- Action arguments are schema-validated and cannot inject shell syntax.
- The executor uses exact argv, never `sh -c` with generated content.
- Secrets are supplied by a narrowly scoped executor environment and are not
  copied into agent context or artifacts.
- Script identity is rechecked at lease time; a changed script invalidates the
  SOP certification.
- Component and SOP configuration is reviewed code, not production-writable
  model memory. Any SOP authority above `observe` is additionally pinned by the
  signed authority manifest of section 6.3.1, under the same off-mini Ed25519
  key as operator approval: configuration that grants power is signed evidence,
  not merely reviewed prose.
- Operator approval is an Ed25519-signed canonical envelope containing the
  incident ID, SOP ID and digest, one-time nonce, decision, and expiry. `opsd`
  holds only the trusted public key; the private signing key remains off the
  mini on the operator's trusted workstation. The owner-only control socket is
  outside every agent workspace and provider sandbox, but same-UID access alone
  is never accepted as approval.
- All observations, decisions, actions, outputs, and verification records have
  retention and redaction rules.

## 13. Durability and controller ownership

### 13.1 Action exclusion

Only one valid action lease may exist for a component/incident/SOP attempt.
Multiple schedulers may observe the same incident. The guaranteed properties
are: the intent is written ahead of the side effect; at most one action lease is
active per component; a non-terminal action is never blindly retried; where the
registered action is idempotent the result is effectively-once mutation; and
where it is not, a crash between spawn and receipt reconciles to `uncertain`
and escalates. Helium does not claim exactly-once mutation of an external
system, and no gate, report, or acceptance criterion may be written as though
it did.

On the single Mac mini, `opsd` is the sole writer of the operations log and
holds an OS-atomic component action lock for every executing mutation. Any
future standby controller must acquire that same lock and reconcile the pinned
SOP digest before acting. A local `opsctl` client records approvals and manual
interventions through an owner-only Unix socket; it cannot edit the log or
execute a script directly.

### 13.2 Single mutation ownership per component

The action lease excludes two Helium controllers. It says nothing about the
legacy watchdogs, which are independent launchd jobs that know nothing about
leases, locks, or the ops event log. "Never two restart controllers" is stated
several times elsewhere in this design as a rule; here it is specified as a
recorded field, a fail-closed probe, an ordered handoff, and a test contract.

**1. Recorded ownership.** Every component in the registry carries a required
`mutationOwner`:

```ts
interface MutationOwnership {
  componentId: string;
  owner: "opsd" | "external" | "none";
  externalOwnerLabel?: string; // the legacy controller's launchd label
  competingLabels: string[]; // labels that must not be loaded when opsd owns
  changedAt: string;
  changeRef: string; // reviewed configuration change reference
}
```

`owner: "opsd"` is the only value under which a mutating SOP for that component
may execute. `owner: "external"` means a legacy controller still owns mutation
and every mutating SOP for the component behaves as `forbidden` regardless of
its own authority. `owner: "none"` means the component is observed but nothing
may mutate it. Ownership is reviewed configuration; no runtime trajectory
changes it. The current value and its `changeRef` are projected into durable
ops state and appear in every recovery evidence bundle for that component.

**2. Competing-controller probe, as a fail-closed precondition.** After the
lease is acquired and before the write-ahead intent is appended, the controller
runs a `controller`-dimension probe that enumerates loaded launchd jobs and
checks the component's `competingLabels`. The probe returns exactly one of:

- `clear` — no competing label is loaded; the mutation may proceed;
- `competing` — at least one competing label is loaded; or
- `unknown` — enumeration failed, timed out, or could not be parsed.

Both `competing` and `unknown` refuse the mutation. Unverifiable ownership is
not permission. The refusal is recorded as an action-plane rejection carrying
the probe evidence and the observed labels, escalates to the operator, and is
never recorded as a failed recovery — nothing was attempted.

The probe is re-run immediately before spawn, alongside the script-identity
recheck of section 12, so a competing label loaded during the window between
precondition and execution still refuses.

**3. Handoff and rollback ordering.** Release always precedes acquire, so that
a crash at any step leaves at most one controller enabled. Handing a component
from a legacy watchdog to `opsd`:

1. record the intended `external` -> `opsd` change with its `changeRef`;
2. disable the legacy controller's mutation path — unload its launchd label, or
   reconfigure it to observe-only — and verify the label is no longer loaded;
3. re-run the competing-controller probe and require `clear`;
4. set `mutationOwner.owner` to `opsd` and append the ownership event; then
5. enable the corresponding Ops SOP at its signed authority.

Rollback reverses the same order, releasing before acquiring:

1. return the Ops SOP to `observe` or `approve` and confirm no action lease is
   held for the component;
2. set `mutationOwner.owner` back to `external`;
3. reload the legacy launchd label; and
4. verify with the same probe that exactly one controller is loaded.

Crash semantics follow from the ordering. A crash between steps 2 and 4 of
either sequence leaves the component with no mutation controller: monitored,
alerting, non-mutating — the safe side of the failure, and the state an operator
resolves by re-running the sequence. A crash after the ownership event but
before the SOP is enabled is likewise inert. The reconciler treats an ownership
record of `opsd` combined with a `competing` probe result as an incident in its
own right: it refuses all mutations for that component and escalates until an
operator resolves the conflict; it never resolves the conflict by unloading the
other controller itself.

**4. Test contract.** None of this may require real launchd to test. The Ops
plugin supplies a fake `launchctl` seam — an injected job enumerator with a
scripted label list plus scripted failure modes (non-zero exit, truncated
output, timeout, unparseable output). The suite must cover at least: a
competing label loaded at precondition time; a competing label appearing
between the probe and the spawn; enumeration failure yielding `unknown` and a
refusal; an ownership record that disagrees with the probe; a crash after step
2 and after step 4 of the handoff; and a rollback that ends with exactly one
loaded controller. No test in this suite may invoke the real `launchctl` binary
or load, unload, or start a real job.

### 13.3 Crash boundaries

The controller supports failure at every boundary:

- before and after each ownership handoff step;
- before and after the pre-action baseline;
- before and after intent append;
- before and after process spawn;
- before and after action receipt;
- while waiting for postconditions;
- while an operator intervenes;
- during alert delivery; and
- during Helium restart.

An out-of-band launchd dead-man monitors the collector and Ops controller. The
Ops Agent cannot be its own sole monitor.

### 13.4 The observe boundary, stated exactly

"Observe only" and "no install" are two different constraints, holding in two
different windows. They are stated separately here because conflating them is
how a collector gets installed during a freeze: an implementer reads "observe
only", notes correctly that `opsd` in observe mode executes nothing, and
concludes that putting it on the mini is inside the rule. It is not. Where any
other document's prose is looser — "observe-only", "read-only", "no production
component or host mutation" — this section governs.

Each window is stated as verbs rather than adjectives. An adjective is what an
implementer rationalizes: whether `docker ps -a` is read-only and whether
rendering a plist is a mutation are both arguable. A named verb is not, and a
named verb is checkable at registration time.

**Window 1 — pre-install.** P2.5a: Ops Tasks 9-12 and 18, for the duration of
the AC#1 freeze, which closes **2026-08-31**. The boundary is the **host** and
the test is **presence**: if it puts a byte on the mini or starts a process
there, it is forbidden. That date is the value the installer's configured
freeze window must read; a freeze guard with no configured value to read is not
a guard.

Permitted:

- create, edit, test, review and merge collector, adapter, probe, registry and
  packaging code on any branch;
- run the install and uninstall scripts **on a developer machine only**, with
  `HOME` and the launchd root redirected into a process-local temporary
  directory that is removed on exit;
- read, add and sanitize fixtures; and
- read the mini's already-published health artifacts through channels that
  existed before this program — read-only, starting no new process there.

Forbidden without exception until 2026-08-31 has passed and the AC#1 evidence is
recorded:

- writing, copying or rendering any file anywhere on the mini's filesystem:
  plist, script, binary, configuration, log, or state directory;
- `launchctl load`, `launchctl bootstrap`, or `launchctl enable` of any
  `com.helium.opsd*` label;
- starting `helium-opsd`, `opsctl`, or any probe process on the mini,
  **including a single manual one-shot run "just to see the output"**;
- installing or upgrading any package on the mini;
- executing any probe command against the mini from another host; and
- deploying any Helium release to the mini, including one whose only change is
  that it contains the ops-agent plugin.

"No production component or host mutation" is **not** the test in this window.
Installing a LaunchAgent mutates no production component, and on a literal
reading mutates nothing at all; it is still forbidden. Presence is the test.

**Window 2 — installed and observing.** P4: rollout Stage 1's observe-only days
and Stage 2's suggest-only days, at least seven of each. Here `opsd` **is**
installed, so presence is no longer the boundary; it moves to **mutation**.

Permitted:

- `opsd` running as a LaunchAgent under the operator UID, with no privilege
  escalation and no `sudo`;
- exact-argv, timeout-bounded read-only probes: `vm_stat`, `df`, `sysctl`,
  `docker ps` and `docker inspect`, `colima status`, `launchctl list`, `psql`
  restricted to `SELECT`, and service health endpoints;
- writes confined to `opsd`'s own declared base directory — its append-only
  event log, observation store, bounded rotating logs, and lock directory; and
- emitting observations, incidents, alerts, and, in Stage 2 only, proposals
  recorded as proposals.

Forbidden:

- executing any SOP script at any authority in any runtime mode, **including a
  dry run that invokes the real script**;
- any write outside that declared base directory;
- `launchctl` mutation verbs: `load`, `unload`, `bootstrap`, `bootout`,
  `kickstart`, `enable`, `disable`;
- `docker` and `colima` lifecycle verbs: `start`, `stop`, `restart`, `rm`,
  `prune`;
- `kill` and `pkill`, any SQL other than `SELECT`, any file deletion, and any
  package-manager invocation;
- claiming, reassigning, or asserting `mutationOwner` for any component;
- unloading, reconfiguring, or otherwise touching an existing watchdog, restart
  policy, or dead-man — those remain the authoritative controllers for the whole
  window; and
- restarting or reconfiguring anything on the mini as a side effect of
  installing `opsd` itself.

**Enforcement.** Window 2's boundary is a deny-list in the executor, not prose.
A probe registered with a forbidden verb fails **registration at load time**,
not at call time, and a contract test asserts that a fixture probe carrying
`docker restart` cannot register. This extends, and does not replace, the
implementation plan's Task 10 gate requiring that no probe may mutate state.
Window 1's boundary is enforced by the installer's freeze-window refusal, whose
configured value is the date named above.

## 14. Rollout

### Stage 0: contracts and fixtures

- implement core schemas, reducers, dependency correlation, action leases, and
  fake executors;
- freeze sanitized fixtures representing the observed Colima, Livewire,
  Argon-backup, Apex, resource-pressure, and parser-drift cases; and
- pass crash, concurrency, injection, and replay suites.

### Stage 1: observe-only

- install the host-native collector after AC#1;
- run no recovery action;
- compare observations with existing sweep, watchdog, service APIs, and manual
  checks for at least seven days; and
- resolve false positive, parser drift, and dependency-correlation errors.

### Stage 2: suggest-only

- generate eligible SOP proposals but do not execute them;
- record operator accept/reject/alternate decisions and actual intervention;
- require truthful attribution of Colima-style manual recovery; and
- certify exact scripts and postconditions.

### Stage 3: narrow automatic recovery

- enable one `auto` SOP at a time, and only with a signed authority manifest
  entry for its exact digest (section 6.3.1);
- transfer mutation ownership from any existing component watchdog using the
  ordered handoff of section 13.2 before enabling the corresponding Ops SOP;
  the competing-label probe must report `clear` and the mutation precondition
  refuses on `competing` or `unknown`;
- preserve Docker restart policies but wait through their settle window before
  considering an additional action;
- keep attempt count one, cooldown long, and blast radius narrow;
- canary outside market-sensitive windows where applicable;
- stop promotion on any false recovery, duplicate action, incorrect
  attribution, or unexplained state transition.

### Stage 4: multi-agent analysis

- enable diagnostician and verifier with read-only tools;
- measure whether they find new evidence or reduce time to correct SOP;
- keep deterministic recovery available when providers fail; and
- add the incident lead only after eligibility enforcement is proven.

### Stage 5: ecosystem expansion

- add new components and SOPs without core changes;
- keep per-component owners and independent promotion evidence; and
- preserve the same action, verification, and audit contracts.

## 15. Acceptance criteria

The Ops Agent is accepted only when:

1. Livewire, Argon, Apex, Colima, PostgreSQL, CPU, memory, and disks all emit
   typed, freshness-bounded observations.
2. A new fixture component can be added without changing core.
3. Parser drift produces `unknown`, not a false healthy or restart decision.
4. Parent dependency failure groups or inhibits downstream alerts without
   deleting their evidence.
5. No action runs without an exact SOP version, a signed authority manifest
   entry, an authority decision, a lease, a verified single mutation owner, a
   pre-action baseline, a write-ahead intent, and a recovery budget.
6. Two controllers cannot execute the same attempt, and no mutation proceeds
   while a competing launchd controller is loaded or while the
   competing-controller probe returns `unknown`.
7. Command success with failed postconditions is not reported as recovery.
8. Command failure followed by operator recovery is attributed to the operator.
9. Restart at every action boundary converges to a terminal state with at most
   one active lease and no blind retry; where the target is not idempotent the
   terminal state may be `uncertain`, which is an accepted outcome and not a
   recovery.
10. All model providers may be disabled while observation, policy, execution,
    verification, and alerting continue.
11. Resource pressure reduces Helium concurrency before it adds analysis load.
12. Livewire targeted repair is proven on a corrupted fixture and then in a
    controlled drill before automatic promotion.
13. Colima automatic recovery passes a deterministic failure drill without
    operator intervention before it is considered effective.
14. IB restart, destructive database operations, data deletion, and host
    reboot remain impossible through the Ops Agent.
15. Every recovery report links to raw observations, SOP identity, action
    receipt, attribution, and postcondition evidence.
16. The Colima production-derived fixture records detection as proven,
    automatic recovery and attribution as failed, final health as proven, and
    operator recovery as the accepted attribution.
17. Livewire cannot close from process liveness alone; integrity, freshness,
    and coverage postconditions must all satisfy the exact repair policy.
18. Every terminal incident assertion has a policy-complete recovery evidence
    bundle, or remains explicitly partial, failed, or blocked.
19. An SOP file declaring `auto` or `approve` whose signed authority manifest
    entry is missing, unsigned, digest-mismatched, version-mismatched, or of a
    different authority loads at `observe` and cannot mutate anything.
20. An action whose postconditions already pass at its pre-action baseline
    terminates as `not-needed`, executes no script, and is excluded from every
    automation-credit and promotion statistic.

## 16. Research basis

This design follows:

- the provider/plugin, durable event, and subagent seams in the DeepSeek
  Harness architecture:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>;
- the _AI Agent Book_ emphasis on evaluation, traceable trajectories, and
  verified evolution rather than unreviewed online self-modification:
  <https://github.com/bojieli/ai-agent-book>;
- Google SRE guidance on automation risk, cascading failures, and separating
  process health from service health:
  <https://sre.google/sre-book/automation-at-google/> and
  <https://sre.google/sre-book/addressing-cascading-failures/>;
- Docker's native restart-policy semantics, which the controller must compose
  with rather than duplicate:
  <https://docs.docker.com/engine/containers/start-containers-automatically/>;
- PostgreSQL's distinction between server connection status and higher-level
  application health:
  <https://www.postgresql.org/docs/current/app-pg-isready.html>; and
- Apple's memory-pressure model, which considers more than allocated-memory
  percentage:
  <https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac>.
