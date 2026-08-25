# Helium Multi-Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn Helium's proven v1 runner into a model-blind, capability-routed,
restart-safe multi-agent harness while preserving the v1 production path.

**Architecture:** Helium core owns provider-neutral work orders, capability
routing, durable team state, evidence, budgets, and delivery policy. Provider
plugins resolve opaque execution leases into concrete model calls. DSH supplies
agent and subagent lifecycle primitives; Helium supplies business durability and
verification around them.

**Tech Stack:** TypeScript 5, Node.js 22+, pnpm, Vitest, Zod, YAML, DeepSeek
Harness/Cordis `0.1.1-rc.2`, append-only JSONL, MCP, nodemailer.

---

## Execution rules

- Work on an isolated feature branch or worktree, never directly on `master`.
- Do not deploy to the mini during the active AC#1 observation window.
- Run the focused failing test before writing production code.
- Keep every commit green for all previously completed tasks.
- Do not add a provider/model name to `packages/core`.
- Do not silently relax a capability, safety, or budget requirement.
- Do not give a mutating team a generic shell or treat command exit as
  verified recovery.
- Stop at every phase gate for code review and evidence review.

## Phase 0: certify the v1 boundary

### Task 1: Restrict and isolate the senior CLI process

**Files:**

- Modify: `plugins/helium/src/claude.ts`
- Modify: `plugins/helium/src/claude.test.ts`
- Modify: `plugins/helium/src/index.ts`
- Modify: `plugins/helium/src/config.ts`
- Modify: `plugins/helium/src/index.test.ts`
- Modify: `profile/cordis.patch.yml`
- Modify: `plugins/helium/cordis.patch.yml`

**Step 1: Write the failing argument-isolation test**

Extend `plugins/helium/src/claude.test.ts` so the fake CLI captures and asserts
all restrictive flags, including an empty tool set:

```ts
it("restricts tools, MCP and setting sources even when no tools are allowed", async () => {
  const dir = fakeClaude(`echo "{\\"result\\":\\"$*\\",\\"is_error\\":false}"`);
  const out = await runClaude({
    prompt: "PROMPTBODY",
    cwd: "/tmp/helium-owned-workspace",
    maxTurns: 4,
    timeoutMs: 5_000,
    allowedTools: [],
    mcpConfigPath: "/tmp/mcp.json",
    env: { PATH: dir },
  });
  expect(out.text).toContain("--tools ");
  expect(out.text).toContain("--strict-mcp-config");
  expect(out.text).toContain("--setting-sources ");
  expect(out.text).not.toContain("--allowedTools");
});
```

Add a second fixture that spawns a child process and records its PID. After a
timeout, assert both the CLI and descendant are gone.

**Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm exec vitest run --project unit plugins/helium/src/claude.test.ts
```

Expected: FAIL because `runClaude()` does not pass `--tools`, strict MCP, or
isolated setting sources and does not kill the process group.

**Step 3: Implement the restrictive invocation**

In `runClaude()`, construct arguments from the actual restriction contract:

```ts
const args = [
  "-p", opts.prompt,
  "--output-format", "json",
  "--max-turns", String(opts.maxTurns),
  "--tools", opts.allowedTools.join(","),
  "--setting-sources", "",
];
if (opts.mcpConfigPath) {
  args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
}
```

Do not use `--allowedTools` as a restriction. Spawn a detached process group on
macOS/Linux and send TERM then KILL to the group, falling back to direct child
termination only when no group exists.

Create a per-attempt workspace below `stateRoot/workspaces/<job>/`, pass that
path as `cwd`, and remove it after the child reaches quiescence. Add
`workspaces` to `StatePaths`; do not use `process.cwd()` for senior execution.

**Step 4: Run focused and plugin tests**

Run:

```bash
pnpm exec vitest run --project unit plugins/helium/src/claude.test.ts plugins/helium/src/index.test.ts
pnpm typecheck
```

Expected: PASS; no descendant process remains after the timeout test.

**Step 5: Commit**

```bash
git add plugins/helium/src/claude.ts plugins/helium/src/claude.test.ts plugins/helium/src/index.ts plugins/helium/src/config.ts plugins/helium/src/index.test.ts profile/cordis.patch.yml plugins/helium/cordis.patch.yml
git commit -m "fix: isolate senior execution capabilities"
```

### Task 2: Add an adversarial senior isolation contract

**Files:**

- Create: `contracts/fixtures/senior-isolation/package.json`
- Create: `contracts/fixtures/senior-isolation/fake-claude.mjs`
- Create: `contracts/fixtures/senior-isolation/forbidden.txt`
- Create: `contracts/tests/senior-isolation.contract.spec.ts`

**Step 1: Write the failing contract**

The fake CLI must inspect argv, cwd, environment, and the supplied MCP file. It
should emit a JSON result only when all of these are true:

```ts
const proof = {
  strictMcp: argv.includes("--strict-mcp-config"),
  toolsRestricted: argv.includes("--tools"),
  settingsIsolated: argv.includes("--setting-sources"),
  ownedCwd: process.cwd().startsWith(process.env.HELIUM_EXPECTED_WORKSPACE!),
  secretAbsent: process.env.HELIUM_FORBIDDEN_SECRET === undefined,
};
```

The contract invokes the real `runClaude()` adapter with a narrowed environment
and asserts every proof field. It also verifies that an empty tool list remains
empty rather than becoming the provider default.

**Step 2: Run the contract and verify failure**

Run:

```bash
pnpm exec vitest run --project contracts contracts/tests/senior-isolation.contract.spec.ts
```

Expected: FAIL until Task 1's production path satisfies the same boundary.

**Step 3: Make the fixture exercise the production adapter**

Export only the minimal adapter entry needed by the contract. Do not create a
second test-only argument builder. The contract must call the same function
used by `buildSeniorLane()`.

**Step 4: Run the contract twice**

Run once with one allowed MCP tool and once with no tools:

```bash
pnpm exec vitest run --project contracts contracts/tests/senior-isolation.contract.spec.ts
```

Expected: both cases PASS.

**Step 5: Commit**

```bash
git add contracts/fixtures/senior-isolation contracts/tests/senior-isolation.contract.spec.ts plugins/helium/src/claude.ts
git commit -m "test: prove senior execution isolation"
```

### Task 3: Validate tool selections and make mutation policy truthful

**Files:**

- Modify: `packages/core/src/mcp/selection.ts`
- Modify: `packages/core/tests/mcp-selection.spec.ts`
- Modify: `packages/core/src/tools/types.ts`
- Modify: `plugins/helium/src/index.ts`
- Modify: `plugins/helium/src/index.test.ts`
- Modify: `plugins/helium/src/runtime.test.ts`

**Step 1: Write failing selection tests**

Add tests for unknown names and mutation mismatch:

```ts
expect(() => selected({ HELIUM_TOOLS: "argon_api,typo_tool" }))
  .toThrow(/unknown tools: typo_tool/);

