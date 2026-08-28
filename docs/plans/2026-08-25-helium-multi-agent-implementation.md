# Helium Multi-Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn Helium's proven v1 runner into a model-blind, capability-selected,
restart-safe multi-agent harness while preserving the v1 production path.

**Architecture:** Helium core owns provider-neutral work orders, a thin
capability selector, durable team state, evidence, budgets, and delivery policy.
A provider-executor registry resolves opaque execution leases into concrete
model calls; each registered executor declares an `isolationClass` and passes
one shared execution-boundary conformance suite. DSH supplies agent and
subagent lifecycle primitives — its in-process driver being one low-isolation
executor, not the universal execution path; Helium supplies business durability
and verification around them.

**Revised 2026-08-28** per `docs/reviews/2026-08-28-plan-review-adjudication.md`:
executor registry and isolation class (D2), thin selector v1 with scoring
deferred (D3), `quota-exhausted` in Phase 0 (ARCH-3), frozen P0 evidence
template (ARCH-2), general mailbox deferred (D5 step 6), and the Phase 0 snippet
fixes (IMPL-1/2/3).

**Revised again 2026-08-28** per
`docs/reviews/2026-08-28-adjudication-round-2.md`: the generic append-only event
store moves into Phase 1 Task 7 (R1), Task 10b adds the structural half of the
topology guard and Task 19 keeps the behavioral half (R4/ARCH-5), and Task 6
carries one exported forbidden-word contract plus the v1 domain-module moves
while Task 10 registers two fakes as workspace packages (R6/ARCH-8).

**Tech Stack:** TypeScript 5, Node.js 22+, pnpm, Vitest, Zod, YAML, DeepSeek
Harness/Cordis `0.1.1-rc.2`, append-only JSONL, MCP, nodemailer.

---

## Execution rules

- Work on an isolated feature branch or worktree, never directly on `master`.
- Do not deploy to the mini during the active AC#1 observation window.
- Run the focused failing test before writing production code.
- Keep every commit green for all previously completed tasks.
- Do not add a provider/model name to `packages/core`.
- Treat the canonical topology and evidence status vocabulary in the design as
  contract surfaces; implementation may not add a sensor-to-provider,
  agent-to-delivery, or agent-to-authority shortcut.
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

**Interface note (frozen):** `runClaude()`'s option field keeps the name
`allowedTools`. Only the emitted CLI flag changes — from `--allowedTools` to
`--tools`. Do **not** rename the field to `tools`; downstream plans (the
provider-effort-selection plan resumes at exactly this seam) must extend this
signature, not redefine it. Any snippet that passes `tools:` to `runClaude()`
is wrong and must be corrected to `allowedTools:`.

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
  "-p",
  opts.prompt,
  "--output-format",
  "json",
  "--max-turns",
  String(opts.maxTurns),
  "--tools",
  opts.allowedTools.join(","),
  "--setting-sources",
  "",
];
if (opts.mcpConfigPath) {
  args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
}
```

Do not use `--allowedTools` as a restriction. The option field stays
`opts.allowedTools`; only the flag it produces changes. Spawn a detached process
group on macOS/Linux and send TERM then KILL to the group, falling back to
direct child termination only when no group exists.

Create a per-attempt workspace below `stateRoot/workspaces/<job>/`, pass that
path as `cwd`, and remove it after the child reaches quiescence. Add
`workspaces` to `StatePaths`; do not use `process.cwd()` for senior execution.

**Step 3b: Add `quota-exhausted` to the classification vocabulary**

`classify()` is already open in this task, and subscription session-window
exhaustion is the highest-frequency real failure this system sees — it has
already broken two live dispatches and currently classifies as a generic
`error`. Add it now:

```ts
export type ClaudeClassification =
  "proxy" | "auth" | "timeout" | "quota-exhausted" | "error";

export interface ClaudeResult {
  ok: boolean;
  text?: string;
  classification?: ClaudeClassification;
  /** Opaque provider-supplied hint; only meaningful for `quota-exhausted`. */
  retryAfter?: string;
  raw?: unknown;
}
```

Detect it ahead of the `auth` and `proxy` branches (a `429`, a rate-limit or
session-limit envelope, or an explicit reset timestamp) and carry the provider's
reset hint through as an opaque `retryAfter` string. Do not parse it into a
duration in this task, and do not invent one when the provider gives none.

`quota-exhausted` is **dynamic provider-availability state, not a capability
score and not a budget**: the target's capabilities are unchanged, it is simply
unavailable until `retryAfter`. A flat-rate subscription reports neither dollars
nor tokens, so it must never be folded into `budget-exhausted`. Downstream, the
class means "this target is filtered out until `retryAfter`, try the configured
fallback" — never "retry this target immediately" and never "this target is
worse than it was".

Write the red test first: a fake CLI that emits a rate-limit envelope must
produce `classification: "quota-exhausted"` with `retryAfter` preserved
verbatim, and `plugins/helium/src/index.ts` must not report it as a plain
`error`.

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

### Task 2: Build the reusable execution-boundary conformance harness

**Files:**

- Create: `contracts/fixtures/senior-isolation/package.json`
- Create: `contracts/fixtures/senior-isolation/fake-claude.mjs`
- Create: `contracts/fixtures/senior-isolation/forbidden.txt`
- Create: `contracts/harness/execution-boundary.ts`
- Create: `contracts/tests/senior-isolation.contract.spec.ts`

**Scope note (sequencing).** This task delivers a _reusable_ harness, not a
one-off test for the senior lane. The formal `Executor` interface does not exist
until Phase 1 Task 10, so this contract must **not** be written generically over
`Executor` — that type is unavailable here. Write it generically over a minimal
local subject shape instead:

```ts
// contracts/harness/execution-boundary.ts
export interface ExecutionBoundarySubject {
  readonly name: string;
  /** What the subject claims about what its child inherits. */
  readonly declaredIsolationClass: "in-process" | "process" | "sandboxed";
  /** Run one probe prompt under the supplied restriction and environment. */
  invoke(input: {
    prompt: string;
    allowedTools: string[];
    mcpConfigPath?: string;
    expectedWorkspace: string;
    env: Record<string, string>;
  }): Promise<{ text?: string }>;
}

export function runExecutionBoundaryConformance(
  subject: ExecutionBoundarySubject,
): void; /* registers the shared describe/it block */
```

Task 10 adapts the P1 `Executor` to this same subject shape and inherits the
contract; it does not fork a second suite. The harness owns the assertions, each
subject owns only its `invoke`.

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

The harness asserts every proof field, and additionally that:

- an empty tool list stays empty rather than becoming the provider default;
- no undeclared MCP server, setting source, instruction file, or environment
  secret reaches the child;
- the child cannot read or write outside `expectedWorkspace`; and
- the subject's observed boundary is at least as strong as its
  `declaredIsolationClass` — a declaration the harness cannot demonstrate is a
  failure, not a warning.

The first registered subject is the real `runClaude()` adapter invoked with a
narrowed environment.

**Step 2: Run the contract and verify failure**

Run:

```bash
pnpm exec vitest run --project contracts contracts/tests/senior-isolation.contract.spec.ts
```

Expected: FAIL until Task 1's production path satisfies the same boundary.

**Step 3: Make the fixture exercise the production adapter**

Export only the minimal adapter entry needed by the harness subject. Do not
create a second test-only argument builder. The subject's `invoke` must call the
same function used by `buildSeniorLane()`.

**Step 4: Run the contract twice**

Run once with one allowed MCP tool and once with no tools:

```bash
pnpm exec vitest run --project contracts contracts/tests/senior-isolation.contract.spec.ts
```

Expected: both cases PASS.

**Step 5: Commit**

```bash
git add contracts/fixtures/senior-isolation contracts/harness/execution-boundary.ts contracts/tests/senior-isolation.contract.spec.ts plugins/helium/src/claude.ts
git commit -m "test: add reusable execution-boundary conformance harness"
```

### Task 3: Validate tool selections and make mutation policy truthful

**Files:**

- Modify: `packages/core/src/mcp/selection.ts`
- Modify: `packages/core/tests/mcp-selection.spec.ts`
- Modify: `packages/core/src/tools/types.ts`
- Modify: `plugins/helium/src/index.ts`
- Modify: `plugins/helium/src/index.test.ts`
- Modify: `plugins/helium/src/runtime.test.ts`

**Step 1: Replace the "silently drops" test with failing selection tests**

`packages/core/tests/mcp-selection.spec.ts` currently contains
`it("silently drops a HELIUM_TOOLS name that matches no known tool", ...)`,
which asserts `.not.toThrow()` and locks in exactly the behaviour this task
removes. That test is **replaced**, not extended: delete it and write the
fail-loud expectations in its place. Extending the file while leaving the old
case in would make the suite assert both behaviours at once and fail.

Add tests for unknown names and mutation mismatch. Use a genuinely mutating
tool: `thesis_write` is declared `mutating: false` by explicit design
(`packages/core/src/tools/thesis.ts`) and would never trip the mutation branch.
The real mutating tools are `argon_rescan` and `argon_ai_analysis`
(`packages/core/src/tools/argon.ts`, both registered with `mutating: true`).

```ts
expect(() => selected({ HELIUM_TOOLS: "argon_api,typo_tool" })).toThrow(
  /unknown tools: typo_tool/,
);

