# Helium Ops Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a provider-neutral, dependency-aware Ops Agent that continuously
observes the ecosystem, executes only certified and authorized SOP scripts, and
verifies recovery without requiring an LLM in the safety path.

**Architecture:** Helium core owns typed observations, incidents, dependencies,
SOP authority, action leases, durable action state, and verification semantics.
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
- Complete and merge the multi-agent plan's Phase 0, Phase 1 Tasks 6-10, and
  Phase 2 Tasks 12-15 before starting the action controller in this plan.
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

## Phase A: evidence fixtures and operations contracts

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

Create `packages/core/tests/ops-fixtures.spec.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "evals", "fixtures", "ops");

describe("ops evidence fixtures", () => {
  it("contains sanitized, attributed, time-bounded cases", () => {
    const files = readdirSync(root).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(6);
    for (const name of files) {
      const value = JSON.parse(readFileSync(join(root, name), "utf8"));
      expect(value).toMatchObject({
        fixtureVersion: 1,
        observedAt: expect.any(String),
        observations: expect.any(Array),
        expected: expect.any(Object),
      });
      expect(JSON.stringify(value)).not.toMatch(/100\.66\.|api[_-]?key|password/i);
    }
  });
});
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-fixtures.spec.ts
```

Expected: FAIL because the fixture directory does not exist.

**Step 3: Add the sanitized fixtures**

Use the read-only audit evidence and the operator correction. The Colima fixture
must encode:

```json
{
  "fixtureVersion": 1,
  "observedAt": "2026-08-25T03:02:34.000Z",
  "observations": [
    { "source": "watchdog", "state": "recovery_exhausted" },
    { "source": "docker", "state": "healthy", "containerCount": 20 }
  ],
  "interventions": [
    { "actor": "operator", "kind": "manual-recovery", "confirmed": true }
  ],
  "expected": {
    "terminal": "recovered",
    "attribution": "operator",
    "automaticRecoverySucceeded": false
  }
}
```

The Livewire corruption fixture must require a data-integrity SOP and reject a
generic process restart. Document what was removed or normalized in
`evals/fixtures/ops/README.md`.

**Step 4: Re-run the fixture contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/ops-fixtures.spec.ts
git diff --check
```

Expected: PASS; no credential, host address, or raw sensitive log payload is
committed.

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
expect(() => ObservationSchema.parse({ ...observation, model: "forbidden" }))
  .toThrow();
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
rg -n -i "livewire|argon|apex|colima|postgres|claude|deepseek|codex" packages/core/src/operations && exit 1 || true
```

Expected: PASS; the search returns no domain/provider match.

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
- Create: `packages/core/src/operations/authority.ts`
- Create: `packages/core/tests/operations-sop.spec.ts`
- Create: `packages/core/tests/operations-authority.spec.ts`
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

expect(decideAuthority({
  sop: { ...certifiedAutoSop, authority: "forbidden" },
  incident,
  observations,
  history: [],
  now,
}).eligible).toBe(false);
```

Reject free-form command strings, missing postconditions, `auto` without a
script hash/release identity, and an approval for a different incident or SOP
version. Add two equally ranked eligible SOPs in one exclusive group and assert
the controller returns `ambiguous` without selecting either.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-authority.spec.ts
```

Expected: FAIL because the schemas and decision function do not exist.

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
```

The policy may return only `eligible`, `approval-required`, or `rejected`; it
does not execute. Re-evaluate preconditions and authority at lease time later.
Automatic arbitration orders eligible SOPs by explicit priority, match
specificity, and stable ID. Persist and later recheck the full SOP digest, not
only its human-readable version.

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-authority.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-sop.spec.ts packages/core/tests/operations-authority.spec.ts packages/core/src/index.ts
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

Reuse the Phase 2 team store's append, fsync, hash, snapshot, and replay
primitives. Do not create a second JSONL implementation. Append the event before
updating the in-memory projection. Reject duplicate event IDs and unsupported
versions. A corrupt snapshot falls back to full event replay.

**Step 4: Run store, reducer, and shared replay tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-reducer.spec.ts packages/core/tests/operations-store.spec.ts packages/core/tests/team-store.spec.ts
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
const first = controllerA.acquire({ incidentId, componentId, sopId, attempt: 1 });
expect(first.ok).toBe(true);
const second = controllerB.acquire({ incidentId, componentId, sopId, attempt: 1 });
expect(second).toEqual({ ok: false, reason: "lease-held" });
```