expect(() => selected({
  HELIUM_TOOLS: "thesis_write",
  HELIUM_ALLOW_MUTATIONS: "0",
})).toThrow(/requires mutation permission/);
```

**Step 2: Run the focused test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/mcp-selection.spec.ts
```

Expected: FAIL because unknown or disallowed names are silently filtered.

**Step 3: Implement fail-loud catalog validation**

Build a map from `buildTools()` before filtering:

```ts
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const unknown = names.filter((name) => !byName.has(name));
if (unknown.length > 0) throw new Error(`unknown tools: ${unknown.join(", ")}`);
const forbidden = names.filter((name) => byName.get(name)?.mutating && !allowMutations);
if (forbidden.length > 0) {
  throw new Error(`tools require mutation permission: ${forbidden.join(", ")}`);
}
```

Generate a per-attempt MCP config from the job's exact tool list and
`allowMutations` value. Delete the static all-tools MCP config. If mutation is
not intended for v1 production, reject `allowMutations: true` at job load until
a mutating provider contract is certified; do not advertise a no-op flag.

**Step 4: Run selection, runtime, and type tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/mcp-selection.spec.ts plugins/helium/src/index.test.ts plugins/helium/src/runtime.test.ts
pnpm typecheck
```

Expected: PASS; a bad tool name fails only its tenant load path.

**Step 5: Commit**

```bash
git add packages/core/src/mcp/selection.ts packages/core/tests/mcp-selection.spec.ts packages/core/src/tools/types.ts plugins/helium/src/index.ts plugins/helium/src/index.test.ts plugins/helium/src/runtime.test.ts
git commit -m "fix: validate execution tool contracts"
```

### Task 4: Make delivery a write-ahead state machine

**Files:**

- Modify: `plugins/helium/src/delivery.ts`
- Modify: `plugins/helium/src/delivery.test.ts`
- Modify: `packages/core/src/jsonl.ts`
- Modify: `packages/core/tests/jsonl.spec.ts`

**Step 1: Write the failing ordering test**

Change the fake transport so it reads the delivery stream inside `sendMail()`:

```ts
sendMail: async () => {
  const rows = readRows();
  expect(rows.at(-1)).toMatchObject({
    kind: "delivery-intent",
    deliveryId: expect.any(String),
    state: "pending",
  });
  return { messageId: "x" };
}
```

Add crash-point tests for failure after intent, after SMTP success, and before
outcome append.

**Step 2: Run the focused test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/delivery.test.ts
```

Expected: FAIL because SMTP currently runs before the first audit append.

**Step 3: Implement intent and outcome rows**

Create one `deliveryId` and append before any external side effect:

```ts
this.opts.jsonl.append("deliveries", {
  kind: "delivery-intent",
  deliveryId,
  job: job.name,
  runId: result.runId,
  dedupKey: ev.dedupKey,
  state: "pending",
});
```

After rate limiting or SMTP, append a separate `delivery-outcome` row with the
same ID and `sent`, `skipped`, `rate-capped`, `failed`, or `unknown`. Count rate
limits from successful outcome rows, not intents. Preserve dead letters as a
third row tied to the same ID.

Add `appendAt()` or injectable clock support to `JsonlWriter` so the file name
and record timestamp use the same clock; remove the fake-timer workaround from
delivery tests.

**Step 4: Run focused and regression tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/jsonl.spec.ts plugins/helium/src/delivery.test.ts
pnpm test
```

Expected: PASS; every SMTP observation sees a prior intent row.

**Step 5: Commit**

```bash
git add packages/core/src/jsonl.ts packages/core/tests/jsonl.spec.ts plugins/helium/src/delivery.ts plugins/helium/src/delivery.test.ts
git commit -m "fix: write delivery intent before side effects"
```

### Task 5: Add expected-tenant and per-tenant liveness

**Files:**

- Create: `packages/core/src/tenant-health.ts`
- Create: `packages/core/tests/tenant-health.spec.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `plugins/helium/src/runtime.ts`
- Modify: `plugins/helium/src/runtime.test.ts`
- Create: `scripts/deadman/check-tenant-heartbeats.mjs`
- Create: `scripts/deadman/check-tenant-heartbeats.test.mjs`
- Modify: `scripts/deadman/check-heartbeat.sh`

