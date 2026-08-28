# Provider Effort Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Revision:** 2026-08-28 — rescoped per adjudication D3: thin selector v1 now, scoring/learning deferred to v2.

**Goal:** Add provider-owned model-effort selection, beginning with Claude subscription targets, while keeping Helium core and team manifests model-blind.

**Architecture:** Provider plugins describe native model and effort options and expose only opaque execution targets to the core capability catalog. A thin selector hard-filters those targets on isolation, tools, quota, and availability, then applies a configured per-role preference with ordered fallback and issues a provider-neutral `ExecutionLease`; the Claude adapter invokes the exact model and effort and records the full runtime snapshot. Provider-owned orchestration modes such as `ultracode` never enter the effort field.

**Tech Stack:** TypeScript 5, Zod 4, Vitest 3, pnpm workspace, DSH/Cordis provider plugins, Claude Code subscription OAuth.

---

## Scope tiers

**v1 — in scope now (thin selector):**

```
WorkOrder capability requirements
  -> isolation / tools / quota / availability hard filter
  -> configured opaque target preference
  -> ordered fallback
  -> ExecutionLease
```

Kept in v1: the opaque target registry; capability tags; an `isolationClass` per
target; quota availability as a **dynamic provider-availability state** (this
plan consumes the `quota-exhausted` failure class and `retryAfter`, which enter
the vocabulary at multi-agent Phase 0); per-role preference and fallback ordering
configured in the plugin composition root; and a provider-neutral
`ExecutionLease`. Effort and model choices live **only** in the provider catalog
and the privileged admin override — core code never sees a provider or model
name.

Active v1 tasks: **Tasks 1 through 7** below.

**v2 — deferred until real usage data exists:** the capability ontology,
confidence intervals, weighted scoring, automatic learning, and the full
effort-evaluation harness. These are collected in
[Deferred (v2) tasks](#deferred-v2-tasks--do-not-implement-until-real-usage-data-exists)
and are deliberately outside the active task numbering.

## Preconditions and scope

Execute this plan only after these tasks in
`docs/plans/2026-08-25-helium-multi-agent-implementation.md` are complete:

- Phase 0 senior-lane isolation and real tool restriction;
- Task 6, which moves legacy model-specific jobs to `@helium/v1-compat`;
- Task 7, which adds strict model-blind `WorkOrder` schemas;
- Task 8, which adds the opaque capability catalog;
- Task 9, which adds deterministic routing — the P1 router is **hard-filter
  only**; scoring is deferred with the rest of v2; and
- Task 10, which adds leases and the executor registry.

No active task in this plan depends on `@helium/evals`. The Phase 3 Task 20
dependency belongs only to the deferred evaluation work; do not create a second
evaluation package to bypass it, and do not pull that work forward.

Do not deploy this work to the Mac mini during the active AC#1 observation
window. Live subscription calls remain explicit opt-in certification steps and
must use temporary directories rather than production state paths.

This plan does not:

- add `model` or `effort` to core or team schemas;
- enable Claude `ultracode`;
- assign Claude to a fixed role;
- change the v1 production path;
- add scoring, weighting, confidence, or learned preference to selection; or
- promote a model-effort variant into normal routing before its entitlement is
  verified.

### Task 1: Protect the model-blind boundary

**Files:**

- Modify: `packages/core/tests/work.spec.ts`
- Modify: `contracts/tests/core-neutrality.contract.spec.ts`
- Modify later with Phase 2: `packages/core/tests/team-manifest.spec.ts`

**Step 1: Add strict-schema regression tests**

Add provider-native fields to an otherwise valid fixture and require rejection:

```ts
for (const forbidden of [
  { provider: "claude-subscription" },
  { model: "claude-sonnet-5" },
  { effort: "high" },
]) {
  expect(() =>
    WorkOrderSchema.parse({ ...validWorkOrder, ...forbidden }),
  ).toThrow();
}
```

When the Phase 2 team manifest exists, add the same recursive rejection for
`provider`, `model`, and `effort` at every manifest depth.

**Step 2: Run the tests and verify the prerequisite**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts
```

Expected after the prerequisite Phase 1 work: PASS. This task locks an existing
model-blind boundary; it is intentionally a regression guard rather than a
red-green implementation step. If it fails, stop and repair the Phase 1 schema
before adding any provider catalog.

**Step 3: Make only the boundary correction**

Keep `WorkOrderSchema` strict. Do not add a provider-neutral field called
`effort`; work requirements remain capability, budget, latency, and safety
constraints.

Extend the neutrality contract to ensure production provider vocabulary stays
outside `packages/core/src`. Do not ban the English word `effort` from comments
or opaque metadata because that would create false positives; enforce the data
contract through strict schema tests.

**Step 4: Run the focused and contract tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/tests/work.spec.ts contracts/tests/core-neutrality.contract.spec.ts
git commit -m "test: protect provider effort boundary"
```

### Task 2: Add a provider-edge effort catalog schema

**Files:**

- Create: `plugins/helium/src/provider-catalog.ts`
- Create: `plugins/helium/src/provider-catalog.test.ts`

**Step 1: Write the failing schema tests**

Cover supported and unsupported effort, duplicate options, missing defaults,
defaults outside the option set, and orchestration modes placed in effort:

```ts
expect(
  ProviderTargetSchema.parse({
    targetRef: "target-1",
    model: "opaque-to-core-but-provider-owned",
    enabled: true,
    effort: {
      supported: true,
      options: ["low", "medium", "high"],
      default: "high",
    },
  }),
).toBeDefined();

expect(() =>
  ProviderTargetSchema.parse({
    targetRef: "target-2",
    model: "provider-model",
    enabled: true,
    effort: {
      supported: true,
      options: ["low", "high"],
      default: "medium",
    },
  }),
).toThrow(/default.*options/i);

expect(() =>
  ProviderTargetSchema.parse({
    targetRef: "target-3",
    model: "provider-model",
    enabled: true,
    effort: {
      supported: true,
      options: ["ultracode"],
      default: "ultracode",
    },
  }),
).toThrow(/orchestration mode/i);
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/provider-catalog.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the strict edge schema**

Create a provider-layer discriminated union:

```ts
import { z } from "zod";

const UnsupportedEffortSchema = z
  .object({
    supported: z.literal(false),
  })
  .strict();

const SupportedEffortSchema = z
  .object({
    supported: z.literal(true),
    options: z.array(z.string().min(1)).min(1).max(8),
    default: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.options).size !== value.options.length) {
      ctx.addIssue({ code: "custom", message: "duplicate effort option" });
    }
    if (!value.options.includes(value.default)) {
      ctx.addIssue({
        code: "custom",
        message: "effort default must be in options",
      });
    }
    if (
      value.options.includes("ultracode") ||
      value.options.includes("ultra")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "orchestration mode is not effort",
      });
    }
  });