expect(() =>
  selected({
    HELIUM_TOOLS: "argon_rescan",
    HELIUM_ALLOW_MUTATIONS: "0",
  }),
).toThrow(/requires mutation permission/);

expect(() =>
  selected({
    HELIUM_TOOLS: "argon_ai_analysis",
    HELIUM_ALLOW_MUTATIONS: "0",
  }),
).toThrow(/requires mutation permission/);
```

Keep the existing positive cases (`HELIUM_ALLOW_MUTATIONS: "1"` admits
`argon_rescan`) unchanged — only the silent-drop assertions are inverted.

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
const forbidden = names.filter(
  (name) => byName.get(name)?.mutating && !allowMutations,
);
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
};
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
same ID and `sent`, `skipped`, `rate-capped`, `failed`, or `uncertain`. Count
rate limits from successful outcome rows, not intents. Preserve dead letters as
a third row tied to the same ID.

**State the property this buys, and do not overstate it.** SMTP acceptance
followed by a crash before the outcome append is genuinely indeterminate, so
this is **not** exactly-once delivery and must never be described as such. What
the state machine guarantees is: a durable write-ahead intent before any
external side effect; at most one active (unresolved) delivery intent per
`deliveryId` — this lane issues no lease object of its own, and neither
`ExecutionLease` nor `ActionLease` exists yet at P0; no
blind retry of an intent whose outcome is unknown; idempotent or
effectively-once completion where the transport supports a dedup key; and,
where it does not, a durable `uncertain` outcome that a human or a
reconciliation pass resolves. `uncertain` is a real terminal row, not a missing
one — the crash-point tests in Step 1 must assert it is written.

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

**Phase 0 exit evidence.** The `EvidenceManifest` _schema_ is a Phase 1 Task 7
deliverable, so P0 cannot produce one. P0's exit artifact is instead the **frozen
P0 EvidenceManifest template** recorded in the
[multi-agent master plan](2026-08-25-helium-multi-agent-master-plan.md)
("frozen P0 template"). It is hand-writable, requires no P1 code, and its field
list is fixed — fill it in, do not redesign it, and do not defer P0's exit
evidence to Phase 1.

For every deterministic assertion in that manifest, **the verifier is a command
plus its version plus the hash of its output — never a model, and never the
plan's author signing off as a second pretend human.** Record, per assertion,
the exact command, the tool version that ran it, and the hash of its output; a
reviewer must be able to re-run the command and compare hashes without
re-reading the plan. The solo operator authoring this phase is the author of the
record, not its verifier; the command is the verifier. Assertions that are not
deterministically checkable are recorded as `PARTIAL` with the missing proof
named — never as `PROVEN` on human assurance.

Every P0 exit assertion is deterministic (test-suite results, isolation
conformance output, delivery crash-matrix replay, per-tenant liveness exit
codes), so no P0 assertion needs a model verifier at all.

## Phase 1: model-blind core and provider contracts

### Task 6: Move v1 provider knowledge into a compatibility package

**Files:**

- Create: `packages/v1-compat/package.json`
- Create: `packages/v1-compat/tsconfig.json`
- Move: `packages/core/src/job.ts` -> `packages/v1-compat/src/job.ts`
- Move: `packages/core/tests/job.spec.ts` -> `packages/v1-compat/tests/job.spec.ts`
- Move: `packages/core/tests/macro-watch-job.spec.ts` -> `packages/v1-compat/tests/macro-watch-job.spec.ts`
- Move: `packages/core/src/tools/apex.ts` -> `packages/v1-compat/src/tools/apex.ts`
- Move: `packages/core/src/tools/argon.ts` -> `packages/v1-compat/src/tools/argon.ts`
- Move: `packages/core/src/tools/livewire.ts` -> `packages/v1-compat/src/tools/livewire.ts`
- Move: `packages/core/src/mcp/server.ts` -> `packages/v1-compat/src/mcp/server.ts`
- Move: `packages/core/tests/tools.spec.ts` -> `packages/v1-compat/tests/tools.spec.ts`
- Create: `packages/v1-compat/src/tools/index.ts`
- Modify: `packages/core/src/tools/index.ts`
- Modify: `packages/core/src/mcp/selection.ts`
- Modify: `packages/core/tests/mcp-selection.spec.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/v1-compat/src/index.ts`
- Modify: `plugins/helium/package.json`
- Modify: imports under `plugins/helium/src`
- Modify: `vitest.config.ts`

**Step 1: Add a failing core-neutrality test**

Create `contracts/tests/core-neutrality.contract.spec.ts` that scans every source
file under `packages/core/src` and fails on production provider or domain
vocabulary. The two word lists are **exported constants of that file**, and they
are the single definition — every other gate invokes this test rather than
restating a pattern of its own:

```ts
export const FORBIDDEN_PROVIDER_WORDS = [
  "deepseek",
  "claude",
  "anthropic",
  "codex",
  "openai",
  "gpt-",
  "gemini",
];

export const FORBIDDEN_DOMAIN_WORDS = [
  "livewire",
  "argon",
  "apex",
  "colima",
  "postgres",
];

for (const file of sourceFiles(coreSrc)) {
  const text = readFileSync(file, "utf8").toLowerCase();
  for (const word of [...FORBIDDEN_PROVIDER_WORDS, ...FORBIDDEN_DOMAIN_WORDS])
    expect(text, `${file}: ${word}`).not.toContain(word);
}
```

Bare `claude` is deliberate and is **not** a typo for `claude-max`. `claude-max`
is a v1 `job.ts` string literal that this very task removes from core, so a guard
keyed to it matches nothing under `packages/core/src` forever after — a
permanently-green assertion — while `claude-subscription`, `claude-sonnet-5`,
`runClaude`, and `claude -p` all walk straight past it. Bare `claude` is the only
token that catches every production spelling.

Beyond `job.ts`, which this task already moves, bare `claude` fails today on
exactly one line: `packages/core/src/mcp/server.ts:3`, a module doc comment
reading "a `claude -p` senior-lane child". That one line is the leak the narrower
list was hiding, and Step 3 rewords it. **Do not add a file or line allow-list**
— an allow-list is how `mcp/server.ts:3` survived four reviewers. The scan reads
whole files, comments included: do not exclude documentation comments and do not
exclude whole source files.

**Step 2: Run the contract and verify failure**

```bash
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: FAIL on `packages/core/src/job.ts` (`deepseek`, `claude`), on
`packages/core/src/mcp/server.ts` (`claude`), and on
`packages/core/src/tools/{apex,argon,livewire,index}.ts` and
`packages/core/src/mcp/selection.ts` (`apex`, `argon`, `livewire`).

**Step 3: Move the legacy surface without changing behavior**

Create `@helium/v1-compat`, move the parser/tests, and update plugin imports.
Keep the YAML and normalized `JobSpec` byte-for-byte compatible. Do not redesign
the job schema in this task.

Move the v1 provider-and-domain surface with it. `packages/core/src/mcp/server.ts`
is an MCP stdio transport and `packages/core/src/tools/{apex,argon,livewire}.ts`
are three domain modules; acceptance criterion 14 — component and SOP plugins can
be installed without adding domain names to core — bans all four from core, and
no task in any of the seven plans moved them, which made the criterion
unsatisfiable by any phase (review finding ARCH-8). No scan could see it either:
the neutrality lists checked `packages/core/src` but carried no domain tokens,
while the Ops lists carried domain tokens but were scoped to
`packages/core/src/operations`, a directory these files are not in.
`FORBIDDEN_DOMAIN_WORDS` is what makes the omission visible.

