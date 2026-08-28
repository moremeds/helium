# Helium Ops Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a provider-neutral, dependency-aware Ops Agent that continuously
observes the ecosystem, executes only certified and authorized SOP scripts, and
verifies recovery without requiring an LLM in the safety path.

**Architecture:** Helium core owns typed observations, incidents, dependencies,
SOP authority and its signed manifest verification, single mutation ownership,
action leases, durable action state, and verification semantics.
The `ops-agent` plugin owns component adapters, exact script registrations,
host probes, team roles, and incident presentation. A host-native collector and
deterministic controller continue to work when Colima, DSH, or every model
provider is unavailable.

**Tech Stack:** TypeScript 5, Node.js 22+, pnpm, Vitest, Zod, YAML, DeepSeek
Harness/Cordis `0.1.1-rc.2`, append-only JSONL, macOS launchd, exact-argv child
processes, existing ecosystem health and recovery scripts.

---

## Execution rules and prerequisites

- Work in a dedicated worktree and land every phase through a green pull
  request; never push directly to `master`.
- Do not deploy, install launchd jobs, restart services, run repairs, or execute
  recovery drills on the mini during AC#1.
- Complete and merge the multi-agent plan's Phase 0 and Phase 1
  Tasks 6-7 and 10b before starting the action controller in this plan. That
  is the whole prerequisite, and it matches the near-term subset the master
  plan enumerates; do not re-inflate it to the full MA Tasks 8-15 block — only
  Task 10b, the structural topology guard Ops Task 10 runs against, is required
  out of that range.
- Re-read the actual post-prerequisite interfaces before creating the first
  Ops branch. Update paths in this plan through a reviewed documentation PR if
  those interfaces moved; do not create parallel stores or lease systems.
- Write and run a focused failing test before each production change.
- Keep the deterministic observation, policy, execution, and verification path
  fully testable with no provider plugin installed.
- Never expose a generic shell tool to an Ops role.
- Never represent a free-form command string in a persisted action.
- Treat probe output, logs, status pages, and model text as untrusted data.
- Do not promote an SOP from `approve` to `auto` in the same PR that first
  implements or certifies it.
- Stop at each phase gate for code review and evidence review.
- Reuse the canonical `EvidenceBundle` and accepted-ledger contracts; do not
  create an Ops-only definition of proven, partial, failed, or blocked.
- Never write "exactly-once" about a mutation or a delivery, in a test name, a
  gate, or a report. The properties this system provides are: write-ahead
  intent; at most one active lease; no blind retry; idempotent or
  effectively-once where the target supports it; otherwise a crash-reconcilable
  `uncertain`. An arbitrary external script cannot be made exactly-once, and
  claiming it hides the case the reconciler exists to handle.

### Program phase mapping

The A-E phases below are internal to this plan. They map onto the master plan's
program phases as follows:

| Ops work                                      | Program phase | Blocking dependency                                                                                                  |
| --------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase A, Tasks 1-4 (execute 2 -> 1 -> 3 -> 4) | P2.5a         | MA Phase 0-1 contracts                                                                                               |
| Phase B, Tasks 5-8 (incl. 7b)                 | P2.5a         | MA Phase 0-1 contracts                                                                                               |
| Phase C, Tasks 9-12 and 13a                   | P2.5a         | Ops Phase B; Task 10 additionally requires MA Task 10b — `contracts/tests/topology-structure.contract.spec.ts` exists and passes |
| Phase D, Tasks 14, 16, 17, 18                 | P2.5a         | Ops Phase C                                                                                                          |
| Phase E, Tasks 13b and 15                     | P3.5          | MA Phase 3 Task 18 (team manifests) and Task 19 (`team-controller.ts`)                                               |

Phase B blocks on MA Phase 0-1 only, exactly like Phase A. A P2.5a row cannot
block on P2: the program order is `P0 -> P1 -> P2.5a -> P2 -> P3 -> P3.5 -> P4`.
Four of the five Phase B tasks have no MA Phase 2 dependency at all. Task 6
builds the `ActionLease`, explicitly distinct from the work-execution
`ExecutionLease`. Task 7 creates `plugins/ops-agent` from scratch on pure
`spawn`. Task 7b depends only on Task 7. Task 8 consumes `EvidenceBundle`, which
MA Task 7 defines in P1. Only Task 5 ever needed a durable primitive, and that
primitive is the **generic** append-only event store — append, fsync, hash,
snapshot, truncated-line recovery, replay — not the team kernel; MA Task 7
defines it in P1 beside `EvidenceBundle`, and both Ops Task 5 and MA Task 13
consume it. Coupling Phase B to the team kernel would also contradict design
section 6.6, which says the Ops team "does not sit in the mandatory recovery
path" while Phase B _is_ that path, and this plan's own requirement that
`helium-opsd` keep working when Colima, DSH, or every model provider is
unavailable.

P2.5a contains only work whose files already exist or are created by this plan.
Everything that modifies the multi-agent team controller or consumes the team
manifest parser is P3.5 and cannot be scheduled earlier:
`plugins/helium/src/team-controller.ts` is _created_ by MA Phase 3 Task 19, not
modified by it, and `teams/*.yaml` has no parser until MA Task 18. Scheduling
all of this plan inside a single pre-P3 block was circular; do not restore it.

## Phase A: evidence fixtures and operations contracts

**Execution order inside Phase A is Task 2 -> Task 1 -> Task 3 -> Task 4.** The
task headings keep their numbering, but Task 2 lands the `ObservationSchema`
export first because Task 1's fixture contract parses every fixture through it.
No draft or placeholder schema is committed to unblock Task 1.

### Task 1: Freeze sanitized production-derived fixtures

**Files:**

- Create: `evals/fixtures/ops/colima-operator-recovery.json`
- Create: `evals/fixtures/ops/livewire-parquet-corruption.json`
- Create: `evals/fixtures/ops/livewire-parser-drift.json`
- Create: `evals/fixtures/ops/argon-backup-stale.json`
- Create: `evals/fixtures/ops/apex-healthy.json`
- Create: `evals/fixtures/ops/host-memory-pressure.json`
- Create: `evals/fixtures/ops/README.md`
- Create: `packages/core/tests/ops-fixtures.spec.ts`

**Step 1: Write the failing fixture contract**

**Schema first.** This test parses every fixture observation through
`ObservationSchema`, which Task 2 defines, so Task 2 lands before this task:
Phase A executes in the order Task 2 -> Task 1 -> Task 3 -> Task 4. The fixture
contract therefore validates against the real `ObservationSchema` export from
day one; no frozen-draft variant of the schema is ever committed. Do not
write this test against `expect.any(Array)`: an assertion that a key holds an
array can never fail, and these fixtures are the only encoding of the two
production incidents this whole program exists to prevent. A contract that
cannot fail is worse than no contract, because it reports green forever.

Create `packages/core/tests/ops-fixtures.spec.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObservationSchema } from "../src/operations/observation.js";

const root = join(process.cwd(), "evals", "fixtures", "ops");
const required = [
  "apex-healthy.json",
  "argon-backup-stale.json",
  "colima-operator-recovery.json",
  "host-memory-pressure.json",
  "livewire-parquet-corruption.json",
  "livewire-parser-drift.json",
];

describe("ops evidence fixtures", () => {
  it("contains exactly the required cases", () => {
    const files = readdirSync(root).filter((name) => name.endsWith(".json"));
    expect(files.sort()).toEqual(required);
  });

  it.each(required)("%s holds schema-valid observations", (name) => {
    const value = JSON.parse(readFileSync(join(root, name), "utf8"));
    expect(value).toMatchObject({
      fixtureVersion: 1,
      observedAt: expect.any(String),
      expected: expect.any(Object),
    });
    expect(Array.isArray(value.observations)).toBe(true);
    expect(value.observations.length).toBeGreaterThan(0);
    for (const raw of value.observations) {
      const parsed = ObservationSchema.parse(raw);
      expect(["ok", "degraded", "failed", "unknown"]).toContain(parsed.state);
    }
    expect(JSON.stringify(value)).not.toMatch(
      /100\.66\.|api[_-]?key|password/i,
    );
  });
});
```

`ObservationSchema.parse` throws on any entry that is not a valid observation,
so a fixture carrying a state outside `ok | degraded | failed | unknown`, an
unknown key such as `source`, a missing `parserVersion`, or an `expiresAt` that
does not follow `observedAt` fails this test. Prove that before moving on:
temporarily set one fixture state to `"healthy"` and confirm the suite goes
red.

The named-file assertion replaces the previous `toHaveLength(6)`. A bare count
breaks whenever a fixture is added and still proves nothing about content.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-fixtures.spec.ts
```

Expected: FAIL because the fixture directory does not exist.

**Step 3: Add the sanitized fixtures**

Use the read-only audit evidence and the operator correction. Every entry of
`observations` is a real `Observation`, not a loose sample record. The raw
vendor vocabulary of the incident (`recovery_exhausted`, `healthy`, the source
tool name) is preserved inside `value` and `evidenceRefs`, where it belongs;
`state` carries only the schema enum and the source tool becomes `probeId`.
The Colima fixture must encode:

```json
{
  "fixtureVersion": 1,
  "observedAt": "2026-08-25T03:02:34.000Z",
  "observations": [
    {
      "version": 1,
      "id": "obs-colima-watchdog-1",
      "componentId": "colima",
      "probeId": "colima.watchdog-log.v1",
      "observedAt": "2026-08-25T03:01:12.000Z",
      "expiresAt": "2026-08-25T03:06:12.000Z",
      "state": "failed",
      "dimension": "controller",
      "value": { "watchdogOutcome": "recovery_exhausted" },
      "evidenceRefs": ["artifact://ops-fixture/colima/watchdog.log"],
      "parserVersion": "colima-watchdog/1"
    },
    {
      "version": 1,
      "id": "obs-colima-inventory-1",
      "componentId": "colima",
      "probeId": "colima.container-inventory.v1",
      "observedAt": "2026-08-25T03:02:34.000Z",
      "expiresAt": "2026-08-25T03:07:34.000Z",
      "state": "ok",
      "dimension": "readiness",
      "value": { "containerCount": 20 },
      "evidenceRefs": ["artifact://ops-fixture/colima/docker-ps.json"],
      "parserVersion": "colima-inventory/1"
    }
  ],
  "interventions": [
    { "actor": "operator", "kind": "manual-recovery", "confirmed": true }
  ],
  "expected": {
    "incidentTerminal": "recovered",
    "actionOutcome": null,
    "attribution": "operator",
    "automaticRecoverySucceeded": false,
    "assertions": {
      "detection": "PROVEN",
      "automaticRecovery": "FAILED",
      "finalDockerHealth": "PROVEN",
      "automaticAttribution": "FAILED",
      "operatorAttribution": "PROVEN"
    }
  }
}
```

The two terminal keys are deliberately separate (review XDOC-9). Incident state
and action outcome are different planes with different vocabularies: an
incident ends `open | diagnosing | action-eligible | recovering | verifying |
recovered | failed | uncertain | escalated`, while an action ends in the
six-value set of design section 6.5 — `succeeded | failed | not-needed |
uncertain | superseded-by-operator | external-recovery`. `recovered` and
`escalated` are incident states and are never action outcomes. In this fixture
Helium attempted no action at all, so `actionOutcome` is `null`, not an
invented value.

Reconcile every other fixture the same way. The review recommends fixing the
fixtures rather than widening the schema: the states it found
(`recovery_exhausted`, `healthy`) are tool vocabulary, not observation states,
and adding them to the enum would let a probe report a state no policy code
handles. Extend `ObservationSchema` only if a genuinely missing observation
state is identified, and then update Task 2's schema, its tests, and the
correlator in the same change. If a fixture must also retain a verbatim vendor
payload, keep it under a separate `rawSamples` key that this contract does not
schema-check, and keep `observations` as real `Observation[]` regardless.

The Livewire corruption fixture must require a data-integrity SOP and reject a
generic process restart. Its targeted-repair assertion remains `BLOCKED` until
both the corrupt fixture and controlled drill pass integrity, freshness, and
coverage. Document what was removed or normalized, and every raw-to-schema
state mapping, in `evals/fixtures/ops/README.md`.

**Step 4: Re-run the fixture contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-fixtures.spec.ts
git diff --check
```