**Step 1: Write failing reducer and script tests**

Define expected states:

```ts
expect(tenantHealth(expected, recentRows, deadline)).toEqual([
  { tenant: "macro-watch", state: "healthy" },
  { tenant: "broken-job", state: "missing" },
]);
```

The script test creates one current and one stale tenant heartbeat and expects a
non-zero exit naming only the stale tenant.

**Step 2: Run focused tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/tenant-health.spec.ts plugins/helium/src/runtime.test.ts
node --test scripts/deadman/check-tenant-heartbeats.test.mjs
```

Expected: FAIL because neither reducer nor tenant checker exists.

**Step 3: Implement expected tenant inventory**

Inventory every `*.yaml` file before parsing. Emit `tenant-health` rows for
`loaded`, `invalid`, `disabled`, and runtime heartbeat. A malformed tenant must
remain in the expected inventory with state `invalid`, not disappear.

The dead-man wrapper runs both process/global heartbeat and tenant checks. It
must preserve the existing deliberate-drill behavior and never infer health
from another tenant's heartbeat.

**Step 4: Run all health and runtime tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/tenant-health.spec.ts plugins/helium/src/runtime.test.ts
node --test scripts/deadman/check-tenant-heartbeats.test.mjs
bash scripts/deadman/check-heartbeat.test.sh
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/tenant-health.ts packages/core/tests/tenant-health.spec.ts packages/core/src/index.ts plugins/helium/src/runtime.ts plugins/helium/src/runtime.test.ts scripts/deadman
git commit -m "feat: monitor liveness per tenant"
```

### Phase 0 gate

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
git diff --check
```

Expected: all commands pass. Do not deploy. Open a PR and obtain review of the
isolation proof and delivery crash matrix before starting Phase 1.

## Phase 1: model-blind core and provider contracts

### Task 6: Move v1 provider knowledge into a compatibility package

**Files:**

- Create: `packages/v1-compat/package.json`
- Create: `packages/v1-compat/tsconfig.json`
- Move: `packages/core/src/job.ts` -> `packages/v1-compat/src/job.ts`
- Move: `packages/core/tests/job.spec.ts` -> `packages/v1-compat/tests/job.spec.ts`
- Move: `packages/core/tests/macro-watch-job.spec.ts` -> `packages/v1-compat/tests/macro-watch-job.spec.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/v1-compat/src/index.ts`
- Modify: `plugins/helium/package.json`
- Modify: imports under `plugins/helium/src`
- Modify: `vitest.config.ts`

**Step 1: Add a failing core-neutrality test**

Create `contracts/tests/core-neutrality.contract.spec.ts` that scans
`packages/core/src` and fails on production provider/model vocabulary:

```ts
const forbidden = ["deepseek", "claude-max", "gpt-", "anthropic", "codex"];
for (const file of sourceFiles(coreSrc)) {
  const text = readFileSync(file, "utf8").toLowerCase();
  for (const word of forbidden) expect(text, `${file}: ${word}`).not.toContain(word);
}
```

Exclude documentation comments only if the exclusion is deterministic; do not
exclude whole source files.

**Step 2: Run the contract and verify failure**

```bash
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: FAIL on `packages/core/src/job.ts`.

**Step 3: Move the legacy surface without changing behavior**

Create `@helium/v1-compat`, move the parser/tests, and update plugin imports.
Keep the YAML and normalized `JobSpec` byte-for-byte compatible. Do not redesign
the job schema in this task.

**Step 4: Run compatibility and neutrality tests**

```bash
pnpm exec vitest run --project unit packages/v1-compat/tests
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
pnpm typecheck
```

Expected: PASS; existing job fixtures parse identically.

**Step 5: Commit**

```bash
git add packages/core packages/v1-compat plugins/helium vitest.config.ts contracts/tests/core-neutrality.contract.spec.ts pnpm-lock.yaml
git commit -m "refactor: isolate v1 model-specific job contract"
```

### Task 7: Define provider-neutral work and result schemas

**Files:**

- Create: `packages/core/src/work.ts`
- Create: `packages/core/tests/work.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing schema tests**

Cover valid work, forbidden keys, normalized failures, and opaque runtime
metadata:

```ts
const work = WorkOrderSchema.parse({
  id: "work-1",
  role: "evidence-verifier",
  taskClass: "research.verification",
  requires: { "verification.claims": { min: 0.8, weight: 1 } },
  constraints: {
    tools: ["artifact_read"],
    mutations: "forbidden",
    maxCost: 2,
    maxLatencyMs: 180_000,
  },
  inputs: { artifacts: ["artifact-1"] },
  acceptance: { outputSchema: "claim-set-v1" },
});
expect(work.role).toBe("evidence-verifier");
expect(() => WorkOrderSchema.parse({ ...raw, model: "anything" })).toThrow();
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement strict schemas**

Export:

```ts
export type FailureClass =
  | "unavailable" | "timeout" | "cancelled" | "budget-exhausted"
  | "capability-shortage" | "schema-invalid" | "tool-boundary-violation"
  | "provider-error" | "verification-failed";

export interface AgentResult {
  workId: string;
  outcome: "completed" | "failed";
  failure?: { class: FailureClass; safeDetail?: string };
  structured?: unknown;
  artifacts: string[];
  usage: { inputTokens?: number; outputTokens?: number; cost?: number; ms: number };
  runtimeMetadata: Record<string, unknown>;
}
```

