# Livewire Shepherd Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a periodically running Livewire Shepherd that verifies current-index data, investigates ambiguous PIT gaps with a cost-bounded agent team, executes exact reversible repairs, and keeps unrelated work moving through every local failure.

**Architecture:** Livewire remains the only owner of market-data bytes, Parquet publication, Silver derivation, and DuckDB query views. A new Helium `livewire-shepherd` plugin owns durable work units, evidence, claims, scheduling, analysis, and recovery supervision while reusing Helium's event, artifact, provider, lease, lock, script, and verification primitives. The two repositories communicate through strict JSON receipts and content hashes; neither reaches into the other's in-memory state.

**Tech Stack:** TypeScript 5.9, Node.js 22, Zod, Vitest, Helium event/team/Ops kernels, Python 3.13, PyArrow/Parquet, DuckDB, pytest, MediaWiki HTTP APIs, Massive, IB, AnySearch, OpenCLI, and `gh`.

---

## 0. Execution contract

This plan implements the approved
[Livewire Shepherd design](2026-08-31-livewire-shepherd-design.md). The old
P3/P4 names are historical only; implementation uses `LS-*` task IDs.

The design/plan lands first through Helium PR #48. Implementation then uses a
short reviewed branch per executable batch; do not turn the documentation PR
into a multi-repository mega-PR. The first branches are:

- Helium LS-01.1–LS-01.3: create
  `/Users/chenxi/projects/helium/.worktrees/livewire-shepherd-kernel`, branch
  `feat/livewire-shepherd-kernel`, from the merged documentation commit.
- Livewire: create `/Users/chenxi/projects/livewire/.worktrees/shepherd-contracts`,
  branch `feat/shepherd-contracts`, before the first Livewire edit.

The optional Unusual Whales evidence adapter is a third, independent Argon PR:

- Argon: create `/Users/chenxi/projects/argon/.worktrees/shepherd-uw-evidence`,
  branch `feat/shepherd-uw-evidence`, before its first edit. It reuses Argon's
  existing UW client, raw-payload audit, and shared budget governor. Neither the
  UW key nor an ungoverned client may be copied into Helium or Livewire.