Expected: PASS; every fixture observation parses through `ObservationSchema`,
and no credential, host address, or raw sensitive log payload is committed.

**Step 5: Commit**

```bash
git add evals/fixtures/ops packages/core/tests/ops-fixtures.spec.ts
git commit -m "test: freeze ops incident fixtures"
```

### Task 2: Define component and observation contracts

**Files:**

- Create: `packages/core/src/operations/component.ts`
- Create: `packages/core/src/operations/observation.ts`
- Create: `packages/core/tests/operations-component.spec.ts`
- Create: `packages/core/tests/operations-observation.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing strict-schema tests**

Cover an open-ended component kind, dependency reference, observation expiry,
parser version, unknown state, and forbidden provider/model keys:

```ts
const observation = ObservationSchema.parse({
  version: 1,
  id: "obs-1",
  componentId: "fixture-service",
  probeId: "fixture.http.v1",
  observedAt: "2026-08-25T00:00:00.000Z",
  expiresAt: "2026-08-25T00:01:00.000Z",
  state: "unknown",
  dimension: "readiness",
  evidenceRefs: ["artifact://probe/1"],
  parserVersion: "fixture-http/1",
});
expect(observation.state).toBe("unknown");
expect(() =>
  ObservationSchema.parse({ ...observation, model: "forbidden" }),
).toThrow();
```

Add tests proving `kind: "future-component-kind"` is valid and a dependency
cycle is rejected only by graph validation, not by a closed component enum.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-component.spec.ts packages/core/tests/operations-observation.spec.ts
```

Expected: FAIL because the operations modules do not exist.

**Step 3: Implement strict provider-neutral schemas**

Export `ComponentSpecSchema`, `DependencyEdgeSchema`,
`ObservationSchema`, and matching inferred types. Use strict Zod objects.
Validate ISO timestamps and require `expiresAt > observedAt`. Keep component
IDs and probe IDs opaque strings with bounded lengths.

Do not add Livewire, Argon, Apex, Colima, PostgreSQL, provider, model, or effort
enums to core.

**Step 4: Run tests, typecheck, and neutrality guard**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-component.spec.ts packages/core/tests/operations-observation.spec.ts
pnpm typecheck
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS; the neutrality contract reports no domain or provider name in
core. That contract test is the single definition of the banned-token set; do
not restate the list as an inline `rg` here or anywhere else in this plan.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-component.spec.ts packages/core/tests/operations-observation.spec.ts packages/core/src/index.ts
git commit -m "feat: define generic operations observations"
```

### Task 3: Add dependency-aware incident correlation

**Files:**

- Create: `packages/core/src/operations/dependency-graph.ts`
- Create: `packages/core/src/operations/incident.ts`
- Create: `packages/core/src/operations/correlate.ts`
- Create: `packages/core/tests/operations-dependency.spec.ts`
- Create: `packages/core/tests/operations-correlate.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing graph and correlation tests**

Test cycle rejection, stable topological order, observation expiry, root-cause
grouping, child inhibition, parser unknown, and deterministic dedupe keys:

```ts
const result = correlate({ graph, observations, previous: [] }, now);
expect(result.incidents).toEqual([
  expect.objectContaining({
    rootComponentId: "runtime",
    symptomComponentIds: ["api-a", "api-b"],
    state: "open",
  }),
]);
expect(result.inhibitions).toEqual([
  expect.objectContaining({ child: "api-a", parent: "runtime" }),
  expect.objectContaining({ child: "api-b", parent: "runtime" }),
]);
```

Add a test where an expired probe becomes `unknown` and cannot produce an
action-eligible incident.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-dependency.spec.ts packages/core/tests/operations-correlate.spec.ts
```

Expected: FAIL because graph and correlator do not exist.

**Step 3: Implement pure deterministic correlation**

The correlator receives only a graph, current observations, previous projected
incidents, and an explicit clock. It returns events or a deterministic result;
it performs no I/O. Generate dedupe keys from component, dimension, failure
class, and active dependency root. Preserve inhibited child observations for
evidence and recovery verification.

**Step 4: Repeat correlation tests for determinism**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-dependency.spec.ts packages/core/tests/operations-correlate.spec.ts --repeat=20
```

Expected: byte-identical incident and inhibition snapshots across repeats.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-dependency.spec.ts packages/core/tests/operations-correlate.spec.ts packages/core/src/index.ts
git commit -m "feat: correlate dependency-aware incidents"
```

### Task 4: Define SOP, action, and authority contracts

**Files:**

- Create: `packages/core/src/operations/sop.ts`
- Create: `packages/core/src/operations/action.ts`
- Create: `packages/core/src/operations/check.ts`
- Create: `packages/core/src/operations/authority.ts`
- Create: `packages/core/src/operations/authority-manifest.ts`
- Create: `packages/core/tests/operations-sop.spec.ts`
- Create: `packages/core/tests/operations-check.spec.ts`
- Create: `packages/core/tests/operations-authority.spec.ts`
- Create: `packages/core/tests/operations-authority-manifest.spec.ts`
- Create: `ops/checks/README.md`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing SOP and authority tests**

Cover all four authority levels, exact executable identity, structured args,
preconditions, postconditions, grace, attempt limits, cooldown, maintenance
window, approval expiry, pinned SOP digest, deterministic priority, exclusive
groups, and fail-closed behavior:

```ts
const decision = decideAuthority({
  sop: certifiedAutoSop,
  incident,
  observations,
  history: [],
  now,
});
expect(decision).toEqual({ eligible: true, authority: "auto", reasons: [] });

expect(
  decideAuthority({
    sop: { ...certifiedAutoSop, authority: "forbidden" },
    incident,
    observations,
    history: [],
    now,
  }).eligible,
).toBe(false);
```

Reject free-form command strings, missing postconditions, `auto` without a
script hash/release identity, and an approval for a different incident or SOP
version. Add two equally ranked eligible SOPs in one exclusive group and assert
the controller returns `ambiguous` without selecting either.

Add a separate signed-authority-manifest suite in
`operations-authority-manifest.spec.ts` (design section 6.3.1). It must prove
that `resolveAuthority(sopFile, manifest, trustedKey)` returns `observe` for
every one of: no manifest present; a manifest whose Ed25519 signature does not
verify; a manifest that does not list the SOP; an entry whose `digest` does not
match the loaded SOP; an entry whose `version` does not match; and an entry
whose `authority` is lower than the file's claim. Only an entry matching
`sopId`, `version`, `digest`, and `authority` under a verifying signature
returns the file's authority:

```ts
expect(resolveAuthority(autoSopFile, signedManifest, trustedKey)).toEqual({
  authority: "auto",
  manifestEntry: expect.objectContaining({ digest: autoSopFile.digest }),
});
expect(
  resolveAuthority(autoSopFile, tamperedManifest, trustedKey),
).toMatchObject({ authority: "observe", reason: "manifest-signature-invalid" });
```

The escalation case is the point of the suite: take a certified `approve` SOP,
flip only the `authority` field in its file, leave the manifest untouched, and
assert the loaded authority is `observe` rather than `approve` or `auto`.

Add an action-intent test that a write-ahead intent without a `baseline` field
fails schema validation, and that an intent whose baseline records every
postcondition as already passing is rejected by the action plane rather than
executed (design section 6.4).

Add an `ActionOutcome` exhaustiveness test in the same suite. Assert the exported
set is exactly the six values of design section 6.5, in that order, and that a
`switch` covering all six compiles while one covering five does not:

```ts
expect(ACTION_OUTCOMES).toEqual([
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
]);

// @ts-expect-error - an incident state is never an action outcome
const notAnOutcome: ActionOutcome = "recovered";

// Exhaustive over all six. A seventh member leaves `outcome` non-`never` in the
// default branch and fails `pnpm typecheck` on this line.
function label(outcome: ActionOutcome): string {
  switch (outcome) {
    case "succeeded":
    case "failed":
    case "not-needed":
    case "uncertain":
    case "superseded-by-operator":
    case "external-recovery":
      return outcome;
    default:
      return assertOutcomeHandled(outcome);
  }
}
```

The two type-level lines are the real assertion. `@ts-expect-error` fails the
build if `"recovered"` ever becomes assignable, and the `default` branch fails it
if a seventh member is added — which is what makes the six-value set a contract
rather than the same prose repeated in five documents.

Add a checks suite in `operations-check.spec.ts`: an SOP whose `postconditions`
name a `CheckRef` absent from the loaded `ops/checks/` registry fails
registration; a `CheckDefinition` naming an unregistered probe fails
registration; a check whose probe cannot run yields `unknown`, never `pass`;
and a mutating SOP whose only postcondition is process liveness, with no
business check, fails certification.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-check.spec.ts packages/core/tests/operations-authority.spec.ts packages/core/tests/operations-authority-manifest.spec.ts
```

