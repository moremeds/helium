# Helium P5/P6 Long-Term Plan

**Date:** 2026-08-29

**Status:** Approved as a separate future plan; not authorized to execute until
the P4 opening gate below is accepted

**Relationship to the master plan:** This file extracts the former P5
ecosystem-expansion and P6 evaluated-evolution sections from the
[Helium Multi-Agent Master Plan](2026-08-25-helium-multi-agent-master-plan.md).
It does not revise, replace, or extend the active P0-P4 execution endpoint.

## Outcome

P5 proves that Helium's contracts support independently installable team
plugins beyond Macro and Ops. P6 then uses accumulated, reviewed trajectories
to propose and evaluate routing, prompt, skill, and catalog changes without
allowing production runs to modify the active safety or routing root.

The order is strict:

```text
P4 accepted
  -> P5 activation review
  -> P5 plugin expansion
  -> P5 accepted
  -> P6 data-readiness review
  -> P6 evaluated evolution
```

P5 and P6 are separate gates. P5 plugin success does not imply that enough
unbiased production data exists for P6.

## Opening gate from P4

Before any P5 implementation branch opens, record one dated activation review
that proves:

- the P4 Macro and Ops evidence manifests are accepted and contain no open
  safety, lineage, rollback, or provider-capacity blocker;
- the Codex single-agent Macro fallback and deterministic Ops plus
  watchdog/operator fallback have both been exercised;
- the three provider plugins expose versioned catalogs and provider-owned quota
  domains, including durable all-provider `waiting-for-capacity` evidence;
- P4 has produced enough real operator friction and plugin-boundary evidence to
  choose the next team by need rather than by novelty; and
- the repository paths, package boundaries, commands, and contract suites named
  below are revalidated against then-current `master`.

If any item is missing, P5 remains `BLOCKED`; do not weaken the gate or use a
fixture-only P4 result as production evidence.

## Program invariants

The P0-P4 invariants remain binding:

1. Core and team manifests are provider/model/effort blind.
2. Provider plugins own native submodels, effort options, entitlement,
   quota-domain membership, and invocation snapshots.
3. Team plugins own domain inputs, roles, DAG templates, tools, artifact and
   claim schemas, verification policy, evaluations, and delivery policy.
4. Sensors cannot invoke providers; agents cannot bypass controller, evidence,
   authority, or delivery gates.
5. Mutating plugins cannot grant themselves authority and never receive a
   generic shell.
6. Every change lands through a branch, pull request, green CI, and a reversible
   release. No production trajectory edits the active code or policy directly.

## P5: ecosystem plugin expansion

### P5.0 Activation and candidate selection

Use P4 evidence to score candidate teams on operator demand, reusable contract
coverage, data availability, verification strength, mutation risk, and expected
maintenance burden. Candidate domains remain:

- fundamental research;
- options and market-structure research;
- release and compatibility analysis; and
- document production.

Select exactly two initial teams. At least one should be read-only. Do not
select two teams that require the same source, renderer, or author judgment and
then call their success independent ecosystem proof.

**Gate:** commit the candidate decision, rejected alternatives, deterministic
baseline, human-takeover rule, and frozen evaluation inputs before writing a
team plugin.

### P5.1 Freeze the team-plugin conformance contract

Extend the existing provider/team install-remove proof into one reusable team
plugin contract. It must test:

- install and removal without edits to `packages/core` or `plugins/helium`;
- one-file manifest discovery and strict validation;
- effect-scoped registration and complete disposal;
- task-DAG, tool, artifact, claim, verification, and delivery schema ownership;
- workspace, tool, secret, and provider isolation;
- per-tenant invalid/unavailable health without global harness failure;
- deterministic/replayed execution with every real provider disabled;
- provider fallback and durable capacity wait without plugin-specific code;
- clean restart, cancellation, artifact replay, and rollback; and
- no direct sensor-to-provider, agent-to-delivery, or agent-to-authority edge.

Retain the Revision 3 activation bound: one non-interactive command, zero
prompts, no core diff, and a wall-clock ceiling of 120 seconds. The 120-second
value remains `PROVISIONAL` until the P5.0 review ratifies or replaces it.

**Gate:** a fake team package passes the complete contract and can be installed,
activated, stopped, removed, and replayed without production credentials.

### P5.2 Implement the first selected team

Build the first team only through the conformance boundary. Reuse the durable
case/task/artifact/evidence contracts and provider selector; do not add a
domain shortcut to core.

Required sequence:

1. freeze source and adversarial fixtures;
2. define the deterministic baseline and autonomy decision per agent-capable
   node;
3. write manifest/schema/tool-boundary failures first;
4. implement adapters, roles, DAG, artifacts, verification, and delivery inside
   the team package;
5. pass fake/replay, restart, cancellation, quota, and isolation suites;
6. run read-only shadow comparison; and
7. open a separate, bounded promotion review.