export const ProviderTargetSchema = z
  .object({
    targetRef: z.string().min(1),
    model: z.string().min(1),
    invokeAs: z.string().min(1).optional(),
    enabled: z.boolean(),
    effort: z.discriminatedUnion("supported", [
      UnsupportedEffortSchema,
      SupportedEffortSchema,
    ]),
  })
  .strict();
```

Keep this file in the plugin package. Do not export it from `@helium/core`.
Cap each provider catalog at 32 targets during registration so a malformed edge
plugin cannot create an unbounded model-effort cross-product.

**Step 4: Run the test and typecheck**

```bash
pnpm exec vitest run --project unit plugins/helium/src/provider-catalog.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/helium/src/provider-catalog.ts plugins/helium/src/provider-catalog.test.ts
git commit -m "feat: validate provider effort catalogs"
```

### Task 3: Register the Claude subscription catalog

**Files:**

- Create: `plugins/helium/src/providers/claude-subscription-catalog.ts`
- Create: `plugins/helium/src/providers/claude-subscription-catalog.test.ts`

**Step 1: Write the failing Claude matrix tests**

```ts
expect(claudeSubscriptionCatalog.targets).toEqual([
  expect.objectContaining({
    model: "claude-haiku-4-5-20251001",
    invokeAs: "haiku",
    effort: { supported: false },
  }),
  expect.objectContaining({
    model: "claude-sonnet-5",
    invokeAs: "sonnet",
    effort: {
      supported: true,
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    },
  }),
  expect.objectContaining({
    model: "claude-opus-5",
    invokeAs: "opus",
    effort: {
      supported: true,
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    },
  }),
]);
expect(claudeSubscriptionCatalog.executionModes.ultracode.enabled).toBe(false);
```

Also test that applying an organization cap returns an ordered subset and that
Haiku rejects any explicit effort:

```ts
expect(applyEffortCap(sonnetEffort, "high").options).toEqual([
  "low",
  "medium",
  "high",
]);
expect(() => resolveClaudeEffort(haikuTarget, "low")).toThrow(/unsupported/i);
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-catalog.test.ts
```

Expected: FAIL because the catalog module does not exist.

**Step 3: Implement the catalog and cap resolver**

Define the ordered effort scale once at the provider edge:

```ts
export const CLAUDE_EFFORT_ORDER = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORT_ORDER)[number];
```

Validate the catalog through `ProviderTargetSchema` at module load. Resolve an
effective effort explicitly before invocation. Treat documented model support
and account-effective support as different fields. A versioned **entitlement**
certification snapshot supplies the allowed effort subset and its source;
variants missing from that subset remain out of normal routing. This snapshot
records what the account can invoke, not how well a variant performs — quality
measurement is deferred to v2.

Do not scrape the interactive picker. The certification workflow may use a
minimal plain-text `claude -p --effort <level>` preflight because Claude Code
surfaces organization clamping warnings there, then run the normal structured
JSON probe. Persist the sanitized result as a versioned certification snapshot.
If applied effort cannot be established, keep the variant uncertified.

**Step 4: Run the tests and typecheck**

```bash
pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-catalog.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/helium/src/providers/claude-subscription-catalog.ts plugins/helium/src/providers/claude-subscription-catalog.test.ts
git commit -m "feat: add Claude model effort catalog"
```

### Task 4: Invoke an exact Claude model and effort

**Files:**

- Modify: `plugins/helium/src/claude.ts`
- Modify: `plugins/helium/src/claude.test.ts`

**Step 1: Add failing invocation tests**

Extend the fake Claude binary test to assert exact arguments:

```ts
// Per-attempt owned workspace under `stateRoot/workspaces/<job>/`, created by
// the test. Never `process.cwd()` — MA Phase 0 Task 1 made an owned workspace
// part of the senior execution boundary, and this plan resumes from that
// interface unchanged.
const cwd = await makeOwnedWorkspace(statePaths, "effort-probe");
const out = await runClaude({
  prompt: "PROMPTBODY",
  cwd,
  model: "claude-sonnet-5",
  effort: "xhigh",
  maxTurns: 2,
  timeoutMs: 5_000,
  allowedTools: [],
  mcpConfigPath: "/tmp/empty-mcp.json",
  env: { PATH: dir },
});
expect(out.text).toContain("--model claude-sonnet-5");
expect(out.text).toContain("--effort xhigh");
```

The option field stays `allowedTools`, exactly as Phase 0 leaves it
(`plugins/helium/src/claude.ts:57`). This task adds `model` and `effort` to the
existing interface and renames nothing — per review IMPL-3/XDOC-15 and
adjudication D3, `runClaude` keeps the `allowedTools` field name and there is no
call-site churn. Only the emitted CLI flag differs (`--tools`, set by Phase 0);
the TypeScript field does not.

`cwd` is likewise unchanged from Phase 0: every senior execution runs in a
per-attempt owned workspace under `stateRoot/workspaces/<job>/`, created before
the call and removed after the child reaches quiescence. This plan must not
reintroduce `process.cwd()` in a `runClaude()` call site, test or production —
the owned workspace is part of the isolation contract the execution-boundary
conformance suite asserts.

Add a Haiku test proving the resolved invocation omits `--effort`. Add a result
fixture whose terminal envelope contains `modelUsage` for both Sonnet and
Haiku, and assert that the normalized result retains both entries.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/claude.test.ts
```