Expected: FAIL because the schemas, the checks registry, and the decision
function do not exist.

**Step 3: Implement strict contracts and pure policy**

Use this closed authority set only:

```ts
export type SopAuthority = "observe" | "auto" | "approve" | "forbidden";

export interface ActionSpec {
  executorId: string;
  executable: {
    path: string;
    identity: { kind: "sha256" | "release"; value: string };
  };
  argvSchemaId: string;
  cwdId: string;
  environmentProfileId: string;
  timeoutMs: number;
}

/**
 * An executable check. `CheckRef` in `SopDefinition` is this `id`, and nothing
 * else. Without this type the pre-action baseline is unimplementable: the
 * baseline must *run* every postcondition before the side effect, so a
 * postcondition cannot be an unresolved reference (review OPS-6).
 */
export interface CheckDefinition {
  id: string;
  /** What to run: a registered read-only probe plus its structured arguments. */
  probe: { probeId: string; args: Record<string, string | number | boolean> };
  /** How to read the probe result. Data, never an expression string. */
  expect: {
    dimension: string;
    operator: "eq" | "neq" | "gte" | "lte" | "contains";
    value: string | number | boolean;
  };
  /** Result when the probe cannot run or answer. */
  onUnavailable: "unknown";
  timeoutMs: number;
  owner: string;
}

export interface PostconditionSample {
  /** Must resolve to a registered `CheckDefinition.id`. */
  checkId: string;
  state: "pass" | "fail" | "unknown";
  observedAt: string;
  evidenceRefs: string[];
}

export interface ActionIntent {
  actionId: string;
  incidentId: string;
  componentId: string;
  sopId: string;
  sopVersion: number;
  sopDigest: string;
  leaseId: string;
  mutationOwnerRef: string;
  /** Fresh evaluation of every postcondition, taken before any side effect. */
  baseline: {
    capturedAt: string;
    samples: PostconditionSample[];
    allPassing: boolean;
  };
  argv: string[];
  recordedAt: string;
}

/**
 * The action plane's terminal set, exactly as classified in design section 6.5.
 * Six values, closed. The incident-plane states `recovered` and `escalated` are
 * not members, and neither is the action-plane decision `rejected`, which is a
 * policy refusal rather than an outcome.
 */
export const ACTION_OUTCOMES = [
  "succeeded",
  "failed",
  "not-needed",
  "uncertain",
  "superseded-by-operator",
  "external-recovery",
] as const;

export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** Exhaustiveness guard: a seventh outcome fails `pnpm typecheck` here. */
export function assertOutcomeHandled(value: never): never {
  throw new Error(`unhandled action outcome: ${String(value)}`);
}
```

`ActionOutcome` is a named P2.5a deliverable in the master plan, but until now no
task defined it. The six values existed only as English prose in five separate
places, so nothing mechanically prevented a seventh from being typed — the exact
drift review XDOC-9 and OPS-3 exist to stop. Define the union once here, in
`action.ts`, and have every other module import it rather than restate the list.
Do not add a value; do not widen it to accept an incident state.

The policy may return only `eligible`, `approval-required`, or `rejected`; it
does not execute. Re-evaluate preconditions and authority at lease time later.
Automatic arbitration orders eligible SOPs by explicit priority, match
specificity, and stable ID. Persist and later recheck the full SOP digest, not
only its human-readable version.

Add a checks registry alongside the SOP registry: checks are declared as data
under `ops/checks/*.yaml`, loaded and validated at startup, and addressed by ID.
Every precondition, postcondition, and baseline sample must reference a check
that exists in that registry and whose `probe` resolves to a registered
read-only probe; an SOP naming an unknown `CheckRef`, or a check naming an
unknown probe, fails registration rather than loading with a dangling
reference. Ship at least one real business check per mutating SOP — not only a
process-liveness check — so "postconditions pass" means the component does its
job, not merely that something is running. This is deliberately the whole
mechanism: no expression language, no check-authoring framework, no dynamic
evaluation. Do not expand it here.

**Sequencing.** `CheckDefinition` and the `ops/checks/` registry must land
before or with Task 8. Task 8's grace-window verification and its entire
attribution matrix start from a pre-action baseline that runs the postcondition
set; that is not implementable while a postcondition is an unresolved
`CheckRef`. Task 7's executor and Task 8's verifier both consume the registry.

`baseline` is required, not optional, and is not a cached observation: it is a
fresh run of the exact postcondition set that will later decide success. When
`baseline.allPassing` is true the action terminates as `not-needed` before
execution and no script runs. That state is not a success and not an
`uncertain` — it is deterministic knowledge that the component was already
healthy — and it must be excluded from every automation-credit statistic.
Without it, an operator fixing the component concurrently hands the controller
a free exit-0 plus passing postconditions, and the promotion gate that exists
to detect false automation credit is fed by exactly the case it is meant to
catch.

Implement `authority-manifest.ts` as a pure verifier: canonical-JSON encode,
Ed25519 verify against an injected trusted public key, then match the entry.
It performs no I/O and holds no key material; loading and key configuration
belong to `opsd` (Task 9 and Task 14). Reuse the canonical-JSON and Ed25519
helpers used by the operator approval envelope; do not introduce a second
signing scheme, key, or algorithm.

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-check.spec.ts packages/core/tests/operations-authority.spec.ts packages/core/tests/operations-authority-manifest.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-check.spec.ts packages/core/tests/operations-authority.spec.ts packages/core/tests/operations-authority-manifest.spec.ts ops/checks packages/core/src/index.ts
git commit -m "feat: authorize exact operations SOPs"
```

### Phase A gate

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
git diff --check
```

Expected: all checks pass; provider and ecosystem names remain outside the core
operations contracts. Open and merge a contracts-only PR before executor work.

## Phase B: durable action execution and reconciliation

### Task 5: Add the operations event reducer and store

**Files:**

- Create: `packages/core/src/operations/events.ts`
- Create: `packages/core/src/operations/reducer.ts`
- Create: `packages/core/src/operations/store.ts`
- Create: `packages/core/tests/operations-reducer.spec.ts`
- Create: `packages/core/tests/operations-store.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing transition and crash tests**

Test observation append, incident open/update, action proposal, authorization,
intent, execution receipt, verification, operator intervention, alert, snapshot,
truncated last line, and illegal transitions:

```ts
const state = reduceOperations([
  opened,
  proposed,
  authorized,
  intentRecorded,
  operatorIntervened,
  verifiedRecovered,
]);
expect(state.actions[actionId]).toMatchObject({
  state: "superseded-by-operator",
  attribution: "operator",
});
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-reducer.spec.ts packages/core/tests/operations-store.spec.ts
```

Expected: FAIL because event, reducer, and store modules do not exist.

**Step 3: Implement append-only operations state**

Reuse the generic append-only event store defined in MA Task 7
(`packages/core/src/event-store.ts`) for append, fsync, hash, snapshot,
truncated-line recovery, and replay. That module is a
P1 core primitive, not the Phase 2 team store: this task consumes it and so does
MA Task 13, which is the point of defining it once. Do not create a second JSONL
implementation, and do not wait for the team store. Append the event before
updating the in-memory projection. Reject duplicate event IDs and unsupported
versions. A corrupt snapshot falls back to full event replay.

**Step 4: Run store and reducer tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-reducer.spec.ts packages/core/tests/operations-store.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-reducer.spec.ts packages/core/tests/operations-store.spec.ts packages/core/src/index.ts
git commit -m "feat: persist operations incidents and actions"
```

### Task 6: Add exclusive action leases and recovery budgets

**Files:**

- Create: `packages/core/src/operations/lease.ts`
- Create: `packages/core/src/operations/recovery-budget.ts`
- Create: `packages/core/tests/operations-lease.spec.ts`
- Create: `packages/core/tests/operations-recovery-budget.spec.ts`
- Create: `packages/core/src/operations/component-lock.ts`
- Create: `packages/core/tests/operations-component-lock.spec.ts`
- Modify: `packages/core/src/operations/events.ts`
- Modify: `packages/core/src/operations/reducer.ts`

**Step 1: Write failing concurrency tests**

```ts
const first = controllerA.acquire({
  incidentId,
  componentId,
  sopId,
  attempt: 1,
});
expect(first.ok).toBe(true);
const second = controllerB.acquire({
  incidentId,
  componentId,
  sopId,
  attempt: 1,
});
expect(second).toEqual({ ok: false, reason: "lease-held" });
```

Test stale revisions, expired `ActionLease` records, mismatched release, stable
operation IDs,
cooldown, maximum attempts per incident, maximum runs per window, and duplicate
budget reservation. Spawn two child processes against the same temporary lock
directory and prove only one acquires the component mutation lock.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-lease.spec.ts packages/core/tests/operations-recovery-budget.spec.ts packages/core/tests/operations-component-lock.spec.ts
```

Expected: FAIL because lease and budget modules do not exist.

**Step 3: Implement event-backed CAS leases**

This is the `ActionLease` — the mutation-plane lease, distinct from the
work-execution `ExecutionLease` of the multi-agent plan. Scope the durable
`ActionLease` to `componentId + incidentId + sopId + sopDigest + attempt`. `helium-opsd` is the sole event-log writer. Before a mutation it also
acquires an OS-atomic component lock using `mkdir` or `O_CREAT|O_EXCL` under a
validated state-root lock directory. The lock receipt records boot identity,
PID, lease ID, SOP digest, acquisition time, and expiry. Reclaim only after
owner/process/boot reconciliation; never delete a live lock from elapsed time
alone.

Acquiring a lease appends a revision-checked event and reserves a stable
recovery operation ID. Replaying the same reservation is a no-op; replaying the
ID with different values is corruption.

**Step 4: Run the concurrency suite repeatedly**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-lease.spec.ts packages/core/tests/operations-recovery-budget.spec.ts packages/core/tests/operations-component-lock.spec.ts --repeat=50
```