While `mcp/server.ts` is open, reword its module comment: line 3 today reads "a
`claude -p` senior-lane child", the single line bare `claude` fails on. Name the
lane, not the vendor — "the senior-lane child process" — and do not suppress the
match with an allow-list.

`packages/core/src/tools/types.ts` and `packages/core/src/mcp/selection.ts`
**stay** in core: the first is the generic `EcosystemTool` contract, the second
the generic mutation-then-name selection filter, and neither is a domain or
provider concept. Two consequential edits follow from the moves and are in scope
here. `buildTools()` — the aggregate that constructs all three domain toolkits —
moves to `packages/v1-compat/src/tools/index.ts`, leaving `tools/index.ts` in
core exporting only `types.ts` and the domain-free `thesis.ts`. And `selected()`
today reads `HELIUM_ARGON_BASE`, `HELIUM_APEX_BASE`, and `HELIUM_LIVEWIRE_DB` and
calls `buildTools()` itself, so those three env keys and that construction move
to the compatibility package and core's filter takes an injected tool list. The
filter's semantics do not change: mutation filter before name filter,
fail-closed, and the fail-loud unknown-name and mutation-mismatch validation
Phase 0 Task 3 added travel with it.

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

### Task 7: Define provider-neutral work, result, and evidence schemas

**Files:**

- Create: `packages/core/src/work.ts`
- Create: `packages/core/src/event-store.ts`
- Create: `packages/core/src/evidence/bundle.ts`
- Create: `packages/core/src/evidence/ledger.ts`
- Create: `packages/core/src/evidence/manifest.ts`
- Create: `packages/core/tests/work.spec.ts`
- Create: `packages/core/tests/event-store.spec.ts`
- Create: `packages/core/tests/evidence-bundle.spec.ts`
- Create: `packages/core/tests/evidence-ledger.spec.ts`
- Create: `packages/core/tests/evidence-manifest.spec.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing schema tests**

Cover valid work, forbidden keys, normalized failures, the typed execution
snapshot, and opaque runtime metadata:

```ts
const work = WorkOrderSchema.parse({
  id: "work-1",
  role: "evidence-verifier",
  taskClass: "research.verification",
  requires: ["verification.claims"],
  constraints: {
    tools: ["artifact_read"],
    mutations: "forbidden",
    minIsolationClass: "process",
    maxCost: 2,
    maxLatencyMs: 180_000,
  },
  inputs: { artifacts: ["artifact-1"] },
  acceptance: { outputSchema: "claim-set-v1" },
});
expect(work.role).toBe("evidence-verifier");
expect(() => WorkOrderSchema.parse({ ...raw, model: "anything" })).toThrow();

// v1 `requires` is a flat tag set evaluated as a hard filter. The graded form
// is deferred v2 (Task 9), so the strict schema must reject it rather than
// accept a shape nothing reads.
expect(() =>
  WorkOrderSchema.parse({
    ...raw,
    requires: { "verification.claims": { min: 0.8, weight: 1 } },
  }),
).toThrow();

// The execution snapshot is typed and required, not an untyped bag. A result
// without it, or with an unusable isolation class, must not parse (XDOC-2).
expect(() =>
  AgentResultSchema.parse({ ...completedResult, executionSnapshot: undefined }),
).toThrow();
expect(() =>
  AgentResultSchema.parse({
    ...completedResult,
    executionSnapshot: { ...snapshot, isolationClass: "sandboxed-ish" },
  }),
).toThrow();
expect(
  AgentResultSchema.parse(completedResult).executionSnapshot,
).toMatchObject({
  targetId: expect.any(String),
  providerId: expect.any(String),
  model: expect.any(String),
  providerVersion: expect.any(String),
  isolationClass: "process",
});

expect(() =>
  acceptEvidence({
    assertionClass: "capability",
    status: "PROVEN",
    rawEvidenceRefs: ["artifact://run/raw"],
    requiredStages: ["raw", "replay", "regression", "bounded-production"],
    replayRefs: [],
  }),
).toThrow(/missing required evidence stage: replay/);
```

Also reject an unknown evidence status, an omitted required stage without an
accepted `notApplicableReason`, expired proof, a missing artifact hash, and a
status promotion that has no new verifier decision.

The manifest rejection test validates against the **frozen P0 template's field
set**, not a shorter list of its own — this is review finding XDOC-12, where an
8-field test silently narrowed the master plan's 11-row requirement. Drive it
from the template's own claim fields so the two cannot drift: reject a manifest
claim missing any of the exact assertion, acceptance bound, assertion class,
evidence-policy version, raw artifact references with hashes, reproduction or
replay procedure, baseline/control snapshot, verifier identity + version +
decision, failure and bad-case categories, scope, status, remaining limitation,
or next unopened gate — plus sample count, latency, cost, and confidence when
the assertion class is `statistical`.

P1's schema **inherits** the frozen template recorded in the
[multi-agent master plan](2026-08-25-helium-multi-agent-master-plan.md): every
field survives with the same meaning, P1 may only add fields or tighten types,
and a hand-written P0 manifest must validate against this schema without being
rewritten. Add that round-trip as a test case — parse the template instance
from the master plan and assert it passes.

Cover the generic append-only event store in the same red pass: append and
read-back, the `fsync` boundary, a content hash per appended record, snapshot
plus its last-event ID and hash, recovery from a truncated final line, and
replay:

```ts
const store = openEventStore(dir, { schema: SomeRecordSchema });
store.append(first);
store.append(second);
expect(store.replay()).toEqual([first, second]);
expect(store.contentHash(first)).toBe(sha256(canonicalJson(first)));

store.snapshot();
store.append(third);
truncateFinalLine(store.logPath);
expect(store.replay()).toEqual([first, second]);
```

A truncated final line is dropped and the store recovers; it is never a fatal
read and never a repaired record. Also test an unsupported record version and a
snapshot whose hash does not match the log — in both cases the log is
authoritative and the snapshot is discarded, matching the discipline Task 13
later relies on.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts packages/core/tests/event-store.spec.ts packages/core/tests/evidence-bundle.spec.ts packages/core/tests/evidence-ledger.spec.ts packages/core/tests/evidence-manifest.spec.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement strict schemas**

Export:

```ts
export type FailureClass =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "budget-exhausted"
  | "quota-exhausted"
  | "capability-shortage"
  | "schema-invalid"
  | "tool-boundary-violation"
  | "provider-error"
  | "verification-failed";