Expected: FAIL because `runClaude()` does not accept or pass model and effort.

**Step 3: Extend the invocation boundary**

Add the provider-owned fields:

```ts
export interface ClaudeInvocation {
  model: string;
  effort?: ClaudeEffort;
}

export interface ClaudeRuntimeSnapshot {
  requestedModel: string;
  requestedEffort?: ClaudeEffort;
  effectiveEffort?: ClaudeEffort;
  providerReportedEffort?: string;
  modelUsage: Record<string, unknown>;
}
```

Append `--model <exact-id>` and, only when present, `--effort <level>` to the
Claude CLI arguments. Preserve all Phase 0 isolation flags and actual tool
restrictions: the `allowedTools` option field is unchanged and still emits the
Phase 0 `--tools` flag; do not reintroduce the `--allowedTools` CLI flag as a
security boundary.

If Claude Code does not report applied effort in JSON, leave
`providerReportedEffort` absent. Record the explicitly resolved
`effectiveEffort` and the entitlement certification snapshot that produced it
rather than claiming the provider reported a value it did not.

Keep the full `modelUsage` map from the terminal result envelope.

When the provider reports a quota or rate limit, classify the failure as
`quota-exhausted` and surface `retryAfter`. That vocabulary is defined at
multi-agent Phase 0; this adapter only produces it, so the selector can treat
the provider as temporarily unavailable rather than permanently incapable. It is
a dynamic availability state, never a capability score.