Expected: at most one controller wins each attempt, and never two; no duplicate
budget charge. The property under test is at-most-one active lease, not
exactly-once execution — a losing controller correctly does nothing, and a
crashed winner reconciles rather than retries.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-lease.spec.ts packages/core/tests/operations-recovery-budget.spec.ts packages/core/tests/operations-component-lock.spec.ts
git commit -m "feat: lease and bound recovery actions"
```

### Task 7: Implement the certified exact-argv script executor

**Files:**

- Create: `plugins/ops-agent/package.json`
- Create: `plugins/ops-agent/tsconfig.json`
- Create: `plugins/ops-agent/tsconfig.typecheck.json`
- Create: `plugins/ops-agent/src/index.ts`
- Create: `plugins/ops-agent/src/script-registry.ts`
- Create: `plugins/ops-agent/src/script-registry.test.ts`
- Create: `plugins/ops-agent/src/script-executor.ts`
- Create: `plugins/ops-agent/src/script-executor.test.ts`
- Create: `plugins/ops-agent/src/testing/fake-script.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing registry and executor tests**

Test path, owner/mode, hash/release identity, exact argv, argument schema,
environment allow-list, owned cwd, timeout, process-group kill, output bound,
signal handling, and refusal after script drift:

```ts
await expect(
  executor.run(
    {
      actionId: "action-1",
      executorId: "script-v1",
      argv: ["--target-date", "2026-08-21"],
    },
    signal,
  ),
).resolves.toMatchObject({
  actionId: "action-1",
  exit: { code: 0 },
});

await expect(
  executor.run(
    {
      actionId: "action-2",
      executorId: "script-v1",
      argv: ["; rm", "anything"],
    },
    signal,
  ),
).rejects.toThrow(/argument schema/);
```

Assert the executor never calls `sh -c`, `bash -c`, or any command assembled
from model text.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/script-registry.test.ts plugins/ops-agent/src/script-executor.test.ts
```

Expected: FAIL because the plugin does not exist.

**Step 3: Implement registration and execution**

Use `spawn(executablePath, argv, { shell: false, detached: true, cwd, env })`.
Build the child environment only from the registered profile and explicitly
passed values. Compare the script identity immediately before spawn. Start a
new process group, TERM then KILL descendants on timeout, and retain only a
bounded output tail plus a digest of full output.

Return an execution receipt. Do not return `recovered`; verification owns that
classification.

**Step 4: Run focused tests and typecheck**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/script-registry.test.ts plugins/ops-agent/src/script-executor.test.ts
pnpm typecheck
```

Expected: PASS; the fake descendant is gone after timeout.

**Step 5: Commit**

```bash
git add plugins/ops-agent pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: execute certified ops scripts"
```

### Task 7b: Enforce single mutation ownership per component

The lease of Task 6 excludes a second Helium controller. It says nothing about
the legacy watchdogs, which are independent launchd jobs outside every lease,
lock, and event log. This task implements design section 13.2 — the one
crash-matrix cell that can produce a genuine duplicate production mutation. It
runs after Task 7 because the probe and its fake seam live in the
`plugins/ops-agent` package that Task 7 creates.

**Files:**

- Create: `packages/core/src/operations/mutation-owner.ts`
- Create: `packages/core/tests/operations-mutation-owner.spec.ts`
- Create: `plugins/ops-agent/src/probes/launchd-controller.ts`
- Create: `plugins/ops-agent/src/probes/launchd-controller.test.ts`
- Create: `plugins/ops-agent/src/testing/fake-launchctl.ts`
- Modify: `packages/core/src/operations/component.ts`
- Modify: `packages/core/src/operations/events.ts`
- Modify: `packages/core/src/operations/reducer.ts`

**Step 1: Write the failing ownership and probe tests**

Assert that `ComponentSpecSchema` requires `mutationOwner` with
`owner: "opsd" | "external" | "none"`, an optional `externalOwnerLabel`, a
`competingLabels` array, `changedAt`, and `changeRef`; a component without it
must not parse.

Assert the precondition is fail-closed in every non-`clear` case:

```ts
const probe = launchdControllerProbe({
  launchctl: fakeLaunchctl(["com.helium.opsd"]),
});
expect(await probe.check(component)).toMatchObject({ result: "clear" });

const competing = launchdControllerProbe({
  launchctl: fakeLaunchctl(["com.helium.opsd", "com.local.colima-watchdog"]),
});
expect(await canMutate(component, await competing.check(component))).toEqual({
  ok: false,
  reason: "competing-controller",
});

const broken = launchdControllerProbe({
  launchctl: fakeLaunchctl({ exitCode: 1 }),
});
expect(await canMutate(component, await broken.check(component))).toEqual({
  ok: false,
  reason: "ownership-unverifiable",
});
```

Cover the full contract from design section 13.2 step 4: `owner: "external"`
makes every mutating SOP behave as `forbidden` regardless of its own authority;
`owner: "none"` refuses all mutation; a competing label appearing between the
probe and the spawn is caught by the re-check at spawn time; enumeration
timeout, truncated output, and unparseable output all yield `unknown` and
therefore refusal; an ownership record of `opsd` contradicted by a `competing`
probe raises an incident and never self-resolves by unloading the other
controller.

Drive the handoff and rollback sequences as ordered state machines and assert
the crash invariant directly: for every prefix of the handoff sequence and
every prefix of the rollback sequence, the number of enabled mutation
controllers for the component is at most one. Assert a crash between steps 2
and 4 leaves zero controllers — monitored and non-mutating — and that rollback
ends with exactly one loaded controller.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-mutation-owner.spec.ts plugins/ops-agent/src/probes/launchd-controller.test.ts
```

Expected: FAIL because ownership state and the controller probe do not exist.

**Step 3: Implement ownership state and the fake-launchctl seam**

`mutation-owner.ts` is pure: it projects ownership from configuration and
ownership events, and exposes `canMutate(component, probeResult)` returning
`{ ok: true }` only for `owner === "opsd"` plus `probeResult.result ===
"clear"`. Every other combination returns a typed refusal reason. Core holds no
launchd knowledge and no label strings.

`launchd-controller.ts` enumerates loaded jobs with exact argv through an
injected `launchctl` runner and emits a `controller`-dimension observation. The
runner is an interface; `fake-launchctl.ts` is the only implementation used in
tests, scripting the loaded-label list plus non-zero exit, truncated output,
timeout, and unparseable output. No test in this plan may invoke the real
`launchctl` binary or load, unload, or start a real job — including the
contract suite in Task 17.

Record ownership changes as events so `mutationOwner` and its `changeRef`
appear in the component projection and in every recovery evidence bundle for
that component.

**Step 4: Run ownership, probe, and lease suites**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-mutation-owner.spec.ts packages/core/tests/operations-lease.spec.ts plugins/ops-agent/src/probes/launchd-controller.test.ts --repeat=20
pnpm typecheck
rg -n -i "launchctl|com\.helium|com\.local" packages/core/src/operations && exit 1 || true
```

Expected: PASS; no mutation proceeds without `clear`; no launchd or label
knowledge leaks into core.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-mutation-owner.spec.ts plugins/ops-agent/src/probes/launchd-controller.ts plugins/ops-agent/src/probes/launchd-controller.test.ts plugins/ops-agent/src/testing/fake-launchctl.ts
git commit -m "feat: enforce single mutation ownership per component"
```

### Task 8: Verify actions and reconcile operator intervention

**Files:**

- Create: `packages/core/src/operations/verify.ts`
- Create: `packages/core/src/operations/reconcile.ts`
- Create: `packages/core/src/operations/recovery-evidence.ts`
- Create: `packages/core/tests/operations-verify.spec.ts`
- Create: `packages/core/tests/operations-reconcile.spec.ts`
- Create: `packages/core/tests/recovery-evidence-bundle.spec.ts`
- Modify: `packages/core/src/operations/events.ts`
- Modify: `packages/core/src/operations/reducer.ts`

**Step 1: Write the failing Colima attribution matrix**

Table-drive these cases. Every row now starts from a recorded pre-action
baseline, because the baseline is what separates a recovery the controller
caused from a state it merely observed:

| Baseline        | Intent   | Executor exit   | Postconditions | Operator event | Expected                           |
| --------------- | -------- | --------------- | -------------- | -------------- | ---------------------------------- |
| some failing    | recorded | 0               | pass           | none           | succeeded / Helium                 |
| some failing    | recorded | 0               | fail           | none           | failed / Helium                    |
| some failing    | recorded | nonzero         | pass           | none           | uncertain, never claimed automatic |
| some failing    | recorded | nonzero         | pass           | confirmed      | superseded-by-operator             |
| some failing    | recorded | missing receipt | pass           | none           | uncertain                          |
| some failing    | none     | missing receipt | pass           | none           | external-recovery                  |
| some failing    | recorded | unknown/timeout | unknown        | none           | uncertain                          |
| all passing     | none     | not executed    | pass           | none           | not-needed, no automation credit   |
| all passing     | none     | not executed    | pass           | confirmed      | not-needed, operator-attributed    |
| unknown/refused | none     | not executed    | n/a            | none           | rejected, no action attempted      |

The `Intent` column is load-bearing, and the two `missing receipt` rows are why
it exists (review OPS-5). A missing receipt is **not** by itself evidence of an
external actor. If a write-ahead intent was recorded, Helium may well have run
the script and crashed before the receipt landed: attribution is genuinely
unclear, so the outcome is `uncertain`. Only when no intent exists — nothing
was ever attempted — can a recovered component be attributed to something
outside Helium, which is `external-recovery`. Classifying the intent-recorded
case as `external-recovery` would credit an external actor for a mutation
Helium may have performed, and would contradict this plan's own definition of
`uncertain`. Both rows must appear in the table-driven suite.

The two `all passing` rows are the operator-concurrent-fix case: the controller
must terminate before spawning anything, must not report `succeeded`, and must
not report `uncertain` either — the attribution is not unclear, it is known.
Assert explicitly that a `not-needed` action is excluded from any
automation-credit tally the promotion gate reads, and that a `succeeded`
classification is impossible unless the intent's baseline recorded at least one
failing postcondition. `uncertain` stays reserved for genuine attribution gaps:
missing receipt with a recorded intent, crash between spawn and receipt,
timeout, contested operator window.

Every `Expected` value above is drawn from the six-value action outcome set
defined in design section 6.5 — `succeeded`, `failed`, `not-needed`,
`uncertain`, `superseded-by-operator`, `external-recovery` — plus the
action-plane `rejected` decision, which is a policy refusal rather than an
outcome. Do not introduce a seventh value, and do not use the incident-plane
states (`recovered`, `escalated`) as action outcomes.

The final row covers Task 7b: a mutation refused for `competing-controller` or
`ownership-unverifiable` is an action-plane rejection with probe evidence
attached, not a failed recovery and not an attempt.

Use `colima-operator-recovery.json` as a regression fixture.
Assert its evidence decisions independently: detection `PROVEN`, automatic
recovery `FAILED`, final Docker health `PROVEN`, automatic attribution
`FAILED`, and operator attribution `PROVEN`. A later healthy observation must
not rewrite the failed automatic assertions.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts packages/core/tests/recovery-evidence-bundle.spec.ts
```