export interface AgentResult {
  workId: string;
  outcome: "completed" | "failed";
  failure?: {
    class: FailureClass;
    safeDetail?: string;
    /** Opaque provider hint; only meaningful for `quota-exhausted`. */
    retryAfter?: string;
  };
  structured?: unknown;
  artifacts: string[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    ms: number;
  };
  /**
   * Provenance, recorded at the provider edge and stored as evidence.
   * Core never branches on any field here.
   */
  executionSnapshot: {
    /** Opaque target the selector resolved. */
    targetId: string;
    /** As executed, written by the provider adapter, never read by core logic. */
    providerId: string;
    model: string;
    effort?: string;
    providerVersion: string;
    /** The class actually demonstrated by the executor that ran this work. */
    isolationClass: "in-process" | "process" | "sandboxed";
    recordedAt: string;
  };
  runtimeMetadata: Record<string, unknown>;
}
```

Use strict Zod objects at every persistence and provider boundary. Keep provider
identity out of core **logic**.

`executionSnapshot` is the typed half of what `runtimeMetadata` used to carry
loosely; it is what satisfies the P1 exit requirement "exact execution
snapshot" and the program outcome "audit every decision back to an exact
execution snapshot". It closes review finding XDOC-2: without it, the P1 gate
was being met by an uninterpreted bag no schema constrained. Two rules keep it
from breaking rule 5:

- The **provider adapter** is the only writer. Core, teams, and the selector
  never read it to decide anything — no branch, no filter, no ranking. Its only
  consumers are the evidence ledger, the manifest, and replay.
- The neutrality guard bans provider and model **names in core source and
  branching logic**, not provider-supplied string values flowing through a
  typed audit field at runtime. `providerId`, `model`, and `effort` are opaque
  strings to core.

`runtimeMetadata` survives alongside it for provider-native audit data that has
no typed home; core persists it without interpreting it.

`quota-exhausted` is distinct from `budget-exhausted` and must stay distinct:
it is dynamic provider-availability state carrying an opaque `retryAfter`, not a
spent dollar or token allowance, and not a capability score. Phase 0 Task 1
already emits it from the Claude CLI wrapper; this schema is where the normalized
class lands, and the thin selector (Task 9) reads it as an availability input to
its hard filter.

Define the generic `EvidenceBundle` and append-only `EvidenceLedger` here so
both Ops Phase 2.5a and research Phase 3 use one contract. A bundle binds an
assertion to an assertion-class policy, raw artifact hashes, required proof
stages, verifier decision and version, freshness, execution snapshot, status,
and remaining limitations. The policy declares required stages; a factual
claim, capability evaluation, and incident recovery may specialize the generic
contract without redefining its status semantics.

Only `PLANNED`, `PARTIAL`, `PROVEN`, `FAILED`, and `BLOCKED` are valid. The
ledger validates completeness and freshness and records every new decision.
`AgentResult.outcome === "completed"` is never an evidence verdict.

`EvidenceManifest` is the phase/release index over one or more bundles. Its
field set is the frozen P0 template's field set — assertion and bound,
assertion class, evidence-policy version, immutable bundle and raw artifact
references with hashes, reproduction or replay procedure, baseline/control
snapshot, verifier identity/version/decision, statistical fields when
applicable, failure and bad-case categories, offline/shadow/drill/production
scope, current status, remaining limitation, and next unopened gate — with
types tightened but nothing dropped or renamed. Runtime manifests live under the owned
state/artifact root; reviewed promotion summaries link their hashes rather than
copying or rewriting raw evidence.

Define the **generic append-only event store** here too, in
`packages/core/src/event-store.ts`. It provides append, an `fsync` boundary, a
content hash per record, snapshot, truncated-line recovery, and replay over a
caller-supplied record schema. It lives in `packages/core/src/` and **not**
under `src/operations/`, because it is not an operations concept: Ops Task 5
(P2.5a) and MA Task 13 (P2) both consume it.

That shared consumption is why it is defined in P1 rather than in Task 13, where
it was first specified. The corrected execution order is
`P0 -> P1 -> P2.5a -> P2 -> P3`, which runs P2.5a **before** P2, so a P2.5a
consumer cannot depend on a P2 primitive — Ops Phase B would otherwise block on
the durable team kernel, the exact circularity XDOC-1 was raised to kill. The
primitive is not team-specific: the discipline it encodes is the same atomic
file and hash discipline existing state already uses. This follows the precedent
in the paragraph above, where `EvidenceBundle` and `EvidenceLedger` are defined
here so both Ops Phase 2.5a and research Phase 3 use one contract.

This is **new code, not a rename**. `packages/core/src/jsonl.ts` today does one
`appendFileSync` per record and has no fsync, no content hash, no snapshot, and
no replay; `packages/core/src/state.ts` has only tmp-write-then-rename. Task 13
then persists team streams through this module rather than shipping a second
implementation of it, and Ops Task 5 reuses the same one.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/work.spec.ts packages/core/tests/event-store.spec.ts packages/core/tests/evidence-bundle.spec.ts packages/core/tests/evidence-ledger.spec.ts packages/core/tests/evidence-manifest.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/work.ts packages/core/src/event-store.ts packages/core/src/evidence packages/core/tests/work.spec.ts packages/core/tests/event-store.spec.ts packages/core/tests/evidence-bundle.spec.ts packages/core/tests/evidence-ledger.spec.ts packages/core/src/index.ts
git commit -m "feat: define model-blind work and evidence contracts"
```

### Task 8: Define the opaque target registry and capability tags

**Files:**

- Create: `packages/core/src/capabilities.ts`
- Create: `packages/core/tests/capabilities.spec.ts`
- Modify: `packages/core/src/index.ts`

**Scope (thin selector v1).** This task ships the _seam_, not the scoring
machinery: an opaque target registry, flat capability tags, a declared isolation
class, and dynamic availability including quota. It does **not** ship graded
scores.

**Deferred v2 — pending real usage data.** The 31-leaf capability ontology,
per-capability scores, confidence intervals, evaluation suite/version and
`sampleCount` fields, and any automatic learning of capability values from
production trajectories are deferred. A session-capped subscription cannot
produce an `n` that makes a confidence interval mean anything; the number would
launder a guess. Provider-native effort levels are not part of this catalog
either — they live in the provider catalog described by the
provider-effort-selection design and implementation plans. Do not add any of
these fields "so they are ready"; an unused numeric field is exactly what a
later reader mistakes for a measurement.

**Step 1: Write failing catalog tests**

```ts
const catalog = new CapabilityCatalog();
catalog.register({
  targetId: ExecutionTargetId("target-a"),
  capabilities: ["writing.executive", "evidence.synthesis"],
  isolationClass: "process",
  operations: { maxLatencyMs: 180_000 },
  supports: { structuredOutput: true, toolIsolation: true, mutations: false },
});
expect(catalog.list()).toHaveLength(1);
expect(() => catalog.register(sameTargetAgain)).toThrow(/duplicate target/);
```

Also reject a duplicate capability tag, an unknown `isolationClass`, a profile
with no capability tags at all, and any registration carrying a `score`,
`confidence`, or `sampleCount` field — the schema is strict, and a v2 field
arriving early must fail loud rather than be silently ignored.

Availability is dynamic and separate from the registered profile:

```ts
catalog.setAvailability(ExecutionTargetId("target-a"), {
  state: "quota-exhausted",
  retryAfter: "2026-08-25T01:00:00.000Z",
});
expect(catalog.available(ExecutionTargetId("target-a"), now)).toBe(false);
```

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/capabilities.spec.ts
```

Expected: FAIL because the catalog does not exist.

**Step 3: Implement catalog registration**

The catalog stores opaque `ExecutionTargetId` values, their capability tag sets,
their declared `isolationClass`, their supported hard constraints, and their
current availability state. It must not expose a provider/model field.
Provider-specific details remain in the executor registry and audit metadata.

`isolationClass` is a claim the catalog records; the execution-boundary
conformance harness from Phase 0 Task 2 is what proves it (Task 10 wires the
two together). A registered target whose class is unproven is not eligible for
work that requires that class.

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
git commit -m "feat: add opaque target registry with capability tags"
```

### Task 9: Implement the thin deterministic selector

**Files:**

- Create: `packages/core/src/router.ts`
- Create: `packages/core/tests/router.spec.ts`
- Modify: `packages/core/src/index.ts`

**Scope (thin selector v1).** The selector is a hard filter followed by a
configured preference and an ordered fallback. Nothing is scored:

```text
WorkOrder capability requirements
  -> isolation / tools / quota / availability hard filter
  -> configured opaque target preference
  -> ordered fallback
  -> ExecutionLease
```

**Deferred v2 — pending real usage data.** Weighted capability scoring,
evaluation confidence as a routing input, cost/latency/reliability weighting,
bounded preference _boosts_ that reorder eligible targets, learned tie-breaks,
and the effort-evaluation harness are all deferred. The preference in v1 is a
lookup, not a weight: it either survives the hard filter or the fallback list
advances. Budget is charged on completion from the ledger — do **not** reserve
budget inside selection.

The seam that must survive is the model-blind one: WorkOrder capability
requirements in, opaque `ExecutionTargetId` out, no provider or model name at
any step. Scoring can be added behind that seam later without changing the
WorkOrder or lease contract.

**Step 1: Write failing selector tests**

Test the hard filter (missing capability tag, insufficient `isolationClass`,
tool/mutation policy, context and latency bounds, `quota-exhausted`
availability), preference resolution, ordered fallback, and shortage:

```ts
const decision = select(workOrder, policy, catalog.snapshot(now));
expect(decision.selected).toBe(ExecutionTargetId("target-b"));
expect(decision.candidates).toEqual([
  expect.objectContaining({ targetId: "target-b", eligible: true }),
  expect.objectContaining({
    targetId: "target-a",
    eligible: false,
    reasons: ["tool-isolation"],
  }),
]);
```

Add these cases specifically:

- the configured preference is filtered out by `isolationClass`, and the
  decision records the fallback position that produced the selection;
- the preferred target is `quota-exhausted` with a future `retryAfter`, the
  fallback is chosen, and the same call after `retryAfter` chooses the
  preference again;
- a preference can never re-admit a target a hard filter excluded — there is no
  boost that outranks a hard requirement;
- an empty surviving set yields `capability-shortage` with per-target exclusion
  reasons, and never a relaxed requirement.