Use strict Zod objects at every persistence and provider boundary. Keep provider
identity out of the schema.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/work.ts packages/core/tests/work.spec.ts packages/core/src/index.ts
git commit -m "feat: define model-blind work contracts"
```

### Task 8: Define the capability catalog and evaluation evidence

**Files:**

- Create: `packages/core/src/capabilities.ts`
- Create: `packages/core/tests/capabilities.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing catalog tests**

```ts
const catalog = new CapabilityCatalog();
catalog.register({
  targetId: ExecutionTargetId("target-a"),
  capabilities: {
    "writing.executive": {
      score: 0.91,
      confidence: 0.82,
      sampleCount: 84,
      suite: "helium-eval-v1",
      evaluatedAt: "2026-08-25T00:00:00.000Z",
      source: "measured",
    },
  },
  operations: { maxLatencyMs: 180_000, costClass: "low" },
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
});
expect(catalog.list()).toHaveLength(1);
expect(() => catalog.register(sameTargetAgain)).toThrow(/duplicate target/);
```

Also reject scores outside `[0,1]`, missing evidence, stale profile versions,
and unknown capabilities when a closed ontology version is selected.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/capabilities.spec.ts
```

Expected: FAIL because the catalog does not exist.

**Step 3: Implement catalog registration**

The catalog stores opaque `ExecutionTargetId` values and capability evidence.
It must not expose a provider/model field. Provider-specific details remain in
the executor registry and audit metadata.

Registration returns an effect-scoped disposer:

```ts
const dispose = catalog.register(profile);
dispose();
expect(catalog.get(profile.targetId)).toBeUndefined();
```

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/capabilities.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/capabilities.ts packages/core/tests/capabilities.spec.ts packages/core/src/index.ts
git commit -m "feat: add measured capability catalog"
```

### Task 9: Implement deterministic capability routing

**Files:**

- Create: `packages/core/src/router.ts`
- Create: `packages/core/tests/router.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing routing tests**

Test hard constraints, weighted capability score, evaluation confidence,
bounded preference, deterministic tie-breaking, budget reservation, and
shortage:

```ts
const decision = route(workOrder, policy, catalog.list());
expect(decision.selected).toBe(ExecutionTargetId("target-b"));
expect(decision.candidates).toEqual([
  expect.objectContaining({ targetId: "target-b", eligible: true }),
  expect.objectContaining({ targetId: "target-a", eligible: false, reasons: ["tool-isolation"] }),
]);
```

Add a test proving a writing preference boost can change two otherwise eligible
targets but cannot make a target bypass a required verification or safety score.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/router.spec.ts
```

Expected: FAIL because `route()` does not exist.

**Step 3: Implement pure routing**

Keep the function deterministic and side-effect free:

```ts
export interface RoutingDecision {
  selected?: ExecutionTargetId;
  candidates: CandidateDecision[];
  failure?: { class: "capability-shortage"; reasons: string[] };
  policyVersion: string;
  catalogVersion: string;
}
```

Filter hard requirements first. Score only eligible candidates. Cap the total
tenant-preference contribution so it cannot outweigh required safety or
acceptance capabilities. Break ties by stable target ID. Do not place runtime
availability polling in this pure function; pass an availability snapshot as
catalog input.

**Step 4: Run tests and repeat for determinism**

```bash
pnpm exec vitest run --project unit packages/core/tests/router.spec.ts --repeat=20
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: every repeat chooses the same target and emits the same decision.

**Step 5: Commit**

```bash
git add packages/core/src/router.ts packages/core/tests/router.spec.ts packages/core/src/index.ts
git commit -m "feat: route work by measured capability"
```

### Task 10: Add executor leases and a fake executor

**Files:**

- Create: `packages/core/src/execution.ts`
- Create: `packages/core/tests/execution.spec.ts`
- Create: `plugins/helium/src/executor-registry.ts`
- Create: `plugins/helium/src/executor-registry.test.ts`
- Create: `plugins/helium/src/testing/fake-executor.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing lease and registry tests**

```ts
const lease = leases.issue({
  targetId: ExecutionTargetId("fake-a"),
  workId: "work-1",
  reservedCost: 1.5,
  expiresAt: "2026-08-25T00:05:00.000Z",
});
expect(() => leases.consume(lease.id, "different-work")).toThrow(/work mismatch/);
expect(leases.consume(lease.id, "work-1")).toEqual(lease);
expect(() => leases.consume(lease.id, "work-1")).toThrow(/already consumed/);
```

Test duplicate executor registration, missing target, disposal, timeout,
normalized result, and opaque runtime metadata persistence.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/execution.spec.ts plugins/helium/src/executor-registry.test.ts
```

Expected: FAIL because the lease store and registry do not exist.

**Step 3: Implement the boundary**

Core exports the model-blind interface:

```ts
export interface Executor {
  readonly targetId: ExecutionTargetId;
  run(work: WorkOrder, signal: AbortSignal): Promise<AgentResult>;
  drain(): Promise<void>;
}
```

The plugin registry owns concrete executors. `FakeExecutor` returns a strict
fixture result and records received work orders for contract assertions. Lease
consumption is atomic in process and append-audited by its caller.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/execution.spec.ts plugins/helium/src/executor-registry.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/execution.ts packages/core/tests/execution.spec.ts packages/core/src/index.ts plugins/helium/src/executor-registry.ts plugins/helium/src/executor-registry.test.ts plugins/helium/src/testing/fake-executor.ts
git commit -m "feat: add opaque executor leases"
```