Expected: FAIL because verification and reconciliation do not exist.

**Step 3: Implement grace-window verification**

Inject a clock and probe runner. Wait `initialDelayMs`, sample until all
postconditions pass or `timeoutMs` expires, and append each result. On startup,
reconcile non-terminal intents from receipts, live process evidence, operator
events, and current postconditions. Never rerun an uncertain side effect during
reconciliation.

Build the recovery specialization of the canonical `EvidenceBundle`. Require
raw observation hashes, incident/dependency snapshot, exact SOP digest, the
signed authority manifest entry, the component's `mutationOwner` and its
controller-probe result, eligibility, authority, lease, intent including its
pre-action baseline, receipt, postcondition samples, attribution, verifier
version, replay or drill reference, final status, and remaining limitations.
Use explicit `notApplicableReason` values for a no-action operator, external,
or `not-needed` outcome; never fabricate action evidence.

**Step 4: Run the crash and attribution suite repeatedly**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts packages/core/tests/recovery-evidence-bundle.spec.ts --repeat=20
```

Expected: PASS; the production-derived Colima fixture is attributed only to the
operator.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts packages/core/tests/recovery-evidence-bundle.spec.ts
git commit -m "feat: verify and attribute operations recovery"
```

### Phase B gate

Run the full suite and a persisted crash matrix that terminates the controller
before and after lease, ownership handoff step, baseline capture, intent,
spawn, receipt, each verification sample, and operator event:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: no duplicate spawn, attempt, receipt, or terminal state; at most one
active lease throughout; no blind retry after any crash; no result classified
as recovery from an exit code alone; and no mutation attempted while ownership
is `competing` or unverifiable. The phase evidence manifest must link the crash
matrix, Colima attribution decisions, baseline-derived `not-needed` cases,
mutation-ownership refusals, recovery-bundle validation, verifier versions, and
the remaining live-drill gate. Merge through a dedicated PR.

## Phase C: Ops plugin, host collector, and component adapters

### Task 9: Add the open-ended component, probe, and SOP registry

**Files:**

- Create: `plugins/ops-agent/src/component-registry.ts`
- Create: `plugins/ops-agent/src/component-registry.test.ts`
- Create: `plugins/ops-agent/src/config.ts`
- Create: `plugins/ops-agent/src/config.test.ts`
- Create: `plugins/ops-agent/src/authority-manifest-loader.ts`
- Create: `plugins/ops-agent/src/authority-manifest-loader.test.ts`
- Create: `ops/components/fixture.yaml`
- Create: `ops/sops/fixture-observe.yaml`
- Create: `ops/authority-manifest.json`
- Modify: `plugins/ops-agent/package.json`

**Step 1: Write failing install/remove tests**

Load the fixture component and SOP from YAML. Assert graph validation, unknown
probe/SOP rejection, duplicate identity rejection, effect-scoped disposal, and
removal without core changes:

```ts
const dispose = registry.install(bundle);
expect(registry.component("fixture-service")).toBeDefined();
dispose();
expect(registry.component("fixture-service")).toBeUndefined();
```

Add a temporary `future-service.yaml` in the test and prove it loads without
editing TypeScript.

This is the loader that must actually enforce the authority manifest, so test
it here as a loading behavior, not only as a pure function (design section
6.3.1). Write a temporary SOP YAML declaring `authority: auto` alongside a
manifest that does not cover it, and assert the registry loads it at `observe`,
emits a `controller`-dimension observation naming the SOP and reason, and marks
it ineligible for any mutating decision. Repeat for a digest mismatch, an
unverifiable signature, and a missing manifest file. Assert the loader never
raises an SOP's authority and never falls back to "reviewed configuration
history" — it has no access to history, only to files and one trusted public
key:

```ts
const loaded = registry.install(bundleWithUnlistedAutoSop);
expect(registry.sop("fixture-auto").authority).toBe("observe");
expect(registry.sop("fixture-auto").authorityDowngradeReason).toBe(
  "manifest-entry-missing",
);
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/component-registry.test.ts plugins/ops-agent/src/config.test.ts plugins/ops-agent/src/authority-manifest-loader.test.ts
```

Expected: FAIL because the registry does not exist.

**Step 3: Implement bounded YAML loading**

Use strict schemas from core, maximum file/component/probe/SOP counts, relative
configuration references, exact active-version rules, and atomic bundle
installation. One bad bundle must fail only its tenant and emit tenant health;
it must not remove already-installed healthy components.

`authority-manifest-loader.ts` reads `ops/authority-manifest.json` and the
configured trusted public key path, then calls the pure verifier from Task 4
for every loaded SOP whose file declares an authority above `observe`. The
downgrade is unconditional and silent-free: the SOP loads at `observe`, the
reason is recorded on the registry entry and emitted as an observation, and no
runtime path can repair it. Commit `ops/authority-manifest.json` covering only
the fixture SOPs at this stage; real signed entries arrive with Task 16.

**Step 4: Run tests and package build**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/component-registry.test.ts plugins/ops-agent/src/config.test.ts plugins/ops-agent/src/authority-manifest-loader.test.ts
pnpm --filter dsh-plugin-helium-ops build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/ops-agent ops/components/fixture.yaml ops/sops/fixture-observe.yaml ops/authority-manifest.json
git commit -m "feat: load pluggable operations components"
```

### Task 10: Build the collector library and host resource probes

**Files:**

- Create: `plugins/ops-agent/src/collector.ts`
- Create: `plugins/ops-agent/src/collector.test.ts`
- Create: `plugins/ops-agent/src/probes/process.ts`
- Create: `plugins/ops-agent/src/probes/macos-resource.ts`
- Create: `plugins/ops-agent/src/probes/macos-resource.test.ts`
- Create: `plugins/ops-agent/src/probes/disk.ts`
- Create: `plugins/ops-agent/src/probes/disk.test.ts`
- Create: `ops/components/host.yaml`

**Step 1: Write failing parser and pressure tests**

Use frozen command-output fixtures for macOS memory pressure, `vm_stat`, swap,
CPU, load, `df`, mount identity, and Colima/Docker disk. Test locale variation,
missing fields, timeout, stale sample, and monotonic counter reset.

Assert:

```ts
expect(classifyMemory(sampleWithAllocatedSwapButNoChurn)).toBe("degraded");
expect(classifyMemory(sampleWithRapidSwapoutAndServiceImpact)).toBe("failed");
expect(classifyMemory(unparseableSample)).toBe("unknown");
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/collector.test.ts plugins/ops-agent/src/probes/macos-resource.test.ts plugins/ops-agent/src/probes/disk.test.ts
```

Expected: FAIL because collector and probes do not exist.

**Step 3: Implement bounded collection**

Run probes with exact argv and individual timeouts. Append observations to an
injected sink owned by the future `helium-opsd` process; the collector must not
open a second authoritative event-log writer. Calculate rates from consecutive
samples only when counter continuity is valid. Monitor internal data,
DATA_LAKE, Colima/Docker, backup, and Helium state volumes independently.

**Step 4: Run tests, shell tests, and dry packaging**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/collector.test.ts plugins/ops-agent/src/probes/macos-resource.test.ts plugins/ops-agent/src/probes/disk.test.ts
pnpm exec vitest run --project contracts contracts/tests/topology-structure.contract.spec.ts
```

Expected: PASS; no probe is allowed to mutate state and the collector has no
independent log writer. The collector and every probe must also pass
`contracts/tests/topology-structure.contract.spec.ts`, the structural half of
the topology guard delivered by multi-agent Task 10b: no static import path from
a probe or from the collector reaches an executor, a provider adapter, or a
lease. That guard lands in P1, before this task, precisely because this task
creates every sensor in the program; the behavioral half stays in MA Task 19 and
this expectation does not substitute for it.

**Step 5: Commit**

```bash
git add plugins/ops-agent/src/collector.ts plugins/ops-agent/src/collector.test.ts plugins/ops-agent/src/probes ops/components/host.yaml
git commit -m "feat: collect host operations observations"
```

### Task 11: Add Livewire, Argon, and Apex observation adapters

**Files:**

- Create: `plugins/ops-agent/src/adapters/livewire.ts`
- Create: `plugins/ops-agent/src/adapters/livewire.test.ts`
- Create: `plugins/ops-agent/src/adapters/argon.ts`
- Create: `plugins/ops-agent/src/adapters/argon.test.ts`
- Create: `plugins/ops-agent/src/adapters/apex.ts`
- Create: `plugins/ops-agent/src/adapters/apex.test.ts`
- Create: `ops/components/livewire.yaml`
- Create: `ops/components/argon.yaml`
- Create: `ops/components/apex.yaml`

**Step 1: Write failing adapter tests from fixtures**

For Livewire, distinguish:

- current raw logs with a status parser reporting `not found` -> parser
  `unknown`, not task failure;
- invalid Parquet footer -> integrity `failed` and generic restart ineligible;
- IB unavailable -> upstream degraded and restart forbidden; and
- stale coverage -> freshness degraded/failed by configured trading calendar.

For Argon, separate HTTP liveness from body `.ok`, DB readiness, worker
heartbeat, product freshness, and backup freshness. For Apex, include API,
PostgreSQL, Livewire revision/recency, and mount dependencies.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/adapters/livewire.test.ts plugins/ops-agent/src/adapters/argon.test.ts plugins/ops-agent/src/adapters/apex.test.ts
```

Expected: FAIL because adapters do not exist.

**Step 3: Implement read-only adapters**

Adapters transform raw probe artifacts into core `Observation` values. Preserve
raw evidence references, source/parser versions, and freshness expiry. Do not
put recovery selection or provider calls in adapters. A returned HTTP 200 may
still produce degraded business observations.

**Step 4: Run focused and fixture tests**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/adapters/livewire.test.ts plugins/ops-agent/src/adapters/argon.test.ts plugins/ops-agent/src/adapters/apex.test.ts packages/core/tests/ops-fixtures.spec.ts
```