**Step 2: Run the test and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/router.spec.ts
```

Expected: FAIL because `select()` does not exist.

**Step 3: Implement the pure selector**

Keep the function deterministic and side-effect free:

```ts
export interface SelectionDecision {
  selected?: ExecutionTargetId;
  candidates: CandidateDecision[];
  /** Index into the configured fallback list; 0 means the preference won. */
  fallbackPosition?: number;
  failure?: { class: "capability-shortage"; reasons: string[] };
  policyVersion: string;
  catalogVersion: string;
}
```

Filter hard requirements first, then take the configured per-role preference
from the survivors, then walk the ordered fallback list. Break ties by stable
target ID (with no scoring there are few ties left). Do not place runtime
availability polling in this pure function; pass an availability snapshot —
including quota state and `retryAfter` — as catalog input.

**Step 4: Run tests and repeat for determinism**

```bash
pnpm exec vitest run --project unit packages/core/tests/router.spec.ts --repeat=20
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: every repeat chooses the same target and emits the same decision.

**Step 5: Commit**

```bash
git add packages/core/src/router.ts packages/core/tests/router.spec.ts packages/core/src/index.ts
git commit -m "feat: select execution targets by capability hard filter"
```

### Task 10: Add executor leases and a fake executor

**Files:**

- Create: `packages/core/src/execution.ts`
- Create: `packages/core/tests/execution.spec.ts`
- Create: `plugins/helium/src/executor-registry.ts`
- Create: `plugins/helium/src/executor-registry.test.ts`
- Create: `packages/fake-metered/package.json`
- Create: `packages/fake-metered/src/index.ts`
- Create: `packages/fake-flat-rate/package.json`
- Create: `packages/fake-flat-rate/src/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `plugins/helium/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing lease and registry tests**

```ts
const lease = leases.issue({
  targetId: ExecutionTargetId("fake-a"),
  workId: "work-1",
  reservedCost: 1.5,
  expiresAt: "2026-08-25T00:05:00.000Z",
});
expect(() => leases.consume(lease.id, "different-work")).toThrow(
  /work mismatch/,
);
expect(leases.consume(lease.id, "work-1")).toEqual(lease);
expect(() => leases.consume(lease.id, "work-1")).toThrow(/already consumed/);
```

Test duplicate executor registration, missing target, disposal, timeout,
normalized result, and opaque runtime metadata persistence. Additionally test
that the registry refuses an executor whose `isolationClass` has no passing
conformance record, and that a lease for a work order requiring a stronger class
than the resolved executor declares is rejected before `run()` is called.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/execution.spec.ts plugins/helium/src/executor-registry.test.ts
```

Expected: FAIL because the lease store and registry do not exist.

**Step 3: Implement the boundary**

Core exports the model-blind interface. This is where the formal `Executor` type
first exists; it **inherits** the execution-boundary contract that Phase 0 Task 2
already shipped as a harness, and does not redefine it:

```ts
export type IsolationClass = "in-process" | "process" | "sandboxed";

export interface Executor {
  readonly targetId: ExecutionTargetId;
  /** What this executor's child actually inherits; proven, not asserted. */
  readonly isolationClass: IsolationClass;
  run(work: WorkOrder, signal: AbortSignal): Promise<AgentResult>;
  drain(): Promise<void>;
}
```

Provide the adapter that presents an `Executor` as the P0 harness's
`ExecutionBoundarySubject`, and run
`runExecutionBoundaryConformance()` over every registered executor — the same
suite, whatever the class. The suite is the admission gate: an executor that
declares `sandboxed` but demonstrates only `in-process` fails registration
rather than downgrading silently.

The plugin registry owns concrete executors and is the only place a concrete
execution mechanism appears. Lease consumption is atomic in process and
append-audited by its caller.

Register **exactly two fakes, as workspace packages**, differing on **both**
axes — isolation class and billing model:

- `@helium/fake-metered` — `isolationClass: "process"`, token-priced. Reports
  `usage.tokens` and `usage.cost`; may terminate `budget-exhausted`; **must
  never** emit `quota-exhausted`.
- `@helium/fake-flat-rate` — `isolationClass: "in-process"`,
  flat-rate-with-session-quota. Reports **no** cost and **no** tokens — the
  fields are **absent, not zero**; may terminate `quota-exhausted` with an
  opaque `retryAfter`; **must never** emit `budget-exhausted`.

Both axes are load-bearing, and one fake cannot hold both sets of invariants at
once. Splitting only on isolation class leaves the `budget-exhausted` /
`quota-exhausted` distinction the design establishes with no test that can break
it. The concrete regression that permits: core normalizes one exhaustion state
into the other, or defaults a missing cost to `0` and treats it as a known zero,
and the suite stays green.

They are workspace **packages** rather than in-tree modules because the Phase 1
exit gate in the
[multi-agent master plan](2026-08-25-helium-multi-agent-master-plan.md) proves
install and removal without a core edit: `pnpm remove` then `pnpm add` each
package, requiring every command to exit 0 **and**
`git diff --name-only -- packages/core plugins/helium` to print nothing. An
in-tree `plugins/helium/src/testing/fake-executor.ts` cannot be installed or
removed, so it cannot make that gate falsifiable.

Add these assertions:

- the ledger charges a completed `@helium/fake-flat-rate` run whose cost is
  absent, without throwing and without recording `0` as a known cost;
- a `@helium/fake-flat-rate` target in `quota-exhausted` is excluded by the hard
  filter for the duration of `retryAfter`, and the selector falls through in
  configured order to `@helium/fake-metered` rather than failing the work order;
- neither exhaustion state is ever normalized into the other, in either
  direction; and
- a WorkOrder requiring `isolationClass: "process"` never resolves to
  `@helium/fake-flat-rate`.

**Step 4: Run tests and typecheck**

```bash
pnpm exec vitest run --project unit packages/core/tests/execution.spec.ts plugins/helium/src/executor-registry.test.ts
pnpm exec vitest run --project contracts contracts/tests/senior-isolation.contract.spec.ts
pnpm typecheck
```

Expected: PASS, including the P0 harness re-run through the `Executor` adapter.

**Step 5: Commit**

```bash
git add packages/core/src/execution.ts packages/core/tests/execution.spec.ts packages/core/src/index.ts plugins/helium/src/executor-registry.ts plugins/helium/src/executor-registry.test.ts packages/fake-metered packages/fake-flat-rate pnpm-lock.yaml
git commit -m "feat: add opaque executor leases and isolation classes"
```

### Task 10b: Add the structural topology guard

**Files:**

- Create: `contracts/tests/topology-structure.contract.spec.ts`
- Modify: `packages/core/src/index.ts`

**Scope note (scheduling).** This is the **static** half of the design §5.5 edge
rule — "no sensor can bypass the controller to call a provider" — and of
acceptance criterion 15. It is scheduled here rather than in Phase 3 because
both of its assertions are decidable from types and the import graph: it needs
no task DAG, no evidence ledger, and no team controller, none of which exist at
P1. The corrected execution order is `P0 -> P1 -> P2.5a -> P2 -> P3`, and P2.5a
runs Ops Task 10, which creates the collector and every probe — that is every
sensor in the program. A guard that first appears in Phase 3 Task 19 would be
written two phases after its own subjects, and the Ops adversarial matrix is not
a substitute: it has no sensor-to-executor case. The **behavioral** half, which
does need an advancing DAG and an accepted-claim ledger, stays in Task 19.

**Step 1: Write the failing structural contract**

Assert the type-level exclusion first. Core exports the sensor context type a
sensor is handed, and the contract asserts as a **compile-time** exclusion that
it carries no executor, provider, lease, or run member — so adding one breaks
`pnpm typecheck` rather than only a runtime expectation:

```ts
type ForbiddenSensorMember =
  | "executor"
  | "executors"
  | "registry"
  | "provider"
  | "providers"
  | "lease"
  | "leases"
  | "run";

// Resolves to `never` only while SensorContext exposes none of them.
type SensorContextIsNeutral = Extract<
  keyof SensorContext,
  ForbiddenSensorMember
>;
const _sensorContextIsNeutral: [SensorContextIsNeutral] extends [never]
  ? true
  : never = true;