Test stale revisions, expired leases, mismatched release, stable operation IDs,
cooldown, maximum attempts per incident, maximum runs per window, and duplicate
budget reservation. Spawn two child processes against the same temporary lock
directory and prove only one acquires the component mutation lock.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-lease.spec.ts packages/core/tests/operations-recovery-budget.spec.ts packages/core/tests/operations-component-lock.spec.ts
```

Expected: FAIL because lease and budget modules do not exist.

**Step 3: Implement event-backed CAS leases**

Scope the durable lease to `componentId + incidentId + sopId + sopDigest +
attempt`. `helium-opsd` is the sole event-log writer. Before a mutation it also
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

Expected: exactly one controller wins each attempt; no duplicate budget charge.

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
await expect(executor.run({
  actionId: "action-1",
  executorId: "script-v1",
  argv: ["--target-date", "2026-08-21"],
}, signal)).resolves.toMatchObject({
  actionId: "action-1",
  exit: { code: 0 },
});

await expect(executor.run({
  actionId: "action-2",
  executorId: "script-v1",
  argv: ["; rm", "anything"],
}, signal)).rejects.toThrow(/argument schema/);
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

### Task 8: Verify actions and reconcile operator intervention

**Files:**

- Create: `packages/core/src/operations/verify.ts`
- Create: `packages/core/src/operations/reconcile.ts`
- Create: `packages/core/tests/operations-verify.spec.ts`
- Create: `packages/core/tests/operations-reconcile.spec.ts`
- Modify: `packages/core/src/operations/events.ts`
- Modify: `packages/core/src/operations/reducer.ts`

**Step 1: Write the failing Colima attribution matrix**

Table-drive these cases:

| Executor exit | Postconditions | Operator event | Expected |
|---|---|---|---|
| 0 | pass | none | succeeded / Helium |
| 0 | fail | none | failed / Helium |
| nonzero | pass | none | uncertain, never claimed automatic |
| nonzero | pass | confirmed | recovered / operator |
| missing receipt | pass | none | external-recovery |
| timeout | unknown | none | uncertain |

Use `colima-operator-recovery.json` as a regression fixture.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts
```

Expected: FAIL because verification and reconciliation do not exist.

**Step 3: Implement grace-window verification**

Inject a clock and probe runner. Wait `initialDelayMs`, sample until all
postconditions pass or `timeoutMs` expires, and append each result. On startup,
reconcile non-terminal intents from receipts, live process evidence, operator
events, and current postconditions. Never rerun an uncertain side effect during
reconciliation.

**Step 4: Run the crash and attribution suite repeatedly**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts --repeat=20
```

Expected: PASS; the production-derived Colima fixture is attributed only to the
operator.

**Step 5: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations-verify.spec.ts packages/core/tests/operations-reconcile.spec.ts
git commit -m "feat: verify and attribute operations recovery"
```

### Phase B gate

Run the full suite and a persisted crash matrix that terminates the controller
before and after lease, intent, spawn, receipt, each verification sample, and
operator event:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: no duplicate spawn, attempt, receipt, or terminal state; no result is
classified as recovery from an exit code alone. Merge through a dedicated PR.

## Phase C: Ops plugin, host collector, and component adapters

### Task 9: Add the open-ended component, probe, and SOP registry

**Files:**