Expected: PASS; the Livewire corruption fixture never selects a process restart.

**Step 5: Commit**

```bash
git add plugins/ops-agent/src/adapters ops/components/livewire.yaml ops/components/argon.yaml ops/components/apex.yaml
git commit -m "feat: observe livewire argon and apex"
```

### Task 12: Add Colima, PostgreSQL, and Helium adapters

**Files:**

- Create: `plugins/ops-agent/src/adapters/colima.ts`
- Create: `plugins/ops-agent/src/adapters/colima.test.ts`
- Create: `plugins/ops-agent/src/adapters/postgres.ts`
- Create: `plugins/ops-agent/src/adapters/postgres.test.ts`
- Create: `plugins/ops-agent/src/adapters/helium.ts`
- Create: `plugins/ops-agent/src/adapters/helium.test.ts`
- Create: `ops/components/colima.yaml`
- Create: `ops/components/postgres.yaml`
- Create: `ops/components/helium.yaml`

**Step 1: Write failing system-adapter tests**

Colima probes cover host socket, guest runtime, VM state, expected container
inventory, restart counts, and OOM state. PostgreSQL covers `pg_isready`,
`SELECT 1` latency, connection pressure, locks, database growth, backup age,
backup metadata/integrity tier, and launch ownership. Helium covers process,
global heartbeat, expected tenant, per-tenant heartbeat, collector freshness,
and dead-man state.

Use the Colima operator-recovery and Argon backup-stale fixtures. Assert a
healthy database listener plus stale backup remains a critical backup incident.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/adapters/colima.test.ts plugins/ops-agent/src/adapters/postgres.test.ts plugins/ops-agent/src/adapters/helium.test.ts
```

Expected: FAIL because adapters do not exist.

**Step 3: Implement read-only system adapters**

Use exact argv, bounded SQL, read-only transactions where applicable, and no
credentials in artifacts. A backup check may read headers and run `gzip -t` on
an existing file only in its configured low-impact integrity window; routine
samples check freshness, size, name, and manifest without streaming a 20 GiB
dump. Restore rehearsal is a separate approval-required SOP against an isolated
target. A probe may not create a backup. Helium expected-tenant health reuses
the Phase 0 manifest instead of inventing another tenant list.

**Step 4: Run focused tests and neutrality guard**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/adapters/colima.test.ts plugins/ops-agent/src/adapters/postgres.test.ts plugins/ops-agent/src/adapters/helium.test.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS; domain names exist only in the plugin/configuration.

**Step 5: Commit**

```bash
git add plugins/ops-agent/src/adapters ops/components/colima.yaml ops/components/postgres.yaml ops/components/helium.yaml
git commit -m "feat: observe colima postgres and helium"
```

### Task 13a: Add alert grouping and the admission decision function (P2.5a)

The original Task 13 also modified `plugins/helium/src/team-controller.ts`,
which MA Phase 3 Task 19 _creates_. That made this phase unschedulable. The
task is split: everything with no P3 dependency stays here; enforcement inside
the team controller moves to Task 13b in Phase E.

**Files:**

- Create: `packages/core/src/operations/admission.ts`
- Create: `packages/core/tests/operations-admission.spec.ts`
- Create: `plugins/ops-agent/src/alerts.ts`
- Create: `plugins/ops-agent/src/alerts.test.ts`

**Step 1: Write failing alert and admission tests**

Test sustained `for` windows, dedupe, inhibition, recovery transition, alert
channel failure, and no periodic restatement. Test the admission decision
directly as a pure function: sustained memory pressure refuses optional new
teams and subagent fan-out but admits collectors, deterministic actions, one
minimal incident lane, and dead-man work.

```ts
expect(admission.decide(optionalResearch, pressure)).toEqual({
  admitted: false,
  reason: "host-memory-pressure",
});
expect(admission.decide(deterministicRecovery, pressure).admitted).toBe(true);
```

No test in this task may import `plugins/helium/src/team-controller.ts`; it
does not exist yet.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.test.ts
```

Expected: FAIL because admission and Ops alerts do not exist.

**Step 3: Implement pure admission and transition alerts**

Make admission a core pure function over resource observations, work class,
and policy, with no caller in this task. The Ops alert renderer groups by
incident root and lists inhibited symptoms. Reuse the existing delivery
write-ahead contract. Alert failure creates a delivery incident; it does not
repeat the recovery action.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/operations/admission.ts packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.ts plugins/ops-agent/src/alerts.test.ts
git commit -m "feat: group ops alerts and decide admission under pressure"
```

### Phase C gate

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: all initial required components have fixture-backed observations; the
admission decision function is proven as a pure function; no action executes
yet. This gate does **not** assert that host pressure prevents team fan-out —
that requires the team controller and is asserted at the Phase E gate. Open and
merge an observe-only plugin PR. Do not install `opsd` until AC#1 is complete
and a separate deployment plan is approved. "Do not install" here is design
section 13.4's Window 1, where the boundary is the **host** and the test is
**presence**, not mutation: merging this code is permitted, and putting a byte
on the mini or starting any process there — including one manual one-shot probe
run — is not, until 2026-08-31 has passed and the AC#1 evidence is recorded.

## Phase D: true multi-agent analysis and SOP certification

### Task 14: Add observe-only and suggest-only `opsd` modes

**Files:**

- Create: `plugins/ops-agent/src/controller.ts`
- Create: `plugins/ops-agent/src/controller.test.ts`
- Create: `plugins/ops-agent/src/mode.ts`
- Create: `plugins/ops-agent/src/mode.test.ts`
- Create: `plugins/ops-agent/src/ipc.ts`
- Create: `plugins/ops-agent/src/ipc.test.ts`
- Create: `plugins/ops-agent/src/approval.ts`
- Create: `plugins/ops-agent/src/approval.test.ts`
- Create: `plugins/ops-agent/src/bin/opsd.ts`
- Create: `plugins/ops-agent/src/bin/opsctl.ts`
- Create: `plugins/ops-agent/src/bin/opsctl.test.ts`
- Create: `scripts/ops/sign-approval.mjs`
- Create: `scripts/ops/sign-approval.test.mjs`
- Modify: `plugins/ops-agent/src/index.ts`
- Create: `plugins/ops-agent/src/index.test.ts`
- Create: `plugins/ops-agent/cordis.patch.yml`

**Step 1: Write failing mode tests**

Assert:

- `observe` records incidents but produces no action proposal;
- `suggest` records eligible SOP proposals and operator decisions but never
  executes;
- `approve` can execute only after a matching unexpired approval;
- `auto` executes only an eligible automatic SOP;
- a runtime mode cannot elevate an SOP's configured authority;
- no mode executes an SOP whose signed authority manifest entry is missing or
  invalid — `opsd` starts, serves observations, and holds that SOP at
  `observe`, rather than refusing to start or executing anyway; and
- **an installation carrying no authority manifest at all still starts `opsd`
  with every SOP at `observe`**, rather than failing open into a higher
  authority or refusing to start. **Moved here from Task 18 Step 1**, which
  asserted it against a binary its own phase does not build: `opsd` and
  `mode.ts` are created by this task, and Task 18 is packaging-only. Task 18
  keeps the packaging half — that the installer renders the manifest path into
  the configuration and never fabricates a manifest.

Add a process-boundary test that stops the DSH fixture while `opsd` continues
to collect, correlate, and execute a fake eligible automatic SOP. Test owner-only
Unix-socket access for `opsctl approve` and `opsctl record-intervention`; direct
event-log edits and approval for another incident/SOP digest must fail.
Test approval nonce replay, expiry, signature/authenticator failure, and an
agent sandbox attempting to reach the control socket.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/controller.test.ts plugins/ops-agent/src/mode.test.ts plugins/ops-agent/src/ipc.test.ts plugins/ops-agent/src/approval.test.ts plugins/ops-agent/src/bin/opsctl.test.ts plugins/ops-agent/src/index.test.ts
```

Expected: FAIL because controller composition does not exist.

**Step 3: Implement deterministic-first orchestration**

The controller ingests observations, correlates incidents, evaluates SOPs, and
persists state before optionally creating a team run. In observe and suggest
modes it must not instantiate the script executor. In approve/auto modes it
rechecks current state and uses the durable action path from Phase B.

Compose the collector and deterministic controller in the standalone
`helium-opsd` binary. `opsd` is the sole event-log writer and runs independently
of DSH. The DSH plugin connects as an optional analysis client; losing it never
stops collection or an already-authorized recovery. Expose an owner-only Unix
socket with mode `0600`. `opsctl` may submit a scoped, expiring approval or a
manual-intervention event through that socket; it cannot invoke an executor or
edit state directly. Approval includes an incident/SOP/digest-bound nonce and
an Ed25519 signature over canonical JSON. `opsd` is configured with only the
trusted public key. `scripts/ops/sign-approval.mjs` runs on the operator's
trusted workstation with an off-mini private key; `opsctl approve --envelope`
submits the signed artifact. A socket connection or matching UID alone is not
approval.

The same trusted public key verifies the authority manifest (Task 9). `opsd`
resolves every SOP's effective authority at load and on every configuration
reload, never at execution time from the file, and records the resolved
authority plus the manifest entry in the action's evidence. `opsctl` has no
command that writes, replaces, or reloads a manifest.

**Step 4: Run tests with no providers installed**

```bash
HELIUM_TEST_NO_PROVIDERS=1 pnpm exec vitest run --project unit plugins/ops-agent/src/controller.test.ts plugins/ops-agent/src/ipc.test.ts plugins/ops-agent/src/approval.test.ts plugins/ops-agent/src/bin/opsctl.test.ts plugins/ops-agent/src/index.test.ts
node --test scripts/ops/sign-approval.test.mjs
```

Expected: PASS; observations, incidents, policy, and eligible recovery continue.

**Step 5: Commit**

```bash
git add plugins/ops-agent/src plugins/ops-agent/cordis.patch.yml scripts/ops/sign-approval.mjs scripts/ops/sign-approval.test.mjs
git commit -m "feat: run ops in observe and suggest modes"
```

### Task 16: Inventory and certify the first existing scripts

**Files:**