```

Then assert the import-graph lint. Walk static imports transitively from every
module under `packages/core/src/sensors` and `plugins/ops-agent/src` — the
collector and every probe — and fail on transitive reachability of the executor
registry, any `Executor` implementation, or a provider adapter:

```ts
const reachable = transitiveStaticImports([
  "packages/core/src/sensors",
  "plugins/ops-agent/src",
]);
expect(reachable).not.toContain("plugins/helium/src/executor-registry.ts");
expect(reachable.filter(isExecutorImplementation)).toEqual([]);
expect(reachable.filter(isProviderAdapter)).toEqual([]);
```

Declare both roots explicitly rather than globbing for them: at P1
`packages/core/src/sensors` does not exist yet and `plugins/ops-agent/src`
arrives with Ops Task 7 in P2.5a. The lint must therefore report a declared root
it could not enumerate instead of walking an empty set and passing — a guard
that goes green because it found nothing to check is the failure mode this task
exists to prevent.

**Step 2: Run the contract and verify failure**

```bash
pnpm exec vitest run --project contracts contracts/tests/topology-structure.contract.spec.ts
pnpm typecheck
```

Expected: FAIL because core exports no sensor context type and the lint has no
root it can enumerate.

**Step 3: Export a neutral sensor context**

Export from `packages/core/src/index.ts` the context type a sensor receives: the
event or observation it is normalizing, its freshness bound, its clock, and its
append-only sink. Nothing else. An executor, a registry handle, a lease, a run,
or a provider adapter reaching a sensor is what the type-level exclusion refuses,
and the sensor's fail-closed state stays `unknown` — never a model call.

The import-graph lint needs no production code; it needs a root it can walk.
Point it at the roots above and record, in the test itself, which roots existed
at the run. Ops Task 10 Step 4 is where the collector and the probes are
required to pass this contract, and Phase 3 Task 19's behavioral suite layers on
top of it without weakening it.

**Step 4: Run the contract and the typecheck**

```bash
pnpm exec vitest run --project contracts contracts/tests/topology-structure.contract.spec.ts
pnpm typecheck
```

Expected: PASS, and adding an executor, provider, lease, or run member to the
sensor context breaks `pnpm typecheck` rather than only this suite.

**Step 5: Commit**

```bash
git add contracts/tests/topology-structure.contract.spec.ts packages/core/src/index.ts
git commit -m "test: guard the sensor-to-executor topology edge statically"
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
  triage: {
    taskClass: "legacy.triage",
    constraints: { mutations: "forbidden" },
  },
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
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
git diff --check
```

The gate runs the contract test rather than an inline `rg` pattern of its own.
The gate and the contract test must never carry two vocabularies: the contract
test's exported `FORBIDDEN_PROVIDER_WORDS` and `FORBIDDEN_DOMAIN_WORDS` are the
single definition, and a gate that restates a pattern is a second list that
drifts — five disagreeing lists across the plan set is how
`packages/core/src/mcp/server.ts:3` stayed green.

Expected: all test commands pass and the neutrality contract reports no matches.
The gate's "exact execution snapshot" requirement is satisfied by the typed
`AgentResult.executionSnapshot` from Task 7 — every recorded run must carry a
parsed snapshot, not an uninterpreted `runtimeMetadata` entry — and the
neutrality search must still return no matches, which is the proof that the
snapshot is written and read as evidence and never as a branch condition. Open
separate PRs for the compatibility move and new contracts if review size would
otherwise exceed one coherent change.

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
  {
    type: "case/opened",
    caseId: "case-1",
    eventId: "e1",
    at,
    subject: "macro",
  },
  {
    type: "team/started",
    caseId: "case-1",
    teamRunId: "team-1",
    eventId: "e2",
    at,
  },
  {
    type: "agent/rostered",
    teamRunId: "team-1",
    agentId: "lead",
    role: leadRole,
    eventId: "e3",
    at,
  },
];
expect(reduceTeam(events)).toMatchObject({
  cases: { "case-1": { state: "open" } },
  teams: {
    "team-1": { state: "running", roster: { lead: expect.anything() } },
  },
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

Store one team stream per UTC day or case partition **on top of the generic
append-only event store from Task 7**: append, the fsync boundary, the content
hash, snapshot, truncated-line recovery, and replay all come from that module,
and this task adds only the team-specific partitioning and projection. Do not
re-implement the primitive here. Append the event before mutating the in-memory
projection. Snapshot only a projection plus last event ID/hash; the event log
remains authoritative.

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

### Task 14: Add the CAS task DAG and artifact handoff

**Files:**

- Create: `packages/core/src/team/tasks.ts`
- Create: `packages/core/src/team/artifacts.ts`
- Create: `packages/core/tests/team-tasks.spec.ts`
- Create: `packages/core/tests/team-artifacts.spec.ts`
- Modify: `packages/core/src/team/events.ts`
- Modify: `packages/core/src/team/reducer.ts`

**Scope — the general mailbox is deferred.** No task in either reference team
graph sends a sibling an ad-hoc message: every real handoff is a DAG dependency
edge plus an immutable artifact reference, and that pair _is_ the message.
Building a second queue-then-acknowledge delivery system alongside the DAG adds
redelivery and duplicate-ack semantics (which contradicted each other as
written) for a channel nothing uses. Do not create
`packages/core/src/team/mailbox.ts` in this task.

In scope and unchanged: the durable task DAG with CAS revisions, isolated agent
identities, and immutable artifact handoff. Also in scope elsewhere in the plan
and unaffected by this deferral: the claim comparator and the independent
verifier (Task 17).

**Deferred v2:** the structured message envelope
(`message_id, case_id, team_run_id, sender, target, type, task_id,
artifact_refs, payload_schema, created_at, acknowledged_at`) and its
queue-then-acknowledge delivery, revisited only if a real sibling-to-sibling
message appears. If it is ever built, its restart property is write-ahead plus
at-most-one active lease plus no blind retry — not exactly-once delivery.

**Step 1: Write failing task and artifact tests**

Cover cycle rejection, stale revision, ownership conflict, lease expiry, and
artifact handoff across a dependency edge:

```ts
expect(() => graph.add({ id: "b", dependsOn: ["c"] }, revision)).toThrow(
  /cycle/,
);
expect(() => graph.update("task-1", staleRevision, patch)).toThrow(
  /stale revision/,
);

artifacts.publish({ taskId: "task-1", ref: "artifact://a", hash });
expect(() =>
  artifacts.publish({ taskId: "task-1", ref: "artifact://a", hash: other }),
).toThrow(/immutable artifact/);
expect(graph.inputsFor("task-2")).toEqual(["artifact://a"]);
```

The last assertion is the deferral's load-bearing case: a downstream task
receives its predecessor's output through the dependency edge, with no message
delivered and no acknowledgement recorded.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-tasks.spec.ts packages/core/tests/team-artifacts.spec.ts
```

Expected: FAIL because the modules do not exist.

**Step 3: Implement event-backed task and artifact operations**

All accepted operations append an event and then update the projection. Task
state is one of `pending`, `ready`, `leased`, `running`, `needs-input`,
`completed`, `failed`, or `cancelled`. Artifacts are content-addressed and
immutable: republishing a ref with a different hash fails loud, and a task may
only read artifact refs reachable through its own dependency edges.

**Step 4: Run task, artifact, and replay tests**

```bash
pnpm exec vitest run --project unit packages/core/tests/team-tasks.spec.ts packages/core/tests/team-artifacts.spec.ts packages/core/tests/team-store.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/team/tasks.ts packages/core/src/team/artifacts.ts packages/core/src/team/events.ts packages/core/src/team/reducer.ts packages/core/tests/team-tasks.spec.ts packages/core/tests/team-artifacts.spec.ts
git commit -m "feat: add durable task DAG and artifact handoff"
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
expect(() =>
  budget.reserve({ caseId, agentId, tokens: 1, cost: 0.01 }),
).toThrow(/case budget exhausted/);

const recovered = reconcile(replay(logWithRunningLease), now);
expect(recovered.events).toContainEqual(
  expect.objectContaining({
    type: "task/interrupted",
    payload: expect.objectContaining({ reason: "startup-recovery" }),
  }),
);
```

Build a table-driven crash matrix for task assignment, executor start, artifact
publication, cancellation, and delivery intent. (There is no message-acceptance
cell: the general mailbox is deferred — Task 14.)

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

State the guarantee precisely and do not inflate it. This buys: write-ahead
intent before every external side effect; at-most-one active lease per unit of
work; no blind retry of an intent whose outcome is unknown; idempotent or
effectively-once completion where the target supports it; and a durable
crash-reconcilable `uncertain` outcome where it does not. It does **not** buy
exactly-once mutation, and no test, gate, or report may claim that it does — an
arbitrary external script cannot be made exactly-once, and a success followed by
a crash before the outcome append is genuinely indeterminate.

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