- Create: `plugins/ops-agent/src/component-registry.ts`
- Create: `plugins/ops-agent/src/component-registry.test.ts`
- Create: `plugins/ops-agent/src/config.ts`
- Create: `plugins/ops-agent/src/config.test.ts`
- Create: `ops/components/fixture.yaml`
- Create: `ops/sops/fixture-observe.yaml`
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

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/component-registry.test.ts plugins/ops-agent/src/config.test.ts
```

Expected: FAIL because the registry does not exist.

**Step 3: Implement bounded YAML loading**

Use strict schemas from core, maximum file/component/probe/SOP counts, relative
configuration references, exact active-version rules, and atomic bundle
installation. One bad bundle must fail only its tenant and emit tenant health;
it must not remove already-installed healthy components.

**Step 4: Run tests and package build**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/component-registry.test.ts plugins/ops-agent/src/config.test.ts
pnpm --filter dsh-plugin-helium-ops build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/ops-agent ops/components/fixture.yaml ops/sops/fixture-observe.yaml
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
```

Expected: PASS; no probe is allowed to mutate state and the collector has no
independent log writer.

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
rg -n -i "livewire|argon|apex|colima|postgres" packages/core/src/operations && exit 1 || true
```

Expected: PASS; domain names exist only in the plugin/configuration.

**Step 5: Commit**

```bash
git add plugins/ops-agent/src/adapters ops/components/colima.yaml ops/components/postgres.yaml ops/components/helium.yaml
git commit -m "feat: observe colima postgres and helium"
```

### Task 13: Add alert grouping and resource admission control

**Files:**

- Create: `packages/core/src/operations/admission.ts`
- Create: `packages/core/tests/operations-admission.spec.ts`
- Create: `plugins/ops-agent/src/alerts.ts`
- Create: `plugins/ops-agent/src/alerts.test.ts`
- Modify: `plugins/helium/src/team-controller.ts`
- Modify: `plugins/helium/src/team-controller.test.ts`

**Step 1: Write failing alert and admission tests**

Test sustained `for` windows, dedupe, inhibition, recovery transition, alert
channel failure, and no periodic restatement. Test that sustained memory
pressure prevents optional new teams and subagent fan-out but leaves collectors,
deterministic actions, one minimal incident lane, and dead-man work admitted.

```ts
expect(admission.decide(optionalResearch, pressure)).toEqual({
  admitted: false,
  reason: "host-memory-pressure",
});
expect(admission.decide(deterministicRecovery, pressure).admitted).toBe(true);
```

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.test.ts plugins/helium/src/team-controller.test.ts
```

Expected: FAIL because admission and Ops alerts do not exist.

**Step 3: Implement pure admission and transition alerts**

Make admission a core pure function over resource observations, work class,
and policy. The Ops alert renderer groups by incident root and lists inhibited
symptoms. Reuse the existing delivery write-ahead contract. Alert failure
creates a delivery incident; it does not repeat the recovery action.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.test.ts plugins/helium/src/team-controller.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/operations/admission.ts packages/core/tests/operations-admission.spec.ts plugins/ops-agent/src/alerts.ts plugins/ops-agent/src/alerts.test.ts plugins/helium/src/team-controller.ts plugins/helium/src/team-controller.test.ts
git commit -m "feat: inhibit alerts and agent fan-out under pressure"
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

Expected: all initial required components have fixture-backed observations; no
action executes yet. Open and merge an observe-only plugin PR. Do not install
`opsd` until AC#1 is complete and a separate deployment plan is approved.

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
- `auto` executes only an eligible automatic SOP; and
- a runtime mode cannot elevate an SOP's configured authority.

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

### Task 15: Define the capability-based Ops team

**Prerequisite:** complete the multi-agent implementation plan's Task 18 team
manifest parser and the provider-neutral routing/executor contracts. Do not
create a second team manifest parser in this plugin.

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
await expect(tools.selectSop({ incidentId, sopId: "not-eligible" }))
  .rejects.toThrow(/not eligible/);
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