- Create: `docs/ops/script-inventory.md`
- Create: `ops/executors/trading-stack-reconcile.yaml`
- Create: `ops/executors/colima-restart.yaml`
- Create: `ops/executors/livewire-targeted-repair.yaml`
- Create: `ops/sops/colima-reconnect.yaml`
- Create: `ops/sops/colima-bounded-restart.yaml`
- Create: `ops/sops/livewire-targeted-parquet-repair.yaml`
- Create: `plugins/ops-agent/tests/script-certification.spec.ts`
- Create: `scripts/ops/sign-authority-manifest.mjs`
- Create: `scripts/ops/sign-authority-manifest.test.mjs`
- Modify: `ops/authority-manifest.json`

**Step 1: Write a failing certification test**

Require every inventory row and executor/SOP registration to include repository
or deployment owner, exact path, release/hash identity, argv schema, cwd,
environment profile, preflight, postconditions, timeout, attempt limit,
cooldown, blast radius, rollback/compensation statement, drill state, and the
`mutationOwner` of the component the SOP mutates — including the competing
launchd label of any legacy controller that currently owns it. A mutating SOP
registered against a component whose `mutationOwner.owner` is not `opsd` must
fail certification with that reason, not load as eligible.

Assert every registration above `observe` has a matching entry in
`ops/authority-manifest.json` with the same digest, and that the test fails if
an SOP file's authority is edited without re-signing the manifest. Assert all
first registrations use `approve` unless their controlled drill record is
already present. Explicitly assert the IB Gateway restart action is absent and
forbidden by policy.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/tests/script-certification.spec.ts
```

Expected: FAIL because no script inventory or registrations exist.

**Step 3: Certify without claiming automatic readiness**

Inventory the live deployment versions of the existing trading-stack sweep and
container-only reconcile, Colima watchdog action, Livewire status/quality and
targeted repair commands, and Argon backup tooling. Resolve runbook-versus-live
topology drift before registering an executable.

For Livewire, first prove which existing targeted command repairs the exact
corrupt artifact represented by the fixture. Do not infer that every Parquet
error is repairable by the same command. Keep the SOP at `approve` and
`certificationState: fixture-only` until a controlled drill passes.

Record, for each component these SOPs touch, which legacy controller currently
owns mutation and under what launchd label. That label is the component's
`competingLabels` entry and the input to the Task 7b probe; certification
cannot be completed by guessing it.

`sign-authority-manifest.mjs` mirrors `sign-approval.mjs`: it runs on the
operator's trusted workstation, reads the SOP digests, and emits a signed
`ops/authority-manifest.json` using the same off-mini Ed25519 key. It must
refuse to run against a private key found on the mini, and it never runs in CI
or from `opsd`. Signing the manifest is a deliberate operator act, which is the
entire point of the mechanism.

**Step 4: Run certification and drift tests**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/tests/script-certification.spec.ts plugins/ops-agent/src/script-registry.test.ts
node --test scripts/ops/sign-authority-manifest.test.mjs
```

Expected: PASS; script drift makes registration ineligible rather than silently
updating identity, and an unsigned authority change downgrades the SOP to
`observe` rather than taking effect.

**Step 5: Commit**

```bash
git add docs/ops ops/executors ops/sops ops/authority-manifest.json scripts/ops/sign-authority-manifest.mjs scripts/ops/sign-authority-manifest.test.mjs plugins/ops-agent/tests/script-certification.spec.ts
git commit -m "docs: certify initial operations scripts"
```

### Task 17: Add the full adversarial contract suite

**Files:**

- Create: `contracts/fixtures/ops-controller/package.json`
- Create: `contracts/fixtures/ops-controller/cordis.patch.yml`
- Create: `contracts/fixtures/ops-controller/src/index.ts`
- Create: `contracts/tests/ops-controller.contract.spec.ts`
- Create: `contracts/tests/ops-action-boundary.contract.spec.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Step 1: Write the failing adversarial matrix**

Cover at least:

- HTTP 200 with stale product data;
- parser drift with current raw logs;
- corrupted Parquet where restart is ineligible;
- Colima failure followed by operator recovery;
- parent dependency alert storm;
- two controllers racing for one action;
- a competing legacy launchd controller loaded on the same component, and the
  same case with the label appearing between the probe and the spawn;
- the controller probe failing, timing out, or returning unparseable output, so
  ownership is unverifiable;
- a crash at each step of the ownership handoff and of the rollback, asserting
  at most one enabled mutation controller after every prefix;
- an SOP file edited from `approve` to `auto` with the authority manifest left
  untouched, and the same case with a re-signed manifest under an untrusted
  key;
- crash before/after baseline, intent, spawn, receipt, and verification;
- an operator fixing the component between incident opening and lease
  acquisition, so the pre-action baseline already passes;
- executable changed after SOP approval;
- action exits zero but postconditions fail;
- action exits nonzero but postconditions later pass;
- DATA_LAKE path exists but mount identity is wrong;
- model/log prompt injection requests forbidden action;
- a same-UID agent process attempts to reach the control socket or replay an
  approval nonce;
- provider outage;
- alert delivery outage;
- clock/timezone jump;
- operator and controller act concurrently;
- a healthy final observation attempting to overwrite a failed automatic
  recovery assertion;
- an incomplete recovery bundle attempting to enter the accepted ledger; and
- a reporter attempting to promote `PARTIAL`, `FAILED`, or `BLOCKED` to
  `PROVEN`.

The "host memory pressure during attempted team fan-out" case is **not** in
this suite: it needs the real team controller and therefore belongs to Task 13b
and the Phase E gate. Do not fake a team controller here to keep the case.

**Step 2: Run the contracts and verify failure**

```bash
pnpm exec vitest run --project contracts contracts/tests/ops-controller.contract.spec.ts contracts/tests/ops-action-boundary.contract.spec.ts
```

Expected: FAIL because the fixtures and contracts do not exist.

**Step 3: Build a fake host and executor fixture**

The fixture uses temporary files, fake clocks, fake processes, fake providers,
and the `fake-launchctl` seam from Task 7b. It must never SSH, invoke the real
`launchctl`, touch a real launchd job, connect to the real PostgreSQL instance,
or mutate a real mount. It also supplies a fake signing keypair so manifest
verification is exercised end to end without the real operator key. Persist the
event log across controller process restarts and assert terminal convergence.

**Step 4: Run the contracts repeatedly**

```bash
pnpm exec vitest run --project contracts contracts/tests/ops-controller.contract.spec.ts contracts/tests/ops-action-boundary.contract.spec.ts --repeat=20
```

Expected: PASS with one or zero authorized side effects per case, truthful
attribution, no forbidden command, no mutation under competing or unverifiable
ownership, no authority taken from an unsigned file, no execution when the
baseline already passes, immutable evidence decisions, and no terminal recovery
assertion without a policy-complete evidence bundle.

**Step 5: Commit**

```bash
git add contracts/fixtures/ops-controller contracts/tests/ops-controller.contract.spec.ts contracts/tests/ops-action-boundary.contract.spec.ts pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "test: adversarially verify ops recovery"
```

### Task 18: Package observe-only deployment without installing it

**Files:**

- Create: `scripts/ops/install-observe-only.sh`
- Create: `scripts/ops/uninstall-observe-only.sh`
- Create: `scripts/ops/install-observe-only.test.sh`
- Create: `scripts/ops/run-opsd.sh`
- Create: `launchd/com.helium.opsd.plist.template`
- Modify: `scripts/release/deploy.sh`
- Modify: `scripts/release/rollback.sh`
- Modify: `scripts/deadman/check-heartbeat.sh`
- Modify: `scripts/deadman/check-heartbeat.test.sh`
- Create: `docs/ops/observe-only-runbook.md`

**Step 1: Write failing packaging tests**

**Scope: packaging only. This task asserts nothing about `opsd` at runtime.**
The `helium-opsd` binary and its mode module are created by Task 14
(`plugins/ops-agent/src/bin/opsd.ts`, `plugins/ops-agent/src/mode.ts`), and
Task 14 is outside the authoritative near-term subset the master plan
enumerates ("Near-term subset — stated as task IDs"), which admits Ops
Tasks 9-12 and 18 only. A test here that started `opsd` would either be
asserting against a binary this subset never builds, or asserting nothing at
all. Everything below is therefore an assertion about **files, exit codes, and
filesystem effects** — text the installer renders, syntax of the scripts it
installs, and what appears and disappears under a redirected root.

The whole suite runs against a **process-local temporary directory** with `HOME`
and the launchd root redirected into it and removed on exit — exactly and only
what section 13.4's Window 1 permits. This test runs on a developer machine;
nothing in this task may put a byte on the mini or start a process there.

Assert:

- **Static syntax.** `bash -n` parses `scripts/ops/install-observe-only.sh`,
  `scripts/ops/uninstall-observe-only.sh`, and `scripts/ops/run-opsd.sh`
  without error, and `plutil -lint` accepts the rendered
  `launchd/com.helium.opsd.plist.template`. A plist that does not lint is a
  packaging defect discoverable without ever loading it.
- **Install/uninstall round trip.** Install writes exactly its declared file
  set under the redirected root and nothing outside it; uninstall removes only
  its exact labels and files and leaves the redirected root byte-identical to
  its pre-install state. No test invokes the real `launchctl`.
- **Freeze-window refusal, both directions.** The configured freeze window ends
  **2026-08-31**: that is the value the refusal reads, and design section 13.4
  is where it is stated normatively. A freeze guard with no configured value is
  not a guard, so assert both directions — an install attempt dated before that
  date exits non-zero and writes nothing, and one dated after it does not
  refuse on freeze grounds.
- **Rendered configuration text.** The rendered `opsd` configuration names
  `observe` as the default mode, contains no secret, names the operator public
  key **path** and no private key material, and names the authority manifest
  path. The installer never writes or regenerates a manifest itself.
- **Neighboring packaging.** Existing watchdogs and their plists are untouched
  by install and by uninstall; `scripts/release/rollback.sh` restores the prior
  compatible collector/plugin pair; and `scripts/deadman/check-heartbeat.sh`,
  run against a fixture state file carrying a stale `opsd` observation
  timestamp and a current DSH heartbeat, reports the `opsd` staleness.

**Moved out of this task.** The assertion that *installing without an authority
manifest still starts `opsd` with every SOP held at `observe` rather than
failing open* is a runtime property of a binary this task does not build. It now
lives in **Task 14 Step 1**, where `plugins/ops-agent/src/mode.ts` and
`plugins/ops-agent/src/bin/opsd.ts` exist and the mode tests can actually
observe it. What survives here is only the packaging half: the installer renders
the manifest path into the configuration and never fabricates a manifest.

**Step 2: Run tests and verify failure**

```bash
bash scripts/ops/install-observe-only.test.sh
```

Expected: FAIL because packaging scripts do not exist.

**Step 3: Implement reversible packaging**

Use explicit target directories, validated release paths, and launchd labels.
Do not use destructive recursive removal. The deployment script must require a
separate post-AC#1 operator command; merging this code cannot install or start
`opsd`.

The launchd template runs `helium-opsd` outside Colima and DSH, uses the current
Helium release, writes bounded logs, and contains no credential. Extend the
existing host dead-man to check `opsd` freshness as an independent expected
tenant/controller. Do not create a dead-man inside `opsd` itself.

**Step 4: Run packaging and full gates**

```bash
bash scripts/ops/install-observe-only.test.sh
bash -n scripts/ops/install-observe-only.sh
bash -n scripts/ops/uninstall-observe-only.sh
bash -n scripts/ops/run-opsd.sh
plutil -lint launchd/com.helium.opsd.plist.template
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: PASS; no host or production state changes.