### Task 16: Register provider executors behind the DSH lifecycle seam

**Files:**

- Modify: `plugins/helium/package.json`
- Modify: `plugins/helium/src/index.ts`
- Create: `plugins/helium/src/dsh-team-host.ts`
- Create: `plugins/helium/src/dsh-team-host.test.ts`
- Create: `plugins/helium/src/executors/dsh-in-process.ts`
- Create: `plugins/helium/src/executors/dsh-in-process.test.ts`
- Create: `plugins/helium/src/executors/out-of-process-cli.ts`
- Create: `plugins/helium/src/executors/out-of-process-cli.test.ts`
- Create: `contracts/fixtures/team-host/package.json`
- Create: `contracts/fixtures/team-host/cordis.patch.yml`
- Create: `contracts/fixtures/team-host/src/index.ts`
- Create: `contracts/tests/team-host.contract.spec.ts`
- Modify: `pnpm-lock.yaml`

**Correction from the previous revision.** This task previously hardcoded
`"spawn"` as _the_ execution path for every target. That is wrong twice over:
it makes one low-isolation mechanism the universal default, and it cannot reach
a Claude or Codex subscription target at all. Execution targets resolve through
the **provider-executor registry** (Task 10); the DSH in-process driver is one
member of that registry, not the mechanism behind it.

**Grounding (verified against the pinned `0.1.1-rc.2` packages in
`node_modules/.pnpm/`).**

- `@deepseek-ai/dsh-subagent` README line 5: "The subagent seam lets one agent
  delegate work to a child through a named provider. Callers use one service API
  (`ctx.subagents`); providers decide whether the child runs in this process, in
  another process, or through a future transport." Line 7 adds: "Multiple named
  providers may coexist behind that contract."
- `@deepseek-ai/dsh-subagent-in-process-driver` README line 19: "The child gets
  the parent's working-directory/session lineage and inherits the parent
  provider, model, and output-token cap unless `request.agentOptions` overrides
  them."

So the DSH **seam** is provider-decided and keeps its value; the DSH
**in-process driver** is one low-isolation implementation of it, whose child
inherits parent provider, model, and working directory. Those inherited
properties are exactly what a low `isolationClass` records, and they are also
why an in-process child cannot reach a distinct subscription entitlement:
it resolves to the DSH-configured model by construction.

**Contract for this task:**

1. Keep the DSH lifecycle seam — start, follow-up, interrupt, list, drain, cold
   resume. Helium does not build a second model loop.
2. Every provider executor declares an `isolationClass` and passes the **same**
   execution-boundary conformance suite from Phase 0 Task 2. One suite, every
   class, no exemptions.
3. `dsh-in-process.ts` registers the DSH in-process driver as a
   **low-isolation** executor (`isolationClass: "in-process"`), documenting the
   inheritance quoted above as its declared, harness-proven boundary.
4. `out-of-process-cli.ts` registers a **dedicated out-of-process executor**
   for Claude and Codex subscription targets, with its own process tree,
   environment, workspace, and settings boundary — reusing the Phase 0 Task 1
   isolation work rather than re-deriving it.
5. An in-process target only receives work whose WorkOrder tolerates its
   isolation class. A WorkOrder requiring `process` or `sandboxed` never reaches
   the in-process executor, and the selector's hard filter (Task 9) is what
   enforces that — the executor is not asked to police its own eligibility.

**Step 1: Write the structural host and registry tests**

The deterministic controller needs a durable DSH parent identity without asking
that parent model to control scheduling. Test that the host creates one parent
`Agent`, resolves the executor **from the registry using the lease's target**,
passes persona/tool/depth constraints, awaits the result, and always disposes:

```ts
const result = await host.run(work, lease, signal);
expect(registry.resolve).toHaveBeenCalledWith(lease.targetId);
expect(resolvedExecutor.isolationClass).toBe("in-process");
expect(fakeSubagents.start).toHaveBeenCalledWith(
  resolvedExecutor.providerName, // the registered DSH provider, resolved — never a literal
  expect.objectContaining({
    parent: host.parentAgent,
    maxDepth: 1,
    toolFilter: { allow: ["artifact_read"] },
    outputSchema: expect.any(Object),
  }),
);
expect(fakeRun.dispose).toHaveBeenCalledOnce();
```

Add these cases:

- a lease whose target resolves to the out-of-process executor never calls
  `ctx.subagents.start()` at all;
- a WorkOrder requiring `isolationClass: "process"` cannot be executed by the
  in-process executor — the attempt fails closed with
  `tool-boundary-violation`, it does not silently downgrade;
- both executors run the Phase 0 conformance harness and pass it, each against
  its own declared class.

**Step 2: Run the tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/dsh-team-host.test.ts plugins/helium/src/executors
```

Expected: FAIL because the host and the executors do not exist.

**Step 3: Implement against the published DSH seam**

Pin `@deepseek-ai/dsh-subagent` to `0.1.1-rc.2`. Add `subagents` to Cordis
injection. Create one host Agent per `TeamRun`, with its own durable session and
owned workspace.

For the in-process executor, call `ctx.subagents.start()` with the **registered
provider name resolved from the registry** — never a hardcoded string literal —
plus an `AbortSignal`, structured output schema, explicit depth cap, tool
restriction, and persona. Map `SubagentResult.stopReason` into `AgentResult`,
including `quota-exhausted` with its `retryAfter` where the provider reports
one. Dispose in `finally` and drain descendants when the team stops.

For the out-of-process executor, spawn a detached process group with its own
environment, workspace, and settings boundary, and reuse the Phase 0 Task 1
termination discipline (TERM then KILL to the group). It declares
`isolationClass: "process"` and must demonstrate it under the harness.

Do not use DSH workflow as the durable controller; its current run does not own
Helium's task DAG, budget, or restart contract.

**Step 4: Add a real non-live DSH contract**

The fixture boots a DSH profile with a fake in-process provider. It starts two
sibling children, cancels one, lets one complete, drains the parent, and writes
a proof record. No live model or credential is used.

Register a second fake executor with a _different_ isolation class in the same
fixture, so the contract proves the registry actually dispatches on the resolved
target rather than always taking the in-process path.

Run:

```bash
pnpm exec vitest run --project contracts contracts/tests/team-host.contract.spec.ts contracts/tests/senior-isolation.contract.spec.ts
```

Expected: PASS; the completed sibling is unaffected, the cancelled sibling is
settled, no child remains after drain, and both registered executors pass the
shared execution-boundary conformance suite at their declared class.

**Step 5: Commit**

```bash
git add plugins/helium/package.json plugins/helium/src/index.ts plugins/helium/src/dsh-team-host.ts plugins/helium/src/dsh-team-host.test.ts plugins/helium/src/executors contracts/fixtures/team-host contracts/tests/team-host.contract.spec.ts pnpm-lock.yaml
git commit -m "feat: dispatch team work through the provider-executor registry"
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
replay converges, at most one active lease exists per unit of work and every
other lease is terminal or ready, every published artifact remains immutable and
reachable only through its dependency edges, every intent whose outcome is
unknown is recorded `uncertain` rather than retried, and the process table
contains no child from the test. Exactly-once is not asserted anywhere in this
gate.

Also expected: every executor registered by Task 16 passes the shared
execution-boundary conformance suite at its declared `isolationClass`, and no
work order requiring a stronger class than its resolved executor declares was
executed.

## Phase 2.5a: operations safety substrate and Ops reference team

Execute the separate
[Helium Ops Agent Implementation Plan](2026-08-25-helium-ops-agent-implementation.md).
Its core observation, incident, SOP, action, lease, verification, attribution,
and admission contracts must land before any automatic recovery is enabled.

P2.5a is only the part of that plan with no dependency on the team controller:
its Phases A-D (Tasks 1-12, 13a, 14, 16, 17, 18). Its Phase E (Tasks 13b and 15)
is **P3.5** and runs after Phase 3 Task 19 creates
`plugins/helium/src/team-controller.ts` and Task 18 delivers the team manifest
parser. Scheduling the whole Ops plan inside one pre-Phase-3 block was the
circular dependency recorded as XDOC-1; do not restore it.

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
- Create: `packages/core/tests/accepted-claim-ledger.spec.ts`
- Modify: `packages/core/src/evidence/ledger.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write failing evidence and claim tests**

```ts
const comparison = compareClaimSets(primary, reviewer);
expect(comparison.contradictions).toEqual([
  expect.objectContaining({
    key: "policy.rate_path",
    requiresVerification: true,
  }),
]);
expect(comparison.uniqueEvidence).toContainEqual(
  expect.objectContaining({ sourceRef: "artifact://source/new" }),
);