### Task 11: Adapt v1 jobs through the new boundary

**Files:**

- Create: `packages/v1-compat/src/adapter.ts`
- Create: `packages/v1-compat/tests/adapter.spec.ts`
- Modify: `packages/v1-compat/src/index.ts`
- Modify: `plugins/helium/src/runtime.ts`
- Modify: `plugins/helium/src/runtime.test.ts`
- Modify: `plugins/helium/src/index.ts`
- Modify: `plugins/helium/src/index.test.ts`

**Step 1: Write a failing golden compatibility test**

Parse each shipped job, adapt it, and snapshot the behaviorally relevant work:

```ts
const adapted = adaptV1Job(parseJobYaml(macroYaml, "macro-watch.yaml"));
expect(adapted).toMatchObject({
  triggerCount: 3,
  triage: { taskClass: "legacy.triage", constraints: { mutations: "forbidden" } },
  escalation: { threshold: "material" },
  delivery: { jsonl: true },
});
```

The adapter may carry legacy exact-target hints outside `WorkOrder`; verify
those hints are marked `source: "v1-compat"` and are not serialized into core
work schemas.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/v1-compat/tests/adapter.spec.ts
```

Expected: FAIL because no adapter exists.

**Step 3: Implement the compatibility adapter**

Translate current triggers, budgets, prompts, tools, and delivery without
changing their semantics. Put provider-specific legacy target resolution in the
plugin composition root, not in `WorkOrder` or the router.

Add a runtime flag that chooses `legacy-direct` or `work-order-adapter`; default
to `legacy-direct` until the adapter passes the full local end-to-end suite.

**Step 4: Run the complete v1 regression suite**

```bash
pnpm test
pnpm test:contracts
pnpm test:e2e-local
```

Expected: PASS in both runtime modes with equivalent golden delivery records.

**Step 5: Commit**

```bash
git add packages/v1-compat plugins/helium/src/runtime.ts plugins/helium/src/runtime.test.ts plugins/helium/src/index.ts plugins/helium/src/index.test.ts
git commit -m "feat: preserve v1 through work-order adapter"
```

### Phase 1 gate

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
rg -n -i "deepseek|claude|anthropic|codex|gpt-" packages/core/src && exit 1 || true
git diff --check
```

Expected: all test commands pass and the neutrality search returns no matches.
Open separate PRs for the compatibility move and new contracts if review size
would otherwise exceed one coherent change.

## Phase 2: durable team kernel

### Task 12: Define team events and a deterministic reducer

**Files:**

- Create: `packages/core/src/team/events.ts`
- Create: `packages/core/src/team/reducer.ts`
- Create: `packages/core/tests/team-reducer.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing reducer tests**

Start with a minimal event vocabulary:

```ts
const events: TeamEvent[] = [
  { type: "case/opened", caseId: "case-1", eventId: "e1", at, subject: "macro" },
  { type: "team/started", caseId: "case-1", teamRunId: "team-1", eventId: "e2", at },
  { type: "agent/rostered", teamRunId: "team-1", agentId: "lead", role: leadRole, eventId: "e3", at },
];
expect(reduceTeam(events)).toMatchObject({
  cases: { "case-1": { state: "open" } },
  teams: { "team-1": { state: "running", roster: { lead: expect.anything() } } },
});
```

Test duplicate event IDs, out-of-order references, invalid terminal
transitions, and byte-identical replay.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-reducer.spec.ts
```

Expected: FAIL because the team event modules do not exist.

**Step 3: Implement strict event schemas and reducer**

Use versioned, strict event envelopes:

```ts
interface TeamEventEnvelope {
  version: 1;
  eventId: string;
  at: string;
  caseId: string;
  teamRunId?: string;
  type: string;
  payload: unknown;
}
```

The reducer is pure. It rejects corrupt sequences rather than repairing them.
No event contains provider or model fields.

**Step 4: Run reducer tests repeatedly**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-reducer.spec.ts --repeat=20
```

Expected: PASS with identical snapshots across repeats.

**Step 5: Commit**

```bash
git add packages/core/src/team packages/core/tests/team-reducer.spec.ts packages/core/src/index.ts
git commit -m "feat: add durable team event model"
```

### Task 13: Persist team logs and snapshots

**Files:**

- Create: `packages/core/src/team/store.ts`
- Create: `packages/core/tests/team-store.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing crash and replay tests**

Test append, fsync boundary, truncated last line, unsupported version, snapshot
hash mismatch, and replay after snapshot:

```ts
store.append(opened);
store.append(started);
store.snapshot();
store.append(rostered);
expect(store.load()).toEqual(reduceTeam([opened, started, rostered]));
```

Corrupt a snapshot and assert the store ignores it and replays the full event
log rather than trusting bad state.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-store.spec.ts
```

Expected: FAIL because the store does not exist.

**Step 3: Implement append-only persistence**

Store one team stream per UTC day or case partition, using the same atomic file
and hash discipline as existing state. Append the event before mutating the
in-memory projection. Snapshot only a projection plus last event ID/hash; the
event log remains authoritative.

**Step 4: Run store and JSONL tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-store.spec.ts packages/core/tests/jsonl.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/team/store.ts packages/core/tests/team-store.spec.ts packages/core/src/index.ts
git commit -m "feat: persist restart-safe team state"
```

### Task 14: Add CAS task DAG and durable mailbox

**Files:**