**Step 4: Run the focused tests and typecheck**

```bash
pnpm exec vitest run --project unit plugins/helium/src/claude.test.ts
pnpm typecheck
```

Expected: PASS; exact model and effort are visible in the fake binary's
arguments, and background Haiku usage remains in the snapshot.

**Step 5: Commit**

```bash
git add plugins/helium/src/claude.ts plugins/helium/src/claude.test.ts
git commit -m "feat: invoke Claude with explicit effort"
```

### Task 5: Publish only certified model-effort variants to routing

**Files:**

- Create: `plugins/helium/src/providers/claude-subscription-executor.ts`
- Create: `plugins/helium/src/providers/claude-subscription-executor.test.ts`
- Modify: `plugins/helium/src/executor-registry.ts`
- Modify: `plugins/helium/src/executor-registry.test.ts`

**Step 1: Write failing registry tests**

In v1, "certified" means **entitlement-certified**: the account demonstrably
accepts that `(model, effort)` invocation. It does not mean quality-measured —
measured profiles arrive with the deferred v2 evaluation work.

Build a certification fixture containing one Haiku target and selected Sonnet
and Opus effort variants. Assert that:

- every registered core target ID is opaque;
- each `(model, effort)` variant has its own provider target reference;
- every registered target declares an `isolationClass`, and registration fails
  closed when one is missing;
- uncertified variants remain absent from the capability catalog;
- Haiku produces exactly one no-effort variant;
- `ultracode` produces no target; and
- disposing the provider removes all of its registered variants.

```ts
const registered = registerCertifiedClaudeTargets({
  providerCatalog: claudeSubscriptionCatalog,
  certification: certifiedFixture,
  capabilityCatalog,
  executorRegistry,
});
expect(registered.map((entry) => entry.profile.targetId)).toEqual([
  expect.stringMatching(/^target-[a-f0-9-]+$/),
  expect.stringMatching(/^target-[a-f0-9-]+$/),
]);
expect(
  registered.some((entry) => entry.native.executionMode === "ultracode"),
).toBe(false);
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-executor.test.ts plugins/helium/src/executor-registry.test.ts
```

Expected: FAIL because the provider executor does not exist.

**Step 3: Implement registration and execution**

Keep two inventories:

1. the provider-edge catalog with model, effort, entitlement, and invocation
   details; and
2. the core capability catalog with opaque IDs, declared capability tags, an
   `isolationClass`, and a current availability state — no scores, no
   confidence, no weights.

The provider executor owns the mapping between them. The core selector never
receives the native catalog entry. The runtime snapshot returned through
`AgentResult.runtimeMetadata` may contain provider-native audit data, which
core persists without interpreting.

Each registered target carries its `isolationClass` so the hard filter can
reject a target whose isolation is too weak for the work order, and the
provider's availability state (including `quota-exhausted` with its
`retryAfter`) so exhausted targets drop out of the candidate set until the
window elapses.

Registration must be all-or-nothing: validate every target and certification
entry before registering any disposer. On failure, leave both registries
unchanged.

Target IDs must be opaque but stable across restart, catalog reload, and
registration order. Derive `target-<hash>` deterministically from a
provider-plugin namespace plus its versioned native target key, using
`node:crypto`; never generate a fresh UUID during registration. Add tests that
rebuild the catalog in reversed order and receive the same IDs. The native
model and effort remain only in the provider registry and audit snapshot.

**Step 4: Run tests and the neutrality contract**

```bash
pnpm exec vitest run --project unit plugins/helium/src/providers/claude-subscription-executor.test.ts plugins/helium/src/executor-registry.test.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/helium/src/providers/claude-subscription-executor.ts plugins/helium/src/providers/claude-subscription-executor.test.ts plugins/helium/src/executor-registry.ts plugins/helium/src/executor-registry.test.ts
git commit -m "feat: register certified Claude effort targets"
```

### Task 6: Configure per-role preference/fallback and the privileged exact-target override