**Step 1: Write a failing certification test**

Require every inventory row and executor/SOP registration to include repository
or deployment owner, exact path, release/hash identity, argv schema, cwd,
environment profile, preflight, postconditions, timeout, attempt limit,
cooldown, blast radius, rollback/compensation statement, and drill state.

Assert all first registrations use `approve` unless their controlled drill
record is already present. Explicitly assert the IB Gateway restart action is
absent and forbidden by policy.

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

**Step 4: Run certification and drift tests**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/tests/script-certification.spec.ts plugins/ops-agent/src/script-registry.test.ts
```

Expected: PASS; script drift makes registration ineligible rather than silently
updating identity.

**Step 5: Commit**

```bash
git add docs/ops ops/executors ops/sops plugins/ops-agent/tests/script-certification.spec.ts
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
- crash before/after intent, spawn, receipt, and verification;
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
- operator and controller act concurrently; and
- host memory pressure during attempted team fan-out.

**Step 2: Run the contracts and verify failure**

```bash
pnpm exec vitest run --project contracts contracts/tests/ops-controller.contract.spec.ts contracts/tests/ops-action-boundary.contract.spec.ts
```

Expected: FAIL because the fixtures and contracts do not exist.

**Step 3: Build a fake host and executor fixture**

The fixture uses temporary files, fake clocks, fake processes, and fake
providers. It must never SSH, touch a real launchd job, connect to the real
PostgreSQL instance, or mutate a real mount. Persist the event log across
controller process restarts and assert terminal convergence.

**Step 4: Run the contracts repeatedly**

```bash
pnpm exec vitest run --project contracts contracts/tests/ops-controller.contract.spec.ts contracts/tests/ops-action-boundary.contract.spec.ts --repeat=20
```

Expected: PASS with one or zero authorized side effects per case, truthful
attribution, and no forbidden command.

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

Run against a temporary fake home and launchd directory. Assert install defaults
to `observe`, refuses during a configured freeze window, renders no secret,
preserves existing watchdogs, and uninstall removes only its exact labels and
files. Assert rollback restores the prior compatible collector/plugin pair.
Assert the existing dead-man reports stale `opsd` observations even when the
main DSH heartbeat is current.
Assert the rendered `opsd` configuration contains only the operator public key
path and cannot read or install a private signing key.

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
rg -n -i "provider|model|effort|livewire|argon|apex|colima|postgres" packages/core/src/operations
rg -n "shell:\s*true|sh -c|bash -c" plugins/ops-agent/src
git diff --check
```

Expected:

- build, type, unit, contract, and local E2E checks pass;
- core contains no provider/model or component-specific branching;
- the Ops plugin contains no generated-shell execution;
- all production-derived fixtures remain sanitized;
- all initial recovery SOPs remain `approve` unless a separate reviewed drill
  record already promoted one;
- observe/suggest modes cannot execute; and
- no deployment or mini mutation occurs from CI or merge.

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
- make no recovery action.

### Suggest-only gate

- run for at least seven additional days;
- record eligible SOP, operator accept/reject/alternate action, and actual
  recovery attribution;
- resolve every wrong or obsolete SOP mapping;
- certify the exact target scripts and postconditions; and
- require zero suggestion of a forbidden action.

### First automatic SOP gate

- promote one exact SOP version in a separate PR;
- transfer mutation ownership from the existing component watchdog to `opsd`,
  or make the old watchdog observe-only, before enabling the SOP;
- prove rollback restores the previous single controller; never leave both
  controllers able to restart the component;
- use one attempt, long cooldown, narrow component scope, and explicit stop
  conditions;
- conduct a controlled failure without operator intervention;
- prove the action receipt and all postconditions;
- prove duplicate controllers cannot repeat it; and
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