- Create: `packages/core/src/team/tasks.ts`
- Create: `packages/core/src/team/mailbox.ts`
- Create: `packages/core/tests/team-tasks.spec.ts`
- Create: `packages/core/tests/team-mailbox.spec.ts`
- Modify: `packages/core/src/team/events.ts`
- Modify: `packages/core/src/team/reducer.ts`

**Step 1: Write failing task and message tests**

Cover cycle rejection, stale revision, ownership conflict, lease expiry,
queue-then-acknowledge, duplicate message ID, and restart redelivery:

```ts
expect(() => graph.add({ id: "b", dependsOn: ["c"] }, revision))
  .toThrow(/cycle/);
expect(() => graph.update("task-1", staleRevision, patch))
  .toThrow(/stale revision/);

mailbox.enqueue(message);
expect(mailbox.pending("agent-b")).toEqual([message]);
mailbox.ack(message.id, "agent-b");
expect(mailbox.pending("agent-b")).toEqual([]);
```

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-tasks.spec.ts packages/core/tests/team-mailbox.spec.ts
```

Expected: FAIL because the modules do not exist.

**Step 3: Implement event-backed task and mailbox operations**

All accepted operations append an event and then update the projection. Task
state is one of `pending`, `ready`, `leased`, `running`, `needs-input`,
`completed`, `failed`, or `cancelled`. Message acknowledgement records receiver
identity and time. Unknown or already-acknowledged messages fail loud.

**Step 4: Run task, mailbox, and replay tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-tasks.spec.ts packages/core/tests/team-mailbox.spec.ts packages/core/tests/team-store.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/team/tasks.ts packages/core/src/team/mailbox.ts packages/core/src/team/events.ts packages/core/src/team/reducer.ts packages/core/tests/team-tasks.spec.ts packages/core/tests/team-mailbox.spec.ts
git commit -m "feat: add durable task DAG and mailbox"
```

### Task 15: Add budgets, cancellation, and recovery reconciliation

**Files:**

- Create: `packages/core/src/team/budget.ts`
- Create: `packages/core/src/team/recovery.ts`
- Create: `packages/core/tests/team-budget.spec.ts`
- Create: `packages/core/tests/team-recovery.spec.ts`
- Modify: `packages/core/src/team/events.ts`
- Modify: `packages/core/src/team/reducer.ts`

**Step 1: Write failing budget and crash-matrix tests**

```ts
budget.reserve({ caseId, agentId, tokens: 10_000, cost: 1 });
expect(() => budget.reserve({ caseId, agentId, tokens: 1, cost: 0.01 }))
  .toThrow(/case budget exhausted/);

const recovered = reconcile(replay(logWithRunningLease), now);
expect(recovered.events).toContainEqual(expect.objectContaining({
  type: "task/interrupted",
  payload: expect.objectContaining({ reason: "startup-recovery" }),
}));
```

Build a table-driven crash matrix for task assignment, message acceptance,
executor start, artifact publication, cancellation, and delivery intent.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-budget.spec.ts packages/core/tests/team-recovery.spec.ts
```

Expected: FAIL because budget and recovery modules do not exist.

**Step 3: Implement idempotent reservations and reconciliation**

Reservations use stable operation IDs. Applying the same charge twice is a
no-op; applying the same ID with different values is corruption. Cancellation
walks the task/agent ownership tree child-first. Recovery converts uncertain
in-process work into interrupted state and marks uncertain external side
effects for reconciliation rather than retrying them blindly.

**Step 4: Run the crash matrix repeatedly**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-budget.spec.ts packages/core/tests/team-recovery.spec.ts --repeat=20
```

Expected: PASS with no duplicate charge or terminal event.

**Step 5: Commit**

```bash
git add packages/core/src/team/budget.ts packages/core/src/team/recovery.ts packages/core/src/team/events.ts packages/core/src/team/reducer.ts packages/core/tests/team-budget.spec.ts packages/core/tests/team-recovery.spec.ts
git commit -m "feat: reconcile team budgets and cancellation"
```

### Task 16: Integrate a DSH subagent team host

**Files:**

- Modify: `plugins/helium/package.json`
- Modify: `plugins/helium/src/index.ts`
- Create: `plugins/helium/src/dsh-team-host.ts`
- Create: `plugins/helium/src/dsh-team-host.test.ts`
- Create: `contracts/fixtures/team-host/package.json`
- Create: `contracts/fixtures/team-host/cordis.patch.yml`
- Create: `contracts/fixtures/team-host/src/index.ts`
- Create: `contracts/tests/team-host.contract.spec.ts`
- Modify: `pnpm-lock.yaml`

**Step 1: Write the structural host test**

The deterministic controller needs a durable DSH parent identity without
asking that parent model to control scheduling. Test that the host creates one
parent `Agent`, starts a child through `ctx.subagents`, passes persona/tool/depth
constraints, awaits result, and always disposes:

```ts
const result = await host.run(work, lease, signal);
expect(fakeSubagents.start).toHaveBeenCalledWith("spawn", expect.objectContaining({
  parent: host.parentAgent,
  maxDepth: 1,
  toolFilter: { allow: ["artifact_read"] },
  outputSchema: expect.any(Object),
}));
expect(fakeRun.dispose).toHaveBeenCalledOnce();
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/dsh-team-host.test.ts
```

Expected: FAIL because the host does not exist.

**Step 3: Implement against the published DSH seam**