Never push any repository's `main` or `master` directly. Merge each branch
through a PR and then align the local default branch to the remote merge commit.
Livewire issue [#89](https://github.com/moremeds/livewire/issues/89) runs in a
separate target-repo loop and is not a dependency: the existing corporate-action
endpoint remains usable until dual-read parity proves the replacement.

### Dependency graph

```text
LS-01.1 -> LS-01.2 -> LS-01.3 -> LS-01.4
                              |
                              +-> LS-02.1 -> LS-02.2a -> LS-02.2b --+
                              |          \                           |
                              +-> LS-07.1 -> LS-07.2 ----------------+-> LS-02.3
                              |                                          |
                              |                                          +-> LS-03.1 -> LS-03.2
                              |                                          +-> LS-04
                              |                                          +-> LS-05.1 -> LS-05.2
                              |                                                               |
                              +---------------------------------------------------------------+-> LS-06.1
                                                                                                  |
                                                                                                  +-> LS-06.2a -> LS-06.2b -> LS-06.2c
                                                                                                                              |
                                                                                                                              +-> LS-06.3a -> LS-06.3b -> LS-07.3
                                                                                                                              +-> LS-08.1 -> LS-08.2

LS-01.4 + LS-02.3 + LS-03.2 + LS-05.2 + LS-06.3b + LS-07.3 -> LS-GATE
LS-04 and LS-08 continue after the first working-system gate
```

`LS-04`, Livewire #89, and free-source historical research may proceed in
parallel after `LS-02.3`. None may stop the deterministic queue.

### Complexity and stop conditions

| Work | Size | Main risk | Mandatory checkpoint or fallback |
| --- | --- | --- | --- |
| LS-01 | M | durable state split | artifact/event replay tests before plugin composition |
| LS-02.2 | L | false identity through ticker reuse | freeze identifier priority/collision policy before schemas |
| LS-03/04/05 | M | provider-specific incompleteness | preserve local status and continue unrelated work |
| LS-06.1 | L | wider-than-declared data mutation | disposable-lake crash matrix before real partition |
| LS-06.2 | L | regression in proven Ops transaction | characterization commit first; use narrow Ops adapter if extraction changes projections |
| LS-07 | M | tools or expensive models overused | capability-denial and quota tests before live analysis |
| LS-08 | L/continuous | retrospective/PIT contamination | publish only evidenced intervals and retain the full unresolved denominator |

### Requirement traceability

| Required behavior | Owning tasks | Proof |
| --- | --- | --- |
| Periodic unattended verification and cold resume | LS-01.2–01.4, LS-06.3b, LS-07.3 | durable replay plus launchd/restart drill |
| One unavailable source never stops unrelated work | LS-01.3, LS-03.2, LS-05.1, LS-07.2 | IB/UW/quota mixed-cycle tests |
| Parquet canonical, DuckDB verified query truth | LS-02.1, LS-02.3, LS-03.1, LS-05.2 | sampled byte-hash reconciliation |
| Current members first without shrinking full PIT goal | LS-02, LS-03, LS-08 | current gate plus explicit historical denominator |
| All material assertions independently verified | LS-07.1–07.2 | claim/evidence-decision contract tests |
| Exact reversible autonomous repair | LS-06.1–06.3b | scope, crash, rollback, and signed-authority drills |
| Target-repo engineering issue lifecycle | LS-07.3 | dedupe, deploy, and production-verification tests |
| Cost-aware agents and provider quota recovery | LS-01.3, LS-07.2 | cheap/senior routing, checkpoint, no-busy-loop tests |
| AnySearch/OpenCLI/Massive/IB/UW source tools | LS-03.2, LS-05.1, LS-07.2 | allowlist, raw-evidence, and provider-state tests |

### Pre-execution adversarial review record

`CLOSED-IN-PLAN` means the implementation and test gate is now explicit; it is
not a claim that code already exists.

| Finding | Failure if uncorrected | Resolution | Status |
| --- | --- | --- | --- |
| AR-01 work units required `securityId` | unresolved members and whole-market partitions were unrepresentable | discriminated candidate/security/index/partition scopes in LS-01.2 | CLOSED-IN-PLAN |
| AR-02 evidence required CAS-shaped refs | existing team logical refs could never attach despite verified hashes | strict logical ref + SHA-256 pair with byte verification | CLOSED-IN-PLAN |
| AR-03 scheduler had decisions but no durable attempt lease | cold restart could duplicate or strand execution | event-backed lease, intent, outcome, and reconciliation in LS-01.2–01.3 | CLOSED-IN-PLAN |
| AR-04 existing claim schema carried no enforced PIT clocks | future leakage could hide in prose | injectable output-contract registry plus Shepherd PIT/proposal schemas in LS-07.1 | CLOSED-IN-PLAN |
| AR-05 only Codex had a default availability refresher | Claude/DeepSeek quota recovery could remain stranded | provider-owned single-flight bounded refreshers in LS-07.2 | CLOSED-IN-PLAN |
| AR-06 receipt outcome/state combinations were unconstrained | failed work could claim `VERIFIED` | read-only receipt semantic refinement and separate mutation receipt | CLOSED-IN-PLAN |
| AR-07 first gate depended on continuous historical expansion | no working system could be promoted until the full long-term goal | LS-GATE depends only on current working path; LS-04/08 continue by coverage | CLOSED-IN-PLAN |
| AR-08 one branch/PR held the whole program | review and rollback scope would become unbounded | documentation PR first, then short task-batch PRs per repository | CLOSED-IN-PLAN |
| AR-09 durable log append was not cross-process compare-and-append | two daemons could both observe no lease and persist competing decisions | OS-atomic append coordination plus a real two-process lease race in LS-01.3 | CLOSED-IN-PLAN |

### Repository rules before implementation

1. In Livewire, read `AGENTS.md`, `CLAUDE.md`, `README.md`,
   `.codex/project-memory.md`, and `tasks/lessons.md` before editing.
2. Add this task graph and `depends_on: [...]` annotations to Livewire
   `tasks/todo.md` as the first Livewire commit.
3. Use `apply_patch` for manual edits.
4. Treat Parquet as canonical and DuckDB as rebuildable query metadata.
5. Never add an IB restart path to Livewire. A separately certified IB-only
   operation, if later enabled, belongs to Helium Ops/trading-stack ownership.
6. Every task is test-first and ends in a small commit.
7. Raw HTML/JSON and command output are immutable evidence bytes under
   `data-lake/raw/shepherd/sha256/`; normalized source manifests, membership
   events, coverage, and lineage are canonical Parquet. Raw evidence supports
   the Parquet truth; it never becomes a second query truth.

## LS-01 Shepherd Kernel

### Task LS-01.1: Extract a generic immutable artifact store

**depends_on:** `[]`

**Repository:** Helium

The team artifact registry already stores bytes by SHA-256. Extract that byte
store so Shepherd can use it without creating a fake team task.

**Files:**

- Create: `packages/core/src/artifact-store.ts`
- Create: `packages/core/tests/artifact-store.spec.ts`
- Modify: `packages/core/src/team/artifacts.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing tests**

Test all of these cases in `artifact-store.spec.ts`:

```ts
it("persists bytes by their declared sha256 and reopens them", () => {
  const store = new ContentAddressedArtifactStore(root, { sync: noSync });
  const saved = store.put(Buffer.from("alpha"), sha256("alpha"));
  expect(saved.ref).toBe(`artifact://sha256/${sha256("alpha").slice(7)}`);
  expect(new ContentAddressedArtifactStore(root).read(saved.ref)).toEqual(Buffer.from("alpha"));
});

it("rejects a declared hash mismatch and detects later tampering", () => { /* exact assertions */ });
it("uses owner-only directories and files", () => { /* 0700 and 0600 */ });
it("is idempotent for identical bytes and immutable for a reused ref", () => { /* exact assertions */ });
it("refuses a symlink, non-regular destination, or foreign-owned root", () => { /* exact assertions */ });
```

**Step 2: Run the test and confirm failure**

Run:

```bash
pnpm exec vitest run --project unit packages/core/tests/artifact-store.spec.ts
```

Expected: FAIL because `ContentAddressedArtifactStore` is not exported.

**Step 3: Implement the minimal generic store**

Move the verified `#persist`, `#verifyStored`, fsync, hard-link, ownership, and
mode logic out of `ArtifactRegistry`. The public contract is:

```ts
export interface StoredArtifact { ref: string; hash: `sha256:${string}`; size: number }

export class ContentAddressedArtifactStore {
  constructor(root: string, options?: { sync?: (fd: number) => void });
  put(content: string | Uint8Array, declaredHash?: string): StoredArtifact;
  read(ref: string): Buffer;
  verify(ref: string, declaredHash?: string): StoredArtifact;
}
```

Only `artifact://sha256/<64 lowercase hex>` is accepted. `ArtifactRegistry`
delegates byte persistence to this class and keeps only team reachability events.

**Step 4: Run focused and regression tests**

Run:

```bash
pnpm exec vitest run --project unit packages/core/tests/artifact-store.spec.ts packages/core/tests/team-artifacts.spec.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/artifact-store.ts packages/core/src/team/artifacts.ts packages/core/src/index.ts packages/core/tests/artifact-store.spec.ts
git commit -m "refactor: share immutable artifact storage"
```

### Task LS-01.2: Add the durable Shepherd work-unit model

**depends_on:** `[LS-01.1]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/package.json`
- Create: `plugins/livewire-shepherd/cordis.patch.yml`
- Create: `plugins/livewire-shepherd/tsconfig.json`
- Create: `plugins/livewire-shepherd/tsconfig.typecheck.json`
- Create: `plugins/livewire-shepherd/src/work-unit.ts`
- Create: `plugins/livewire-shepherd/src/events.ts`
- Create: `plugins/livewire-shepherd/src/reducer.ts`
- Create: `plugins/livewire-shepherd/src/store.ts`
- Create: `plugins/livewire-shepherd/src/index.ts`
- Create: `plugins/livewire-shepherd/src/reducer.test.ts`
- Create: `plugins/livewire-shepherd/src/store.test.ts`
- Modify: `pnpm-lock.yaml`

**Step 1: Scaffold the package and write schema tests**

The package is named `dsh-plugin-livewire-shepherd` and depends only on
`@helium/core`, `dsh-plugin-ops-agent`, `zod`, and `yaml` initially.

Use a closed discriminated scope. A flat list of required `securityId`/symbol
fields is forbidden because unresolved membership candidates and whole-market
Massive partitions do not yet have one stable security identity:

```ts
export const ShepherdWorkUnitSchema = z.strictObject({
  version: z.literal(1),
  workUnitId: z.string().regex(/^lws-[0-9a-f]{32}$/),
  scope: z.discriminatedUnion("kind", [
    SecurityIntervalScopeSchema,    // stable securityId + versioned symbol interval
    CandidateIdentityScopeSchema,   // candidateId + observed symbol, no invented identity
    IndexRevisionScopeSchema,       // indexId + exact source/revision refs
    MarketPartitionScopeSchema,     // provider + asset class + date/timeframe
  ]),
  revision: z.number().int().nonnegative(),
  scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const SHEPHERD_STATES = [
  "DISCOVERED", "EVIDENCE_PENDING", "ADJUDICATING", "REPAIR_READY",
  "REPAIRING", "VERIFYING", "VERIFIED", "AWAITING_PROVIDER",
  "AWAITING_USER", "QUARANTINED", "ENGINEERING_ESCALATED",
  "UNRESOLVED", "RETRY_SCHEDULED",
] as const;
```

Tests must reject end-before-start, an unbound identified-symbol interval,
`securityId` on an unresolved candidate, symbol-only stable identity, unknown
states, a changed scope under the same ID, and a state named `BLOCKED`. Prove a
whole-market date partition and an unresolved candidate are representable.

**Step 2: Run the schema tests**

Run:

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/reducer.test.ts
```

Expected: FAIL before the package is implemented.

**Step 3: Add hash-chained events and the pure reducer**

Define only these event families for v1:

```text
work-unit/discovered
work-unit/transitioned
work-unit/retry-scheduled
attempt/lease-acquired
attempt/lease-expired
attempt/execution-intent
attempt/outcome-recorded
evidence/attached
claim/recorded
claim/verified
repair/intent-recorded
repair/receipt-recorded
repair/verification-recorded
repair/rolled-back
issue/linked
cycle/recorded
```

Every transition carries `expectedRevision` and `revision`. Evidence uses a
strict `{ ref, hash: sha256:* }` pair: the ref may be a team logical ref, while
the hash must resolve to verified CAS bytes. The reducer rejects duplicate
event IDs, stale revisions, illegal transitions, reused refs with different
hashes, and terminal `VERIFIED` without a successful independent-verification
event. The store/attachment boundary verifies the bytes; the pure reducer never
pretends a string ref proves content.

Use `openEventStore()` in `store.ts`; do not invent another JSONL format.

**Step 4: Add restart and torn-tail tests**

Test discovery, every legal local-wait transition, durable lease expiry,
execution intent/outcome, stale revision rejection, reopen/replay, snapshot,
torn-tail append, and the absence of a global status.

Run:

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/reducer.test.ts plugins/livewire-shepherd/src/store.test.ts
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add plugins/livewire-shepherd
git commit -m "feat: add durable Shepherd work units"
```

### Task LS-01.3: Implement no-global-blocker scheduling and retries

**depends_on:** `[LS-01.2]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/scheduler.ts`
- Create: `plugins/livewire-shepherd/src/scheduler.test.ts`
- Create: `plugins/livewire-shepherd/src/coordinator.ts`
- Create: `plugins/livewire-shepherd/src/coordinator.test.ts`
- Create: `plugins/livewire-shepherd/src/append-coordination.ts`
- Create: `plugins/livewire-shepherd/src/append-coordination.test.ts`
- Create: `plugins/livewire-shepherd/src/coverage-ledger.ts`
- Create: `plugins/livewire-shepherd/src/coverage-ledger.test.ts`

**Step 1: Write the scheduler tests**

Create three independent units: Massive-ready, IB-needs-2FA, and UW-403. Assert
that one cycle leases Massive work, persists `AWAITING_USER` for IB,
`AWAITING_PROVIDER` for UW, and never returns a daemon-wide failure.

Also test:

- exactly one active lease per work unit;
- retry time and provider-availability triggers;
- no polling before the trigger;
- quota closes the attempt and releases capacity;
- resource pressure admits deterministic verification but refuses agent fanout;
- one poisoned work unit cannot starve a later ready unit; and
- cold restart resumes one attempt, not two.

**Step 2: Run and confirm failure**

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/scheduler.test.ts
```

Expected: FAIL because `ShepherdScheduler` is missing.

**Step 3: Implement a deterministic planner**

The scheduler consumes a frozen state snapshot and returns decisions; it does
not sleep or call tools:

```ts
export interface ShepherdDecision {
  workUnitId: string;
  disposition: "lease" | "wait" | "fanout" | "repair" | "verify";
  reason: string;
  wakeAt?: string;
}

decide(state, availability, pressure, now): ShepherdDecision[]
```

Sort by explicit priority, discovery time, then work-unit ID. A decision for one
unit never changes another unit's eligibility.

**Step 4: Persist leases and attempts before side effects**

`ShepherdCoordinator` applies a decision with compare-and-append revision
checks. It records `attempt/lease-acquired`, then `attempt/execution-intent`
before calling any bridge. Completion, quota, local wait, and failure each
append one typed outcome that closes the attempt and releases capacity. Startup
reconciliation expires read-only attempts safely; any attempt with a persisted
mutation intent is handed to LS-06 recovery and is never blindly retried.

Do not use the in-memory `LeaseStore` as durable truth. It may be used only as a
process-local capacity primitive after the event-backed lease wins.

The compare-and-append section is serialized across processes with an
OS-atomic, owner-receipted lock using boot identity plus PID liveness; elapsed
time alone never reclaims it. A second process reloads after losing the lock
and cannot append a competing lease. Add a real two-process test plus a
SIGKILL/stale-holder recovery test; an in-process mutex is not sufficient.

**Step 5: Implement the multidimensional coverage ledger**

Record `universe`, `identity`, `bars`, `corporate-actions`, `pit`, `lineage`,
`duckdb-parity`, `repair`, and `rollback` independently. Compute numerators and
denominators only from explicit scope manifests. Never infer `verified` from
the existence of data.

**Step 6: Run tests and commit**

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/scheduler.test.ts plugins/livewire-shepherd/src/coordinator.test.ts plugins/livewire-shepherd/src/append-coordination.test.ts plugins/livewire-shepherd/src/coverage-ledger.test.ts
git add plugins/livewire-shepherd/src
git commit -m "feat: schedule Shepherd work without global blockers"
```

### Task LS-01.4: Define the strict Livewire bridge and daemon shell

**depends_on:** `[LS-01.3]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/bridge.ts`
- Create: `plugins/livewire-shepherd/src/bridge.test.ts`
- Create: `plugins/livewire-shepherd/src/config.ts`
- Create: `plugins/livewire-shepherd/src/config.test.ts`
- Create: `plugins/livewire-shepherd/src/daemon.ts`
- Create: `plugins/livewire-shepherd/src/daemon.test.ts`
- Create: `plugins/livewire-shepherd/src/bin/shepherdd.ts`

**Step 1: Freeze the receipt schema in a failing test**

```ts
const LivewireReceiptSchema = z.strictObject({
  version: z.literal(1),
  operationKind: z.literal("probe"),
  operationId: z.string().min(1),
  workUnitId: z.string().min(1),
  outcome: z.enum(["completed", "no-op", "temporary-unavailable", "unsafe", "failed"]),
  stateHint: z.enum(["VERIFIED", "AWAITING_PROVIDER", "AWAITING_USER", "QUARANTINED", "UNRESOLVED"]),
  scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidence: z.array(z.strictObject({ ref: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  changedPaths: z.array(z.string()),
  summary: z.record(z.string(), z.unknown()),
});
```

Reject extra fields, a changed work-unit ID, non-absolute changed paths, paths
outside configured roots, and a receipt whose stdout contains additional text.
For this read-only bridge, `changedPaths` must be empty. Add a semantic
`superRefine`: `temporary-unavailable` may map only to `AWAITING_PROVIDER` or
`AWAITING_USER`; `unsafe`/`failed` may map only to `QUARANTINED` or
`UNRESOLVED`; and `VERIFIED` requires `completed`/`no-op` plus at least one
verified evidence object. Mutation receipts are a separate LS-06 schema, not a
widening of this one.

**Step 2: Implement the bridge using existing command safety**

Load executable, cwd, environment, timeout, and argv schema through
`ScriptRegistry`. Run it through `ScriptExecutor`, capture the raw receipt, and
persist stdout bytes in `ContentAddressedArtifactStore` before parsing exactly
one JSON object. Bind the output digest, CAS ref, scope hash, and typed evidence
hashes. Do not source `.env`, use a shell, or copy secrets into argv.

**Step 3: Implement the daemon shell**

`ShepherdDaemon.tickOnce()` serializes deterministic cycles like `OpsDaemon`.
It scans, records decisions, runs only eligible read-only bridge operations, and
hands mutations to the later LS-06 transaction seam. An optional analysis port
is circuit-broken and cannot fail the cycle.

**Step 4: Verify**

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/bridge.test.ts plugins/livewire-shepherd/src/config.test.ts plugins/livewire-shepherd/src/daemon.test.ts
pnpm build && pnpm typecheck
```

**Step 5: Commit**

```bash
git add plugins/livewire-shepherd
git commit -m "feat: add the Shepherd Livewire bridge"
```

## LS-02 Current Universe Reconciliation

### Task LS-02.1: Preserve source bytes and MediaWiki revisions in Livewire

**depends_on:** `[LS-01.4]`

**Repository:** Livewire

**Files:**

- Modify: `tasks/todo.md`
- Create: `clients/source_evidence.py`
- Create: `clients/mediawiki_client.py`
- Create: `tests/test_source_evidence.py`
- Create: `tests/test_mediawiki_client.py`
- Modify: `clients/universe_client.py`
- Modify: `tests/test_universe_client.py`

**Step 1: Create the Livewire worktree and task ledger**

```bash
git worktree add .worktrees/shepherd-contracts -b feat/shepherd-contracts
```

Add the dependency graph from section 0 to `tasks/todo.md`; commit it before
runtime changes.

**Step 2: Write failing evidence-store tests**

Test content-addressed raw HTML/JSON storage, manifest fsync, a duplicate write,
hash mismatch, tampering, and path traversal. Exact response bytes live at
`data-lake/raw/shepherd/sha256/<digest>` with mode `0600`; their normalized
manifests live in canonical Parquet and are exposed through DuckDB only after
hash verification. The manifest must contain:

```python
@dataclass(frozen=True)
class SourceEvidence:
    ref: str
    sha256: str
    source_url: str
    retrieved_at: datetime
    publication_time: datetime | None
    mediawiki_revision_id: int | None
    mediawiki_revision_time: datetime | None
    content_type: str
```

**Step 3: Implement `MediaWikiClient.snapshot()`**

Use the MediaWiki API to retrieve revision ID, revision timestamp, canonical
URL, and exact revision content in one bounded request. Store response bytes
before parsing. `fetch_sp500()` and `fetch_ndx100()` remain compatibility
helpers but delegate to a snapshot parser and return no unevidenced metadata.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_source_evidence.py tests/test_mediawiki_client.py tests/test_universe_client.py -q
uv run ruff check clients/source_evidence.py clients/mediawiki_client.py clients/universe_client.py tests/test_source_evidence.py tests/test_mediawiki_client.py tests/test_universe_client.py
git add tasks/todo.md clients/source_evidence.py clients/mediawiki_client.py clients/universe_client.py tests
git commit -m "feat: preserve index source revisions"
```

### Task LS-02.2a: Freeze the stable-identity evidence policy

**depends_on:** `[LS-02.1]`

**Repository:** Livewire

**Files:**

- Create: `docs/contracts/shepherd-security-identity.md`
- Create: `tests/fixtures/shepherd/identity/README.md`
- Create: `tests/test_security_identity_contract.py`

**Step 1: Inventory only evidence that is actually obtainable**

Freeze sanitized fixtures for Wikipedia CIK fields, SEC company-ticker and
submission data, Massive ticker details (including CIK/composite FIGI/share
class FIGI only when returned by the current entitlement), exchange/symbol, and
issuer/corporate-action evidence. Record the exact source revision, retrieval
time, raw hash, missing fields, and observed collisions. Do not assume every
provider supplies every identifier.

**Step 2: Freeze identifier priority and collision policy**

The internal `security_id` is an immutable generated identifier linked to
versioned external identifier intervals. It is never a hash of ticker alone.
CIK, composite/share-class FIGI, exchange, issuer history, and corporate-action
evidence may prove continuity only under the documented priority rules. A
symbol rename can retain an identity; ticker reuse must create a distinct one.
Conflicting or insufficient evidence remains `candidate` or `unresolved` and
cannot enter a PIT Silver publication.

**Step 3: Turn the policy examples into an executable contract fixture**

Cover same ticker/different issuer, symbol rename/same security, share classes,
merger, spinoff, missing CIK/FIGI, provider disagreement, and an identifier that
changes retrospectively. At this checkpoint the test validates fixture hashes,
required evidence fields, and the expected disposition table; LS-02.2b imports
the same table as implementation acceptance tests.

**Step 4: Verify and commit the frozen policy before storage code**

```bash
uv run pytest tests/test_security_identity_contract.py -q
git add docs/contracts/shepherd-security-identity.md tests/fixtures/shepherd/identity tests/test_security_identity_contract.py
git commit -m "docs: freeze Shepherd security identity policy"
```

Expected at this checkpoint: the contract/fixture linter passes and no runtime
implementation is claimed. Any newly discovered collision changes the policy
in a reviewed commit before, never after, publishing membership.

### Task LS-02.2b: Add stable security identity and revisioned membership events

**depends_on:** `[LS-02.2a]`

**Repository:** Livewire

**Files:**

- Create: `clients/security_master.py`
- Create: `clients/index_membership_store.py`
- Create: `tests/test_security_master.py`
- Create: `tests/test_index_membership_store.py`
- Modify: `tests/test_security_identity_contract.py`

**Step 1: Write identity failure cases first**

Cover same ticker/different issuer, symbol rename/same security, removal and
re-addition, share classes, merger, spinoff, mixed-case provider symbols, and an
unresolved candidate. A ticker string alone must never create a verified stable
identity. Import and satisfy the already frozen LS-02.2a contract fixtures.

**Step 2: Define append-only schemas**

`security_master/events.parquet` records identifier intervals and supersession.
`index_membership/<index>/events.parquet` records:

```python
@dataclass(frozen=True)
class MembershipEvent:
    event_id: str
    index_id: str
    security_id: str
    action: Literal["add", "remove"]
    announced_at: datetime | None
    effective_at: datetime
    known_at: datetime
    source_refs: tuple[str, ...]
    source_hashes: tuple[str, ...]
    revision: int
    supersedes: str | None
    status: Literal["candidate", "verified", "rejected", "unresolved"]
```

Use exact-path `flock`, temp write, `ParquetFile.read()`, validation, fsync, and
`os.replace()`. New evidence appends a revision; it never edits an old row.

**Step 3: Add PIT query functions**

`members_effective_at(index_id, effective_at, as_of)` must exclude a row whose
`known_at > as_of`, even when its effective date is earlier. Add boundary tests
for announcement day versus effective day.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_security_identity_contract.py tests/test_security_master.py tests/test_index_membership_store.py -q
git add clients/security_master.py clients/index_membership_store.py tests/test_security_identity_contract.py tests/test_security_master.py tests/test_index_membership_store.py
git commit -m "feat: add PIT index membership storage"
```

### Task LS-02.3: Reconcile current S&P 500 and Nasdaq-100 seeds

**depends_on:** `[LS-02.2b, LS-07.2]`

**Repository:** Livewire

**Files:**

- Create: `livewire_scripts/shepherd_universe.py`
- Create: `tests/test_shepherd_universe.py`
- Modify: `scripts/livewire_ingest.py`
- Modify: `tests/test_livewire_entrypoints.py`
- Modify: `clients/duckdb_catalog.py`
- Modify: `tests/test_duckdb_catalog.py`

**Step 1: Write a fixture reproducing the current disagreement**

Use small sanitized fixtures with Wikipedia-only, preset-only, renamed, and
unresolved symbols. Assert the command emits candidate claims and evidence but
does not mutate presets or membership on `scan`.

**Step 2: Add the strict commands**

```text
livewire_ingest.py shepherd-universe scan --index sp500|ndx100
livewire_ingest.py shepherd-universe import-decision --manifest ABS
livewire_ingest.py shepherd-universe verify --revision N
```

`scan` captures both seed bytes. Disagreements create a source-conflict team
case; the deterministic path does not silently choose Wikipedia or presets.
`import-decision` accepts only a verifier-bound
manifest whose source hashes exist locally and whose effective/known clocks are
valid. `verify` reconstructs current membership independently from append-only
events and returns a strict receipt.

**Step 3: Expose query metadata in DuckDB**

Register membership and security-master views on demand. Extend only metadata;
do not copy bars into DuckDB. Add a `shepherd_coverage` table keyed by scope
hash, dimension, state, and evidence hash. Build a staging database and replace
it atomically.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_shepherd_universe.py tests/test_livewire_entrypoints.py tests/test_duckdb_catalog.py -q
uv run pytest tests -q --cov=clients --cov=scripts --cov-report=term-missing
git add livewire_scripts/shepherd_universe.py scripts/livewire_ingest.py clients/duckdb_catalog.py tests
git commit -m "feat: reconcile verified current index membership"
```

## LS-03 Current-Member Daily History

### Task LS-03.1: Produce exact current-member daily coverage work units

**depends_on:** `[LS-02.3]`

**Repository:** Livewire

**Files:**

- Create: `livewire_scripts/shepherd_daily.py`
- Create: `tests/test_shepherd_daily.py`
- Modify: `clients/duckdb_catalog.py`
- Modify: `livewire_scripts/duckdb_catalog_cli.py`
- Modify: `scripts/livewire_store.py`

**Step 1: Write coverage tests**

Use a verified membership revision containing complete, missing, corrupt,
pre-listing, post-delisting, renamed, and ticker-reuse fixtures. The denominator
comes from verified security intervals, not files found on disk.

Assert symbol-scoped reads are used; a test must fail if the implementation
binds a whole-universe glob for one symbol.

**Step 2: Implement `daily plan`**

```text
livewire_store.py shepherd-daily plan --membership-revision N --as-of YYYY-MM-DD
```

Return one work unit per identity/symbol/date interval with coverage state,
expected NYSE sessions, Parquet hash, first/last dates, gaps, provenance mix,
and an exact next operation. Do not fetch or write in this command.

**Step 3: Implement `daily verify`**

Re-read the exact Parquet file, validate schema/footer/OHLCV, calendar coverage,
identity interval, duplicate rows, and row-level source/price basis. A file is
not verified merely because its last date is fresh.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_shepherd_daily.py tests/test_duckdb_catalog.py tests/test_duckdb_catalog_cli.py -q
git add livewire_scripts/shepherd_daily.py clients/duckdb_catalog.py livewire_scripts/duckdb_catalog_cli.py scripts/livewire_store.py tests
git commit -m "feat: plan verified current-member daily coverage"
```

### Task LS-03.2: Connect deep daily retrieval without making IB a blocker

**depends_on:** `[LS-03.1]`

**Repositories:** Livewire and Helium

**Files (Livewire):**

- Modify: `livewire_scripts/shepherd_daily.py`
- Modify: `livewire_scripts/run_ib_fetch_robust.py`
- Create: `tests/test_shepherd_daily_execution.py`
- Modify: `tests/test_run_ib_fetch_robust.py`

**Files (Helium):**

- Create: `plugins/livewire-shepherd/src/livewire-cycle.test.ts`
- Modify: `plugins/livewire-shepherd/src/daemon.ts`

**Step 1: Freeze source-selection behavior in tests**

- Deep current-member daily history selects the existing robust IB path.
- Recent Massive overlap and Yahoo are challenges, not deep-history authority.
- An IB session conflict returns `temporary-unavailable/AWAITING_USER` with no
  retries inside the command.
- Other ready units continue in the same daemon cycle.
- A post-listing data gap is distinct from a pre-listing non-applicable date.

**Step 2: Add manifest-bound execution**

`shepherd_daily.py fetch --manifest ABS` validates the work-unit scope hash and
invokes the canonical robust path. It emits one JSON receipt and never restarts
IB. Existing `clientId` collision retry remains inside `IBClient`; 2FA/session
failure returns exit 75.

**Step 3: Import receipts in Helium**

Map exit 75 plus the typed state hint to local waiting state. Do not parse human
stderr or infer provider state from text.

**Step 4: Verify both repositories and commit separately**

```bash
# Livewire
uv run pytest tests/test_shepherd_daily.py tests/test_shepherd_daily_execution.py tests/test_run_ib_fetch_robust.py -q -W error::RuntimeWarning

# Helium
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/livewire-cycle.test.ts
```

Commit one PR-ready change in each repository:

```bash
# Livewire
git add livewire_scripts/shepherd_daily.py livewire_scripts/run_ib_fetch_robust.py tests/test_shepherd_daily_execution.py tests/test_run_ib_fetch_robust.py
git commit -m "feat: expose resumable Shepherd daily retrieval"

# Helium
git add plugins/livewire-shepherd/src/daemon.ts plugins/livewire-shepherd/src/livewire-cycle.test.ts
git commit -m "feat: isolate unavailable Livewire sources"
```

## LS-04 Current-Member Intraday

### Task LS-04: Verify the Massive flat-file current-member slice

**depends_on:** `[LS-02.3]`

**Repository:** Livewire

**Files:**

- Create: `livewire_scripts/shepherd_intraday.py`
- Create: `tests/test_shepherd_intraday.py`
- Modify: `scripts/livewire_store.py`

**Step 1: Write tests around the existing whole-market source**

The planner must use staged Massive `_symbols.parquet` and canonical 1m files,
then filter the verified current-member security intervals. It must not ask IB
or UW for equity bars and must not rescan the external drive when a valid
DuckDB coverage snapshot already names the partition hashes.

**Step 2: Implement plan and verification commands**

Validate 1m session coverage and deterministically recompute 5m, 30m, and 1h
aggregates from 1m for sampled partitions. Record the entitled start returned
by discovery; never hard-code 2021 as a permanent entitlement promise.

**Step 3: Add repair selection**

Only whole-date Massive flat-file repair is eligible for equity intraday. The
manifest names exact dates and confirms projected storage/free-space reserve.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_shepherd_intraday.py tests/test_ingest_flatfiles.py -q
git add livewire_scripts/shepherd_intraday.py scripts/livewire_store.py tests/test_shepherd_intraday.py
git commit -m "feat: verify current-member intraday coverage"
```

## LS-05 Corporate Actions and PIT Silver

### Task LS-05.1: Emit replayable corporate-action receipts

**depends_on:** `[LS-02.3]`

**Repositories:** Livewire; optional Argon evidence adapter in its own worktree

**Files:**

- Modify: `clients/massive_client.py`
- Modify: `livewire_scripts/sync_corporate_actions.py`
- Modify: `clients/corporate_action_store.py`
- Create: `livewire_scripts/shepherd_actions.py`
- Create: `tests/test_shepherd_actions.py`
- Modify: `tests/test_massive_client.py`
- Modify: `tests/test_corporate_action_store.py`

**Files (Argon, optional supplemental evidence):**

- Modify: `src/uw_scan/api/endpoints.py`
- Modify: `src/uw_scan/sources/uw.py`
- Create: `scripts/shepherd_uw_corporate_actions.py`
- Create: `tests/unit/test_shepherd_uw_corporate_actions.py`

**Step 1: Test the current endpoint path, not the desired migration**

Add raw-response evidence refs, payload hashes, provider event IDs, fetch time,
and cursor identity to the existing deprecated-endpoint normalization. This
task must pass while #89 remains open.

**Step 2: Add a provider-neutral read-only export**

`shepherd_actions.py export --symbols ... --as-of ...` returns every active and
superseded event needed for the exact scope, with raw evidence hashes. It does
not flatten revisions or cancel another provider's event.

**Step 3: Add the optional UW source through Argon's governed boundary**

Create the Argon worktree named in section 0. Add typed UW company split and
dividend endpoint slugs and a read-only JSON command that uses `UwClient`,
`_persist_audit`, `read_snapshot()`, and `may_spend("research", ...)`. It must
load `UW_SCAN_API_KEY` only through Argon's existing `Settings.from_env()` and
must persist Argon's audit row/raw compressed payload before emitting a receipt.
Never return or log the key.

The Livewire input contract accepts only the command's hashed split/dividend
receipt plus responsible-publisher evidence. The capability audit currently
records these endpoints as `403` for this account; map that to
`AWAITING_PROVIDER`, and map exhausted research budget to `AWAITING_QUOTA`.
Either state is local to this supplemental source: it does not alter Massive
events, fail the batch, or delay other work units. Do not add UW bars.

Verify and commit the Argon adapter independently:

```bash
uv run pytest tests/unit/test_shepherd_uw_corporate_actions.py tests/unit/test_uw_budget.py -q
uv run ruff check src/uw_scan/api/endpoints.py src/uw_scan/sources/uw.py scripts/shepherd_uw_corporate_actions.py tests/unit/test_shepherd_uw_corporate_actions.py
git add src/uw_scan/api/endpoints.py src/uw_scan/sources/uw.py scripts/shepherd_uw_corporate_actions.py tests/unit/test_shepherd_uw_corporate_actions.py
git commit -m "feat: expose governed UW corporate-action evidence"
```

**Step 4: Add the #89 dual-read seam without switching it on**

When #89's target branch is available, the same tests must accept a second
typed client and compare identity/date/ratio/amount/currency/count/hash. The
production selector remains old until parity is recorded. Do not make this a
dependency for the rest of LS-05.

**Step 5: Verify and commit**

```bash
uv run pytest tests/test_shepherd_actions.py tests/test_massive_client.py tests/test_corporate_action_store.py -q
git add clients livewire_scripts/sync_corporate_actions.py livewire_scripts/shepherd_actions.py tests
git commit -m "feat: export replayable corporate-action evidence"
```

### Task LS-05.2: Bind membership and actions into PIT Silver revisions

**depends_on:** `[LS-03.1, LS-05.1]`

**Repository:** Livewire

**Files:**

- Create: `clients/pit_silver_revision.py`
- Create: `tests/test_pit_silver_revision.py`
- Create: `livewire_scripts/shepherd_silver.py`
- Create: `tests/test_shepherd_silver.py`
- Modify: `clients/duckdb_catalog.py`
- Modify: `scripts/livewire_store.py`

**Step 1: Write causality and lineage tests**

Test future announcements, future effective dates, corrected corporate actions,
membership changes, ticker reuse, a missing security identity, a moved current
pointer, and a tampered underlying artifact. A retrospective source with
`publication_time > as_of` must not enter the revision.

**Step 2: Add a separate PIT manifest, preserving Apex compatibility**

Do not change the shape of existing `silver/revisions/current.json`. Publish:

```text
silver/pit-revisions/revision=N.json
silver/pit-revisions/current.json
```

The manifest references the existing Silver revision, verified membership
revision, security-master revision, corporate-action input hashes, policy
version, and all affected intervals. The pointer is replaced last.

**Step 3: Add point-in-time DuckDB views**

Register on demand:

```text
pit_index_membership
pit_equity_daily
shepherd_verification_coverage
```

`pit_equity_daily` joins stable security intervals and effective membership to
existing Silver bars; it does not materialize a second bar table.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_pit_silver_revision.py tests/test_shepherd_silver.py tests/test_duckdb_catalog.py -q
git add clients/pit_silver_revision.py livewire_scripts/shepherd_silver.py clients/duckdb_catalog.py scripts/livewire_store.py tests
git commit -m "feat: publish point-in-time Silver lineage"
```

## LS-06 Autonomous Targeted Repair

### Task LS-06.1: Build a reversible Livewire repair wrapper

**depends_on:** `[LS-03.2, LS-05.2]`

**Repository:** Livewire

**Files:**

- Create: `clients/shepherd_repair.py`
- Create: `livewire_scripts/shepherd_repair.py`
- Create: `tests/test_shepherd_repair.py`
- Modify: `scripts/livewire_store.py`

**Step 1: Write the manifest parser tests**

```python
@dataclass(frozen=True)
class RepairManifest:
    version: Literal[1]
    operation_id: str
    work_unit_id: str
    scope_hash: str
    layer: Literal["bronze", "silver", "query"]
    security_id: str
    symbol: str
    date_from: date
    date_to: date
    timeframe: str
    prior_artifacts: tuple[HashedPath, ...]
    source_evidence: tuple[HashedRef, ...]
    max_rows: int
    max_bytes: int
    expires_at: datetime
    operation: Literal["daily-merge", "flatfile-date-republish", "silver-rebuild", "duckdb-rebuild"]
```

Reject an expired manifest, changed prior hash, different data-lake root, path
escape, symlink escape, source evidence missing from the local store, wider
dates, extra symbols, over-budget output, and a second attempt.

**Step 2: Implement dry-run and stage**

```text
livewire_store.py shepherd-repair preflight --manifest ABS
livewire_store.py shepherd-repair stage --manifest ABS
```

`stage` writes only a new candidate or temp file, validates it, hashes it, and
returns a receipt. It cannot advance canonical files.

**Step 3: Implement publish, verify, and rollback**

```text
livewire_store.py shepherd-repair publish --manifest ABS --staged-receipt ABS
livewire_store.py shepherd-repair verify --manifest ABS --publish-receipt ABS
livewire_store.py shepherd-repair rollback --manifest ABS --publish-receipt ABS
```

Before publish, copy the prior bytes verbatim to a content-hashed backup and
fsync. Publish with the existing exact-path lock and atomic replacement. Verify
integrity, freshness, coverage, identity, scope, and lineage independently.
Rollback restores only the prior hashed artifact/pointer and verifies it.

**Step 4: Crash-matrix tests**

Inject failure before stage, after stage, before publish, after publish, during
DuckDB rebuild, before verification, and during rollback. Re-running must
converge without duplicate rows or a widened mutation.

**Step 5: Verify and commit**

```bash
uv run pytest tests/test_shepherd_repair.py tests/test_daily_bronze_repair.py tests/test_silver_revision.py -q
uv run pytest tests -q --cov=clients --cov=scripts --cov-report=term-missing
git add clients/shepherd_repair.py livewire_scripts/shepherd_repair.py scripts/livewire_store.py tests/test_shepherd_repair.py
git commit -m "feat: add reversible Shepherd repairs"
```

### Task LS-06.2a: Characterize the proven Ops action boundary

**depends_on:** `[LS-06.1, LS-01.4]`

**Repository:** Helium

**Files:**

- Modify: `plugins/ops-agent/src/controller.test.ts`
- Modify: `contracts/tests/ops-action-boundary.contract.spec.ts`

**Step 1: Characterize the current `OpsController.#act` behavior**

Before extraction, add tests for exact ordering:

```text
controller probe -> component lease -> OS lock -> baseline -> second controller probe
-> write-ahead intent -> spawn -> receipt -> grace verification -> evidence -> terminal
```

Test `not-needed`, suppression, failed command, failed postcondition,
uncertain restart, and successful evidence. These must pass against current
code before refactoring.

**Step 2: Freeze projections and restart evidence**

Capture the event sequence, terminal projection, persisted recovery-evidence
hash, and restart result for each case. The new assertions must pass against
the unmodified controller.

**Step 3: Verify and commit characterization only**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/controller.test.ts
pnpm exec vitest run --project contracts contracts/tests/ops-action-boundary.contract.spec.ts
git add plugins/ops-agent/src/controller.test.ts contracts/tests/ops-action-boundary.contract.spec.ts
git commit -m "test: characterize the Ops action transaction"
```

### Task LS-06.2b: Extract the certified action transaction

**depends_on:** `[LS-06.2a]`

**Repository:** Helium

**Files:**

- Create: `plugins/ops-agent/src/action-runner.ts`
- Create: `plugins/ops-agent/src/action-runner.test.ts`
- Modify: `plugins/ops-agent/src/controller.ts`
- Modify: `plugins/ops-agent/src/index.ts`
- Modify: `packages/core/src/operations/incident.ts`
- Modify: `packages/core/tests/operations-correlate.spec.ts`

**Step 1: Extract without changing behavior**

Move the transaction to `CertifiedActionRunner`. Its input carries a generic
`scopeId` and already-resolved argv/check definitions. The normal Ops controller
uses the same runner. Add optional `scopeId` to `Incident`; the existing
four-part incident key remains byte-for-byte unchanged when it is absent.

**Step 2: Enforce the characterization stop condition**

Run LS-06.2a's tests after each extraction slice. Event bytes, projections,
recovery evidence, lock/lease timing, and restart result must remain identical.
If the extraction cannot preserve those contracts, stop it and instead add a
narrow queued-action adapter inside `OpsController` that calls the existing
private transaction. Do not create a second mutation engine.

**Step 3: Verify and commit the reusable boundary**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/action-runner.test.ts plugins/ops-agent/src/controller.test.ts packages/core/tests/operations-correlate.spec.ts packages/core/tests/operations-crash-matrix.spec.ts
pnpm exec vitest run --project contracts contracts/tests/ops-action-boundary.contract.spec.ts
git add packages/core plugins/ops-agent
git commit -m "refactor: expose the certified action transaction"
```

### Task LS-06.2c: Bind scoped Shepherd work to the action transaction

**depends_on:** `[LS-06.2b]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/repair-controller.ts`
- Create: `plugins/livewire-shepherd/src/repair-controller.test.ts`

**Step 1: Build the Shepherd repair controller**

For a `REPAIR_READY` work unit, construct one scoped action candidate whose
scope is `workUnitId:scopeHash`. Use the committed Livewire wrapper through
`ScriptRegistry`/`ScriptExecutor`, component-level OS lock `livewire`, one-shot
lease, baseline, persisted exact manifest, and independent verify command.

The model cannot supply argv. The only argument is `--manifest ABS`; the
resolver verifies the real path is under the Shepherd ready directory and the
filename/content hash equals the work unit's scope hash.

**Step 2: Run the combined safety suite**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/action-runner.test.ts plugins/ops-agent/src/controller.test.ts plugins/livewire-shepherd/src/repair-controller.test.ts packages/core/tests/operations-crash-matrix.spec.ts
pnpm test:contracts
```

Expected: all existing Ops behavior unchanged plus scoped Shepherd actions.

**Step 3: Commit**

```bash
git add plugins/livewire-shepherd
git commit -m "feat: run scoped Shepherd repairs through Ops"
```

### Task LS-06.3a: Commission exact-scope automatic authority

**depends_on:** `[LS-06.2c]`

**Repository:** Helium

**Files:**

- Modify: `plugins/ops-agent/src/bin/opsd.ts`
- Modify: `plugins/ops-agent/src/bin/opsd.test.ts`
- Modify: `plugins/ops-agent/src/controller.ts`
- Modify: `plugins/ops-agent/src/controller.test.ts`
- Modify: `plugins/ops-agent/src/probes/launchd-controller.ts`
- Modify: `plugins/ops-agent/src/probes/launchd-controller.test.ts`
- Create: `contracts/tests/livewire-shepherd-auto-authority.contract.spec.ts`

**Step 1: Make `auto` representable only as a cap**

Extend `OpsdRuntimeConfigSchema`, `assertRuntimeAuthority`, controller-probe
composition, and executor composition. The runtime config may parse `auto`, but
it grants nothing by itself. Require a signed promotion bundle whose exact SOP
authority is `auto`, pinned executable identity, `mutationOwner=opsd`, no
competing controller, exact registered argv, and independently runnable
business postconditions. Any mismatch loads at observe or refuses startup
before an executor is created.

**Step 2: Prove the cap cannot widen authority**

Contract-test mode above signed authority, wrong executable/hash/owner,
unregistered postcondition, competing controller, unsigned manifest, and a
second SOP. Only the one signed Livewire operation may reach the action runner.

**Step 3: Verify and commit runtime authority separately**

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/bin/opsd.test.ts plugins/ops-agent/src/controller.test.ts plugins/ops-agent/src/probes/launchd-controller.test.ts
pnpm exec vitest run --project contracts contracts/tests/livewire-shepherd-auto-authority.contract.spec.ts
git add plugins/ops-agent contracts/tests/livewire-shepherd-auto-authority.contract.spec.ts
git commit -m "feat: commission exact automatic Ops authority"
```

### Task LS-06.3b: Package the daemon and run controlled drills

**depends_on:** `[LS-06.3a]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/bin/shepherdctl.ts`
- Create: `plugins/livewire-shepherd/src/bin/shepherdctl.test.ts`
- Create: `scripts/ops/install-livewire-shepherd.sh`
- Create: `scripts/ops/install-livewire-shepherd.test.sh`
- Create: `ops/sops/livewire-shepherd-targeted-repair.yaml`
- Create: `ops/executors/livewire-shepherd-targeted-repair.yaml`
- Create: `contracts/tests/livewire-shepherd-recovery.contract.spec.ts`

**Step 1: Package a separate Shepherd launchd service**

The service has owner-only state, a Unix control socket, periodic deterministic
ticks, bounded logs, and no provider requirement. It reads the Livewire release
path and data roots from validated config, not from a sourced shell environment.

**Step 2: Add controlled fixture drills**

Contract-test:

- a corrupted disposable Parquet partition repairs and verifies unattended;
- a forced postcondition failure rolls back;
- two processes race and one executes;
- kill/restart at every action boundary converges;
- IB returns `AWAITING_USER` while Massive and DuckDB units finish;
- quota exits one analysis attempt and deterministic repair continues; and
- changed executable/hash/owner/manifest refuses mutation.

**Step 3: Run local gates**

```bash
pnpm build
pnpm typecheck
pnpm exec vitest run --project unit plugins/ops-agent/src/bin/opsd.test.ts plugins/livewire-shepherd/src/bin/shepherdctl.test.ts
pnpm exec vitest run --project contracts contracts/tests/livewire-shepherd-recovery.contract.spec.ts
bash -n scripts/ops/install-livewire-shepherd.sh
```

**Step 4: Commit**

```bash
git add plugins/livewire-shepherd scripts/ops ops/sops ops/executors contracts/tests/livewire-shepherd-recovery.contract.spec.ts
git commit -m "feat: package automatic Livewire Shepherd recovery"
```

## LS-07 Periodic Agent Verification

### Task LS-07.1: Define minimum-role Shepherd team variants

**depends_on:** `[LS-01.4]`

**Repository:** Helium

**Files:**

- Create: `teams/livewire-shepherd-repair.yaml`
- Create: `teams/livewire-shepherd-source-conflict.yaml`
- Create: `teams/livewire-shepherd-pit.yaml`
- Create: `packages/core/tests/livewire-shepherd-team-manifest.spec.ts`
- Create: `plugins/livewire-shepherd/src/analysis.ts`
- Create: `plugins/livewire-shepherd/src/analysis.test.ts`
- Create: `plugins/livewire-shepherd/src/output-contracts.ts`
- Create: `plugins/livewire-shepherd/src/output-contracts.test.ts`
- Create: `plugins/helium/src/output-contract-registry.ts`
- Create: `plugins/helium/src/output-contract-registry.test.ts`
- Modify: `plugins/helium/src/team-controller.ts`
- Modify: `plugins/helium/src/team-controller.test.ts`

**Step 1: Extract an injectable output-contract registry**

`TeamController` currently hard-codes four macro-era schema IDs. Characterize
all four first, then inject an `OutputContractRegistry` whose built-in entries
produce byte-for-byte identical validation and prompts. Unknown IDs remain
fail-closed. This is a provider/runtime extension point, not Livewire logic in
the generic controller.

Register two Shepherd-owned contracts:

```text
ShepherdClaimSet.v1:
  ClaimSet.v1 fields plus scopeHash and, for PIT/material facts,
  eventTime/publicationTime/retrievalTime/revisionTime and source authority

ShepherdRepairProposal.v1:
  workUnitId, scopeHash, eligibleOperation, acceptedClaimKeys,
  sourceEvidence[{ref,hash}], maxRows/maxBytes, expiresAt
```

Reject future leakage (`publicationTime > asOf`), missing clocks on PIT facts,
unhashed evidence, scope mismatch, an operation outside the deterministic
eligible set, or a proposal citing an unaccepted claim. These schemas describe
and verify; neither exposes execution.

**Step 2: Write manifest tests**

The repair variant rosters Lead, Repair Planner, Independent Verifier, and
Reporter. The source-conflict variant adds only relevant provider investigators.
The PIT variant contains all eight approved roles. Every factual/judgment claim
must flow through `EvidenceDecisionSet.v1` before Lead/Reporter may cite it.
PIT-producing roles use `ShepherdClaimSet.v1`; Repair Planner uses
`ShepherdRepairProposal.v1` only after accepted evidence exists.

**Step 3: Reuse existing generic contracts where they are sufficient**

Basic diagnostic investigators may return `ClaimSet.v1`; PIT Adjudicator and
any role making a claim with PIT consequences return `ShepherdClaimSet.v1`.
Independent Verifier returns `EvidenceDecisionSet.v1`; Lead returns
`AdjudicatedSynthesis.v1`; Reporter returns `ShadowReport.v1`. The Repair Planner returns
`ShepherdRepairProposal.v1`. Deterministic policy revalidates that proposal and
builds the manifest. No model receives a mutation tool.

**Step 4: Add role tool allowlists**

```text
IB Investigator: livewire.evidence.read, livewire.ib.observe
Massive Investigator: livewire.evidence.read, livewire.massive.read
CA & Universe Researcher: livewire.evidence.read, anysearch.search, anysearch.extract, opencli.read
PIT Adjudicator: livewire.evidence.read only
Repair Planner: livewire.evidence.read, livewire.repair.eligible
Independent Verifier: livewire.evidence.read, livewire.probe.request
Lead/Reporter: accepted ledger only
```

**Step 5: Verify and commit**

```bash
pnpm exec vitest run --project unit packages/core/tests/livewire-shepherd-team-manifest.spec.ts plugins/livewire-shepherd/src/output-contracts.test.ts plugins/livewire-shepherd/src/analysis.test.ts plugins/helium/src/output-contract-registry.test.ts plugins/helium/src/team-controller.test.ts
git add teams packages/core/tests/livewire-shepherd-team-manifest.spec.ts plugins/livewire-shepherd/src/output-contracts.ts plugins/livewire-shepherd/src/output-contracts.test.ts plugins/livewire-shepherd/src/analysis.ts plugins/livewire-shepherd/src/analysis.test.ts plugins/helium/src/output-contract-registry.ts plugins/helium/src/output-contract-registry.test.ts plugins/helium/src/team-controller.ts plugins/helium/src/team-controller.test.ts
git commit -m "feat: define Livewire Shepherd team variants"
```

### Task LS-07.2: Add source tools and cost-aware provider policy

**depends_on:** `[LS-07.1, LS-02.1]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/team-tools.ts`
- Create: `plugins/livewire-shepherd/src/team-tools.test.ts`
- Modify: `plugins/helium/src/provider-runtime.ts`
- Modify: `plugins/helium/src/provider-runtime.test.ts`
- Modify: `plugins/helium/src/routing-service.test.ts`

**Step 1: Test tool restrictions and evidence capture**

Every tool result is copied to the immutable artifact store before the agent
sees normalized content. AnySearch/OpenCLI results without URL, retrieval time,
and raw hash are rejected. Search snippets cannot satisfy a fact claim.

Test that Reporter and PIT Adjudicator cannot call search, Repair Planner cannot
execute, and every role is denied undeclared MCP tools by Codex's real executor
boundary contract.

**Step 2: Add production tool adapters**

AnySearch is default for web/general/vertical search and extraction. OpenCLI is
read-only fallback for authenticated or source-specific adapters. Massive, IB,
and corporate-action reads call the strict Livewire bridge rather than duplicating
vendor clients in TypeScript. Secrets stay in tool configuration.

Discover OpenCLI commands and adapter strategy from `opencli list -f json`; do
not hard-code a remembered command registry. Its current daemon is reachable
but the Browser Bridge reports an unstable extension, so a browser-backed
adapter must return a local typed wait/fallback and let AnySearch or another
unit proceed. Never run OpenCLI write commands or trigger its setup/update from
the daemon.

**Step 3: Add edge-owned cheap/senior routing**

In `ProviderRuntime`, create two ordered target groups from currently certified
variants:

- basic research/reporting prefers Codex Luna and equivalent low-cost certified
  provider targets;
- PIT adjudication, conflict resolution, planning, and independent verification
  prefer senior reasoning targets.

The manifest names capabilities/roles only. Provider/model names remain inside
the provider runtime. Claude, Codex, and DeepSeek participate only when their
certified sub-model and quota-domain availability says they can; no test
intentionally consumes Claude quota, and live model smoke tests focus on Codex.

**Step 4: Verify quota behavior**

Use fakes to exhaust one model, one shared provider quota domain, and all
providers. Assert checkpoint, no busy-loop, no tool expansion, deterministic
continuity, and exactly one resume after availability changes.

Also close the current production asymmetry: `ProviderRuntime` has a built-in
Codex availability refresher but no production-owned Claude or DeepSeek
refresher, while Claude starts as quota-exhausted. Add provider-owned bounded
refreshers for every configured provider using its cheapest certified target,
no tools, a minimal exact response, persisted `retryAfter`/backoff, and one
in-flight probe per quota domain. Unit/contract tests inject fake invokers; they
must not consume live Claude quota. A failed probe stays local and schedules one
later retry rather than a timer loop.

**Step 5: Run and commit**

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/team-tools.test.ts plugins/helium/src/provider-runtime.test.ts plugins/helium/src/routing-service.test.ts plugins/provider-codex-subscription/src/executor.test.ts
git add plugins/livewire-shepherd plugins/helium/src/provider-runtime.ts plugins/helium/src/provider-runtime.test.ts plugins/helium/src/routing-service.test.ts
git commit -m "feat: route Shepherd research by cost and capability"
```

### Task LS-07.3: Periodic sampling and target-repository issue lifecycle

**depends_on:** `[LS-07.2, LS-06.3b]`

**Repository:** Helium

**Files:**

- Create: `plugins/livewire-shepherd/src/issues.ts`
- Create: `plugins/livewire-shepherd/src/issues.test.ts`
- Create: `plugins/livewire-shepherd/src/sampling.ts`
- Create: `plugins/livewire-shepherd/src/sampling.test.ts`
- Modify: `plugins/livewire-shepherd/src/daemon.ts`
- Modify: `plugins/livewire-shepherd/src/events.ts`

**Step 1: Write issue lifecycle tests**

Deduplicate by target repo, component, defect class, and affected contract.
Sanitize secrets and payload bytes. Persist issue URL/number and evidence refs.
An open issue moves only affected units to `ENGINEERING_ESCALATED`.

Mock these cases:

- issue already open;
- issue closed without a merged PR;
- PR merged but not deployed;
- deployed commit differs from PR merge;
- production independently verifies the fix; and
- GitHub unavailable.

Only the last verified case closes the Shepherd escalation.

**Step 2: Implement the constrained `gh` adapter**

Allow only issue lookup/create/comment/close for configured repositories. No
push, merge, release, repository settings, or arbitrary API path is exposed to
the model. Coding agents in target repos still branch/test/PR/merge through
their own workflow.

**Step 3: Implement periodic stratified sampling**

Sample healthy and unhealthy strata across universe, provider, timeframe,
revision age, corporate-action presence, and prior repair status. Deterministic
checks run first; create an agent case only for unresolved evidence. Persist the
sample seed and population hash so periodic verification is replayable.

**Step 4: Verify and commit**

```bash
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/issues.test.ts plugins/livewire-shepherd/src/sampling.test.ts plugins/livewire-shepherd/src/daemon.test.ts
git add plugins/livewire-shepherd/src
git commit -m "feat: add periodic verification and issue escalation"
```

## LS-08 Historical PIT Expansion

### Task LS-08.1: Parse historical Wikipedia events as candidates

**depends_on:** `[LS-02.3, LS-07.2]`

**Repository:** Livewire

**Files:**

- Create: `clients/historical_membership.py`
- Create: `tests/test_historical_membership.py`
- Modify: `livewire_scripts/shepherd_universe.py`
- Modify: `tests/test_shepherd_universe.py`

**Step 1: Freeze sanitized historical tables**

Fixtures cover S&P's early discontinuity, Nasdaq's pre-2007 absence, cited and
uncited rows, simultaneous add/remove, renamed security, ticker reuse, and a
page revision that changes an old row.

**Step 2: Parse candidates, citations, and gaps**

Emit a work unit per event. Preserve the page revision and exact row/citation
bytes. Never set `known_at` from the retrospective page revision. A citation's
publication time or separately verified publisher document is required.

**Step 3: Reconstruct only evidenced intervals**

Reverse verified events from a verified current snapshot. Stop an interval at
the first missing/contradictory boundary and record `UNRESOLVED`; do not bridge
it by assumption. Report the early S&P and Nasdaq gaps in the denominator.

**Step 4: Verify and commit**

```bash
uv run pytest tests/test_historical_membership.py tests/test_shepherd_universe.py -q
git add clients/historical_membership.py livewire_scripts/shepherd_universe.py tests
git commit -m "feat: seed historical PIT membership research"
```

### Task LS-08.2: Expand removed/delisted daily history without shrinking the goal

**depends_on:** `[LS-08.1, LS-03.2, LS-05.2]`

**Repositories:** Livewire and Helium

**Files (Livewire):**

- Modify: `livewire_scripts/shepherd_daily.py`
- Create: `tests/test_shepherd_delisted_history.py`
- Modify: `clients/duckdb_catalog.py`

**Files (Helium):**

- Modify: `plugins/livewire-shepherd/src/scheduler.ts`
- Create: `plugins/livewire-shepherd/src/historical-expansion.test.ts`

**Step 1: Add identity-bounded history work units**

Include archived Bronze and removed/delisted securities. Source selection is
evidence-driven: IB where retrievable, current free sources where independently
verifiable, and `UNRESOLVED` when no trustworthy free bar source exists. Never
join through ticker alone.

**Step 2: Make historical expansion incremental**

Prioritize current members first, then verified recent membership intervals,
then older event boundaries. Completion of one interval publishes coverage
without waiting for the entire index history.

**Step 3: Verify PIT queries**

For sampled historical dates, assert the member set is effective and knowable
then, each bar joins the correct security identity, later removal does not erase
history, and later knowledge does not leak backward.

**Step 4: Commit separately in both repositories**

```bash
# Livewire
uv run pytest tests/test_shepherd_delisted_history.py tests/test_shepherd_daily.py tests/test_duckdb_catalog.py -q
git add livewire_scripts/shepherd_daily.py clients/duckdb_catalog.py tests/test_shepherd_delisted_history.py
git commit -m "feat: expand identity-bound historical coverage"

# Helium
pnpm exec vitest run --project unit plugins/livewire-shepherd/src/historical-expansion.test.ts plugins/livewire-shepherd/src/scheduler.test.ts
git add plugins/livewire-shepherd/src/scheduler.ts plugins/livewire-shepherd/src/historical-expansion.test.ts
git commit -m "feat: schedule incremental PIT history expansion"
```

## LS-GATE Working-System Proof

### Task LS-GATE: Prove and promote the first working Shepherd

**depends_on:** `[LS-01.4, LS-02.3, LS-03.2, LS-05.2, LS-06.3b, LS-07.3]`

**Repositories:** Helium and Livewire; Argon only when the optional UW adapter landed

This is evidence collection, not another coding phase. No seven-day duration is
required.

**Files:**

- Create: `docs/evidence/livewire-shepherd/manifest.yaml`
- Create: `docs/evidence/livewire-shepherd/verification.log`
- Create: `docs/evidence/livewire-shepherd/coverage.json`
- Create: `docs/evidence/livewire-shepherd/drills.json`
- Create: `scripts/evidence/verify-livewire-shepherd.mjs`
- Create: `scripts/evidence/verify-livewire-shepherd.test.mjs`
- Modify: `docs/evidence/claims.yaml`
- Modify: `docs/plans/2026-08-31-livewire-shepherd-design.md`

**Step 1: Run offline gates**

Helium:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
git diff --check
```

Livewire:

```bash
uv run ruff check clients livewire_scripts scripts tests
uv run pyright
uv run pytest tests -q -W error::RuntimeWarning --cov=clients --cov=scripts --cov-report=term-missing
git diff --check
```

**Step 2: Run read-only production preflight**

- record exact releases/config hashes;
- recheck Massive entitlement and corporate-action endpoint behavior;
- capture MediaWiki revision IDs and the current preset divergence;
- verify DuckDB coverage metadata against sampled Parquet hashes;
- verify provider/model availability without consuming quota deliberately; and
- confirm IB unavailability is classified locally.

**Step 3: Run reversible controlled drills**

In a disposable lake first, then one reviewed real partition:

- successful targeted repair with integrity/freshness/coverage/scope proof;
- forced verification failure and automatic rollback;
- crash/restart recovery;
- provider quota checkpoint/resume;
- IB session/2FA local wait while other work completes; and
- code defect issue creation/deduplication, with production verification kept
  separate from PR merge.

**Step 4: Evaluate the working-system gates**

Mark each of design section 20's twelve gates `PROVEN`, `PARTIAL`, or `FAILED`
from replayable evidence. There is no `BLOCKED` program verdict; incomplete
coverage names the affected work units and next actions.

The deterministic verifier rejects a missing artifact, hash mismatch,
uncommitted repo SHA, contradictory gate verdict, terminal repair without its
raw/source/postcondition hashes, or a denominator that silently omits
unresolved work. Run it twice from a clean checkout and require identical
output:

```bash
node --test scripts/evidence/verify-livewire-shepherd.test.mjs
node scripts/evidence/verify-livewire-shepherd.mjs docs/evidence/livewire-shepherd/manifest.yaml
```

**Step 5: PR and merge**

Create PRs for both repositories. Merge only after their own tests and reviews
pass. Fetch and align local `master`/`main` after each merge. Do not close
Livewire #89 until the migrated endpoint is deployed and independently verified.

## Implementation order for the first working release

Execute in this order:

```text
LS-01.1 -> LS-01.4
LS-02.1 -> LS-02.2b
LS-07.1 -> LS-07.2
LS-02.3 (deterministic reconcile plus agent-resolved disagreements)
LS-03.1 -> LS-03.2
LS-05.1 -> LS-05.2
LS-06.1 -> LS-06.3b
LS-07.3
LS-GATE for current-member daily + one real repair
```

Then deliver `LS-04` and expand `LS-08` continuously. This order yields a
working unattended system before the full historical denominator is filled,
without redefining the full PIT objective.