**Files:**

- Create: `plugins/helium/src/exact-target-override.ts`
- Create: `plugins/helium/src/exact-target-override.test.ts`
- Create: `plugins/helium/src/routing-service.ts`
- Create: `plugins/helium/src/routing-service.test.ts`

**Step 1: Write failing authorization and audit tests**

Require target reference, operator, reason, expiry, and allowed purpose:

```ts
expect(
  ExactTargetOverrideSchema.parse({
    targetRef: "provider-target-7",
    operator: "operator-1",
    reason: "compare Sonnet effort regression",
    purpose: "evaluation",
    expiresAt: "2026-08-25T12:00:00.000Z",
  }),
).toBeDefined();

expect(() =>
  ExactTargetOverrideSchema.parse({
    model: "claude-opus-5",
    effort: "max",
  }),
).toThrow();
```

Also prove the override cannot expand tools, mutations, budget, or workspace
access and that an expired override fails closed.

Add selector tests for the v1 ordering rule: given a configured per-role
preference and an ordered fallback list of opaque target references, the
selector returns the preferred surviving target; when the preferred target is
filtered out (isolation, tools, or a `quota-exhausted` availability state with
an unexpired `retryAfter`) it returns the next entry in the configured order;
and when the list is exhausted it returns `capability-shortage`. Assert that no
score, weight, or confidence value participates in the decision.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/exact-target-override.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the plugin-layer override**

Allow only these purposes:

```ts
const OverridePurposeSchema = z.enum([
  "replay",
  "evaluation",
  "certification",
  "incident-diagnosis",
  "emergency-failover",
]);
```

The override selects an existing provider target reference. It does not accept
raw model or effort fields and does not enter `WorkOrder`. Resolve it before
lease issuance and append the operator, reason, purpose, and target snapshot to
the routing audit record.

`routing-service.ts` is the plugin composition boundary around the pure core
selector and lease issuer. Normal requests call the pure selector; privileged
requests validate the override, look up the existing opaque target, re-check
the original work-order safety and budget constraints, and then issue the same
lease type. A pinned target that fails the original constraints returns
`capability-shortage` rather than bypassing policy.

The composition root also owns the per-role preference and fallback
configuration. It is a plain ordered list of opaque target references per role —
no weights, no scores, no learned adjustment — and it never leaves the plugin
layer. Core receives an ordered candidate list and the hard-filter predicates;
it never learns which provider or model is behind an entry, and it never learns
that a preference exists for a named vendor. Luna-class or any other favored
target is a configured preference here, never a hardcoded role in core.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit plugins/helium/src/exact-target-override.test.ts plugins/helium/src/routing-service.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/helium/src/exact-target-override.ts plugins/helium/src/exact-target-override.test.ts plugins/helium/src/routing-service.ts plugins/helium/src/routing-service.test.ts
git commit -m "feat: add preference fallback ordering and audited exact target override"
```

### Task 7: Run the integration gate and record evidence

**Files:**

- Modify: `docs/reviews/2026-08-25-model-selection-probe.md`
- Create: `docs/reviews/YYYY-MM-DD-provider-effort-certification.md`

**Step 1: Run the complete local gate**

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: all commands pass, with no network call. The `@helium/evals` fixture
run is **not** part of the v1 gate; it belongs to the deferred evaluation work.

**Step 2: Run isolated live certification only after AC#1**

Use the Mac mini subscription OAuth credential and existing proxy, but run from
a mode-0700 temporary directory with production JSONL, jobs, releases, and
credential files read-only. Certify every enabled Claude model-effort target
that will enter routing. Do not run `ultracode`.

For each effort level, first run a minimal plain-text invocation and inspect
stderr for an organization-cap warning. Then run the structured JSON invocation
used by the adapter. Record `requested`, `effective`, and
`providerReportedEffort` separately; never infer a provider-reported value from
the absence of an error.

Expected production invariants before and after:

- the DSH PID is unchanged;
- the release pointer is unchanged;
- the loopback UI remains HTTP 200;
- heartbeat continuity is preserved; and
- no temporary probe directory remains.

**Step 3: Record the certification result**

The review must distinguish:

- documented support;
- account entitlement;
- successful invocation;
- organization cap; and
- routing eligibility.

In v1, routing eligibility follows from entitlement plus configuration; record
"quality evaluation evidence: deferred (v2)" rather than leaving the column
blank or inventing a score. Do not promote a target because it returned one
valid response, and do not infer a quality ranking from these probes.

**Step 4: Open and merge a pull request**

```bash
git status --short
git push -u origin <feature-branch>
gh pr create --base master --head <feature-branch>
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --merge --delete-branch
git fetch origin
git switch master
git pull --ff-only origin master
```

Expected: green CI, merge commit on `master`, clean local tree aligned to
`origin/master`, and no mini deployment.

## Deferred (v2) tasks — do not implement until real usage data exists

The task below is **preserved design work that is out of scope**. It is
deliberately outside the active task numbering (Tasks 1-7) and must not be
started, tested against, or depended on by any v1 acceptance criterion. It
unblocks only when real usage data exists — per adjudication D3 and D5.7.

Also deferred with it, and described in the design document's deferred section:
the capability ontology, measured capability scores and confidence intervals,
weighted scoring and tie-break arithmetic, and automatic learning of routing
preference from outcomes.

Standing preconditions for the deferred work, recorded so they are not lost:
this task must not start until Phase 3 Task 20 has created `@helium/evals`, and
no second evaluation package may be created to bypass that dependency.

### Deferred task D1 (was Task 7): Certify effort variants with offline-first evaluations

**Files:**

- Create: `evals/fixtures/provider-effort/claude/`
- Modify: `packages/evals/src/run.ts`
- Modify: `packages/evals/src/score.ts`
- Modify: `packages/evals/tests/score.spec.ts`
- Modify: `evals/README.md`

**Step 1: Add failing effort comparison fixtures**

Create frozen task cases for:

- concise document rendering;
- evidence synthesis;
- causal reasoning;
- repository review;
- structured output; and
- contradiction verification.

Every fixture records the opaque target ID, effort variant, accepted output,
latency, token usage, runtime model usage, and safety outcome.

Add scorer tests proving variants are not pooled:

```ts
const scores = scoreRuns(frozenEffortRuns);
expect(scores.byTarget[sonnetLowId]).not.toEqual(scores.byTarget[sonnetHighId]);
expect(scores.byTarget[opusMaxId].sampleCount).toBeGreaterThan(0);
```

**Step 2: Run the scorer test and verify failure**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts
```