Pin `@deepseek-ai/dsh-subagent` to `0.1.1-rc.2`. Add `subagents` to Cordis
injection. Create one host Agent per `TeamRun`, with its own durable session and
owned workspace. Call `ctx.subagents.start()` with an `AbortSignal`, structured
output schema, explicit depth cap, tool restriction, and persona. Map
`SubagentResult.stopReason` into `AgentResult`. Dispose in `finally` and drain
descendants when the team stops.

Do not use DSH workflow as the durable controller; its current run does not own
Helium's mailbox, budget, or restart contract.

**Step 4: Add a real non-live DSH contract**

The fixture boots a DSH profile with a fake in-process provider. It starts two
sibling children, cancels one, lets one complete, drains the parent, and writes
a proof record. No live model or credential is used.

Run:

```bash
pnpm exec vitest run --project contracts contracts/tests/team-host.contract.spec.ts
```

Expected: PASS; the completed sibling is unaffected, the cancelled sibling is
settled, and no child remains after drain.

**Step 5: Commit**

```bash
git add plugins/helium/package.json plugins/helium/src/index.ts plugins/helium/src/dsh-team-host.ts plugins/helium/src/dsh-team-host.test.ts contracts/fixtures/team-host contracts/tests/team-host.contract.spec.ts pnpm-lock.yaml
git commit -m "feat: execute team work through dsh subagents"
```

### Phase 2 gate

Run:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
```

Then run the persisted crash matrix against a temporary state root. Expected:
replay converges, all leases are terminal or ready, all acknowledged messages
remain acknowledged, and the process table contains no child from the test.

## Phase 2.5: operations safety substrate and Ops reference team

After the Phase 2 gate passes, execute the separate
[Helium Ops Agent Implementation Plan](2026-08-25-helium-ops-agent-implementation.md).
Its core observation, incident, SOP, action, lease, verification, attribution,
and admission contracts must land before any automatic recovery is enabled.

The Ops plan has its own contracts-only, executor, observe-only, suggest-only,
and post-AC#1 promotion gates. Completing its code does not authorize production
installation or promote any SOP to automatic authority.

## Phase 3: cross-reference and macro shadow team

### Task 17: Add claim sets and evidence-based adjudication

**Files:**

- Create: `packages/core/src/evidence/claims.ts`
- Create: `packages/core/src/evidence/compare.ts`
- Create: `packages/core/tests/claims.spec.ts`
- Create: `packages/core/tests/claim-compare.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing claim comparison tests**

```ts
const comparison = compareClaimSets(primary, reviewer);
expect(comparison.contradictions).toEqual([
  expect.objectContaining({ key: "policy.rate_path", requiresVerification: true }),
]);
expect(comparison.uniqueEvidence).toContainEqual(
  expect.objectContaining({ sourceRef: "artifact://source/new" }),
);
```

Test same conclusion with different evidence, direct contradiction, missing
provenance, stale evidence, subjective judgment, and three-agent false
consensus using the same bad source.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts
```

Expected: FAIL because the evidence modules do not exist.

**Step 3: Implement normalized claim sets**

Each claim contains:

```ts
interface Claim {
  key: string;
  statement: string;
  kind: "fact" | "inference" | "judgment";
  evidenceRefs: string[];
  confidence: number;
  assumptions: string[];
  asOf?: string;
}
```

The comparator emits agreement, contradiction, unique evidence, and evidence
gaps. It never chooses a winner. Material contradictions create verification
work orders that require fresh evidence capabilities.

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/evidence packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts packages/core/src/index.ts
git commit -m "feat: compare agent claims against evidence"
```

### Task 18: Define provider-neutral team manifests

**Files:**

- Create: `packages/core/src/team/manifest.ts`
- Create: `packages/core/tests/team-manifest.spec.ts`
- Create: `teams/macro.yaml`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing manifest tests**

Parse a manifest with roles, capability contracts, task dependencies,
cross-reference policy, budgets, and acceptance criteria. Explicitly reject
provider/model keys at every depth:

```ts
expect(() => parseTeamYaml(`
name: bad
roles:
  writer:
    model: forbidden
`)).toThrow(/unrecognized key.*model/);
```

Test DAG cycles, unknown roles, missing capability requirements, and renderer
permission to read only adjudicated artifacts.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-manifest.spec.ts
```

Expected: FAIL because the manifest parser does not exist.

**Step 3: Implement the macro manifest**

The task graph is:

```text
inflation-evidence ----\
                       -> rates-path -> usd-transmission -> gold-impact
policy-evidence -------/                         |               |
                                                +----> verifier -+
                                                           |
                                                      lead-synthesis
                                                           |
                                                        renderer
```

Use capability requirements only. The renderer receives the adjudicated claim
ledger and cannot call external research or mutation tools.

**Step 4: Run manifest and macro-causality tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-manifest.spec.ts
```

Expected: PASS; the serialized manifest contains no provider or model field.

**Step 5: Commit**

```bash
git add packages/core/src/team/manifest.ts packages/core/tests/team-manifest.spec.ts packages/core/src/index.ts teams/macro.yaml
git commit -m "feat: define capability-based macro team"
```

### Task 19: Run the macro team in shadow mode

**Files:**

- Create: `plugins/helium/src/team-controller.ts`
- Create: `plugins/helium/src/team-controller.test.ts`
- Create: `plugins/helium/src/shadow.ts`
- Create: `plugins/helium/src/shadow.test.ts`
- Modify: `plugins/helium/src/runtime.ts`
- Modify: `plugins/helium/src/config.ts`
- Modify: `plugins/helium/src/index.ts`
- Modify: `profile/cordis.patch.yml`
- Modify: `plugins/helium/cordis.patch.yml`