expect(() => acceptedClaims.publish(rendererResult)).toThrow(
  /renderer cannot add or promote claims/,
);
```

Test same conclusion with different evidence, direct contradiction, missing
provenance, stale evidence, subjective judgment, and three-agent false
consensus using the same bad source. Also test that:

- an expired or incomplete claim bundle cannot enter the accepted claim view;
- a renderer cannot add, remove, or promote a claim;
- a `PARTIAL` claim remains labelled when delivery policy permits it; and
- replay preserves artifact hashes, verifier version, execution snapshot, and
  remaining limitations.

**Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run --project unit packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts packages/core/tests/accepted-claim-ledger.spec.ts
```

Expected: FAIL because the claim comparison and adjudication modules do not
exist.

**Step 3: Implement normalized claims and adjudication**

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

Specialize the Phase 1 evidence policy for factual claims, inferences, and
judgments. The accepted claim view is derived from the generic append-only
ledger. It validates claim-specific completeness and freshness and rejects a
status promotion without a new evidence decision. `AgentResult.outcome` is
never an evidence verdict.

**Step 4: Run tests and neutrality contract**

```bash
pnpm exec vitest run --project unit packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts packages/core/tests/accepted-claim-ledger.spec.ts
pnpm exec vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/evidence packages/core/tests/claims.spec.ts packages/core/tests/claim-compare.spec.ts packages/core/tests/accepted-claim-ledger.spec.ts packages/core/src/index.ts
git commit -m "feat: adjudicate agent claims through evidence"
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
expect(() =>
  parseTeamYaml(`
name: bad
roles:
  writer:
    model: forbidden
`),
).toThrow(/unrecognized key.*model/);
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
- Create: `contracts/tests/topology-boundary.contract.spec.ts`
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
  expect.objectContaining({
    headers: expect.objectContaining({ "x-helium-path": "shadow" }),
  }),
);
expect(mutationTools.calls).toHaveLength(0);
```

Test capability shortage, one failed evidence role, contradiction requiring a
verifier, cancellation, and restart between every DAG layer. Add the
**behavioral** half of the topology guard, which is the half that needs an
advancing DAG and an accepted-claim ledger: a provider result cannot advance the
DAG before schema and evidence checks, and delivery cannot read an unaccepted
claim or bypass write-ahead intent.

The sensor-cannot-reach-an-executor edge is **not** re-derived here. It is
already held statically by Task 10b's
`contracts/tests/topology-structure.contract.spec.ts` — a compile-time exclusion
on the sensor context type plus an import-graph lint — which has been in force
since Phase 1, two phases before P2.5a wrote the collector and the probes. This
suite layers runtime behaviour on top of that guard and must not weaken it:
never relax, re-scope, or re-implement the structural assertion here, and never
let a runtime expectation stand in for the compile-time one.

**Step 2: Run the focused tests and verify failure**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.test.ts
```

Expected: FAIL because the controller and shadow adapter do not exist.

**Step 3: Implement the deterministic controller**

The controller:

1. opens or updates a case;
2. instantiates the task DAG;
3. selects a target for ready work through the thin selector (Task 9);
4. issues a lease (budget is charged on completion from the ledger, not
   reserved here);
5. executes through the provider-executor registry, which dispatches on the
   resolved target's isolation class;
6. validates and publishes immutable artifacts, which are also the handoff
   channel to dependent tasks;
7. compares claims and creates verification tasks;
8. advances dependent tasks;
9. renders only after adjudication; and
10. records a terminal shadow result without production delivery.

Add `teamShadowEnabled` and `teamsDir` configuration. Default shadow to false.
No configuration accepts a provider or model name.

**Step 4: Run fake-executor end-to-end tests**

```bash
pnpm exec vitest run --project unit plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.test.ts
pnpm exec vitest run --project contracts contracts/tests/topology-structure.contract.spec.ts contracts/tests/topology-boundary.contract.spec.ts
pnpm test:e2e-local
```

Expected: PASS; enabling shadow adds records but does not change v1 reports or
email. The event log must demonstrate the canonical sequence from `CaseEvent`
through lease, agent result, accepted evidence decision, and terminal shadow
outcome; no shortcut edge is accepted.

**Step 5: Commit**

```bash
git add plugins/helium/src/team-controller.ts plugins/helium/src/team-controller.test.ts plugins/helium/src/shadow.ts plugins/helium/src/shadow.test.ts plugins/helium/src/runtime.ts plugins/helium/src/config.ts plugins/helium/src/index.ts contracts/tests/topology-boundary.contract.spec.ts profile/cordis.patch.yml plugins/helium/cordis.patch.yml
git commit -m "feat: run macro team in shadow mode"
```

### Task 20: Build the model capability evaluation harness

**Files:**

- Create: `packages/evals/package.json`
- Create: `packages/evals/tsconfig.json`
- Create: `packages/evals/src/run.ts`
- Create: `packages/evals/src/score.ts`
- Create: `packages/evals/src/autonomy.ts`
- Create: `packages/evals/tests/score.spec.ts`
- Create: `packages/evals/tests/autonomy.spec.ts`
- Create: `evals/fixtures/routing/`
- Create: `evals/fixtures/macro/`
- Create: `evals/README.md`
- Modify: `pnpm-workspace.yaml`

**Step 1: Write failing scorer tests**

Use frozen fake results to test acceptance, claim provenance, contradiction
detection, unique evidence, structured output, latency, cost, and human
preference:

```ts
expect(scoreRun(fixture)).toEqual(
  expect.objectContaining({
    acceptance: 1,
    verifiedClaimRate: 1,
    unsupportedClaimRate: 0,
    unauthorizedCalls: 0,
  }),
);
```

Table-drive autonomy decisions for a deterministic workflow, an agent-assisted
node, and a human-required node. Assert that the agent path cannot be selected
without measured lift and an independent verifier, and that high failure cost
plus weak verification selects human takeover.

**Step 2: Run the scorer test and verify failure**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts packages/evals/tests/autonomy.spec.ts
```

Expected: FAIL because the eval package does not exist.

**Step 3: Implement offline-first evaluations**

The runner consumes a team manifest, work fixtures, a catalog snapshot, and
executor adapters. Default to fake/replayed results. Live provider evaluation
requires an explicit environment opt-in and writes results under an untracked
run directory. Promotion consumes only reviewed, committed summaries and
versioned catalog updates.

**Deferred v2 — capability scoring and effort evaluation.** Measured capability
scores, confidence intervals, sample counts, suite versions, automatic learning
of any of them, and the provider-effort-evaluation harness are deferred pending
real usage data; the thin selector (Task 9) consumes none of them. Keep the text
below as the design for that future work, but do not build it in this task and
do not emit score fields the catalog (Task 8) rejects: _do not derive capability
scores directly from production success counts; store sample size, confidence,
suite version, and known failure categories._ Effort levels are not evaluated
here at all — they live in the provider catalog described by the
provider-effort-selection design and implementation plans.

What this task does build now is the scorecard and the autonomy record below,
both of which read only run outcomes and neither of which feeds selection.

Emit a versioned `AutonomyDecisionRecord` for every agent-capable node. It
contains deterministic-baseline coverage, ambiguity, measured lift, failure
cost, verification strength, latency and cost delta, chosen mode, and the human
takeover condition. The decision engine chooses `workflow` when the baseline
meets the bound, `agent` only when lift and verification gates pass, and
`human` when risk or unresolved uncertainty exceeds authority.

**Step 4: Run offline evaluations**

```bash
pnpm exec vitest run --project unit packages/evals/tests/score.spec.ts packages/evals/tests/autonomy.spec.ts
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
- every registered executor passes the shared execution-boundary conformance
  suite at its declared `isolationClass`, and no work order ran on an executor
  weaker than it required;
- every deterministic exit assertion names a verifier that is a command plus its
  version plus an output hash, never a model;
- every material factual claim has provenance;
- every accepted claim has a policy-complete, freshness-bounded evidence bundle
  and exact execution snapshot;
- evidence states remain distinct and no renderer can promote them;
- contradictions create evidence verification rather than majority vote;
- every agent-capable node has an autonomy decision against the deterministic
  baseline and a human-takeover condition;
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