Expected: FAIL because the scorer does not separate target variants.

**Step 3: Implement target-variant scoring**

Store suite version, sample count, confidence, timestamp, known failures,
latency distribution, token use, and provider-reported audit metadata per
opaque target ID. Do not infer quality from one successful probe.

Live Claude subscription evaluation requires:

```text
HELIUM_LIVE_CLAUDE_EFFORT=1
```

It writes raw runs only to a gitignored temporary run directory. Promotion
uses a reviewed, sanitized summary and a versioned certification snapshot.
This task must not start until Phase 3 Task 20 has created `@helium/evals`.

**Step 4: Run offline evaluations**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts
pnpm --filter @helium/evals run evaluate -- --fixtures evals/fixtures/provider-effort/claude
```

Expected: deterministic scorecards with no network access.

**Step 5: Commit**

```bash
git add evals/fixtures/provider-effort/claude packages/evals/src/run.ts packages/evals/src/score.ts packages/evals/tests/score.spec.ts evals/README.md
git commit -m "feat: evaluate Claude effort variants"
```

## Final acceptance gate (v1)

- Claude Haiku is registered only as a no-effort target.
- Claude Sonnet 5 and Opus 5 expose only entitlement-certified subsets of `low`,
  `medium`, `high`, `xhigh`, and `max`.
- Normal work orders and team manifests reject provider, model, and effort.
- `ultracode` is absent from the effort catalog and executor registry.
- Every routed target carries a versioned catalog entry with its capability
  tags, `isolationClass`, entitlement, availability state, and safety
  constraints.
- Selection is reproducible from configuration alone: the same catalog, the same
  availability state, and the same per-role preference and fallback order select
  the same target, and no score, weight, or confidence value participates.
- A `quota-exhausted` target with an unexpired `retryAfter` is filtered out of
  the candidate set rather than being treated as permanently incapable.
- Every result retains requested/effective effort and complete runtime model
  usage without claiming unreported provider data.
- Exact-target overrides are privileged, expiring, bounded, and audited.
- The v1 production path and rollback remain unchanged.

Deferred to v2, and explicitly **not** part of this gate: measured quality,
latency, reliability, and cost profiles per model-effort variant; sample counts
and confidence; and any scored or learned routing preference.