**Step 1: Write a failing fake-executor shadow test**

Feed one material trigger to both paths. Assert the v1 delivery path remains
unchanged and the team path writes only shadow artifacts:

```ts
await shadow.handle(job, event);
expect(v1Delivery).toHaveBeenCalledOnce();
expect(teamStore.state().teams).toHaveLength(1);
expect(emailTransport.sendMail).not.toHaveBeenCalledWith(
  expect.objectContaining({ headers: expect.objectContaining({ "x-helium-path": "shadow" }) }),
);
expect(mutationTools.calls).toHaveLength(0);
```

Test capability shortage, one failed evidence role, contradiction requiring a
verifier, cancellation, and restart between every DAG layer.

**Step 2: Run the focused tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.test.ts
```

Expected: FAIL because the controller and shadow adapter do not exist.

**Step 3: Implement the deterministic controller**

The controller:

1. opens or updates a case;
2. instantiates the task DAG;
3. routes ready work;
4. reserves budget and issues a lease;
5. executes through the registry;
6. validates and publishes artifacts;
7. compares claims and creates verification tasks;
8. advances dependent tasks;
9. renders only after adjudication; and
10. records a terminal shadow result without production delivery.

Add `teamShadowEnabled` and `teamsDir` configuration. Default shadow to false.
No configuration accepts a provider or model name.

**Step 4: Run fake-executor end-to-end tests**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.test.ts
pnpm test:e2e-local
```

Expected: PASS; enabling shadow adds records but does not change v1 reports or
email.

**Step 5: Commit**

```bash
git add plugins/helium/src/team-controller.ts plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.ts plugins/helium/src/shadow.test.ts plugins/helium/src/runtime.ts plugins/helium/src/config.ts plugins/helium/src/index.ts profile/cordis.patch.yml plugins/helium/cordis.patch.yml
git commit -m "feat: run macro team in shadow mode"
```

### Task 20: Build the model capability evaluation harness

**Files:**

- Create: `packages/evals/package.json`
- Create: `packages/evals/tsconfig.json`
- Create: `packages/evals/src/run.ts`
- Create: `packages/evals/src/score.ts`
- Create: `packages/evals/tests/score.spec.ts`
- Create: `evals/fixtures/routing/`
- Create: `evals/fixtures/macro/`
- Create: `evals/README.md`
- Modify: `pnpm-workspace.yaml`

**Step 1: Write failing scorer tests**

Use frozen fake results to test acceptance, claim provenance, contradiction
detection, unique evidence, structured output, latency, cost, and human
preference:

```ts
expect(scoreRun(fixture)).toEqual(expect.objectContaining({
  acceptance: 1,
  verifiedClaimRate: 1,
  unsupportedClaimRate: 0,
  unauthorizedCalls: 0,
}));
```

**Step 2: Run the scorer test and verify failure**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts
```

Expected: FAIL because the eval package does not exist.

**Step 3: Implement offline-first evaluations**

The runner consumes a team manifest, work fixtures, a catalog snapshot, and
executor adapters. Default to fake/replayed results. Live provider evaluation
requires an explicit environment opt-in and writes results under an untracked
run directory. Promotion consumes only reviewed, committed summaries and
versioned catalog updates.

Do not derive capability scores directly from production success counts. Store
sample size, confidence, suite version, and known failure categories.

**Step 4: Run offline evaluations**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts
pnpm --filter @helium/evals run evaluate -- --fixtures evals/fixtures/macro
```

Expected: deterministic scorecard and no network access.

**Step 5: Commit**

```bash
git add packages/evals evals pnpm-workspace.yaml
git commit -m "feat: evaluate routing and team quality"
```

### Phase 3 gate

Run the full suite plus frozen macro evaluation:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
pnpm --filter @helium/evals run evaluate -- --fixtures evals/fixtures/macro
git diff --check
```

Expected:

- zero unauthorized capability calls;
- no provider/model names in core or team manifests;
- every material factual claim has provenance;
- contradictions create evidence verification rather than majority vote;
- crash/restart and cascading cancellation pass;
- shadow mode performs no email or mutation; and
- the scorecard compares the team with the frozen v1 control.

Open a PR for shadow-mode code only. Do not enable it on the mini until Phase 0,
Phase 1, and Phase 2 evidence is reviewed and AC#1 is complete.

## Production promotion plan

Create a separate execution plan after shadow evaluation fixes the actual
catalog, cost envelope, and failure behavior. That plan must include:

- the tagged canary release;
- review-only delivery first;
- explicit human approval;
- per-tenant and per-team health;
- provider circuit-breaker drills;
- state-schema rollback proof;
- five uninterrupted trading days;
- one real material macro case; and
- rollback within 60 seconds.

Ops promotion follows the independent ladder in the Ops implementation plan:
observe-only, suggest-only, then one certified automatic SOP at a time. Macro
promotion does not imply Ops mutation authority, and Ops promotion does not
retire the v1 macro lane.

Do not pre-authorize production email, mutations, or v1 retirement in this
implementation plan.

## Final documentation and handoff

After every phase PR merges:

1. Fetch the remote merge commit.
2. Align local `master` to that commit.
3. Re-run the phase gate from clean `master`.
4. Record measured results in the corresponding plan and review document.
5. Update README's "What works today" only after the capability is actually
   deployed and observed.
6. Preserve exact open gates and non-goals for the next execution session.