**Gate:** the plugin adds no core or harness composition change, every material
claim has accepted evidence, and disabling all providers preserves its declared
deterministic behavior.

### P5.3 Implement the second selected team

Repeat P5.2 without copying the first team's domain types or bypassing the
conformance package. Use the second plugin to falsify accidental assumptions in
the first implementation: different event shape, task graph, artifact schema,
verification policy, and delivery surface.

**Gate:** both plugins can be installed together, removed independently, and
run against different provider catalog snapshots without cross-tenant state,
tool, artifact, or quota leakage.

### P5 exit gate

P5 is accepted only when:

- at least two non-Macro teams run through the existing durable kernel;
- install/remove and one-command activation gates pass for both;
- neither plugin changes core, team controller, selector, or provider packages;
- each plugin has a deterministic baseline, autonomy decisions, human takeover,
  and an independent promotion record;
- an invalid or crashing plugin stays isolated and surfaces tenant health;
- shared provider quota exhaustion produces the same durable behavior proven at
  P4, with no plugin-specific retry loop; and
- the accumulated evidence identifies which, if any, P6 mechanisms are now
  data-justified.

## P6: evaluated evolution

### P6.0 Data-readiness review

Inventory reviewed P3-P5 trajectories by task type, provider target, outcome,
verifier, failure class, intervention, catalog version, and policy version.
Exclude quota-interrupted paired runs, changed-input pairs, unverifiable
outcomes, and operator-authored labels without independent checks.

Open P6 only when the review can define a representative train/tune/test split,
minimum sample sizes per decision class, contamination controls, and one frozen
primary metric before results are visible. If it cannot, continue collecting
data under P5; do not manufacture confidence intervals from a session-capped
subscription.

### P6.1 Build the offline trajectory corpus

Create an immutable, versioned corpus manifest that references redacted run
artifacts rather than copying secrets or mutable production paths. Record
provenance, schema/catalog/policy versions, inclusion/exclusion reason, and
content hashes. Freeze adversarial and regression holdouts separately.

**Gate:** replay is deterministic, redaction is verified, no live credential is
required, and the frozen test set cannot be read by proposal generation.

### P6.2 Add measured profiles behind the existing selector seam

Only now implement the deferred capability/effort evaluation work. Measurements
remain keyed by opaque target ID and suite version, with sample count,
confidence, known failures, latency, and cost. Provider-native model and effort
stay at the provider edge.

Weighted or learned routing, if justified, is a candidate policy evaluated
offline against the unchanged thin-selector baseline. It cannot relax hard
capability, isolation, tool, mutation, budget, or availability filters.

**Gate:** repeated evaluation reproduces the same result; ablation shows which
input causes any lift; uncertainty and sparse-target behavior fail closed; and
the thin selector remains a one-flag rollback.

### P6.3 Generate bounded change proposals

Candidate changes may include provider catalog defaults, ordered preferences,
prompts, skills, team DAG parameters, or verification policy. They may not
include credentials, authority roots, approval rules, audit retention,
isolation requirements, or direct production mutation.

Every candidate is an inert artifact containing its parent versions, rationale,
expected metric effect, changed fields, test command, rollback snapshot, and
expiry. A production run cannot activate it.

**Gate:** a proposal can only become code/config through a normal branch and PR;
the proposal generator has no write path to the active release or policy root.

### P6.4 Evaluate, review, canary, and roll back

For every candidate:

1. run frozen offline task, safety, retention, adversarial, and quota suites;
2. compare with the exact prior version on the pre-registered primary metric;
3. reject regressions or unbounded trade-offs;
4. obtain human review through a pull request;
5. canary a bounded, reversible shadow cohort;
6. promote only after the canary gate; and
7. prove rollback restores compatible code, policy, catalog, and state-schema
   snapshots.

### P6 exit gate

P6 is accepted only when:

- at least one promoted change has reproducible before/after evidence on a
  frozen holdout and an independently reviewed PR;
- no production run can directly change the active safety or routing root;
- hard filters and exact-target audit semantics remain unchanged;
- provider quota changes invalidate affected evaluations rather than becoming
  negative quality labels;
- rollback restores the prior code and compatible policy/catalog snapshots;
  and
- disabling P6 returns Helium to the accepted P5/P4 behavior without data loss.

## Delivery sequence

Use one PR per independently reversible unit:

1. P5 activation record and conformance contract;
2. first team plugin;
3. first team promotion record;
4. second team plugin;
5. second team promotion record and P5 exit evidence;
6. P6 data-readiness record and corpus tooling;
7. measured-profile evaluation behind a disabled flag;
8. bounded proposal generation;
9. first candidate evaluation/canary; and
10. P6 exit evidence.

After each merge, fetch and align local `master` to the remote merge commit,
rerun the gate from clean `master`, and preserve the next unopened gate. P5/P6
never authorize a direct push to `master`, automatic production policy edits,
or retirement of the P4 fallback paths.