**Step 5: Commit**

```bash
git add scripts/ops launchd/com.helium.opsd.plist.template scripts/release/deploy.sh scripts/release/rollback.sh scripts/deadman/check-heartbeat.sh scripts/deadman/check-heartbeat.test.sh docs/ops/observe-only-runbook.md
git commit -m "feat: package ops observe-only rollout"
```

### Phase D gate

Before merging:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
rg -n "shell:\s*true|sh -c|bash -c" plugins/ops-agent/src && exit 1 || true
git diff --check
```

The neutrality line above replaces an inline `rg` that carried two independent
defects, both fixed here. First, it banned the English words `provider`, `model`
and `effort` by grep, which
`docs/plans/2026-08-25-provider-effort-selection-implementation.md` explicitly
forbids — "Do not ban the English word `effort` … enforce the data contract
through strict schema tests" — so the gate as written was in direct conflict
with the plan that owns those words. Second, it omitted the `&& exit 1 || true`
suffix its sibling scans carry, so it printed its matches and passed regardless:
it was never a gate at all, and a leak would have scrolled past a reviewer as
ordinary output. `contracts/tests/core-neutrality.contract.spec.ts` is now the
single definition of the banned-token set for this plan and the multi-agent
plan both; a token argument belongs in that test, never in a new inline scan.

The `shell:` scan directly below it carried the identical suffix defect and is
fixed in the same pass. That one guards the exact-argv invariant this plan sets
in Task 7 — `spawn(executablePath, argv, { shell: false, … })` — so a scan that
printed and passed was giving false assurance on a shell-injection boundary, not
on a style rule. Every scan in this fence is now a gate.

Expected:

- build, type, unit, contract, and local E2E checks pass;
- core contains no provider/model or component-specific branching;
- the Ops plugin contains no generated-shell execution;
- all production-derived fixtures remain sanitized and parse through
  `ObservationSchema`;
- all initial recovery SOPs remain `approve` unless a separate reviewed drill
  record already promoted one, and every one of them is covered by a signed
  authority manifest entry;
- no test invokes the real `launchctl`;
- observe/suggest modes cannot execute; and
- no deployment or mini mutation occurs from CI or merge; and
- the phase evidence manifest distinguishes fixture proof, contract proof, and
  still-unopened production proof.

## Phase E (P3.5): team admission enforcement and the Ops team

This phase runs after MA Phase 3, not before it. Task 19 of the multi-agent
plan creates `plugins/helium/src/team-controller.ts` and Task 18 delivers the
team manifest parser; nothing here can be scheduled earlier without inventing a
second controller or a second parser. Merge it as its own PR after the MA Phase
3 gate passes.

### Task 13b: Enforce admission control in the team controller (P3.5)

**Prerequisite:** MA Phase 3 Task 19 has created
`plugins/helium/src/team-controller.ts`. Task 13a has already landed the pure
`admission.decide` function in core; this task is only its enforcement point.

**Files:**

- Modify: `plugins/helium/src/team-controller.ts`
- Modify: `plugins/helium/src/team-controller.test.ts`
- Modify: `packages/core/tests/operations-admission.spec.ts`

**Step 1: Write the failing enforcement tests**

Drive the real team controller under sustained memory pressure and assert it
refuses to start optional team runs and additional subagent fan-out, while
collectors, deterministic recovery actions, one minimal incident lane, and
dead-man work still run. Assert concurrency is restored only after a sustained
recovery window, not on the first healthy sample.

```ts
const controller = createTeamController({ admission, ...deps });
await expect(controller.start(optionalResearchRun)).rejects.toMatchObject({
  reason: "host-memory-pressure",
});
expect(await controller.start(deterministicRecoveryRun)).toMatchObject({
  admitted: true,
});
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts packages/core/tests/operations-admission.spec.ts
```

Expected: FAIL because the controller does not consult admission.

**Step 3: Wire admission into the controller**

Call the existing core function; do not reimplement the policy in the plugin
and do not add a second pressure source. The controller reads resource
observations from the ops projection it already receives. Admission refusal is
a recorded, surfaced decision, not a silent drop.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts packages/core/tests/operations-admission.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/helium/src/team-controller.ts plugins/helium/src/team-controller.test.ts packages/core/tests/operations-admission.spec.ts
git commit -m "feat: inhibit team fan-out under host pressure"
```

### Task 15: Define the capability-based Ops team (P3.5)

**Prerequisite:** complete the multi-agent implementation plan's Task 18 team
manifest parser and the provider-neutral routing/executor contracts, both of
which land in MA Phase 3. Do not create a second team manifest parser in this
plugin, and do not pull this task forward into P2.5a — there is nothing to
parse `teams/ops.yaml` before MA Task 18.

**Files:**

- Create: `teams/ops.yaml`
- Create: `packages/core/tests/ops-team-manifest.spec.ts`
- Create: `plugins/ops-agent/src/team-tools.ts`
- Create: `plugins/ops-agent/src/team-tools.test.ts`

**Step 1: Write the failing manifest and tool-boundary tests**

The team contains diagnostician, independent verifier, incident lead, and
reporter roles. Reject provider/model/effort fields. Assert every role has
read-only evidence tools; only the incident lead can submit an SOP selection,
and that tool accepts only an ID from the deterministic eligible set.

```ts
await expect(
  tools.selectSop({ incidentId, sopId: "not-eligible" }),
).rejects.toThrow(/not eligible/);
expect(tools.names()).not.toContain("shell");
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-team-manifest.spec.ts plugins/ops-agent/src/team-tools.test.ts
```

Expected: FAIL because the team and tools do not exist.

**Step 3: Implement the manifest and evidence tools**

The task graph is:

```text
diagnostician -----\
                    -> incident-lead -> reporter
independent-verifier/
```

The verifier receives raw evidence and the diagnosis separately. The incident
lead receives the current deterministic eligibility snapshot. If agents
disagree, request fresh read-only probes; never vote. If providers are absent,
the deterministic controller proceeds without these roles.

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-team-manifest.spec.ts plugins/ops-agent/src/team-tools.test.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add teams/ops.yaml packages/core/tests/ops-team-manifest.spec.ts plugins/ops-agent/src/team-tools.ts plugins/ops-agent/src/team-tools.test.ts
git commit -m "feat: add capability-routed ops team"
```

### Phase E gate

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: host pressure demonstrably prevents team fan-out through the real
team controller; the Ops team manifest loads through the multi-agent parser
with no provider, model, or effort field; the incident lead can select only
from the deterministic eligible set; and the deterministic controller still
completes every recovery path with the whole team disabled.

## Post-AC#1 production promotion plan

Create and approve a separate execution plan after this implementation is
merged. It must not be folded into the coding PR.

### Observe-only gate

- capture at least seven continuous days;
- compare every required component against existing tools and operator checks;
- measure unknown, false-green, false-critical, alert-deduplication, and
  dependency-inhibition rates;
- verify the collector remains observable when DSH and Colima are stopped in a
  controlled drill; and
- make no recovery action; and
- publish an evidence manifest with raw observation hashes, comparison cases,
  false-state classifications, verifier versions, and remaining gaps.

### Suggest-only gate

- run for at least seven additional days;
- record eligible SOP, operator accept/reject/alternate action, and actual
  recovery attribution;
- record, for every suggestion, whether the postconditions already passed at
  the moment the suggestion was made; those cases are `not-needed` and are
  excluded from any measured automation benefit;
- resolve every wrong or obsolete SOP mapping;
- certify the exact target scripts and postconditions; and
- require zero suggestion of a forbidden action; and
- publish an evidence manifest linking each suggestion, deterministic eligible
  set, operator decision, actual intervention, and attribution.

### First automatic SOP gate

- promote one exact SOP version in a separate PR, and re-sign the authority
  manifest for its exact digest on the operator's trusted workstation; an SOP
  file promoted without a re-signed entry loads at `observe` and the gate fails
  closed;
- transfer mutation ownership from the existing component watchdog to `opsd`,
  or make the old watchdog observe-only, using the ordered handoff of design
  section 13.2 — release the previous owner and verify its label unloaded
  before setting `mutationOwner` and enabling the SOP;
- prove the competing-controller probe reports `clear` for the component, and
  that it refuses the mutation when the legacy label is reloaded;
- prove rollback restores the previous single controller in the reverse order;
  never leave both controllers able to restart the component;
- use one attempt, long cooldown, narrow component scope, and explicit stop
  conditions;
- conduct a controlled failure without operator intervention, with the
  pre-action baseline showing the postconditions failing beforehand — a drill
  whose baseline already passes proves nothing and earns no credit;
- prove the action receipt and all postconditions;
- prove duplicate controllers cannot repeat it; and
- publish the complete recovery evidence bundle and controlled-drill replay;
  and
- roll back authority to `approve` on any false recovery, unexpected effect,
  attribution error, or verification gap.

Colima automatic recovery is not credited until the controller restores Docker
and the expected container set without operator intervention. Livewire repair
is not credited until the targeted corrupted fixture and a controlled live
drill both pass integrity, freshness, and coverage postconditions.

## Final documentation and handoff

After each phase PR merges:

1. Fetch and align local `master` to the remote merge commit.
2. Re-run that phase gate from clean `master`.
3. Record exact measured results and skipped live gates.
4. Update the script inventory only from verified deployment evidence.
5. Keep operator corrections, including action attribution, in durable review
   evidence.
6. Update README's current-capability section only after deployment and an
   observation window prove the capability.
7. Preserve the next unopened authority gate and explicit non-goals for the
   next session.
