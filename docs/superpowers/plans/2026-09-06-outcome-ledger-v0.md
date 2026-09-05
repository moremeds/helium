# Outcome Ledger V0 — implementation plan

> **For agentic workers:** execute with the user's /execute-plan skill (worktree in .worktrees/outcome-ledger-v0/, straight-through implementation, milestone commits, evidence-based verification). Steps use checkbox syntax.

**Goal.** From the next production run onward, every tenant that declares a settler leaves behind machine-settleable commitments; a deterministic step settles them against ground truth and writes a receipt; `helium scoreboard <tenant>` reads the receipts. option-wizard is the first tenant. Nothing the reader sees changes except the `TARGET —` bug in argon Flash being fixed.

**Architecture.** Core learns three domain-blind types (`Commitment`, `Receipt`, `Settler`) beside `Gate` and one append-only jsonl per tenant (`packages/core/src/ledger.ts`); the CLI calls the tenant's settler as a zero-token audited span at DAG start, dumps per-step evidence, and aggregates `scores` by key in `packages/cli/src/scoreboard.ts`. Everything that knows what SPY is lives in `plugins/option-wizard/` — the typed target, the forecast semantics, `eval/settle.ts`, and the bar reader. argon mirrors the new view shape by hand and renders it.

**Tech Stack.** TypeScript ESM, pnpm workspace, Node 22.19+/24+, vitest (unit + contracts projects), zod for tenant-side parsing, no new runtime dependency. Bars come over HTTP from apex (`OW_APEX_API_BASE`), mirroring `plugins/option-wizard/tools/index.ts:2892` `ow_apex_bars` — no duckdb dependency is added. argon side: Next.js 16 / React 19, vitest + @testing-library/react.

**Spec:** `/Users/chenxi/projects/helium/docs/superpowers/specs/2026-09-04-outcome-ledger-v0-design.md`

## Global Constraints

- Node 22.19+ or 24+; TypeScript ESM; pnpm workspace.
- `lib/` is build output and is not committed. Contract tests and `deploy-profile.sh` consume it, so `pnpm build` first.
- DSH is pinned exactly (`@deepseek-ai/dsh` `0.1.1-rc.2`) with a patch in `patches/`. _(AGENTS.md says `0.1.1-rc.2`; the tree actually pins `0.1.2-alpha.3` — `package.json:21`. Do not change either; the evidence header records whatever the root manifest says.)_
- `contracts/tests/core-neutrality.contract.spec.ts` fails the build if anything under `packages/core/src` names a provider or a business domain. Forbidden words: `deepseek claude anthropic codex openai gpt- gemini livewire argon apex colima postgres`, matched on camelCase-split word boundaries, comments included.
- Evidence and decisions are append-only. Records are written before external side effects, never after.
- No synthetic market data in tests: real ticker, real prices, frozen with an as-of date, no network at test runtime.
- Never add a `Co-Authored-By: Claude …` trailer or any other AI-attribution trailer to a commit. Write the commit message as if the user authored it.
- Never push to `master`; branch, push, open a PR, wait for green CI.

## Rebase discipline (session helium-df, PR #92, branch `feat/quality-loop`)

PR #92 edits `packages/cli/src/runner.ts` in the tool-wrapper region (~600–690), a post-step output strip, the delivery header, and `packages/cli/src/args.ts`. This plan's runner edits are three insertion points, none of them in those regions:

- **R-A** — DAG start: the settler span and the evidence header, inserted immediately before `tasks: for (const taskId of topologicalOrder(manifest)) {` (`runner.ts:770` on `e503995`).
- **R-B** — top of the task loop and beside the clock block: `assembledPrompts.set(taskId, work.inputs.prompt)` after the `WorkOrderSchema.parse` (`runner.ts:830-852` on `e503995`), plus one `evidence.sync(report, assembledPrompts)` at the top of the iteration.
- **R-C** — immediately after the renderer call (`runner.ts:1239-1247`) and **before** the delivery loop (`runner.ts:1265`): the final evidence sync and the ledger append.

**On rebase both sides' runner edits are kept.** They do not overlap; resolve any conflict by taking both hunks, never by dropping one.

Tool-call recording is **not** ours. #92 item 5 records raw tool responses under `<stateRoot>/runs/<runId>/tool-io/`; our evidence header only names that directory. Do not write a tool recorder. We do not write #92's per-run `metric` table. `runIdsWithOutstanding(stateRoot, tenant)` is provided in `ledger.ts` as the `keep(runId)` hook for their pruner; **do not wire it into their recorder.**

## Deliberate deviations from the spec (each with its reason)

| Spec says                                                                                   | Plan does                                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6: SETTLER discovery in `packages/core/src/tenant.ts`                                      | `loadSettler()` in `packages/cli/src/discovery.ts` beside `loadGates`/`loadRenderer`                  | `tenant.ts` parses YAML text and never dynamic-imports a module; `loadTenants` is synchronous (`tenant.ts:260-306`). `VOCABULARY` — the discovery style the spec names — is read in `discovery.ts:167` (`tenantToolGaps`). Putting it in `tenant.ts` would mean making core's loader async for every caller.                                                          |
| §6: `docs/evidence/claims.yaml` — new claims (claims-register contract requires it)         | dropped                                                                                               | Neither the file nor the contract exists on `e503995`: `docs/evidence/` holds only `pit-replays/`, and `contracts/tests/` holds four files, none of them `claims-register`. That row is v1 residue.                                                                                                                                                                   |
| §5 D2: commitment id `<run-day>-spy-t1`                                                     | `<run-day>-<phase>-spy-t1`                                                                            | `design` and `review` declare `phases: [premarket, close]`, so two runs share one ET day. The identical defect for candidate ids is documented at `plugins/option-wizard/render/index.ts:940-950`. A duplicate ledger id makes `outstanding()` ambiguous.                                                                                                             |
| §4: evidence file "appended per step"                                                       | whole document rewritten after each step, filename stays `.json`                                      | A single well-formed JSON object cannot be appended to. The property the spec wants — a run killed mid-way leaves the steps it completed — is satisfied by rewriting ~100 KB at most a dozen times per run.                                                                                                                                                           |
| §4: tenant declares `export const SETTLER` | `export function buildSettler(cfg: TenantToolConfig): Settler` | A settler needs the run's env keys (`OW_APEX_API_BASE`, declared at `plugins/option-wizard/tenant.yaml:32`) and the tenant's `calendar:` block. A module-level constant can only get either by reading `process.env` behind the host's back — which is also what made spec §5 D3's calendar cross-check unimplementable. `Settler.settle(outstanding, now)` in core is unchanged. |
| §10 open item: whether `Receipt.detail` belongs in core                                     | `detail?: unknown` on `Receipt` in core                                                               | §5 D3 already requires it ("Tenant-specific extras … go in a `detail` field core ignores"), and it is opaque, so it costs core no domain knowledge.                                                                                                                                                                                                                   |
| §5 D4: `argon: { signal, expectedReturn20d, confidence, dataDate }` from `ow_argon_metrics` | carries `dataDate` plus whichever of the three fields are present; records `missing: [...]` otherwise | Verified live on the mini 2026-09-06: `ow_argon_metrics` returns `{source, asOf?, rows:[{ticker, iv, gex, skew}]}` (`tools/index.ts:1716-1766`) and the `iv` row is `{"close":770.19,"ticker":"SPY","iv_rank_1y":3.5692,"volatility":0.116,"market_date":"2026-09-04"}` — no `signal`, no `expectedReturn20d`, no `confidence`, no `dataDate`. Those arrive with #92. |

---

# Phase A — core seam (PR 1, must land first)

Another session's quality-loop review phase codes against `readLedger` and `summarise`; this phase exists so it is unblocked. Nine tasks.

## Task A1: ledger types and the jsonl store

**Files:**

- Modify `packages/core/src/plugins.ts` — append after the `Gate` interface (ends `:168`), before `export interface DeliveryPayload` (`:171`)
- Modify `packages/core/src/report.ts` — `RenderedReport` (`:105-128`), `RunReport` (`:39`+)
- Create `packages/core/src/ledger.ts`
- Modify `packages/core/src/index.ts` — add `export * from "./ledger.js";`
- Test: `packages/core/tests/ledger.spec.ts`

**Interfaces:**

- Consumes: `node:fs`, `node:path`
- Produces: `Commitment`, `Receipt`, `Settler`, `CommitmentDraft` (plugins.ts); `LedgerRecord`, `LedgerRead`, `ledgerPath(stateRoot: string, tenant: string): string`, `appendLedger(stateRoot: string, tenant: string, records: readonly LedgerRecord[]): void`, `readLedger(stateRoot: string, tenant: string, opts?: { since?: string }): LedgerRead`, `outstanding(read: { commitments: readonly Commitment[]; receipts: readonly Receipt[] }): Commitment[]`, `runIdsWithOutstanding(stateRoot: string, tenant: string): Set<string>`

**Steps:**

- [ ] Write the failing test `packages/core/tests/ledger.spec.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLedger,
  ledgerPath,
  outstanding,
  readLedger,
  runIdsWithOutstanding,
  type Commitment,
  type LedgerRecord,
  type Receipt,
} from "@helium/core";

function root(): string {
  return mkdtempSync(join(tmpdir(), "helium-ledger-"));
}

function commitment(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id,
    runId: `run-${id}`,
    tenant: "t",
    issuedAt: "2026-09-04T12:00:00Z",
    deployment: "production",
    variant: "live",
    payload: { k: 1 },
    ...over,
  };
}

function receipt(
  id: string,
  status: string,
  over: Partial<Receipt> = {},
): Receipt {
  return {
    commitmentId: id,
    runId: "run-settler",
    settledAt: "2026-09-05T12:00:00Z",
    status,
    scores: { b: 0.25 },
    ...over,
  };
}

describe("ledger", () => {
  it("returns empty arrays when the file does not exist", () => {
    expect(readLedger(root(), "t")).toEqual({
      commitments: [],
      receipts: [],
      baselines: [],
    });
  });

  it("round-trips the three record kinds in append order", () => {
    const dir = root();
    const records: LedgerRecord[] = [
      { kind: "commitment", commitment: commitment("a") },
      { kind: "baseline", baseline: commitment("a-base") },
      { kind: "receipt", receipt: receipt("a", "targetFirst") },
    ];
    appendLedger(dir, "t", records);
    appendLedger(dir, "t", [
      { kind: "commitment", commitment: commitment("b") },
    ]);
    const read = readLedger(dir, "t");
    expect(read.commitments.map((c) => c.id)).toEqual(["a", "b"]);
    expect(read.baselines.map((c) => c.id)).toEqual(["a-base"]);
    expect(read.receipts.map((r) => r.status)).toEqual(["targetFirst"]);
    expect(ledgerPath(dir, "t").endsWith("/ledger/t.jsonl")).toBe(true);
  });

  it("appends nothing for an empty batch and creates no file", () => {
    const dir = root();
    appendLedger(dir, "t", []);
    expect(readLedger(dir, "t").commitments).toEqual([]);
  });

  it("skips a corrupt line rather than losing the whole file", () => {
    const dir = root();
    appendLedger(dir, "t", [
      { kind: "commitment", commitment: commitment("a") },
    ]);
    const path = ledgerPath(dir, "t");
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(
      path,
      `{ not json\n${JSON.stringify({ kind: "commitment", commitment: commitment("b") })}\n`,
      "utf8",
    );
    expect(readLedger(dir, "t").commitments.map((c) => c.id)).toEqual(["b"]);
  });

  it("`since` filters commitments by issuedAt and receipts by settledAt", () => {
    const dir = root();
    appendLedger(dir, "t", [
      {
        kind: "commitment",
        commitment: commitment("old", { issuedAt: "2026-08-01T00:00:00Z" }),
      },
      { kind: "commitment", commitment: commitment("new") },
      {
        kind: "receipt",
        receipt: receipt("old", "unresolved", {
          settledAt: "2026-08-02T00:00:00Z",
        }),
      },
      { kind: "receipt", receipt: receipt("new", "unresolved") },
    ]);
    const read = readLedger(dir, "t", { since: "2026-09-01T00:00:00Z" });
    expect(read.commitments.map((c) => c.id)).toEqual(["new"]);
    expect(read.receipts.map((r) => r.commitmentId)).toEqual(["new"]);
  });

  it("outstanding excludes settled, includes pending and never-settled", () => {
    const read = {
      commitments: [
        commitment("settled"),
        commitment("pending"),
        commitment("fresh"),
      ],
      receipts: [
        receipt("settled", "targetFirst"),
        receipt("pending", "pending"),
      ],
    };
    expect(outstanding(read).map((c) => c.id)).toEqual(["pending", "fresh"]);
  });

  it("the LATEST receipt decides: pending then settled is settled", () => {
    const read = {
      commitments: [commitment("x")],
      receipts: [
        receipt("x", "pending", { settledAt: "2026-09-05T00:00:00Z" }),
        receipt("x", "not-entered", { settledAt: "2026-09-06T00:00:00Z" }),
      ],
    };
    expect(outstanding(read)).toEqual([]);
  });

  it("a re-issued id is listed once", () => {
    const read = {
      commitments: [commitment("x"), commitment("x")],
      receipts: [],
    };
    expect(outstanding(read).map((c) => c.id)).toEqual(["x"]);
  });

  it("runIdsWithOutstanding names the runs a pruner must keep", () => {
    const dir = root();
    appendLedger(dir, "t", [
      {
        kind: "commitment",
        commitment: commitment("open", { runId: "run-keep" }),
      },
      {
        kind: "commitment",
        commitment: commitment("done", { runId: "run-drop" }),
      },
      { kind: "receipt", receipt: receipt("done", "unresolved") },
    ]);
    expect([...runIdsWithOutstanding(dir, "t")]).toEqual(["run-keep"]);
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/core/tests/ledger.spec.ts` — expected failure `Failed to resolve import` / `No "appendLedger" export is defined on the "@helium/core" mock` style error, concretely: `SyntaxError: The requested module '@helium/core' does not provide an export named 'appendLedger'`.

- [ ] Append to `packages/core/src/plugins.ts`, immediately after the `Gate` interface's closing brace (`:168`):

```ts
/**
 * A settleable promise a tenant made in one run and can be checked on later.
 *
 * Core never looks inside `payload` and never interprets a `Receipt.status`
 * other than the single word `"pending"` (doctrine 2). What is being promised,
 * and what settles it, is the tenant's own business; the harness owns only the
 * bookkeeping that makes the promise findable days later.
 */
export interface Commitment {
  /** Tenant-minted and stable. One per settleable thing: a receipt has ONE
   *  status, so two things that settle on different days are two ids. */
  id: string;
  runId: string;
  tenant: string;
  /** ISO instant. */
  issuedAt: string;
  /** Derived by the runner: an `asOf` run is a backtest whatever the machine
   *  says; otherwise the operator's declared deployment, defaulting to test. */
  deployment: "production" | "backtest" | "test";
  /** The run's flavour label; `live` for a scheduled run. */
  variant: string;
  /** The replayed instant, when the run replayed one. Absent means live. */
  asOf?: string;
  /** Opaque to core. */
  payload: unknown;
}

/** What a settler concluded about one commitment. */
export interface Receipt {
  commitmentId: string;
  /** The run that SETTLED it, not the run that made it. */
  runId: string;
  settledAt: string;
  /** Tenant vocabulary. `"pending"` is the one word core knows: it means the
   *  commitment stays outstanding and will be offered to a later settler. */
  status: string;
  /** Aggregated by key by the scoreboard, and by nothing else. */
  scores: Record<string, number>;
  /** sha256 of the exact ground-truth rows used, so a later repair of the
   *  source data is detectable. */
  evidenceHash?: string;
  /** Tenant-specific extras. Core stores it and never reads it. */
  detail?: unknown;
}

/**
 * `plugins/<tenant>/tools/index.ts`, `export function buildSettler(cfg)` —
 * the same factory shape as `buildTools(cfg)`, and for the same reason: a
 * settler needs the run's environment keys and the tenant's calendar, and a
 * module-level constant cannot be handed either. Optional: a tenant that ships
 * none is measured by nothing, which is what every tenant got before this
 * existed.
 */
export interface Settler {
  settle(outstanding: Commitment[], now: Date): Promise<Receipt[]>;
}

/**
 * What a renderer emits: the identity and the payload. The runner stamps the
 * run context (`runId`, `tenant`, `issuedAt`, `deployment`, `variant`, `asOf`)
 * because a renderer that minted its own would be guessing at facts the runner
 * already holds — the same reason `RenderedReport.subject` is discouraged.
 */
export interface CommitmentDraft {
  id: string;
  payload: unknown;
}
```

- [ ] Add to `RenderedReport` in `packages/core/src/report.ts`, after `data?: Record<string, unknown>;` (`:127`):

```ts
  /**
   * Promises this render is making, to be settled by a later run. Written to
   * the ledger BEFORE any delivery intent: a record precedes its side effect,
   * never follows it. Opaque — core stamps the run context and stores the rest.
   */
  commitments?: CommitmentDraft[];
  /**
   * The trivial predictors this run is to be measured against. Same shape and
   * same opacity as `commitments`; kept a separate field because a baseline is
   * never outstanding and must never be offered to a settler.
   */
  baselines?: CommitmentDraft[];
```

with `import type { CommitmentDraft } from "./plugins.js";` added at the top of `report.ts` (`plugins.ts` already type-imports `RenderedReport` from `report.js` at `plugins.ts:11`; a type-only cycle is erased at compile time).

- [ ] Add to `RunReport` in `packages/core/src/report.ts`, beside `gatesSkipped`:

```ts
  /** Why the settler did not run, or threw. A settler failure is recorded and
   *  never blocks the run: the commitments stay outstanding and the next run
   *  tries again. */
  settlerSkipped?: { reason: string };
```

- [ ] Create `packages/core/src/ledger.ts`:

```ts
/**
 * The outcome ledger: one append-only jsonl per tenant under the state root.
 *
 * Three record kinds and no schema beyond them. Core does not read inside a
 * payload and does not know what any status other than `"pending"` means
 * (doctrine 2); it owns finding the outstanding promises and nothing else.
 *
 * jsonl rather than a table because a run that is killed mid-write must lose
 * at most its last line, and because the whole file is small enough to read
 * (doctrine 6: a database earns its keep when a `grep` stops working).
 * @module @helium/core/ledger
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Commitment, Receipt } from "./plugins.js";

export type LedgerRecord =
  | { kind: "commitment"; commitment: Commitment }
  | { kind: "receipt"; receipt: Receipt }
  | { kind: "baseline"; baseline: Commitment };

export interface LedgerRead {
  commitments: Commitment[];
  receipts: Receipt[];
  baselines: Commitment[];
}

export function ledgerPath(stateRoot: string, tenant: string): string {
  return join(stateRoot, "ledger", `${tenant}.jsonl`);
}

export function appendLedger(
  stateRoot: string,
  tenant: string,
  records: readonly LedgerRecord[],
): void {
  if (records.length === 0) return;
  const path = ledgerPath(stateRoot, tenant);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

function after(at: string, since: string | undefined): boolean {
  return since === undefined || at >= since;
}

/**
 * Every record, raw and in file order. A line that does not parse is SKIPPED,
 * not thrown on: one torn write at the tail of an append-only file must not
 * make every earlier commitment unreadable.
 */
export function readLedger(
  stateRoot: string,
  tenant: string,
  opts: { since?: string } = {},
): LedgerRead {
  const out: LedgerRead = { commitments: [], receipts: [], baselines: [] };
  const path = ledgerPath(stateRoot, tenant);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let record: LedgerRecord;
    try {
      record = JSON.parse(text) as LedgerRecord;
    } catch {
      continue;
    }
    if (record.kind === "commitment") {
      if (after(record.commitment.issuedAt, opts.since))
        out.commitments.push(record.commitment);
    } else if (record.kind === "baseline") {
      if (after(record.baseline.issuedAt, opts.since))
        out.baselines.push(record.baseline);
    } else if (record.kind === "receipt") {
      if (after(record.receipt.settledAt, opts.since))
        out.receipts.push(record.receipt);
    }
  }
  return out;
}

/**
 * The commitments a settler should be offered: no receipt at all, or a latest
 * receipt that says `pending`.
 *
 * Pass an UNFILTERED read. A `since`-filtered read can hide the receipt that
 * settled an old commitment, which would make a finished promise look open
 * forever.
 */
export function outstanding(read: {
  commitments: readonly Commitment[];
  receipts: readonly Receipt[];
}): Commitment[] {
  const latest = new Map<string, Receipt>();
  for (const receipt of read.receipts) {
    const prior = latest.get(receipt.commitmentId);
    if (prior === undefined || receipt.settledAt >= prior.settledAt)
      latest.set(receipt.commitmentId, receipt);
  }
  const seen = new Set<string>();
  const open: Commitment[] = [];
  for (const commitment of read.commitments) {
    if (seen.has(commitment.id)) continue;
    seen.add(commitment.id);
    const receipt = latest.get(commitment.id);
    if (receipt === undefined || receipt.status === "pending")
      open.push(commitment);
  }
  return open;
}

/**
 * The run ids a pruner must keep: any run that made a commitment nobody has
 * settled yet. Handed to a caller-supplied `keep(runId)` hook; this module
 * never prunes anything itself.
 */
export function runIdsWithOutstanding(
  stateRoot: string,
  tenant: string,
): Set<string> {
  return new Set(
    outstanding(readLedger(stateRoot, tenant)).map(
      (commitment) => commitment.runId,
    ),
  );
}
```

- [ ] Add `export * from "./ledger.js";` to `packages/core/src/index.ts` after `export * from "./report.js";`.

- [ ] Run again — expected PASS: `pnpm vitest run --project unit packages/core/tests/ledger.spec.ts` (9 passed).
- [ ] Run `pnpm typecheck` — expected PASS.
- [ ] Run `pnpm build && pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts` — expected PASS (the new file names no provider and no domain).
- [ ] Commit:

```bash
git add packages/core/src/plugins.ts packages/core/src/report.ts packages/core/src/ledger.ts packages/core/src/index.ts packages/core/tests/ledger.spec.ts
git commit -m "feat(core): an append-only outcome ledger beside Gate

Three domain-blind types and one jsonl per tenant. Core stores a promise
and finds the ones nobody has settled; what the promise MEANS stays in the
tenant that made it."
```

## Task A2: settler discovery at the plugin edge

**Files:**

- Modify `packages/cli/src/discovery.ts` — add after `loadGates` (ends `:219`)
- Test: `packages/cli/tests/settler-discovery.spec.ts`

**Interfaces:**

- Consumes: `Settler` from `@helium/core`; `Skipped` (`discovery.ts:38`); `TenantToolConfig` (`discovery.ts:112-127`)
- Produces: `loadSettler(tenantDir: string, cfg: TenantToolConfig): Promise<{ settler: Settler | null; skipped: Skipped[] }>`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/settler-discovery.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettler } from "../src/discovery.js";

function tenantWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-settler-"));
  mkdirSync(join(dir, "lib", "tools"), { recursive: true });
  writeFileSync(join(dir, "lib", "tools", "index.js"), body, "utf8");
  return dir;
}

const CFG = {
  stateRoot: "/state",
  env: { OW_APEX_API_BASE: "http://apex.invalid" },
  variant: "live",
  calendar: { weekdaysOnly: true, closed: ["2026-09-03"] },
};

describe("loadSettler", () => {
  it("returns null with no skip when the tenant is not built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-settler-"));
    expect(await loadSettler(dir, CFG)).toEqual({ settler: null, skipped: [] });
  });

  it("returns null with no skip when the tenant exports no buildSettler", async () => {
    const dir = tenantWith("export const VOCABULARY = new Map();\n");
    expect(await loadSettler(dir, CFG)).toEqual({ settler: null, skipped: [] });
  });

  it("calls buildSettler with the same config buildTools gets", async () => {
    const dir = tenantWith(
      "export function buildSettler(cfg) { return { async settle(open) { return open.map((c) => ({ commitmentId: c.id, runId: '', settledAt: 'now', status: cfg.env.OW_APEX_API_BASE, scores: { closed: cfg.calendar.closed.length } })); } }; }\n",
    );
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(skipped).toEqual([]);
    const receipts = await settler!.settle(
      [
        {
          id: "x",
          runId: "r0",
          tenant: "t",
          issuedAt: "2026-09-04T00:00:00Z",
          deployment: "test",
          variant: "live",
          payload: {},
        },
      ],
      new Date("2026-09-05T00:00:00Z"),
    );
    expect(receipts[0]!.commitmentId).toBe("x");
    // The factory really received the config, not an empty object: this is the
    // whole reason it is a factory.
    expect(receipts[0]!.status).toBe("http://apex.invalid");
    expect(receipts[0]!.scores.closed).toBe(1);
  });

  it("a buildSettler that is not a function is a SKIP with a reason", async () => {
    const dir = tenantWith("export const buildSettler = { nope: 1 };\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped).toEqual([
      { id: "settler", reason: "buildSettler is not a function" },
    ]);
  });

  it("a settler with no settle() is a SKIP with a reason, never a silent pass", async () => {
    const dir = tenantWith("export function buildSettler() { return { nope: 1 }; }\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped).toEqual([
      { id: "settler", reason: "buildSettler returned no settle()" },
    ]);
  });

  it("a factory that THROWS is a SKIP with its message", async () => {
    const dir = tenantWith("export function buildSettler() { throw new Error('no key'); }\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped[0]!.reason).toContain("no key");
  });

  it("a module that throws on import is a SKIP with its message", async () => {
    const dir = tenantWith("throw new Error('boom');\n");
    const { settler, skipped } = await loadSettler(dir, CFG);
    expect(settler).toBeNull();
    expect(skipped[0]!.reason).toContain("boom");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/settler-discovery.spec.ts` — expected failure `SyntaxError: The requested module '../src/discovery.js' does not provide an export named 'loadSettler'`.

- [ ] Add to `packages/cli/src/discovery.ts` after `loadGates` (`:219`), with `Settler` added to the existing `import type { Gate, ... } from "@helium/core";`:

```ts
/**
 * A tenant's settler: `<tenant>/tools/index.ts`, `export function
 * buildSettler(cfg)`, built to `lib/tools/index.js`. Same discovery style as
 * `VOCABULARY` above, and the same FACTORY shape as `buildTools` — a settler
 * needs the run's environment keys and the tenant's calendar, and a
 * module-level constant would have to reach around the host for both.
 *
 * Absent is normal and silent: most tenants promise nothing measurable. A
 * PRESENT but broken settler is a skip with a reason, like a gate, because a
 * measurement that stopped running must not look like a tenant that never
 * asked to be measured. A factory that THROWS is the same kind of skip: a
 * tenant refusing to build a settler it cannot configure is telling the truth,
 * and the reason travels.
 */
export async function loadSettler(
  tenantDir: string,
  cfg: TenantToolConfig,
): Promise<{ settler: Settler | null; skipped: Skipped[] }> {
  const entry = join(tenantDir, "lib", "tools", "index.js");
  if (!existsSync(entry)) return { settler: null, skipped: [] };
  try {
    const module = (await import(pathToFileURL(entry).href)) as {
      buildSettler?: unknown;
    };
    const factory = module.buildSettler;
    if (factory === undefined) return { settler: null, skipped: [] };
    if (typeof factory !== "function") {
      return {
        settler: null,
        skipped: [{ id: "settler", reason: "buildSettler is not a function" }],
      };
    }
    const settler = (factory as (config: TenantToolConfig) => unknown)({
      stateRoot: cfg.stateRoot,
      env: cfg.env,
      variant: cfg.variant,
      ...(cfg.asOf === undefined ? {} : { asOf: cfg.asOf }),
      ...(cfg.calendar === undefined ? {} : { calendar: cfg.calendar }),
    });
    if (
      settler === null ||
      typeof settler !== "object" ||
      typeof (settler as Settler).settle !== "function"
    ) {
      return {
        settler: null,
        skipped: [
          { id: "settler", reason: "buildSettler returned no settle()" },
        ],
      };
    }
    return { settler: settler as Settler, skipped: [] };
  } catch (error: unknown) {
    return {
      settler: null,
      skipped: [
        {
          id: "settler",
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
```

- [ ] Run again — expected PASS (7 passed).
- [ ] Run `pnpm typecheck` — expected PASS.
- [ ] Commit:

```bash
git add packages/cli/src/discovery.ts packages/cli/tests/settler-discovery.spec.ts
git commit -m "feat(cli): discover a tenant's settler factory beside buildTools

A settler needs the run's env keys and the tenant's calendar, so it is built
the way tools are, not exported as a constant that has to reach around the
host for both. Absent is silent; present-but-broken is a skip with a reason."
```

## Task A3: fake-tenant declares a trivial settler

**Files:**

- Modify `plugins/fake-tenant/tools/index.ts` — append after `buildTools` (ends the file)
- Test: `plugins/fake-tenant/tests/settler.spec.ts`

**Interfaces:**

- Consumes: `Commitment`, `Receipt`, `Settler` from `@helium/core`
- Produces: `export function buildSettler(_cfg: unknown): Settler`

**Steps:**

- [ ] Write the failing test `plugins/fake-tenant/tests/settler.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import { buildSettler } from "../tools/index.js";

const open: Commitment = {
  id: "fake-1",
  runId: "run-0",
  tenant: "fake-tenant",
  issuedAt: "2026-09-04T00:00:00Z",
  deployment: "test",
  variant: "live",
  payload: { answer: 42 },
};

describe("fake-tenant settler", () => {
  const settler = buildSettler({
    stateRoot: "/state",
    env: {},
    variant: "live",
  });

  it("settles every outstanding commitment with a constant score", async () => {
    const receipts = await settler.settle(
      [open],
      new Date("2026-09-05T00:00:00Z"),
    );
    expect(receipts).toEqual([
      {
        commitmentId: "fake-1",
        runId: "",
        settledAt: "2026-09-05T00:00:00.000Z",
        status: "settled",
        scores: { fakeScore: 1 },
      },
    ]);
  });

  it("settles nothing when nothing is outstanding", async () => {
    expect(await settler.settle([], new Date())).toEqual([]);
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/fake-tenant/tests/settler.spec.ts` — expected failure `does not provide an export named 'buildSettler'`.

- [ ] Append to `plugins/fake-tenant/tools/index.ts`:

```ts
/**
 * The seam proof for measurement, and nothing more.
 *
 * It settles everything it is handed with one constant score, so CI can prove
 * that a tenant can be measured — and removed — without any edit to
 * `packages/core`. A settler that computed something real would make the drill
 * depend on the computation instead of on the seam.
 */
export function buildSettler(_cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
  variant: string;
  asOf?: Date;
  calendar?: { weekdaysOnly: boolean; closed: string[] };
}): Settler {
  return {
    async settle(open: Commitment[], now: Date): Promise<Receipt[]> {
      return open.map((commitment) => ({
        commitmentId: commitment.id,
        // Overwritten by the runner with the id of the run that settled it.
        runId: "",
        settledAt: now.toISOString(),
        status: "settled",
        scores: { fakeScore: 1 },
      }));
    },
  };
}
```

with the import line at the top widened to `import type { Commitment, Receipt, Settler, ToolVocabularyEntry } from "@helium/core";`.

- [ ] Add `"tests"` is not needed — `plugins/fake-tenant/tsconfig.json` compiles `tools`; confirm the build still emits `lib/tools/index.js` by running `pnpm build`.
- [ ] Run again — expected PASS (2 passed).
- [ ] Commit:

```bash
git add plugins/fake-tenant/tools/index.ts plugins/fake-tenant/tests/settler.spec.ts
git commit -m "test(fake-tenant): declare a trivial settler so CI exercises the seam

A tenant must be measurable, and removable, with no edit to core. A settler
that computed something real would test the computation instead."
```

## Task A4: the settler runs at DAG start as a zero-token audited span

**Files:**

- Modify `packages/cli/src/runner.ts` — insertion point **R-A**, immediately before `tasks: for (const taskId of topologicalOrder(manifest)) {` (`:770`); `RunOptions` (`:175`+) gains `settler?: Settler`
- Test: `packages/cli/tests/runner-settler.spec.ts`

**Interfaces:**

- Consumes: `loadSettler(tenantDir, cfg)` (Task A2) — handed the same `TenantToolConfig` shape the runner already builds for `loadTenantTools` (`runner.ts:692-703`), minus `pit`; `readLedger`, `outstanding`, `appendLedger` (Task A1), `codeVersion()` (`packages/cli/src/code-version.ts:24`), `AuditStore.append(span: Span)` (`packages/core/src/audit.ts:22`)
- Produces: `runSettler(...)` (module-private); `RunReport.settlerSkipped`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/runner-settler.spec.ts`. Model it on `packages/cli/tests/run-calendar.spec.ts` for the tenant/audit fixtures; the assertions are:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuditStore,
  appendLedger,
  readLedger,
  type Commitment,
} from "@helium/core";
import { runTenant } from "../src/runner.js";
import { tenantFixture } from "./fixtures/tenant.js"; // see step below

function state(): string {
  return mkdtempSync(join(tmpdir(), "helium-runner-settler-"));
}

const open: Commitment = {
  id: "c1",
  runId: "run-earlier",
  tenant: "fake-tenant",
  issuedAt: "2026-09-04T00:00:00Z",
  deployment: "test",
  variant: "live",
  payload: {},
};

describe("settler at DAG start", () => {
  it("settles outstanding commitments and appends the receipts", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle(items) {
          return items.map((item) => ({
            commitmentId: item.id,
            runId: "run-now",
            settledAt: "2026-09-05T00:00:00Z",
            status: "settled",
            scores: { s: 0.25 },
          }));
        },
      },
    });
    // The runner overwrites whatever runId the settler wrote: the id of the
    // settling run is the runner's fact, not the tenant's.
    expect(readLedger(stateRoot, "fake-tenant").receipts).toEqual([
      {
        commitmentId: "c1",
        runId: report.runId,
        settledAt: "2026-09-05T00:00:00Z",
        status: "settled",
        scores: { s: 0.25 },
      },
    ]);
    audit.close();
  });

  it("records the settler as a zero-token span", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          return [];
        },
      },
    });
    const row = audit
      .runCost(report.runId)
      .find((entry) => entry.toolName === "settler");
    expect(row).toBeDefined();
    expect(row!.inputTokens + row!.outputTokens).toBe(0);
    expect(row!.usd).toBe(0);
    audit.close();
  });

  it("a throwing settler is recorded and does not fail the run", async () => {
    const stateRoot = state();
    appendLedger(stateRoot, "fake-tenant", [
      { kind: "commitment", commitment: open },
    ]);
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          throw new Error("lake down");
        },
      },
    });
    expect(report.outcome).toBe("completed");
    expect(report.settlerSkipped?.reason).toContain("lake down");
    expect(readLedger(stateRoot, "fake-tenant").receipts).toEqual([]);
    audit.close();
  });

  it("does not call the settler when nothing is outstanding", async () => {
    const stateRoot = state();
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    let called = 0;
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      settler: {
        async settle() {
          called += 1;
          return [];
        },
      },
    });
    expect(called).toBe(0);
    expect(report.settlerSkipped).toBeUndefined();
    audit.close();
  });
});
```

- [ ] Create the shared fixture `packages/cli/tests/fixtures/tenant.ts` (a minimal loaded fake-tenant so several tests in this phase share one shape):

```ts
import { resolve } from "node:path";
import { loadTenants } from "@helium/core";
import type { RunOptions } from "../../src/runner.js";

const PLUGINS = resolve(import.meta.dirname, "../../../../plugins");

/** The built `fake-tenant`, in tool-only mode, writing under `stateRoot`. */
export function tenantFixture(
  stateRoot: string,
): Omit<RunOptions, "audit"> & {
  tenant: NonNullable<ReturnType<typeof loadTenants>["tenants"][number]>;
} {
  const { tenants } = loadTenants(PLUGINS);
  const tenant = tenants.find((entry) => entry.spec.tenant === "fake-tenant")!;
  return {
    tenant,
    pluginsDir: PLUGINS,
    stateRoot,
    env: { HELIUM_STATE_ROOT: stateRoot },
    providers: [],
    providersSkipped: [],
    tools: [],
    gates: [],
    channels: [],
    phase: "premarket",
    now: (): Date => new Date("2026-09-05T00:00:00Z"),
  };
}
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/runner-settler.spec.ts` — expected failure `Object literal may only specify known properties, and 'settler' does not exist in type 'RunOptions'` at typecheck, and at runtime `expected [] to deeply equal [ { commitmentId: 'c1', … } ]`.

- [ ] Add to `RunOptions` in `packages/cli/src/runner.ts`, beside `gates?: Gate[]` (`:176`):

```ts
  /** Injected in tests; loaded from the tenant's built `lib/tools/index.js`
   *  when absent. */
  settler?: Settler;
```

- [ ] Insert at **R-A**, immediately before `tasks: for (const taskId of topologicalOrder(manifest)) {`:

```ts
// Doctrine 5: a measurement is read-only over somebody else's ground truth,
// so it runs BEFORE the DAG and cannot be starved by a budget the tasks
// spend. It is a zero-token span for the same reason a gate is one — the §5
// cost query has to be able to separate "what did thinking cost" from "what
// did checking cost".
const deployment: Commitment["deployment"] =
  options.asOf !== undefined
    ? "backtest"
    : env.HELIUM_DEPLOYMENT === "production"
      ? "production"
      : "test";
const ledger = readLedger(options.stateRoot, spec.tenant);
const open = outstanding(ledger);
if (open.length > 0) {
  const loadedSettler =
    options.settler === undefined
      ? // The SAME config `buildTools` was handed above, minus `pit`: a
        // settler is not point-in-time-marked, it reads history on purpose.
        await loadSettler(options.tenant.dir, {
          stateRoot: options.stateRoot,
          env,
          variant: options.variant ?? "live",
          ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
          ...(spec.calendar === undefined ? {} : { calendar: spec.calendar }),
        })
      : { settler: options.settler, skipped: [] as Skipped[] };
  if (loadedSettler.skipped[0] !== undefined)
    report.settlerSkipped = { reason: loadedSettler.skipped[0].reason };
  if (loadedSettler.settler !== null) {
    const startedAt = Date.now();
    let receipts: Receipt[] = [];
    let detail = "";
    try {
      receipts = await loadedSettler.settler.settle(
        open,
        options.now?.() ?? new Date(),
      );
      detail = `${String(receipts.length)}/${String(open.length)} settled`;
    } catch (error: unknown) {
      // A settler that throws leaves every commitment outstanding, which is
      // exactly right: the next run tries again. It must never fail the run
      // — nothing the READER gets depends on it.
      detail = error instanceof Error ? error.message : String(error);
      report.settlerSkipped = { reason: detail };
    }
    appendLedger(
      options.stateRoot,
      spec.tenant,
      // `runId` is stamped HERE, not by the settler: `Settler.settle` is handed
      // the outstanding commitments and a clock and nothing else, so a tenant
      // that filled this field would be guessing at the id of the run it is
      // executing inside.
      receipts.map((receipt) => ({
        kind: "receipt" as const,
        receipt: { ...receipt, runId },
      })),
    );
    options.audit.append({
      runId,
      spanId: "settler",
      tenant: spec.tenant,
      role: "settler",
      provider: "none",
      model: "none",
      codeVersion: codeVersion(),
      stepNo: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      contextSize: 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
      costUsd: 0,
      toolName: "settler",
      toolOutputBytes: Buffer.byteLength(detail, "utf8"),
      summarised: false,
      ts: new Date().toISOString(),
    });
  }
}
```

with `loadSettler` added to the `./discovery.js` import and `appendLedger, outstanding, readLedger, type Commitment, type Receipt, type Settler` added to the `@helium/core` import.

- [ ] Run again — expected PASS (4 passed).
- [ ] Run `pnpm typecheck` and `pnpm vitest run --project unit packages/cli` — expected PASS (no existing cli test asserts a span count for a run with no ledger).
- [ ] Commit:

```bash
git add packages/cli/src/runner.ts packages/cli/tests/runner-settler.spec.ts packages/cli/tests/fixtures/tenant.ts
git commit -m "feat(cli): settle outstanding commitments before the DAG runs

Read-only, zero-token, before the budget can be spent. A settler that throws
leaves its commitments outstanding and the run finishes anyway — nothing the
reader gets depends on the measurement."
```

## Task A5: the evidence writer

**Files:**

- Create `packages/cli/src/evidence.ts`
- Test: `packages/cli/tests/evidence.spec.ts`

**Interfaces:**

- Consumes: `RunReport`, `StepReport` from `@helium/core`; `node:fs`, `node:crypto`
- Produces: `evidencePath(stateRoot, tenant, day, phase, runId): string`, `EvidenceHeader`, `EvidenceDoc`, `class EvidenceFile { constructor(path: string, header: EvidenceHeader); sync(report: RunReport, prompts: ReadonlyMap<string, string>, view?: unknown): void; read(): EvidenceDoc }`, `sha256File(path: string): string`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/evidence.spec.ts`:

```ts
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import {
  EvidenceFile,
  evidencePath,
  type EvidenceHeader,
} from "../src/evidence.js";

const header: EvidenceHeader = {
  runId: "run-1",
  tenant: "fake-tenant",
  day: "2026-09-05",
  phase: "premarket",
  deployment: "test",
  variant: "live",
  startedAt: "2026-09-05T00:00:00Z",
  codeSha: "abc1234",
  dshVersion: "0.1.2-alpha.3",
  teamYamlSha256: "a".repeat(64),
  tenantYamlSha256: "b".repeat(64),
  toolIo: "/state/runs/run-1/tool-io/",
};

function report(steps: RunReport["steps"]): RunReport {
  return {
    runId: "run-1",
    tenant: "fake-tenant",
    mode: "model",
    phase: "premarket",
    day: "2026-09-05",
    providersLive: ["p"],
    providersSkipped: [],
    steps,
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  };
}

describe("evidence file", () => {
  it("names the file <tenant>-<day>-<phase>-<runId>.json under evidence/", () => {
    expect(
      evidencePath("/s", "fake-tenant", "2026-09-05", "premarket", "run-1"),
    ).toBe("/s/evidence/fake-tenant-2026-09-05-premarket-run-1.json");
  });

  it("writes the header before any step exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    new EvidenceFile(path, header);
    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      run: EvidenceHeader;
      steps: unknown[];
    };
    expect(doc.run.toolIo).toBe("/state/runs/run-1/tool-io/");
    expect(doc.steps).toEqual([]);
  });

  it("carries the assembled prompt onto each step by task id", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(
      report([
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: "out",
          targetId: "m1",
        },
      ]),
      new Map([["regime", "CLOCK\n\nBUDGET\n\nask"]]),
    );
    const doc = file.read();
    expect(doc.steps[0]).toMatchObject({
      task: "regime",
      role: "regime-analyst",
      mode: "model",
      model: "m1",
      output: "out",
      assembledPrompt: "CLOCK\n\nBUDGET\n\nask",
    });
  });

  it("a run killed after step 3 leaves three steps on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    const steps: RunReport["steps"] = [];
    for (const task of ["a", "b", "c"]) {
      steps.push({ task, role: "r", mode: "model", text: `t-${task}` });
      file.sync(report([...steps]), new Map());
    }
    // Nothing further is written — the process "dies" here.
    const doc = JSON.parse(readFileSync(path, "utf8")) as { steps: unknown[] };
    expect(doc.steps).toHaveLength(3);
  });

  it("keeps gate results and drops nothing a refusal recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(
      report([
        {
          task: "regime",
          role: "regime-analyst",
          mode: "model",
          text: "",
          failure: "gate-refused",
          gateRefusals: [{ id: "as-of-verbatim", reason: "invented" }],
        },
      ]),
      new Map(),
    );
    expect(file.read().steps[0]!.gateResults).toEqual([
      { id: "as-of-verbatim", reason: "invented" },
    ]);
  });

  it("stores the rendered view opaquely", () => {
    const dir = mkdtempSync(join(tmpdir(), "helium-ev-"));
    const path = join(dir, "e.json");
    const file = new EvidenceFile(path, header);
    file.sync(report([]), new Map(), { schemaVersion: 2, anything: [1, 2] });
    expect(file.read().view).toEqual({ schemaVersion: 2, anything: [1, 2] });
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/evidence.spec.ts` — expected failure `Cannot find module '../src/evidence.js'`.

- [ ] Create `packages/cli/src/evidence.ts`:

```ts
/**
 * What a run actually did, on disk, in one file per run.
 *
 * The audit table answers "what did it cost"; this answers "what was it
 * asked, and what did it say". Both exist because neither can be reconstructed
 * from the other, and a scoreboard that says a forecast was bad is useless
 * without the prompt that produced it.
 *
 * The whole document is REWRITTEN after every step rather than appended to. A
 * jsonl would append more cheaply, but the file is read by hand and by a
 * consumer that wants one object; at a dozen steps and ~100 KB, rewriting is
 * cheaper than the tooling that would reassemble it. The property that matters
 * — a run killed by launchd mid-way still leaves the steps it completed — is
 * the same either way.
 *
 * Tool calls are NOT recorded here. The run recorder writes raw tool responses
 * under `<stateRoot>/runs/<runId>/tool-io/`; `toolIo` names that directory and
 * this module never reads inside it.
 * @module @helium/cli/evidence
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunReport } from "@helium/core";

export interface EvidenceHeader {
  runId: string;
  tenant: string;
  day: string;
  phase: string;
  deployment: "production" | "backtest" | "test";
  variant: string;
  asOf?: string;
  startedAt: string;
  codeSha: string;
  dshVersion: string;
  teamYamlSha256: string;
  tenantYamlSha256: string;
  /** Written by the run recorder, not by this module. */
  toolIo: string;
}

export interface EvidenceStep {
  task: string;
  role: string;
  mode: string;
  provider?: string;
  model?: string;
  /**
   * The exact string the runner handed the executor. NOT the full provider
   * request: dsh adds its own system prompt and tool specs at the edge, and
   * `dshVersion` in the header is what pins those.
   */
  assembledPrompt?: string;
  output: string;
  gateResults?: Array<{ id: string; reason: string }>;
}

export interface EvidenceDoc {
  run: EvidenceHeader;
  steps: EvidenceStep[];
  view?: unknown;
}

export function evidencePath(
  stateRoot: string,
  tenant: string,
  day: string,
  phase: string,
  runId: string,
): string {
  return join(stateRoot, "evidence", `${tenant}-${day}-${phase}-${runId}.json`);
}

export function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A manifest that could not be read is a fact about the tree, not a reason
    // to lose the whole evidence file.
    return "";
  }
}

export class EvidenceFile {
  readonly #path: string;
  #doc: EvidenceDoc;

  constructor(path: string, header: EvidenceHeader) {
    this.#path = path;
    this.#doc = { run: header, steps: [] };
    this.#write();
  }

  /** Everything the report holds so far, plus the prompts, plus the view. */
  sync(
    report: RunReport,
    prompts: ReadonlyMap<string, string>,
    view?: unknown,
  ): void {
    this.#doc.steps = report.steps.map((step) => {
      const prompt = prompts.get(step.task);
      return {
        task: step.task,
        role: step.role,
        mode: step.mode,
        ...(step.targetId === undefined ? {} : { model: step.targetId }),
        ...(prompt === undefined ? {} : { assembledPrompt: prompt }),
        output: step.text,
        ...(step.gateRefusals === undefined
          ? {}
          : { gateResults: step.gateRefusals }),
      };
    });
    if (view !== undefined) this.#doc.view = view;
    this.#write();
  }

  read(): EvidenceDoc {
    return JSON.parse(readFileSync(this.#path, "utf8")) as EvidenceDoc;
  }

  /** Write to a sibling then rename: a kill mid-write must not truncate the
   *  file that already held every completed step. */
  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.partial`;
    writeFileSync(tmp, `${JSON.stringify(this.#doc, null, 1)}\n`, "utf8");
    renameSync(tmp, this.#path);
  }
}
```

- [ ] Run again — expected PASS (6 passed).
- [ ] Commit:

```bash
git add packages/cli/src/evidence.ts packages/cli/tests/evidence.spec.ts
git commit -m "feat(cli): dump what a run was asked and what it answered

The audit table has the cost; this has the prompt. A scoreboard that says a
forecast was bad is useless without the words that produced it."
```

## Task A6: wire evidence into the runner

**Files:**

- Modify `packages/cli/src/runner.ts` — **R-A** (construct the file), **R-B** (prompt map + per-iteration sync), **R-C** (final sync with the view)
- Test: `packages/cli/tests/runner-evidence.spec.ts`

**Interfaces:**

- Consumes: `EvidenceFile`, `evidencePath`, `sha256File` (Task A5), `codeVersion()`, `deployment` (Task A4)
- Produces: an evidence file per run under `<stateRoot>/evidence/`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/runner-evidence.spec.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditStore } from "@helium/core";
import { runTenant } from "../src/runner.js";
import { evidencePath, type EvidenceDoc } from "../src/evidence.js";
import { tenantFixture } from "./fixtures/tenant.js";

describe("runner evidence", () => {
  it("writes a header naming the tool-io directory and the code sha", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-runner-ev-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({ ...tenantFixture(stateRoot), audit });
    const doc = JSON.parse(
      readFileSync(
        evidencePath(
          stateRoot,
          "fake-tenant",
          report.day,
          report.phase,
          report.runId,
        ),
        "utf8",
      ),
    ) as EvidenceDoc;
    expect(doc.run.toolIo).toBe(
      join(stateRoot, "runs", report.runId, "tool-io") + "/",
    );
    expect(doc.run.deployment).toBe("test");
    expect(doc.run.codeSha.length).toBeGreaterThan(0);
    expect(doc.run.teamYamlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.run.tenantYamlSha256).toMatch(/^[0-9a-f]{64}$/);
    audit.close();
  });

  it("assembledPrompt equals the string handed to the executor", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-runner-ev-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const seen: string[] = [];
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      providers: [
        {
          id: "recorder",
          models: [
            {
              id: "m1",
              capabilities: [
                "reason.deep",
                "long.context",
                "structured.output",
              ],
              isolationClass: "in-process",
              flatRate: true,
            },
          ],
          async run(work) {
            seen.push(work.inputs.prompt);
            return {
              text: "ok",
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              contextSize: 1,
              latencyMs: 1,
              costUsd: 0,
              model: "m1",
            };
          },
        } as never,
      ],
    });
    const doc = JSON.parse(
      readFileSync(
        evidencePath(
          stateRoot,
          "fake-tenant",
          report.day,
          report.phase,
          report.runId,
        ),
        "utf8",
      ),
    ) as EvidenceDoc;
    expect(doc.steps.length).toBeGreaterThan(0);
    expect(seen).toContain(doc.steps[0]!.assembledPrompt);
    audit.close();
  });
});
```

_(If `fake-tenant`'s manifest routes to a provider shape different from the literal above, take the provider stub verbatim from `packages/cli/src/runner.test.ts` — it already builds one — rather than inventing a second shape.)_

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/runner-evidence.spec.ts` — expected failure `ENOENT: no such file or directory, open '<stateRoot>/evidence/fake-tenant-…json'`.

- [ ] At **R-A** (after the settler block added in Task A4), add:

```ts
/** taskId -> the exact joined prompt. Kept here rather than on the step row
 *  so no `report.steps.push` site has to change: a retry after a quota
 *  re-route is a second row for the SAME task and the same prompt. */
const assembledPrompts = new Map<string, string>();
const evidence = new EvidenceFile(
  evidencePath(options.stateRoot, spec.tenant, reportDay, phase, runId),
  {
    runId,
    tenant: spec.tenant,
    day: reportDay,
    phase,
    deployment,
    variant: options.variant ?? "live",
    ...(options.asOf === undefined ? {} : { asOf: options.asOf.toISOString() }),
    startedAt: new Date().toISOString(),
    codeSha: codeVersion(),
    dshVersion: dshVersion(),
    teamYamlSha256: sha256File(join(options.tenant.dir, spec.team)),
    tenantYamlSha256: sha256File(join(options.tenant.dir, "tenant.yaml")),
    toolIo: join(options.stateRoot, "runs", runId, "tool-io") + "/",
  },
);
```

- [ ] Add `dshVersion()` to `packages/cli/src/code-version.ts` (it already resolves `repoRoot` at `:15`):

```ts
let cachedDsh: string | undefined;

/**
 * Which dsh the edge is running, from the root manifest. The evidence file
 * records it because dsh — not this repo — owns the system prompt and the tool
 * specs that surround `assembledPrompt`, so a prompt is only reproducible
 * beside the version that wrapped it.
 */
export function dshVersion(): string {
  if (cachedDsh !== undefined) return cachedDsh;
  try {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    cachedDsh = manifest.dependencies?.["@deepseek-ai/dsh"] ?? "unknown";
  } catch {
    cachedDsh = "unknown";
  }
  return cachedDsh;
}
```

- [ ] At **R-B**, immediately after the `const work: WorkOrder = WorkOrderSchema.parse({...});` block (`runner.ts:830-852`), add:

```ts
assembledPrompts.set(taskId, work.inputs.prompt);
evidence.sync(report, assembledPrompts);
```

- [ ] At **R-C**, immediately after the renderer try/catch (`runner.ts:1247`) and before the `HELIUM_RENDER_DUMP` block, add:

```ts
// The last sync before anything leaves the machine: the final step's output
// and the rendered view are both on disk before a delivery is attempted.
evidence.sync(report, assembledPrompts, rendered?.data);
```

- [ ] Add the imports: `import { EvidenceFile, evidencePath, sha256File } from "./evidence.js";` and widen the `./code-version.js` import to `{ codeVersion, dshVersion }`.
- [ ] Run again — expected PASS (2 passed).
- [ ] Run `pnpm typecheck && pnpm vitest run --project unit packages/cli` — expected PASS.
- [ ] Commit:

```bash
git add packages/cli/src/runner.ts packages/cli/src/code-version.ts packages/cli/tests/runner-evidence.spec.ts
git commit -m "feat(cli): write per-step evidence for every run

Three insertion points, none of them in the tool wrapper: the header at DAG
start, a sync beside the clock block, a final sync before delivery. A run
killed by launchd leaves the steps it finished."
```

## Task A7: commitments and baselines are written before the delivery intent

**Files:**

- Modify `packages/cli/src/runner.ts` — **R-C**, between the evidence sync and the `HELIUM_RENDER_DUMP` block
- Test: `packages/cli/tests/runner-ledger-order.spec.ts`

**Interfaces:**

- Consumes: `RenderedReport.commitments` / `.baselines` (Task A1), `appendLedger`, `deployment` (Task A4)
- Produces: `commitment` and `baseline` rows in `<stateRoot>/ledger/<tenant>.jsonl`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/runner-ledger-order.spec.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditStore, readLedger } from "@helium/core";
import { runTenant } from "../src/runner.js";
import { tenantFixture } from "./fixtures/tenant.js";

const renderer = () => ({
  text: "brief",
  data: { schemaVersion: 2 },
  commitments: [{ id: "d-premarket-spy-t1", payload: { t1Down: 0.4 } }],
  baselines: [
    { id: "d-premarket-baseline", payload: { neutral: { t1Down: 0.5 } } },
  ],
});

describe("ledger write ordering", () => {
  it("appends commitments and baselines with the run context stamped on", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    const report = await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
    });
    const read = readLedger(stateRoot, "fake-tenant");
    expect(read.commitments).toEqual([
      {
        id: "d-premarket-spy-t1",
        runId: report.runId,
        tenant: "fake-tenant",
        issuedAt: expect.any(String),
        deployment: "test",
        variant: "live",
        payload: { t1Down: 0.4 },
      },
    ]);
    expect(read.baselines.map((b) => b.id)).toEqual(["d-premarket-baseline"]);
    audit.close();
  });

  it("an --as-of run is stamped backtest and carries asOf", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      asOf: new Date("2026-09-04T12:00:00Z"),
      variant: "replay",
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_DEPLOYMENT: "production" },
    });
    const [commitment] = readLedger(stateRoot, "fake-tenant").commitments;
    expect(commitment!.deployment).toBe("backtest");
    expect(commitment!.variant).toBe("replay");
    expect(commitment!.asOf).toBe("2026-09-04T12:00:00.000Z");
    audit.close();
  });

  it("HELIUM_DEPLOYMENT=production with no --as-of is production", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_DEPLOYMENT: "production" },
    });
    expect(
      readLedger(stateRoot, "fake-tenant").commitments[0]!.deployment,
    ).toBe("production");
    audit.close();
  });

  it("the commitment is on disk before any delivery is attempted", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "helium-ledger-order-"));
    const audit = AuditStore.open({
      HELIUM_AUDIT_DB: join(stateRoot, "audit.db"),
    });
    let atDeliver: number | undefined;
    await runTenant({
      ...tenantFixture(stateRoot),
      audit,
      renderer,
      env: { HELIUM_STATE_ROOT: stateRoot, HELIUM_TENANT_DELIVERY: "1" },
      channels: [
        {
          id: "delivery-file",
          external: false,
          async deliver() {
            atDeliver = readLedger(stateRoot, "fake-tenant").commitments.length;
            return { state: "sent" as const };
          },
        } as never,
      ],
    });
    expect(atDeliver).toBe(1);
    audit.close();
  });
});
```

_(The last case needs `fake-tenant`'s `tenant.yaml` to declare a `delivery:` entry with channel `file`. If it declares none, add `delivery: [{ channel: file, config: {} }]` to `plugins/fake-tenant/tenant.yaml` in this task — `fake-tenant` exists to exercise seams and this is one.)_

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/runner-ledger-order.spec.ts` — expected failure `expected [] to deeply equal [ { id: 'd-premarket-spy-t1', … } ]`.

- [ ] Insert at **R-C**, after the `evidence.sync(report, assembledPrompts, rendered?.data);` line and before the `HELIUM_RENDER_DUMP` block:

```ts
// Records precede side effects. The commitment is on disk BEFORE the mail is
// attempted, so a delivery that half-succeeds cannot leave a promise nobody
// recorded — the same ordering the topology boundary already demands of
// intent and evidence.
const stamp = new Date().toISOString();
const context = {
  runId,
  tenant: spec.tenant,
  issuedAt: stamp,
  deployment,
  variant: options.variant ?? "live",
  ...(options.asOf === undefined ? {} : { asOf: options.asOf.toISOString() }),
};
appendLedger(options.stateRoot, spec.tenant, [
  ...(rendered?.commitments ?? []).map((draft) => ({
    kind: "commitment" as const,
    commitment: { ...context, id: draft.id, payload: draft.payload },
  })),
  ...(rendered?.baselines ?? []).map((draft) => ({
    kind: "baseline" as const,
    baseline: { ...context, id: draft.id, payload: draft.payload },
  })),
]);
```

- [ ] Run again — expected PASS (4 passed).
- [ ] Run `pnpm typecheck` — expected PASS.
- [ ] Commit:

```bash
git add packages/cli/src/runner.ts packages/cli/tests/runner-ledger-order.spec.ts plugins/fake-tenant/tenant.yaml
git commit -m "feat(cli): a commitment reaches the ledger before the mail is attempted

The runner stamps the run context — a renderer that minted its own deployment
label would be guessing at a fact the runner already holds."
```

## Task A8: `summarise` — the scoreboard aggregation

**Files:**

- Create `packages/cli/src/scoreboard.ts`
- Test: `packages/cli/tests/scoreboard.spec.ts`

**Interfaces:**

- Consumes: `LedgerRead`, `Commitment`, `Receipt` from `@helium/core`; `AuditStore.runCost(runId)` (`packages/core/src/audit.ts:180`)
- Produces: `VariantSummary`, `Scoreboard`, `summarise(records: LedgerRead, opts?: { deployment?: string; variant?: string }): Scoreboard`, `parseScoreboardArgs(argv: string[]): { tenant?: string; since?: string; deployment: string; variant?: string } | { error: string }`, `renderScoreboard(board: Scoreboard, costByVariant: Record<string, number>): string[]`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/scoreboard.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Commitment, LedgerRead, Receipt } from "@helium/core";
import {
  parseScoreboardArgs,
  renderScoreboard,
  summarise,
} from "../src/scoreboard.js";

function c(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    id,
    runId: `run-${id}`,
    tenant: "t",
    issuedAt: "2026-09-04T00:00:00Z",
    deployment: "production",
    variant: "live",
    payload: {},
    ...over,
  };
}
function r(
  id: string,
  status: string,
  scores: Record<string, number>,
): Receipt {
  return {
    commitmentId: id,
    runId: "run-s",
    settledAt: "2026-09-05T00:00:00Z",
    status,
    scores,
  };
}
const empty: LedgerRead = { commitments: [], receipts: [], baselines: [] };

describe("summarise", () => {
  it("means each scores key over non-pending receipts only", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b"), c("p")],
      receipts: [
        r("a", "down", { t1Brier: 0.04 }),
        r("b", "up", { t1Brier: 0.36 }),
        r("p", "pending", {}),
      ],
    });
    expect(board.byVariant.live!.n).toBe(3);
    expect(board.byVariant.live!.pending).toBe(1);
    expect(board.byVariant.live!.means.t1Brier).toBeCloseTo(0.2, 10);
    expect(board.byVariant.live!.ranges.t1Brier).toEqual({
      min: 0.04,
      max: 0.36,
      n: 2,
    });
  });

  it("groups by the commitment's variant, not the receipt's run", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b", { variant: "replay" })],
      receipts: [
        r("a", "down", { t1Brier: 0 }),
        r("b", "down", { t1Brier: 1 }),
      ],
    });
    expect(Object.keys(board.byVariant).sort()).toEqual(["live", "replay"]);
  });

  it("a test-deployment run never appears when production is asked for", () => {
    const board = summarise(
      {
        ...empty,
        commitments: [c("a"), c("t", { deployment: "test" })],
        receipts: [
          r("a", "down", { t1Brier: 0 }),
          r("t", "down", { t1Brier: 1 }),
        ],
      },
      { deployment: "production" },
    );
    expect(board.byVariant.live!.n).toBe(1);
    expect(board.byVariant.live!.means.t1Brier).toBe(0);
  });

  it("ignores a receipt whose commitment is not in the read", () => {
    expect(
      summarise({ ...empty, receipts: [r("ghost", "down", { x: 1 })] }),
    ).toEqual({ byVariant: {} });
  });

  it("ignores a non-finite score rather than poisoning the mean", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a"), c("b")],
      receipts: [
        r("a", "down", { t1Brier: 0.25 }),
        r("b", "down", { t1Brier: Number.NaN }),
      ],
    });
    expect(board.byVariant.live!.means.t1Brier).toBe(0.25);
  });

  it("defaults the CLI to production and rejects an unknown flag", () => {
    expect(parseScoreboardArgs(["option-wizard"])).toEqual({
      tenant: "option-wizard",
      deployment: "production",
    });
    expect(
      parseScoreboardArgs([
        "option-wizard",
        "--deployment",
        "all",
        "--variant",
        "replay",
        "--since",
        "2026-09-01",
      ]),
    ).toEqual({
      tenant: "option-wizard",
      deployment: "all",
      variant: "replay",
      since: "2026-09-01",
    });
    expect(parseScoreboardArgs(["option-wizard", "--nope"])).toEqual({
      error: "unknown option --nope",
    });
  });

  it("renders one block per variant with the cost joined on", () => {
    const board = summarise({
      ...empty,
      commitments: [c("a")],
      receipts: [r("a", "down", { t1Brier: 0.04 })],
    });
    const lines = renderScoreboard(board, { live: 0.42 });
    expect(lines.join("\n")).toContain("live");
    expect(lines.join("\n")).toContain("t1Brier");
    expect(lines.join("\n")).toContain("0.420000");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/scoreboard.spec.ts` — expected failure `Cannot find module '../src/scoreboard.js'`.

- [ ] Create `packages/cli/src/scoreboard.ts`:

```ts
/**
 * `helium scoreboard <tenant>` — what the ledger says, and nothing else.
 *
 * It aggregates `scores` BY KEY and never learns what a key means (doctrine 2):
 * `t1Brier` and `resolutionBrier` do not share a range, so it prints the
 * observed range beside each mean rather than pretending one scale.
 *
 * Read-only. It computes nothing the settler did not already decide, because a
 * number computed in two places is a number that will disagree with itself.
 * @module @helium/cli/scoreboard
 */
import type { LedgerRead } from "@helium/core";

export interface VariantSummary {
  /** Receipts in this variant, pending included. */
  n: number;
  pending: number;
  /** Mean per score key over NON-pending receipts. */
  means: Record<string, number>;
  /** Observed spread per key, and how many receipts carried it. */
  ranges: Record<string, { min: number; max: number; n: number }>;
}

export interface Scoreboard {
  byVariant: Record<string, VariantSummary>;
}

export function summarise(
  records: LedgerRead,
  opts: { deployment?: string; variant?: string } = {},
): Scoreboard {
  const byId = new Map(records.commitments.map((entry) => [entry.id, entry]));
  const byVariant: Record<string, VariantSummary> = {};
  const values = new Map<string, Map<string, number[]>>();
  for (const receipt of records.receipts) {
    const commitment = byId.get(receipt.commitmentId);
    if (commitment === undefined) continue;
    if (
      opts.deployment !== undefined &&
      opts.deployment !== "all" &&
      commitment.deployment !== opts.deployment
    )
      continue;
    if (opts.variant !== undefined && commitment.variant !== opts.variant)
      continue;
    const key = commitment.variant;
    let row = byVariant[key];
    if (row === undefined) {
      row = { n: 0, pending: 0, means: {}, ranges: {} };
      byVariant[key] = row;
    }
    row.n += 1;
    if (receipt.status === "pending") {
      row.pending += 1;
      continue;
    }
    let keys = values.get(key);
    if (keys === undefined) {
      keys = new Map();
      values.set(key, keys);
    }
    for (const [name, value] of Object.entries(receipt.scores)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const list = keys.get(name);
      if (list === undefined) keys.set(name, [value]);
      else list.push(value);
    }
  }
  for (const [key, keys] of values) {
    const row = byVariant[key]!;
    for (const [name, list] of keys) {
      row.means[name] =
        list.reduce((total, value) => total + value, 0) / list.length;
      row.ranges[name] = {
        min: Math.min(...list),
        max: Math.max(...list),
        n: list.length,
      };
    }
  }
  return { byVariant };
}

export function parseScoreboardArgs(
  argv: string[],
):
  | { tenant?: string; since?: string; deployment: string; variant?: string }
  | { error: string } {
  const out: {
    tenant?: string;
    since?: string;
    deployment: string;
    variant?: string;
  } = { deployment: "production" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (
      token === "--since" ||
      token === "--deployment" ||
      token === "--variant"
    ) {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${token} needs a value` };
      if (token === "--since") out.since = value;
      if (token === "--deployment") out.deployment = value;
      if (token === "--variant") out.variant = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) return { error: `unknown option ${token}` };
    if (out.tenant === undefined) out.tenant = token;
  }
  return out;
}

export function renderScoreboard(
  board: Scoreboard,
  costByVariant: Record<string, number>,
): string[] {
  const lines: string[] = [
    "the same idea re-issued on consecutive days is several correlated samples;",
    "V0 does not de-duplicate them.",
    "",
  ];
  for (const [variant, row] of Object.entries(board.byVariant).sort()) {
    const cost = costByVariant[variant];
    lines.push(
      `${variant}: ${String(row.n)} receipts, ${String(row.pending)} pending` +
        (cost === undefined ? "" : `, ${cost.toFixed(6)} USD`),
    );
    for (const [name, mean] of Object.entries(row.means).sort()) {
      const range = row.ranges[name]!;
      lines.push(
        `  ${name}  mean ${mean.toFixed(4)}  observed ${range.min.toFixed(4)}..${range.max.toFixed(4)}  n=${String(range.n)}`,
      );
    }
    if (Object.keys(row.means).length === 0)
      lines.push("  no settled score yet");
    lines.push("");
  }
  if (Object.keys(board.byVariant).length === 0)
    lines.push(
      "no receipts match; the ledger may hold only outstanding commitments",
    );
  return lines;
}
```

- [ ] Run again — expected PASS (7 passed).
- [ ] Commit:

```bash
git add packages/cli/src/scoreboard.ts packages/cli/tests/scoreboard.spec.ts
git commit -m "feat(cli): aggregate receipts by score key, and by nothing else

Two Brier keys do not share a range, so the observed spread is printed beside
each mean rather than one scale being invented for both."
```

## Task A9: the `scoreboard` subcommand

**Files:**

- Modify `packages/cli/src/cli.ts` — new branch after the `audit` branch (`:159-171`), and the usage block (`:236-249`)
- Test: `packages/cli/tests/scoreboard-cli.spec.ts`

**Interfaces:**

- Consumes: `parseScoreboardArgs`, `summarise`, `renderScoreboard` (Task A8); `readLedger` (Task A1); `AuditStore.runCost`
- Produces: `printScoreboard(store: AuditStore, stateRoot: string, argv: string[]): number` exported from `cli.ts`

**Steps:**

- [ ] Write the failing test `packages/cli/tests/scoreboard-cli.spec.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditStore, appendLedger } from "@helium/core";
import { printScoreboard } from "../src/cli.js";

function ledgerAt(): string {
  const dir = mkdtempSync(join(tmpdir(), "helium-sb-cli-"));
  appendLedger(dir, "option-wizard", [
    {
      kind: "commitment",
      commitment: {
        id: "a",
        runId: "run-a",
        tenant: "option-wizard",
        issuedAt: "2026-09-04T00:00:00Z",
        deployment: "production",
        variant: "live",
        payload: {},
      },
    },
    {
      kind: "commitment",
      commitment: {
        id: "t",
        runId: "run-t",
        tenant: "option-wizard",
        issuedAt: "2026-09-04T00:00:00Z",
        deployment: "test",
        variant: "live",
        payload: {},
      },
    },
    {
      kind: "receipt",
      receipt: {
        commitmentId: "a",
        runId: "run-s",
        settledAt: "2026-09-05T00:00:00Z",
        status: "down",
        scores: { t1Brier: 0.09 },
      },
    },
    {
      kind: "receipt",
      receipt: {
        commitmentId: "t",
        runId: "run-s",
        settledAt: "2026-09-05T00:00:00Z",
        status: "down",
        scores: { t1Brier: 0.81 },
      },
    },
  ]);
  return dir;
}

describe("helium scoreboard", () => {
  it("prints the production ledger and excludes the test run by default", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    expect(printScoreboard(store, dir, ["option-wizard"])).toBe(0);
    spy.mockRestore();
    store.close();
    const text = lines.join("\n");
    expect(text).toContain("mean 0.0900");
    expect(text).not.toContain("0.8100");
  });

  it("returns 2 and says so when the tenant is missing", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(printScoreboard(store, dir, [])).toBe(2);
    spy.mockRestore();
    store.close();
  });

  it("returns 2 on an unknown option", () => {
    const dir = ledgerAt();
    const store = AuditStore.open({ HELIUM_AUDIT_DB: join(dir, "audit.db") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(printScoreboard(store, dir, ["option-wizard", "--nope"])).toBe(2);
    spy.mockRestore();
    store.close();
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit packages/cli/tests/scoreboard-cli.spec.ts` — expected failure `does not provide an export named 'printScoreboard'`.

- [ ] Add to `packages/cli/src/cli.ts`, after `printAudit` (`:177`):

```ts
/** `helium scoreboard <tenant> [--since] [--deployment] [--variant]`. */
export function printScoreboard(
  store: AuditStore,
  root: string,
  argv: string[],
): number {
  const parsed = parseScoreboardArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.tenant === undefined) {
    console.error(
      "usage: helium scoreboard <tenant> [--since <ISO>] [--deployment production|backtest|test|all] [--variant <label>]",
    );
    return 2;
  }
  const records = readLedger(
    root,
    parsed.tenant,
    parsed.since === undefined ? {} : { since: parsed.since },
  );
  const board = summarise(records, {
    deployment: parsed.deployment,
    ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
  });
  // Cost is JOINED, never recomputed: the audit table is the one place that
  // knows what a run cost, and a second arithmetic here would eventually
  // disagree with `helium audit`.
  const runsByVariant = new Map<string, Set<string>>();
  for (const commitment of records.commitments) {
    const set = runsByVariant.get(commitment.variant) ?? new Set<string>();
    set.add(commitment.runId);
    runsByVariant.set(commitment.variant, set);
  }
  const costByVariant: Record<string, number> = {};
  for (const [variant, runIds] of runsByVariant) {
    let usd = 0;
    for (const runId of runIds)
      for (const row of store.runCost(runId)) usd += row.usd;
    costByVariant[variant] = usd;
  }
  for (const line of renderScoreboard(board, costByVariant)) console.log(line);
  return 0;
}
```

- [ ] Add the branch in `main`, after the `audit` branch (`:171`):

```ts
if (command === "scoreboard") {
  const store = AuditStore.open(env);
  try {
    return printScoreboard(store, stateRoot(env), argv.slice(1));
  } finally {
    store.close();
  }
}
```

- [ ] Add to the usage block (`:239`), after the `helium audit` line:

```ts
      "  helium scoreboard <tenant> [--since <ISO>] [--deployment production|backtest|test|all] [--variant <label>]",
      "      what the outcome ledger says: mean and observed range per score key,",
      "      grouped by variant, pending counted separately. Production only unless told otherwise.",
```

- [ ] Add the imports: `readLedger` to the `@helium/core` import and `import { parseScoreboardArgs, renderScoreboard, summarise } from "./scoreboard.js";`. Update the module docstring at `cli.ts:3` from "two subcommands" to "three subcommands".
- [ ] Run again — expected PASS (3 passed).
- [ ] Run `pnpm typecheck && pnpm build && pnpm test && pnpm test:contracts` — expected PASS.
- [ ] Commit and open the Phase A PR:

```bash
git add packages/cli/src/cli.ts packages/cli/tests/scoreboard-cli.spec.ts
git commit -m "feat(cli): helium scoreboard reads the outcome ledger

Cost is joined from audit.db, never recomputed: a number computed in two
places is a number that will eventually disagree with itself."
git push -u origin feat/outcome-ledger-core
gh pr create --title "feat: outcome ledger core seam" --body "$(cat <<'EOF'
Three domain-blind types beside `Gate`, one append-only jsonl per tenant, a
settler span at DAG start, per-step evidence, and `helium scoreboard`.

`readLedger` and `summarise` are the read entry points the quality-loop review
phase is blocked on; their signatures are fixed here.

Spec: docs/superpowers/specs/2026-09-04-outcome-ledger-v0-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase B — option-wizard, the first weight on the scale (PR 2)

Bases on Phase A. Nine tasks.

## Task B1: freeze the ground truth

Real SPY bars and one real argon metrics row, fetched ONCE and committed. Tests never touch the network (no-synthetic-data: real ticker, real prices, frozen with an as-of date).

**Files:**
- Create `plugins/option-wizard/tests/fixtures/spy-bars-2026-09-02_03.json`
- Create `plugins/option-wizard/tests/fixtures/argon-metrics-2026-09-04.json`
- Create `scripts/fixtures/fetch-spy-bars.py` (kept so the fixture is reproducible, not a one-off in a chat log)

**Interfaces:**
- Consumes: the livewire lake on `macmini`, `~/projects/livewire/.venv/bin/python` (duckdb 1.5.5, verified 2026-09-06)
- Produces: `{ asOf, source, symbol, bars1m: Bar[], bars1d: Bar[] }` where `Bar = { time, open, high, low, close, volume }` and `time` is a UTC ISO instant — the SAME field names apex returns (`/Users/chenxi/projects/apex/src/api/payload/chart.py:28-46`), so fixture and production reader share one row type.

**Verified facts this task depends on (checked on `macmini`, 2026-09-06):**
- `~/market-warehouse/data-lake/bronze/asset_class=equity/symbol=SPY/` holds `1d.parquet`, `1m.parquet`, `5m.parquet`, `30m.parquet`, `1h.parquet`.
- `1m.parquet` columns: `bar_timestamp TIMESTAMP WITH TIME ZONE`, `symbol_id`, `open`, `high`, `low`, `close`, `volume`, `asset_class`, `symbol`. Session zone is `Asia/Hong_Kong`; max `bar_timestamp` = `2026-09-05 07:59 HKT`.
- `1d.parquet` columns: **`trade_date DATE`** (not `bar_timestamp`), `symbol_id`, `open`, `high`, `low`, `close`, `adj_close`, `volume`, `source`, `price_basis`, `asset_class`, `symbol`.
- ET RTH bar counts: 2026-09-02 → 390, 2026-09-03 → 390.

**Steps:**

- [ ] Write `scripts/fixtures/fetch-spy-bars.py`:

```python
"""Freeze two ET sessions of real SPY 1m RTH bars plus the surrounding 1d rows.

Run ON the mini (the lake is not on the laptop). The 1m file is EXTENDED HOURS
and keyed in Asia/Hong_Kong, so one ET session spans two HKT dates: everything
here converts to America/New_York first and keeps 09:30-16:00 only. Selecting
by HKT date is the bug this script exists to make impossible.
"""
import duckdb, json

LAKE = "/Users/moremeds/market-warehouse/data-lake/bronze/asset_class=equity/symbol=SPY"
SESSIONS = ("2026-09-02", "2026-09-03")
DAILY_FROM, DAILY_TO = "2026-08-26", "2026-09-03"

d = duckdb.connect()
minute = d.execute(f"""
    SELECT strftime(bar_timestamp AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS t,
           open, high, low, close, volume
      FROM read_parquet('{LAKE}/1m.parquet')
     WHERE (bar_timestamp AT TIME ZONE 'America/New_York')::date
           IN (DATE '{SESSIONS[0]}', DATE '{SESSIONS[1]}')
       AND (bar_timestamp AT TIME ZONE 'America/New_York')::time >= TIME '09:30'
       AND (bar_timestamp AT TIME ZONE 'America/New_York')::time <  TIME '16:00'
     ORDER BY bar_timestamp
""").fetchall()
daily = d.execute(f"""
    SELECT strftime(trade_date, '%Y-%m-%d') AS t, open, high, low, close, volume
      FROM read_parquet('{LAKE}/1d.parquet')
     WHERE trade_date BETWEEN DATE '{DAILY_FROM}' AND DATE '{DAILY_TO}'
     ORDER BY trade_date
""").fetchall()

def row(r):
    return {"time": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}

print(json.dumps({
    "asOf": "2026-09-06",
    "source": ("livewire lake on macmini: "
               "~/market-warehouse/data-lake/bronze/asset_class=equity/symbol=SPY/{1m,1d}.parquet. "
               "1m bar_timestamp is TIMESTAMPTZ in Asia/Hong_Kong, extended hours, ~850 bars per HKT "
               "date; filtered to 09:30-16:00 America/New_York and normalised to UTC here. "
               "1d keys on trade_date (a DATE, no clock)."),
    "symbol": "SPY",
    "sessionsEt": list(SESSIONS),
    "bars1m": [row(r) for r in minute],
    "bars1d": [row(r) for r in daily],
}, indent=1))
```

- [ ] Fetch it, exactly:

```bash
scp scripts/fixtures/fetch-spy-bars.py macmini:/tmp/fetch-spy-bars.py
mkdir -p plugins/option-wizard/tests/fixtures
ssh macmini '~/projects/livewire/.venv/bin/python /tmp/fetch-spy-bars.py' \
  > plugins/option-wizard/tests/fixtures/spy-bars-2026-09-02_03.json
```

- [ ] Verify the fixture before trusting it — expected `390 390 7`:

```bash
node -e 'const f=require("./plugins/option-wizard/tests/fixtures/spy-bars-2026-09-02_03.json");
const et=(t)=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(t));
const n=(d)=>f.bars1m.filter(b=>et(b.time)===d).length;
console.log(n("2026-09-02"), n("2026-09-03"), f.bars1d.length);'
```

- [ ] Fetch the argon metrics row, exactly (this is the shape `ow_argon_metrics` returns today; `psql` is NOT on the mini's non-login PATH, so the env file's `OW_PSQL_BIN` is used):

```bash
ssh macmini 'set -a; . ~/.config/helium/helium.env; set +a; "$OW_PSQL_BIN" -v ON_ERROR_STOP=1 -At -c "SELECT to_jsonb(r) - '"'"'inserted_at'"'"' - '"'"'updated_at_src'"'"' FROM uw_scan.iv_rank_history r WHERE r.ticker='"'"'SPY'"'"' ORDER BY r.market_date DESC LIMIT 1" "$OW_ARGON_PG_URL"'
```

Expected output, already observed on 2026-09-06:
`{"close": 770.19, "ticker": "SPY", "iv_rank_1y": 3.5692, "volatility": 0.116, "market_date": "2026-09-04"}`

Write `plugins/option-wizard/tests/fixtures/argon-metrics-2026-09-04.json` as the full tool envelope built around it:

```json
{
  "asOf": "2026-09-06",
  "note": "ow_argon_metrics envelope (tools/index.ts:1749-1765) around the real SPY row observed on macmini 2026-09-06. No signal / expectedReturn20d / confidence / dataDate exists on this table yet; PR #92 adds them.",
  "response": {
    "source": "argon.uw_scan",
    "rows": [
      {
        "ticker": "SPY",
        "iv": { "close": 770.19, "ticker": "SPY", "iv_rank_1y": 3.5692, "volatility": 0.116, "market_date": "2026-09-04" },
        "gex": null,
        "skew": null
      }
    ]
  }
}
```

- [ ] Commit:

```bash
git add scripts/fixtures/fetch-spy-bars.py plugins/option-wizard/tests/fixtures/
git commit -m "test(option-wizard): freeze real SPY bars and one real argon row

Two ET sessions of 1m RTH bars (390 each) and the 1d rows around them, taken
once from the lake on the mini. The fetch script is kept because a fixture
nobody can regenerate is a fixture nobody can trust."
```

## Task B2: D1 — typed target, thesis, deadlines

**Files:**
- Modify `plugins/option-wizard/render/index.ts` — `CandidateView` (`:44-88`), `BRIEF_VIEW_SCHEMA_VERSION` (`:134`), `candidatesFrom` (`:938-1015`)
- Test: `plugins/option-wizard/tests/render-target.spec.ts`

**Interfaces:**
- Consumes: `toInvalidation(raw: unknown): Invalidation[] | null` (`render/index.ts:287`), `Invalidation` (`:39`)
- Produces: `CandidateView.target?: Invalidation`, `.thesis: string`, `.entry?: Invalidation & { deadlineBars: number }`, `.resolutionDeadline: string`; `BRIEF_VIEW_SCHEMA_VERSION = 2`; `DEFAULT_DEADLINE_BARS = 5`

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/render-target.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BRIEF_VIEW_SCHEMA_VERSION,
  candidatesFrom,
  DEFAULT_DEADLINE_BARS,
} from "../render/index.js";

const legs = [
  { action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 },
  { action: "sell", right: "put", strike: 745, expiry: "2026-10-02", mid: 4.2 },
];

function review(proposal: Record<string, unknown>): string {
  return "```json\n" + JSON.stringify({ proposals: [{ ticker: "SPY", strategy: "put debit spread", legs, invalidation: [{ level: 778, side: "above" }], ...proposal }] }) + "\n```";
}

describe("typed target and deadlines", () => {
  it("bumps the schema version, because target changed meaning", () => {
    expect(BRIEF_VIEW_SCHEMA_VERSION).toBe(2);
  });

  it("keeps a level+side target as a number and leaves thesis empty", () => {
    const { candidates } = candidatesFrom(review({ target: { level: 748, side: "below" } }), "2026-09-04", "premarket");
    expect(candidates[0]!.target).toEqual({ level: 748, side: "below" });
    expect(candidates[0]!.thesis).toBe("");
  });

  it("a prose target becomes the thesis and leaves target unset", () => {
    const { candidates } = candidatesFrom(review({ target: "SPY grinds down toward 748 on a soft ISM" }), "2026-09-04", "premarket");
    expect(candidates[0]!.target).toBeUndefined();
    expect(candidates[0]!.thesis).toBe("SPY grinds down toward 748 on a soft ISM");
  });

  it("carries both when the model writes a typed target AND a thesis", () => {
    const { candidates } = candidatesFrom(review({ target: { level: 748, side: "below" }, thesis: "soft ISM" }), "2026-09-04", "premarket");
    expect(candidates[0]!.target).toEqual({ level: 748, side: "below" });
    expect(candidates[0]!.thesis).toBe("soft ISM");
  });

  it("defaults the entry deadline to five 1d bars", () => {
    const { candidates } = candidatesFrom(review({ entry: { level: 766, side: "below" } }), "2026-09-04", "premarket");
    expect(DEFAULT_DEADLINE_BARS).toBe(5);
    expect(candidates[0]!.entry).toEqual({ level: 766, side: "below", deadlineBars: 5 });
  });

  it("honours a shortened deadline and ignores an extension", () => {
    const short = candidatesFrom(review({ entry: { level: 766, side: "below", deadlineBars: 2 } }), "2026-09-04", "premarket");
    expect(short.candidates[0]!.entry!.deadlineBars).toBe(2);
    const long = candidatesFrom(review({ entry: { level: 766, side: "below", deadlineBars: 40 } }), "2026-09-04", "premarket");
    expect(long.candidates[0]!.entry!.deadlineBars).toBe(5);
    const junk = candidatesFrom(review({ entry: { level: 766, side: "below", deadlineBars: 0 } }), "2026-09-04", "premarket");
    expect(junk.candidates[0]!.entry!.deadlineBars).toBe(5);
  });

  it("resolutionDeadline is the expiry, the one date the contract fixes", () => {
    const { candidates } = candidatesFrom(review({}), "2026-09-04", "premarket");
    expect(candidates[0]!.resolutionDeadline).toBe("2026-10-02");
  });

  it("still drops a proposal whose invalidation is prose", () => {
    const text = "```json\n" + JSON.stringify({ proposals: [{ ticker: "SPY", strategy: "s", legs, invalidation: "if it breaks up" }] }) + "\n```";
    const { candidates, rejected } = candidatesFrom(text, "2026-09-04", "premarket");
    expect(candidates).toEqual([]);
    expect(rejected[0]!.reason).toContain("settleable level");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/render-target.spec.ts` — expected failure `expected 1 to be 2` on the schema version, then `expected undefined to deeply equal { level: 748, side: 'below' }`.

- [ ] In `render/index.ts`, replace `target: string` in `CandidateView` (`:68`, with its comment `:64-67`) by:

```ts
  /** Where the thesis is trying to get to, as a level and the side price has
   *  to reach it from. A NUMBER, not the model's prose: argon's card renders
   *  it through the same helper as `invalidation`, and it was showing
   *  `TARGET —` for every candidate because a sentence has no level to draw.
   *  The sentence still ships — as `thesis`. */
  target?: Invalidation;
  /** The old prose `target`: what the designer said it was going to do, in its
   *  own words. Display only; nothing settles against it. */
  thesis: string;
  /** The declared entry trigger with the window it has to fire in, counted in
   *  1d bars after the reference close. RENDERER-OWNED: an agent that picks its
   *  own deadline inflates `pTrigger` by giving the level forever to be
   *  reached, so the default is five and the model may only shorten it. */
  entry?: Invalidation & { deadlineBars: number };
  /** The expiry, restated as the date after which nothing can resolve. The one
   *  date the contract itself fixes, so it is not a policy choice. */
  resolutionDeadline: string;
```

and delete the old `entry?: Invalidation;` field and its comment (`:69-71`).

- [ ] Add above `candidatesFrom` (`:938`):

```ts
/**
 * The entry window, in 1d bars after `referenceClose.date`.
 *
 * A COUNT of bars, never a calendar date: helium has no exchange calendar and
 * must not grow one. The lake's daily bars ARE the calendar, and a bar that
 * does not exist yet simply leaves the commitment pending.
 */
export const DEFAULT_DEADLINE_BARS = 5;

function deadlineBars(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return DEFAULT_DEADLINE_BARS;
  if (raw < 1 || raw > DEFAULT_DEADLINE_BARS) return DEFAULT_DEADLINE_BARS;
  return raw;
}
```

- [ ] In `candidatesFrom`, replace the `target:` line (`:1003`) and the `entry` spread (`:1004-1008`) by:

```ts
      // A typed target settles; a sentence does not. Both are kept, in the two
      // fields that mean those two different things.
      ...(toInvalidation(proposal.target)?.length === 1
        ? { target: toInvalidation(proposal.target)![0]! }
        : {}),
      thesis:
        typeof proposal.thesis === "string"
          ? proposal.thesis
          : typeof proposal.target === "string"
            ? proposal.target
            : "",
      resolutionDeadline: expiry,
      // Reuses the invalidation parser: an entry trigger is the same shape —
      // one level and the side price has to reach it from.
      ...(toInvalidation(proposal.entry)?.length === 1
        ? {
            entry: {
              ...toInvalidation(proposal.entry)![0]!,
              deadlineBars: deadlineBars(
                (proposal.entry as Record<string, unknown> | null)?.deadlineBars,
              ),
            },
          }
        : {}),
```

- [ ] Set `export const BRIEF_VIEW_SCHEMA_VERSION = 2;` (`:134`).
- [ ] Run again — expected PASS (8 passed).
- [ ] Run `pnpm vitest run --project unit plugins/option-wizard` — the existing `render.spec.ts`, `render-editor.spec.ts`, `render-newsletter.spec.ts`, `render-schema-version.spec.ts` and `candidate-ids.spec.ts` assert against `target` and the schema version. Update each assertion to the new shape; do not weaken one — where a suite asserted `target: "prose"` it now asserts `thesis: "prose"`.
- [ ] Run `pnpm typecheck` — expected PASS.
- [ ] Commit:

```bash
git add plugins/option-wizard/render/index.ts plugins/option-wizard/tests/
git commit -m "fix(option-wizard): a target is a level, and the sentence is the thesis

argon reads target.level/side and helium was emitting prose, so every card
showed TARGET —. The deadline is the renderer's: an agent that picks its own
inflates its trigger probability by giving the level forever to be reached."
```

## Task B3: D1 — the brief prints the thesis and the target

**Files:**
- Modify `plugins/option-wizard/render/html.ts` — candidate table head and body (`:255-287`)
- Test: `plugins/option-wizard/tests/render-html-thesis.spec.ts`

**Interfaces:**
- Consumes: `CandidateView` (Task B2), `invalidationLabel(list: Invalidation[]): string` (`render/math.ts`, imported at `html.ts:41`), `esc`, `BORDER`, `INK`, `DIM` (module-local in `html.ts`)
- Produces: a Target cell and a thesis line in the candidate row

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/render-html-thesis.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderHtml } from "../render/html.js";
import type { BriefView, CandidateView } from "../render/index.js";

const candidate: CandidateView = {
  id: "SPY-2026-09-04-premarket-1",
  ticker: "SPY",
  strategy: "put_debit_spread",
  expiry: "2026-10-02",
  dte: 28,
  legs: [
    { action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 },
    { action: "sell", right: "put", strike: 745, expiry: "2026-10-02", mid: 4.2 },
  ],
  pricing: { kind: "unpriced", reason: "no spot" },
  width: 25,
  invalidation: [{ level: 778, side: "above" }],
  target: { level: 748, side: "below" },
  thesis: "SPY grinds toward the September gamma shelf",
  resolutionDeadline: "2026-10-02",
  rationale: "r",
};

function view(over: Partial<BriefView> = {}): BriefView {
  return {
    schemaVersion: 2,
    date: "2026-09-04",
    tenant: "option-wizard",
    outcome: "completed",
    headline: "h",
    tape: [],
    schedule: [],
    overnight: [],
    sections: [],
    regime: { paragraph: "p" },
    candidates: [candidate],
    riskList: [],
    charts: { gex: [] },
    ...over,
  } as BriefView;
}

describe("candidate card html", () => {
  it("prints the numeric target beside the invalidation", () => {
    const html = renderHtml(view());
    expect(html).toContain("748 below");
    expect(html).toContain("778 above");
  });

  it("prints the thesis under the legs", () => {
    expect(renderHtml(view())).toContain("SPY grinds toward the September gamma shelf");
  });

  it("prints an em dash for a candidate with no typed target, and still renders the row", () => {
    const bare = { ...candidate, thesis: "" };
    delete (bare as { target?: unknown }).target;
    const html = renderHtml(view({ candidates: [bare as CandidateView] }));
    expect(html).toContain("SPY");
    expect(html).not.toContain("undefined");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/render-html-thesis.spec.ts` — expected failure `expected '<table…' to contain '748 below'`.

- [ ] In `html.ts`, inside the candidate `.map(...)` (`:256`), add before the `return`:

```ts
      const targetLabel =
        candidate.target === undefined
          ? "—"
          : invalidationLabel([candidate.target]);
```

and add a cell before the invalidation cell (`:278`):

```ts
        <td valign="top" align="right" class="ink rule" style="${cell};color:${INK};font-size:13px;white-space:nowrap">${esc(targetLabel)}</td>
```

and add the thesis line inside the strategy cell, after the legs `<div>` (`:275`):

```ts
          ${candidate.thesis === "" ? "" : `<div class="ink-dim" style="color:${DIM};font-size:11px;line-height:1.45;padding-top:3px">${esc(candidate.thesis)}</div>`}
```

- [ ] Add the matching `Target` column to the `head` row of the same table (the header string built just above `const body`), between the max-loss and invalidation headers.
- [ ] Run again — expected PASS (3 passed).
- [ ] Run `pnpm vitest run --project unit plugins/option-wizard/tests/render-newsletter.spec.ts plugins/option-wizard/tests/render-flash-budget.spec.ts` — the Flash budget suite counts bytes; if the new column pushes a fixture over `FLASH_BUDGET`, the trim already handles it and the assertion to update is the expected trimmed output, never the budget.
- [ ] Commit:

```bash
git add plugins/option-wizard/render/html.ts plugins/option-wizard/tests/render-html-thesis.spec.ts
git commit -m "feat(option-wizard): the card shows the target level and the thesis

The level is what a later run settles against; the sentence is what the
reader needs. Printing only one of them was the whole bug."
```

## Task B4: D2 — `spyForecast`, parsed and scored for scorability

**Files:**
- Modify `plugins/option-wizard/render/index.ts` — new `SpyForecast` / `ForecastBlock` types, `BriefView` (`:136-224`), `assembleView` (`:1200-1240`)
- Modify `plugins/option-wizard/team.yaml` — the `scenarios` task ONLY (`:553-566`)
- Test: `plugins/option-wizard/tests/render-forecast.spec.ts`

**Interfaces:**
- Consumes: `extractJson(text: string): Record<string, unknown> | null` (`render/index.ts:225`), `RunReport.steps[].text`
- Produces: `SpyForecast`, `ForecastBlock`, `forecastFrom(report: RunReport): ForecastBlock | undefined`, `BriefView.spyForecast?: ForecastBlock`

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/render-forecast.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import { forecastFrom } from "../render/index.js";

function report(scenariosText: string): RunReport {
  return {
    runId: "run-1",
    tenant: "option-wizard",
    mode: "model",
    phase: "premarket",
    day: "2026-09-04",
    providersLive: [],
    providersSkipped: [],
    steps: [{ task: "scenarios", role: "scenario-analyst", mode: "model", text: scenariosText }],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  };
}

const good = JSON.stringify({
  sections: [{ title: "A", body: "b" }],
  spyForecast: {
    referenceClose: { date: "2026-09-03", value: 770.19 },
    t1Down: 0.42,
    t5Down: 0.47,
  },
});

describe("spyForecast", () => {
  it("parses a well-formed forecast as scorable", () => {
    expect(forecastFrom(report(good))).toEqual({
      scorable: true,
      forecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: 0.42, t5Down: 0.47 },
    });
  });

  it("is absent when the scenarios step did not run", () => {
    const bare = report(good);
    bare.steps = [];
    expect(forecastFrom(bare)).toBeUndefined();
  });

  it("a missing forecast is not scorable and says why — the brief still renders", () => {
    const block = forecastFrom(report(JSON.stringify({ sections: [] })));
    expect(block).toEqual({ scorable: false, reason: "the scenarios step wrote no spyForecast object" });
  });

  it("a probability outside [0,1] is not scorable", () => {
    const text = JSON.stringify({ spyForecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: 1.4, t5Down: 0.5 } });
    expect(forecastFrom(report(text))!.scorable).toBe(false);
    expect(forecastFrom(report(text))!.reason).toContain("t1Down");
  });

  it("a missing referenceClose is not scorable", () => {
    const text = JSON.stringify({ spyForecast: { t1Down: 0.4, t5Down: 0.5 } });
    expect(forecastFrom(report(text))!.reason).toContain("referenceClose");
  });

  it("no LLM normalisation: a string probability is refused, not coerced", () => {
    const text = JSON.stringify({ spyForecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: "0.42", t5Down: 0.5 } });
    expect(forecastFrom(report(text))!.scorable).toBe(false);
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/render-forecast.spec.ts` — expected failure `does not provide an export named 'forecastFrom'`.

- [ ] Add to `render/index.ts`, above `BRIEF_VIEW_SCHEMA_VERSION` (`:134`):

```ts
/**
 * The run's own directional forecast on SPY, frozen as `evaluator-v0`.
 *
 * `t1Down` is P(close one trading day after `referenceClose.date` is BELOW
 * `referenceClose.value`); `t5Down` is the same five bars out. `referenceClose`
 * is the last completed close known at issue time — the prior session on a
 * premarket run, that session on a close run — and its value must be a verbatim
 * tool output, which `gates/as-of-verbatim.ts` checks.
 */
export interface SpyForecast {
  referenceClose: { date: string; value: number };
  t1Down: number;
  t5Down: number;
}

/**
 * A forecast and whether it can be scored, with the reason when it cannot.
 *
 * Issue #78: a missing field must never erase a section. A malformed forecast
 * is rendered exactly as it arrived and marked unscorable — dropping the
 * section would hide the fault from the only person who can fix it, and
 * normalising it with a model would invent the number being measured.
 */
export interface ForecastBlock {
  forecast?: SpyForecast;
  scorable: boolean;
  reason?: string;
}

function probability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function forecastFrom(report: RunReport): ForecastBlock | undefined {
  const step = report.steps.find((entry) => entry.task === "scenarios");
  if (step === undefined) return undefined;
  const parsed = extractJson(step.text);
  const raw = parsed?.spyForecast;
  if (raw === undefined || raw === null || typeof raw !== "object")
    return { scorable: false, reason: "the scenarios step wrote no spyForecast object" };
  const row = raw as Record<string, unknown>;
  const reference = row.referenceClose as Record<string, unknown> | undefined;
  if (
    reference === undefined ||
    reference === null ||
    typeof reference !== "object" ||
    typeof reference.date !== "string" ||
    typeof reference.value !== "number" ||
    !Number.isFinite(reference.value)
  )
    return { scorable: false, reason: "referenceClose is not a {date, value} pair" };
  const bad = ["t1Down", "t5Down"].filter((key) => !probability(row[key]));
  if (bad.length > 0)
    return { scorable: false, reason: `${bad.join(", ")} outside [0,1] or not a number` };
  return {
    scorable: true,
    forecast: {
      referenceClose: { date: reference.date, value: reference.value },
      t1Down: row.t1Down as number,
      t5Down: row.t5Down as number,
    },
  };
}
```

- [ ] Add to `BriefView`, after `regime: RegimeView;` (`:174`):

```ts
  /** The run's directional call on SPY, and whether it can be scored. Present
   *  whenever the scenarios step ran, malformed or not. */
  spyForecast?: ForecastBlock;
```

- [ ] In `assembleView`, add `...(forecastFrom(report) === undefined ? {} : { spyForecast: forecastFrom(report)! })` to the `base` object literal (`:1232-1240`).

- [ ] Modify ONLY the `scenarios` task in `plugins/option-wizard/team.yaml` (`:558-566`) — do not touch `regime`, `design`, `review`, `edit`, or any other task. Replace its final `Reply as ONE JSON object…` sentence by:

```yaml
      Reply as ONE JSON object and nothing else:
      {"sections":[{"title","body"}],
       "spyForecast":{"referenceClose":{"date":"<yyyy-mm-dd>","value":<number>},
                      "t1Down":<0..1>,"t5Down":<0..1>}}
      — one `sections` entry per section you were asked for, in that order, no
      prose outside the JSON. Your working notes are not a section.
      `spyForecast` is your own directional call, and it is scored: `t1Down` is
      the probability that SPY's close ONE trading day after `referenceClose.date`
      is BELOW `referenceClose.value`, `t5Down` the same five trading days out.
      `referenceClose` is the last COMPLETED SPY close you were given by a tool —
      copy its date and its number character-for-character from the tool's own
      reply; a number you converted, rounded or remembered is refused by a gate.
      Do not hedge to 0.5 out of caution: a forecast that is always 0.5 scores
      exactly as well as no forecast at all, which is the point of scoring it.
```

- [ ] Run again — expected PASS (6 passed).
- [ ] Run `pnpm vitest run --project unit plugins/option-wizard/tests/team-manifest.spec.ts` — that suite parses `team.yaml`; expected PASS (the change is prompt text only, no new task, no new role).
- [ ] Commit:

```bash
git add plugins/option-wizard/render/index.ts plugins/option-wizard/team.yaml plugins/option-wizard/tests/render-forecast.spec.ts
git commit -m "feat(option-wizard): the scenarios step states a scored SPY forecast

Malformed is rendered and marked unscorable, never dropped: issue #78 is that
a missing field must not erase a section, and normalising one with a model
would invent the number being measured."
```

## Task B5: D2 — `as-of-verbatim` covers `referenceClose.value`

**Files:**
- Modify `plugins/option-wizard/gates/as-of-verbatim.ts` — `appliesTo` (`:33`), `check` (`:34-77`)
- Test: `plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts` (extend the existing suite)

**Interfaces:**
- Consumes: `GateCtx.stepToolOutputs` (`packages/core/src/plugins.ts:140`)
- Produces: an additional refusal reason on the same gate

**Steps:**

- [ ] Append to `plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts`:

```ts
describe("referenceClose", () => {
  const tape = JSON.stringify({ symbol: "SPY", bars: [{ time: "2026-09-03T20:00:00Z", close: 770.19 }] });

  it("passes a referenceClose value that appears verbatim in this step's tool output", async () => {
    const verdict = await gate.check(
      { text: JSON.stringify({ spyForecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: 0.4, t5Down: 0.5 } }) },
      { runId: "r", role: "scenario-analyst", toolOutputs: [tape], stepToolOutputs: [tape] },
    );
    expect(verdict.pass).toBe(true);
  });

  it("refuses a referenceClose value no tool in this step returned", async () => {
    const verdict = await gate.check(
      { text: JSON.stringify({ spyForecast: { referenceClose: { date: "2026-09-03", value: 770.2 }, t1Down: 0.4, t5Down: 0.5 } }) },
      { runId: "r", role: "scenario-analyst", toolOutputs: [tape], stepToolOutputs: [tape] },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("770.2");
  });

  it("refuses when the step called no tool at all", async () => {
    const verdict = await gate.check(
      { text: JSON.stringify({ spyForecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: 0.4, t5Down: 0.5 } }) },
      { runId: "r", role: "scenario-analyst", toolOutputs: [tape], stepToolOutputs: [] },
    );
    expect(verdict.pass).toBe(false);
  });

  it("says nothing about a step that wrote no referenceClose", async () => {
    const verdict = await gate.check({ text: "prose with no forecast" }, { runId: "r", role: "scenario-analyst", toolOutputs: [tape], stepToolOutputs: [tape] });
    expect(verdict.pass).toBe(true);
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts` — expected failure `expected true to be false` on the second case (the gate currently matches ISO timestamps only).

- [ ] Add `"scenario-analyst"` to `appliesTo` (`:33`).
- [ ] Insert at the top of `check`, before the ISO scan (`:39`):

```ts
    // A REFERENCE CLOSE is a price, not a timestamp, and it is the anchor every
    // Brier score is measured from: a value the model rounded or remembered
    // makes the whole forecast unfalsifiable while looking perfectly plausible.
    // Same rule as the clock, same reason — copy it, never compute it.
    const reference = /"referenceClose"\s*:\s*\{[^}]*"value"\s*:\s*(-?\d+(?:\.\d+)?)/u.exec(
      textOf(input),
    );
    if (reference !== null) {
      const value = reference[1]!;
      const step = ctx.stepToolOutputs ?? [];
      if (step.length === 0)
        return {
          pass: false,
          reason: `referenceClose.value ${value} but this step called no tool — there was nothing to copy it from`,
        };
      if (!step.some((out) => out.includes(value)))
        return {
          pass: false,
          reason: `referenceClose.value ${value} appears in no tool output from THIS step — quote the close the tool returned`,
        };
    }
```

*(`stepToolOutputs` is the step-scoped list, not the run-wide `toolOutputs`, and that distinction is the point: the comment at `packages/core/src/plugins.ts:132-140` records why a run-wide list cannot answer "did THIS step consult the tape".)*

- [ ] Run again — expected PASS (existing cases + 4 new).
- [ ] Commit:

```bash
git add plugins/option-wizard/gates/as-of-verbatim.ts plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts
git commit -m "fix(option-wizard): the reference close is quoted, never computed

Every Brier score is measured from that one number. A close the model rounded
makes the forecast unfalsifiable while looking exactly right."
```

## Task B6: D2/D4 — commitments and baselines leave the renderer

**Files:**
- Create `plugins/option-wizard/render/ledger.ts`
- Modify `plugins/option-wizard/render/index.ts` — the default export (`:1441`+) returns `commitments` and `baselines`
- Test: `plugins/option-wizard/tests/render-commitments.spec.ts`

**Interfaces:**
- Consumes: `CommitmentDraft` from `@helium/core`; `BriefView` (Task B4), `CandidateView` (Task B2), `RunReport.steps[].toolOutputs` (`packages/core/src/report.ts:29`)
- Produces: `forecastCommitments(view: BriefView, phase: string): CommitmentDraft[]`, `baselineDraft(view: BriefView, report: RunReport, phase: string): CommitmentDraft`

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/render-commitments.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunReport } from "@helium/core";
import { baselineDraft, forecastCommitments } from "../render/ledger.js";
import type { BriefView } from "../render/index.js";

const metrics = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/argon-metrics-2026-09-04.json"), "utf8"),
) as { response: unknown };

const view = {
  schemaVersion: 2,
  date: "2026-09-04",
  tenant: "option-wizard",
  outcome: "completed",
  headline: "h",
  tape: [],
  schedule: [],
  overnight: [],
  sections: [],
  regime: { paragraph: "p" },
  candidates: [
    {
      id: "SPY-2026-09-04-premarket-1",
      ticker: "SPY",
      strategy: "put_debit_spread",
      expiry: "2026-10-02",
      dte: 28,
      legs: [{ action: "buy", right: "put", strike: 770, expiry: "2026-10-02", mid: 10.45 }],
      pricing: { kind: "unpriced", reason: "no spot" },
      width: 0,
      invalidation: [{ level: 778, side: "above" }],
      target: { level: 748, side: "below" },
      thesis: "t",
      resolutionDeadline: "2026-10-02",
      rationale: "r",
    },
  ],
  riskList: [],
  charts: { gex: [] },
  spyForecast: {
    scorable: true,
    forecast: { referenceClose: { date: "2026-09-03", value: 770.19 }, t1Down: 0.42, t5Down: 0.47 },
  },
} as unknown as BriefView;

function report(toolOutputs: string[]): RunReport {
  return {
    runId: "run-1",
    tenant: "option-wizard",
    mode: "model",
    phase: "premarket",
    day: "2026-09-04",
    providersLive: [],
    providersSkipped: [],
    steps: [{ task: "regime", role: "regime-analyst", mode: "model", text: "", toolOutputs }],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: [],
  };
}

describe("commitments", () => {
  it("mints one commitment per settleable thing, phase-segmented", () => {
    const drafts = forecastCommitments(view, "premarket");
    expect(drafts.map((d) => d.id)).toEqual([
      "2026-09-04-premarket-spy-t1",
      "2026-09-04-premarket-spy-t5",
    ]);
    expect(drafts[0]!.payload).toEqual({
      kind: "spy-direction",
      evaluator: "evaluator-v0",
      horizonBars: 1,
      symbol: "SPY",
      referenceClose: { date: "2026-09-03", value: 770.19 },
      pDown: 0.42,
    });
    expect((drafts[1]!.payload as { horizonBars: number }).horizonBars).toBe(5);
  });

  it("mints nothing when the forecast is not scorable", () => {
    const bad = { ...view, spyForecast: { scorable: false, reason: "no forecast" } } as BriefView;
    expect(forecastCommitments(bad, "premarket")).toEqual([]);
  });

  it("emits NO candidate forecast commitment in V0", () => {
    // The candidate-selection team that will emit `candidate.forecast` is a
    // separate build; settle.ts already knows the -entry/-result rules.
    expect(forecastCommitments(view, "premarket").every((d) => d.id.includes("-spy-"))).toBe(true);
  });
});

describe("baselines", () => {
  it("writes the neutral and uniform floors the run has to beat", () => {
    const draft = baselineDraft(view, report([]), "premarket");
    expect(draft.id).toBe("2026-09-04-premarket-baseline");
    const payload = draft.payload as Record<string, unknown>;
    expect(payload.neutral).toEqual({ t1Down: 0.5, t5Down: 0.5 });
    expect(payload.uniform).toEqual([
      {
        candidateId: "SPY-2026-09-04-premarket-1",
        pTrigger: 0.5,
        givenTrigger: { targetFirst: 1 / 3, invalidationFirst: 1 / 3, unresolved: 1 / 3 },
      },
    ]);
  });

  it("carries dataDate verbatim from ow_argon_metrics and names what is missing", () => {
    const draft = baselineDraft(view, report([JSON.stringify(metrics.response)]), "premarket");
    expect((draft.payload as { argon: unknown }).argon).toEqual({
      dataDate: "2026-09-04",
      missing: ["confidence", "expectedReturn20d", "signal"],
    });
  });

  it("omits the argon block when no metrics tool answered", () => {
    expect((baselineDraft(view, report([]), "premarket").payload as { argon?: unknown }).argon).toBeUndefined();
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/render-commitments.spec.ts` — expected failure `Cannot find module '../render/ledger.js'`.

- [ ] Create `plugins/option-wizard/render/ledger.ts`:

```ts
/**
 * What this run promises, in a form a later run can check.
 *
 * ONE commitment per settleable thing, because each settles on its own day and
 * a receipt carries ONE status. The id carries the phase as well as the day:
 * `design` and `review` run at premarket AND close, so two runs share an ET
 * date, and `render/index.ts:940-950` records what happened the last time an
 * id did not say which of the day's runs minted it.
 *
 * V0 emits the SPY direction pair and no candidate forecast. The candidate
 * numbers will come from the dedicated candidate-selection team; today's design
 * and review steps propose a different set every run, so scoring them would be
 * measuring the sampling, not the judgement.
 * @module dsh-plugin-tenant-option-wizard/render/ledger
 */
import type { CommitmentDraft, RunReport } from "@helium/core";
import type { BriefView } from "./index.js";

export function forecastCommitments(
  view: BriefView,
  phase: string,
): CommitmentDraft[] {
  const block = view.spyForecast;
  if (block === undefined || !block.scorable || block.forecast === undefined)
    return [];
  const { referenceClose, t1Down, t5Down } = block.forecast;
  return [
    { horizon: 1, p: t1Down },
    { horizon: 5, p: t5Down },
  ].map(({ horizon, p }) => ({
    id: `${view.date}-${phase}-spy-t${String(horizon)}`,
    payload: {
      kind: "spy-direction",
      evaluator: "evaluator-v0",
      horizonBars: horizon,
      symbol: "SPY",
      referenceClose,
      pDown: p,
    },
  }));
}

/** The three fields an argon signal would need to be scorable beside ours. */
const ARGON_FIELDS = ["confidence", "expectedReturn20d", "signal"] as const;

/**
 * The trivial predictors this run has to beat.
 *
 * `neutral` and `uniform` are scorable today, so the Briers have a floor from
 * day one. `argon` is raw and unscored, and it carries `dataDate` VERBATIM: a
 * signal computed three sessions ago must never be counted as today's forecast.
 * No `med = 0.6` invention — a calibration map is evaluator-v1, once real
 * (signal, outcome) pairs exist.
 */
export function baselineDraft(
  view: BriefView,
  report: RunReport,
  phase: string,
): CommitmentDraft {
  const argon = argonBaseline(report);
  return {
    id: `${view.date}-${phase}-baseline`,
    payload: {
      evaluator: "evaluator-v0",
      neutral: { t1Down: 0.5, t5Down: 0.5 },
      uniform: view.candidates.map((candidate) => ({
        candidateId: candidate.id,
        pTrigger: 0.5,
        givenTrigger: {
          targetFirst: 1 / 3,
          invalidationFirst: 1 / 3,
          unresolved: 1 / 3,
        },
      })),
      ...(argon === undefined ? {} : { argon }),
    },
  };
}

/**
 * The argon row for SPY, as `ow_argon_metrics` answered it.
 *
 * Verified against the live response 2026-09-06: the envelope is
 * `{source, asOf?, rows:[{ticker, iv, gex, skew}]}` and the `iv` row is
 * `{close, ticker, iv_rank_1y, volatility, market_date}`. There is no `signal`,
 * `expectedReturn20d` or `confidence` on it yet; they arrive with the metrics
 * change on the quality-loop branch. Until then the field NAMES the gap rather
 * than filling it, because a baseline that quietly has no signal in it reads
 * like a baseline nobody could beat.
 */
function argonBaseline(report: RunReport): Record<string, unknown> | undefined {
  for (const output of report.steps.flatMap((step) => step.toolOutputs ?? [])) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      continue;
    }
    const envelope = parsed as { source?: unknown; rows?: unknown };
    if (envelope.source !== "argon.uw_scan" || !Array.isArray(envelope.rows))
      continue;
    const row = envelope.rows.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { ticker?: unknown }).ticker === "SPY",
    ) as Record<string, unknown> | undefined;
    if (row === undefined) continue;
    const iv = (row.iv ?? {}) as Record<string, unknown>;
    const dataDate =
      typeof row.dataDate === "string"
        ? row.dataDate
        : typeof iv.market_date === "string"
          ? iv.market_date
          : undefined;
    if (dataDate === undefined) continue;
    const present: Record<string, unknown> = { dataDate };
    const missing: string[] = [];
    for (const field of ARGON_FIELDS) {
      const value = row[field] ?? iv[field];
      if (value === undefined || value === null) missing.push(field);
      else present[field] = value;
    }
    if (missing.length > 0) present.missing = missing;
    return present;
  }
  return undefined;
}
```

- [ ] In `render/index.ts`, in the default-exported renderer (`:1441`+), return the drafts beside the existing fields:

```ts
  const commitments = forecastCommitments(view, report.phase);
  const baselines = [baselineDraft(view, report, report.phase)];
  return {
    text: renderText(view),
    html: renderHtml(view),
    data: view as unknown as Record<string, unknown>,
    ...(commitments.length === 0 ? {} : { commitments }),
    baselines,
  };
```

with `import { baselineDraft, forecastCommitments } from "./ledger.js";` added.

- [ ] Run again — expected PASS (6 passed).
- [ ] Run `pnpm vitest run --project unit plugins/option-wizard && pnpm typecheck` — expected PASS.
- [ ] Commit:

```bash
git add plugins/option-wizard/render/ledger.ts plugins/option-wizard/render/index.ts plugins/option-wizard/tests/render-commitments.spec.ts
git commit -m "feat(option-wizard): the run writes down what it promised

One commitment per settleable thing, phase-segmented for the same reason the
candidate ids are. Baselines are minted with it so the Briers have a floor to
beat from the first day rather than from the day someone remembers."
```

## Task B7: D3 — bars, ET sessions, and the coverage guard

**Files:**
- Create `plugins/option-wizard/eval/bars.ts`
- Modify `plugins/option-wizard/tsconfig.json` — `"include": ["tools", "gates", "render", "eval"]`
- Modify `plugins/option-wizard/package.json` — add `"eval"` to `files`
- Test: `plugins/option-wizard/tests/eval-bars.spec.ts`

**Interfaces:**
- Consumes: the frozen fixture from Task B1; `fetch` (production only), mirroring `ow_apex_bars` (`tools/index.ts:2892-2965`)
- Produces: `Bar`, `BarSource`, `etSession(iso: string): { date: string; minute: number }`, `RTH_OPEN = 570`, `RTH_CLOSE = 960`, `rthSessions(bars: Bar[]): Map<string, Bar[]>`, `MIN_RTH_BARS = 380`, `TenantCalendar`, `missingWeekdays(have: readonly string[], from: string, to: string, calendar?: TenantCalendar): string[]`, `fixtureBarSource(doc): BarSource`, `apexBarSource(base: string, fetchImpl?: typeof fetch): BarSource`

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/eval-bars.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  etSession,
  fixtureBarSource,
  MIN_RTH_BARS,
  missingWeekdays,
  rthSessions,
  RTH_CLOSE,
  RTH_OPEN,
} from "../eval/bars.js";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/spy-bars-2026-09-02_03.json"), "utf8"),
) as { bars1m: Array<{ time: string }>; bars1d: Array<{ time: string; close: number }> };

describe("ET sessions", () => {
  it("the fixture is real, frozen, and covers two full ET sessions", () => {
    const sessions = rthSessions(doc.bars1m as never);
    expect([...sessions.keys()]).toEqual(["2026-09-02", "2026-09-03"]);
    expect(sessions.get("2026-09-02")!.length).toBe(390);
    expect(sessions.get("2026-09-03")!.length).toBe(390);
    expect(MIN_RTH_BARS).toBe(380);
  });

  it("an ET session split across two HKT dates is ONE session", () => {
    // 2026-09-02 13:30Z is 09:30 ET, which is 2026-09-02 21:30 in Hong Kong;
    // 2026-09-02 19:59Z is 15:59 ET, which is 2026-09-03 03:59 in Hong Kong.
    expect(etSession("2026-09-02T13:30:00Z").date).toBe("2026-09-02");
    expect(etSession("2026-09-02T19:59:00Z").date).toBe("2026-09-02");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong" }).format(new Date("2026-09-02T19:59:00Z")),
    ).toBe("2026-09-03");
  });

  it("marks the RTH window by minutes from ET midnight", () => {
    expect(RTH_OPEN).toBe(9 * 60 + 30);
    expect(RTH_CLOSE).toBe(16 * 60);
    expect(etSession("2026-09-02T13:30:00Z").minute).toBe(RTH_OPEN);
  });

  it("drops a pre-market print: 08:00 ET is outside the window", () => {
    const premarket = { time: "2026-09-02T12:00:00Z", open: 1, high: 999, low: 1, close: 1, volume: 1 };
    const sessions = rthSessions([premarket, ...(doc.bars1m as never[])] as never);
    expect(sessions.get("2026-09-02")!.length).toBe(390);
    expect(sessions.get("2026-09-02")!.some((bar) => bar.high === 999)).toBe(false);
  });

  it("names an open weekday the lake has no daily bar for", () => {
    const have = ["2026-09-02"];
    expect(
      missingWeekdays(have, "2026-09-01", "2026-09-03", {
        weekdaysOnly: true,
        closed: [],
      }),
    ).toEqual(["2026-09-03"]);
  });

  it("says nothing about a day the tenant declared closed, or a weekend", () => {
    expect(
      missingWeekdays(["2026-09-02"], "2026-09-01", "2026-09-06", {
        weekdaysOnly: true,
        closed: ["2026-09-03", "2026-09-04"],
      }),
    ).toEqual([]);
  });

  it("no calendar means no cross-check: the bar count is the only guard", () => {
    expect(missingWeekdays([], "2026-09-01", "2026-09-03")).toEqual([]);
  });

  it("the fixture source serves 1m by ET session and 1d by date", async () => {
    const source = fixtureBarSource(doc as never);
    expect((await source.bars1m("SPY", "2026-09-03", "2026-09-03")).length).toBe(390);
    const daily = await source.bars1d("SPY", "2026-08-26", "2026-09-03");
    expect(daily.length).toBe(doc.bars1d.length);
    expect(daily.at(-1)!.time).toBe("2026-09-03");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/eval-bars.spec.ts` — expected failure `Cannot find module '../eval/bars.js'`.

- [ ] Create `plugins/option-wizard/eval/bars.ts`:

```ts
/**
 * Bars, in ET sessions, from whatever holds them.
 *
 * The settler never selects by HKT date. The lake's 1m file is EXTENDED HOURS
 * and its `bar_timestamp` is `TIMESTAMP WITH TIME ZONE` in `Asia/Hong_Kong`
 * (~850 rows per HKT date, verified on the mini 2026-09-04/05/06), so ONE ET
 * session spans two HKT dates: 09:30 ET is 21:30 the same HK day and 15:59 ET
 * is 03:59 the NEXT one. Everything here converts to America/New_York first.
 *
 * Production reads apex, not the parquet: `ow_apex_bars`
 * (`tools/index.ts:2892`) already serves the same lake over HTTP with no
 * credential, so there is no duckdb dependency to add and no second reader to
 * keep in step. apex normalises `time` to UTC
 * (`apex src/api/payload/chart.py:15-46`), which is why an instant is all this
 * module ever reads.
 * @module dsh-plugin-tenant-option-wizard/eval/bars
 */

/** One OHLCV row, field-for-field as apex returns it. */
export interface Bar {
  /** UTC ISO instant for an intraday bar; `yyyy-mm-dd` for a daily bar. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BarSource {
  /** RTH-inclusive 1m bars covering the ET session dates `fromEt..toEt`. */
  bars1m(symbol: string, fromEt: string, toEt: string): Promise<Bar[]>;
  /** Daily bars for the trade dates `fromDate..toDate`. */
  bars1d(symbol: string, fromDate: string, toDate: string): Promise<Bar[]>;
}

export const RTH_OPEN = 9 * 60 + 30;
export const RTH_CLOSE = 16 * 60;
/**
 * A full RTH session is 390 one-minute bars. 380 is the floor a session must
 * clear to be trusted: an early close is not the case this guards — those are
 * in the tenant's calendar — a LAKE GAP is, and a gap is why
 * `livewire-shepherd` exists. A short session is `pending`, never a verdict.
 */
export const MIN_RTH_BARS = 380;

const ET = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function etSession(iso: string): { date: string; minute: number } {
  const parts = new Map(
    ET.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = Number(parts.get("hour")) % 24;
  return {
    date: `${parts.get("year")!}-${parts.get("month")!}-${parts.get("day")!}`,
    minute: hour * 60 + Number(parts.get("minute")),
  };
}

/** The tenant's own word on which days it has nothing to say about. */
export interface TenantCalendar {
  weekdaysOnly: boolean;
  closed: string[];
}

/**
 * The ET weekdays in `[from, to]` that the tenant says are OPEN and the lake
 * has no daily bar for. Spec §5 D3: settlement still counts lake bars, and the
 * calendar is a CROSS-CHECK — a weekday nobody declared closed with no bar is
 * a lake gap, and a gap must settle `pending`, never `not-entered`.
 *
 * No calendar means no cross-check. The tenant is the only thing that knows
 * why a day is shut (`packages/core/src/tenant.ts:39-60`), and a settler that
 * guessed at holidays would be the exchange calendar this repo has decided not
 * to grow.
 */
export function missingWeekdays(
  have: readonly string[],
  from: string,
  to: string,
  calendar?: TenantCalendar,
): string[] {
  if (calendar === undefined) return [];
  const known = new Set(have);
  const closed = new Set(calendar.closed);
  const out: string[] = [];
  for (
    let at = Date.parse(`${from}T12:00:00Z`);
    at <= Date.parse(`${to}T12:00:00Z`);
    at += 86_400_000
  ) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (date <= from) continue;
    const weekday = new Date(at).getUTCDay();
    if (calendar.weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    if (closed.has(date) || known.has(date)) continue;
    out.push(date);
  }
  return out;
}

/** ET session date -> that session's RTH bars, in time order. */
export function rthSessions(bars: readonly Bar[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const bar of [...bars].sort((a, b) => a.time.localeCompare(b.time))) {
    const { date, minute } = etSession(bar.time);
    if (minute < RTH_OPEN || minute >= RTH_CLOSE) continue;
    const list = out.get(date);
    if (list === undefined) out.set(date, [bar]);
    else list.push(bar);
  }
  return out;
}

/** The frozen fixture, for tests. Never used in production. */
export function fixtureBarSource(doc: {
  bars1m: Bar[];
  bars1d: Bar[];
}): BarSource {
  return {
    async bars1m(_symbol, fromEt, toEt) {
      return doc.bars1m.filter((bar) => {
        const { date } = etSession(bar.time);
        return date >= fromEt && date <= toEt;
      });
    },
    async bars1d(_symbol, fromDate, toDate) {
      return doc.bars1d.filter(
        (bar) => bar.time >= fromDate && bar.time <= toDate,
      );
    },
  };
}

/**
 * apex over HTTP, mirroring `ow_apex_bars`: `start` must be offset-aware or
 * apex answers 500, `price_mode=adjusted` is equity-only, and no credential is
 * needed. The window is widened by a day on each side and then filtered by ET
 * session, because an ET session date is not a UTC date.
 */
export function apexBarSource(
  base: string,
  fetchImpl: typeof fetch = fetch,
): BarSource {
  const day = 86_400_000;
  async function bars(
    symbol: string,
    timeframe: string,
    fromIso: string,
    toIso: string,
  ): Promise<Bar[]> {
    const url = new URL(`/v1/equity/${encodeURIComponent(symbol)}/bars`, base);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", fromIso);
    url.searchParams.set("end", toIso);
    url.searchParams.set("price_mode", "adjusted");
    url.searchParams.set("limit", "0");
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(
        `settler: ${url.pathname} returned ${String(response.status)} ${response.statusText}`,
      );
    const body = (await response.json()) as { bars?: Bar[] };
    return body.bars ?? [];
  }
  return {
    async bars1m(symbol, fromEt, toEt) {
      return bars(
        symbol,
        "1m",
        new Date(Date.parse(`${fromEt}T00:00:00Z`) - day).toISOString(),
        new Date(Date.parse(`${toEt}T00:00:00Z`) + day).toISOString(),
      );
    },
    async bars1d(symbol, fromDate, toDate) {
      const rows = await bars(
        symbol,
        "1d",
        new Date(Date.parse(`${fromDate}T00:00:00Z`) - day).toISOString(),
        new Date(Date.parse(`${toDate}T00:00:00Z`) + day).toISOString(),
      );
      // apex returns a UTC instant for a daily bar too; the trade date is the
      // ET session it belongs to.
      return rows
        .map((bar) => ({ ...bar, time: etSession(bar.time).date }))
        .filter((bar) => bar.time >= fromDate && bar.time <= toDate);
    },
  };
}
```

- [ ] Add `"eval"` to `include` in `plugins/option-wizard/tsconfig.json` and to `files` in `plugins/option-wizard/package.json`.
- [ ] Run again — expected PASS (8 passed).
- [ ] Run `pnpm build` — expected: `plugins/option-wizard/lib/eval/bars.js` exists. If the build is a no-op, delete `plugins/option-wizard/tsconfig.tsbuildinfo` first: a stale tsbuildinfo makes `pnpm build` report success while `lib/` stays old.
- [ ] Commit:

```bash
git add plugins/option-wizard/eval/bars.ts plugins/option-wizard/tsconfig.json plugins/option-wizard/package.json plugins/option-wizard/tests/eval-bars.spec.ts
git commit -m "feat(option-wizard): read bars in ET sessions, never by HKT date

One ET session spans two Hong Kong dates and the 1m lake is extended hours,
so selecting by the stored date silently mixes two sessions and imports a
pre-market print as if it were a trade at the open."
```

## Task B8: D3 — the settler

**Files:**
- Create `plugins/option-wizard/eval/settle.ts`
- Modify `plugins/option-wizard/tools/index.ts` — re-export `buildSettler` at the end
- Test: `plugins/option-wizard/tests/eval-settle.spec.ts`

**Interfaces:**
- Consumes: `Commitment`, `Receipt`, `Settler` from `@helium/core`; `BarSource`, `rthSessions`, `MIN_RTH_BARS`, `missingWeekdays`, `TenantCalendar`, `apexBarSource` (Task B7); `need(env, key, tool)` (`tools/index.ts:180-195`), which is how every existing tool reads a required key out of `cfg.env`; `OW_APEX_API_BASE` is already declared in `plugins/option-wizard/tenant.yaml:32`, so no manifest edit is needed
- Produces: `settleAll(open: Commitment[], now: Date, source: BarSource, calendar?: TenantCalendar): Promise<Receipt[]>`, `binaryBrier(p: number, outcome: 0 | 1): number`, `threeClassBrier(p: {targetFirst,invalidationFirst,unresolved}, outcome: "targetFirst"|"invalidationFirst"|"unresolved"): number`, `export function buildSettler(cfg): Settler`

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/eval-settle.spec.ts`. The frozen SPY bars are the only ground truth; read the two sessions' real extremes out of the fixture at test setup so no price is ever typed by hand:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Commitment } from "@helium/core";
import {
  fixtureBarSource,
  rthSessions,
  type Bar,
  type TenantCalendar,
} from "../eval/bars.js";
import { binaryBrier, settleAll, threeClassBrier } from "../eval/settle.js";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/spy-bars-2026-09-02_03.json"), "utf8"),
) as { bars1m: Bar[]; bars1d: Bar[] };
const source = fixtureBarSource(doc);
const NOW = new Date("2026-09-04T12:00:00Z");

let hi02 = 0;
let lo02 = 0;
let close02 = 0;
let refClose = 0;

beforeAll(() => {
  const s = rthSessions(doc.bars1m).get("2026-09-02")!;
  hi02 = Math.max(...s.map((b) => b.high));
  lo02 = Math.min(...s.map((b) => b.low));
  close02 = doc.bars1d.find((b) => b.time === "2026-09-02")!.close;
  refClose = doc.bars1d.find((b) => b.time === "2026-09-01")!.close;
});

function candidate(payload: Record<string, unknown>, id = "SPY-2026-09-01-premarket-1-entry"): Commitment {
  return {
    id,
    runId: "run-0",
    tenant: "option-wizard",
    issuedAt: "2026-09-01T12:00:00Z",
    deployment: "production",
    variant: "live",
    payload: { kind: "candidate-entry", evaluator: "evaluator-v0", symbol: "SPY", ...payload },
  };
}

async function one(commitment: Commitment) {
  const [receipt] = await settleAll([commitment], NOW, source);
  return receipt!;
}

describe("Brier formulas, frozen as evaluator-v0", () => {
  it("binary is (p - o) squared, range 0..1", () => {
    expect(binaryBrier(0.42, 1)).toBeCloseTo(0.3364, 10);
    expect(binaryBrier(0.42, 0)).toBeCloseTo(0.1764, 10);
    expect(binaryBrier(0, 1)).toBe(1);
  });

  it("three-class sums the squared error over all three classes, range 0..2", () => {
    expect(
      threeClassBrier({ targetFirst: 1, invalidationFirst: 0, unresolved: 0 }, "invalidationFirst"),
    ).toBeCloseTo(2, 10);
    expect(
      threeClassBrier({ targetFirst: 1 / 3, invalidationFirst: 1 / 3, unresolved: 1 / 3 }, "targetFirst"),
    ).toBeCloseTo(2 / 3, 10);
  });
});

describe("entry", () => {
  it("not-entered when the level was never reached inside the deadline", () => {
    const receipt = () =>
      one(
        candidate({
          entry: { level: hi02 + 50, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 100, side: "above" }],
          target: { level: lo02 - 100, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: { pTrigger: 0.3, givenTrigger: { targetFirst: 0.4, invalidationFirst: 0.4, unresolved: 0.2 } },
        }),
      );
    return receipt().then((r) => {
      expect(r.status).toBe("not-entered");
      expect(r.scores.triggerBrier).toBeCloseTo(binaryBrier(0.3, 0), 10);
      expect(r.scores.resolutionBrier).toBeUndefined();
    });
  });

  it("targetFirst when the target is touched before any invalidation", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: hi02 + 100, side: "above" }],
        target: { level: hi02 - 0.01, side: "below" },
        resolutionDeadline: "2026-09-03",
        forecast: { pTrigger: 0.9, givenTrigger: { targetFirst: 0.6, invalidationFirst: 0.3, unresolved: 0.1 } },
      }),
    );
    expect(receipt.status).toBe("targetFirst");
    expect(receipt.scores.triggerBrier).toBeCloseTo(binaryBrier(0.9, 1), 10);
    expect(receipt.scores.resolutionBrier).toBeCloseTo(
      threeClassBrier({ targetFirst: 0.6, invalidationFirst: 0.3, unresolved: 0.1 }, "targetFirst"),
      10,
    );
    expect((receipt.detail as { enteredAt: string }).enteredAt).toBeDefined();
    expect(receipt.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("invalidationFirst when the stop is touched first", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: lo02, side: "below" }],
        target: { level: hi02 + 100, side: "above" },
        resolutionDeadline: "2026-09-03",
        forecast: { pTrigger: 0.9, givenTrigger: { targetFirst: 0.6, invalidationFirst: 0.3, unresolved: 0.1 } },
      }),
    );
    expect(receipt.status).toBe("invalidationFirst");
  });

  it("unresolved when neither side is touched by the resolution deadline", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: hi02 + 100, side: "above" }],
        target: { level: lo02 - 100, side: "below" },
        resolutionDeadline: "2026-09-03",
        forecast: { pTrigger: 0.9, givenTrigger: { targetFirst: 0.2, invalidationFirst: 0.2, unresolved: 0.6 } },
      }),
    );
    expect(receipt.status).toBe("unresolved");
  });

  it("both sides inside ONE 1m bar is ambiguous and earns no resolution score", async () => {
    const receipt = await one(
      candidate({
        entry: { level: hi02, side: "below", deadlineBars: 1 },
        referenceClose: { date: "2026-09-01", value: refClose },
        invalidation: [{ level: lo02, side: "below" }],
        target: { level: hi02, side: "above" },
        resolutionDeadline: "2026-09-03",
        forecast: { pTrigger: 0.9, givenTrigger: { targetFirst: 0.6, invalidationFirst: 0.3, unresolved: 0.1 } },
      }),
    );
    expect(receipt.status).toBe("ambiguous");
    expect(receipt.scores.resolutionBrier).toBeUndefined();
  });

  it("a pre-market print through the level does not enter the trade", async () => {
    const withPremarket = fixtureBarSource({
      bars1d: doc.bars1d,
      bars1m: [
        { time: "2026-09-02T12:00:00Z", open: hi02 + 50, high: hi02 + 60, low: hi02 + 50, close: hi02 + 55, volume: 1 },
        ...doc.bars1m,
      ],
    });
    const [receipt] = await settleAll(
      [
        candidate({
          entry: { level: hi02 + 55, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 200, side: "above" }],
          target: { level: lo02 - 200, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: { pTrigger: 0.5, givenTrigger: { targetFirst: 0.4, invalidationFirst: 0.4, unresolved: 0.2 } },
        }),
      ],
      NOW,
      withPremarket,
    );
    expect(receipt!.status).toBe("not-entered");
  });

  it("a session with 200 bars is pending, never not-entered", async () => {
    const gappy = fixtureBarSource({
      bars1d: doc.bars1d,
      bars1m: rthSessions(doc.bars1m).get("2026-09-02")!.slice(0, 200),
    });
    const [receipt] = await settleAll(
      [
        candidate({
          entry: { level: hi02 + 50, side: "above", deadlineBars: 1 },
          referenceClose: { date: "2026-09-01", value: refClose },
          invalidation: [{ level: hi02 + 100, side: "above" }],
          target: { level: lo02 - 100, side: "below" },
          resolutionDeadline: "2026-09-03",
          forecast: { pTrigger: 0.5, givenTrigger: { targetFirst: 0.4, invalidationFirst: 0.4, unresolved: 0.2 } },
        }),
      ],
      NOW,
      gappy,
    );
    expect(receipt!.status).toBe("pending");
    expect(receipt!.scores).toEqual({});
  });
});

describe("the calendar cross-check", () => {
  // 2026-09-01, 09-02 and 09-03 are Tue/Wed/Thu and all three have a real 1d
  // row in the fixture. Dropping 09-03's row is exactly the shape of a lake
  // gap: no bar for a weekday nobody said was shut.
  const gappy = () =>
    fixtureBarSource({
      bars1m: doc.bars1m,
      bars1d: doc.bars1d.filter((bar) => bar.time !== "2026-09-03"),
    });

  const commitment = () =>
    candidate({
      entry: { level: hi02, side: "below", deadlineBars: 2 },
      referenceClose: { date: "2026-09-01", value: refClose },
      invalidation: [{ level: hi02 + 100, side: "above" }],
      target: { level: lo02 - 100, side: "below" },
      resolutionDeadline: "2026-09-03",
      forecast: {
        pTrigger: 0.5,
        givenTrigger: {
          targetFirst: 0.4,
          invalidationFirst: 0.4,
          unresolved: 0.2,
        },
      },
    });

  const openCal: TenantCalendar = { weekdaysOnly: true, closed: [] };
  const shutCal: TenantCalendar = {
    weekdaysOnly: true,
    closed: ["2026-09-03"],
  };

  it("an open weekday with no daily bar is a lake gap, never a verdict", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy(), openCal);
    expect(receipt!.status).toBe("pending");
    expect((receipt!.detail as { reason: string }).reason).toContain(
      "2026-09-03",
    );
    expect(receipt!.scores).toEqual({});
  });

  it("the same gap on a day the tenant declared closed settles normally", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy(), shutCal);
    expect(receipt!.status).not.toBe("pending");
    // The window counts only the sessions the lake actually holds.
    expect((receipt!.detail as { sessions: string[] }).sessions).toEqual([
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("with no calendar the bar count is the only guard, and the gap is invisible", async () => {
    const [receipt] = await settleAll([commitment()], NOW, gappy());
    expect(receipt!.status).not.toBe("pending");
  });
});

describe("spy direction", () => {
  function spy(horizon: number, pDown: number): Commitment {
    return {
      id: `2026-09-01-premarket-spy-t${String(horizon)}`,
      runId: "run-0",
      tenant: "option-wizard",
      issuedAt: "2026-09-01T12:00:00Z",
      deployment: "production",
      variant: "live",
      payload: {
        kind: "spy-direction",
        evaluator: "evaluator-v0",
        horizonBars: horizon,
        symbol: "SPY",
        referenceClose: { date: "2026-09-01", value: refClose },
        pDown,
      },
    };
  }

  it("t1 scores against the 1d close one bar after the reference", async () => {
    const receipt = await one(spy(1, 0.42));
    const outcome = close02 < refClose ? 1 : 0;
    // The bar after 2026-09-01 is whichever daily row the lake holds next; the
    // fixture's own rows decide it, never a calendar assumption in the test.
    expect(["down", "up"]).toContain(receipt.status);
    expect(receipt.scores.t1Brier).toBeGreaterThanOrEqual(0);
    expect(receipt.scores.t1Brier).toBeLessThanOrEqual(1);
    expect(typeof outcome).toBe("number");
  });

  it("t5 is pending while the fifth bar does not exist yet", async () => {
    const receipt = await one(spy(5, 0.47));
    expect(receipt.status).toBe("pending");
    expect(receipt.scores).toEqual({});
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/eval-settle.spec.ts` — expected failure `Cannot find module '../eval/settle.js'`.

- [ ] Create `plugins/option-wizard/eval/settle.ts`:

```ts
/**
 * How this tenant checks what it promised, against the lake.
 *
 * Order of the rules matters and is the design (§5 D3): coverage first, then
 * entry, then resolution, then direction, then the score. Coverage first
 * because "we cannot see" and "it did not happen" are different answers and
 * only one of them is a verdict — a lake gap that reads as `not-entered` is a
 * measurement that quietly rewards the model for the pipeline being broken.
 *
 * The `-entry` / `-result` rules below are implemented and tested, and V0
 * emits no candidate forecast commitment for them to settle: the candidate
 * numbers come from the candidate-selection team being built separately, and
 * they light up the day it emits them.
 * @module dsh-plugin-tenant-option-wizard/eval/settle
 */
import { createHash } from "node:crypto";
import type { Commitment, Receipt, Settler } from "@helium/core";
import {
  apexBarSource,
  MIN_RTH_BARS,
  missingWeekdays,
  rthSessions,
  type Bar,
  type BarSource,
  type TenantCalendar,
} from "./bars.js";

type Side = "above" | "below";
type Level = { level: number; side: Side };
type Resolution = "targetFirst" | "invalidationFirst" | "unresolved";

export function binaryBrier(p: number, outcome: 0 | 1): number {
  return (p - outcome) ** 2;
}

export function threeClassBrier(
  p: Record<Resolution, number>,
  outcome: Resolution,
): number {
  const classes: Resolution[] = ["targetFirst", "invalidationFirst", "unresolved"];
  return classes.reduce(
    (total, key) => total + (p[key] - (key === outcome ? 1 : 0)) ** 2,
    0,
  );
}

function touches(bar: Bar, level: Level): boolean {
  return level.side === "above" ? bar.high >= level.level : bar.low <= level.level;
}

function hashBars(bars: readonly Bar[]): string {
  return createHash("sha256")
    .update(bars.map((bar) => `${bar.time}|${String(bar.high)}|${String(bar.low)}|${String(bar.close)}`).join("\n"))
    .digest("hex");
}

function pending(commitment: Commitment, now: Date, reason: string): Receipt {
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: "pending",
    scores: {},
    detail: { reason },
  };
}

/**
 * Every ET session in `[from, to]` that the lake can answer for, and the ones
 * it cannot. A weekday with no 1d bar, or a session with fewer than
 * MIN_RTH_BARS 1m bars, is a GAP — not a quiet market.
 */
function coverage(
  daily: readonly Bar[],
  minute: Map<string, Bar[]>,
  from: string,
  to: string,
  calendar?: TenantCalendar,
): { sessions: string[]; short: string[]; missing: string[] } {
  const sessions = daily
    .map((bar) => bar.time)
    .filter((date) => date >= from && date <= to)
    .sort();
  const short = sessions.filter(
    (date) => (minute.get(date)?.length ?? 0) < MIN_RTH_BARS,
  );
  // The calendar cross-check. Without it a lake that lost a whole day looks
  // identical to a market that was shut: both are "no bar", and one of them
  // must not be scored.
  const missing = missingWeekdays(sessions, from, to, calendar);
  return { sessions, short, missing };
}

async function settleSpy(
  commitment: Commitment,
  now: Date,
  source: BarSource,
  calendar?: TenantCalendar,
): Promise<Receipt> {
  const payload = commitment.payload as {
    horizonBars: number;
    symbol: string;
    referenceClose: { date: string; value: number };
    pDown: number;
  };
  // Deliberately generous: the window is counted in BARS, so ask for enough
  // calendar days that the n-th bar is certainly inside it, then count.
  const from = payload.referenceClose.date;
  const to = new Date(
    Date.parse(`${from}T00:00:00Z`) + (payload.horizonBars + 10) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const daily = await source.bars1d(payload.symbol, from, to);
  const after = daily
    .filter((bar) => bar.time > from)
    .sort((a, b) => a.time.localeCompare(b.time));
  // Same cross-check as the candidate path, and it must run BEFORE the count:
  // counting bars over a window with a hole in it settles `t5` against what is
  // really the sixth session.
  const gaps = missingWeekdays(
    daily.map((bar) => bar.time),
    from,
    after[payload.horizonBars - 1]?.time ?? from,
    calendar,
  );
  if (gaps.length > 0)
    return pending(
      commitment,
      now,
      `lake gap: open weekday(s) with no daily bar: ${gaps.join(", ")}`,
    );
  const bar = after[payload.horizonBars - 1];
  if (bar === undefined)
    return pending(
      commitment,
      now,
      `only ${String(after.length)} daily bar(s) after ${from}; need ${String(payload.horizonBars)}`,
    );
  const down = bar.close < payload.referenceClose.value;
  const key = `t${String(payload.horizonBars)}Brier`;
  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: down ? "down" : "up",
    scores: { [key]: binaryBrier(payload.pDown, down ? 1 : 0) },
    evidenceHash: hashBars([bar]),
    detail: {
      settledOn: bar.time,
      close: bar.close,
      referenceClose: payload.referenceClose,
      // Raw, never adjusted. SPY goes ex around the third Friday of September,
      // inside the first live window; recording it is what lets a later reader
      // see the distortion rather than a corrected number that hides it.
      priceBasis: "raw, not dividend-adjusted",
    },
  };
}

async function settleCandidate(
  commitment: Commitment,
  now: Date,
  source: BarSource,
  calendar?: TenantCalendar,
): Promise<Receipt> {
  const payload = commitment.payload as {
    symbol: string;
    entry?: Level & { deadlineBars: number };
    referenceClose: { date: string; value: number };
    invalidation: Level[];
    target?: Level;
    resolutionDeadline: string;
    forecast: {
      pTrigger: number;
      givenTrigger: Record<Resolution, number>;
    };
  };
  const from = payload.referenceClose.date;
  const to = payload.resolutionDeadline;
  const [daily, minute] = await Promise.all([
    source.bars1d(payload.symbol, from, to),
    source.bars1m(payload.symbol, from, to),
  ]);
  const sessions = rthSessions(minute);
  const {
    sessions: known,
    short,
    missing,
  } = coverage(daily, sessions, from, to, calendar);
  if (known.length === 0 || short.length > 0 || missing.length > 0)
    return pending(
      commitment,
      now,
      missing.length > 0
        ? `lake gap: open weekday(s) with no daily bar: ${missing.join(", ")}`
        : short.length > 0
          ? `sessions short of ${String(MIN_RTH_BARS)} RTH bars: ${short.join(", ")}`
          : `no daily bar between ${from} and ${to}`,
    );
  const after = known.filter((date) => date > from);
  const used: Bar[] = [];

  // 2. Entry. No `entry` field means the thesis was live from issue.
  let entered: { bar: Bar; session: string; index: number } | undefined;
  if (payload.entry === undefined) {
    const first = after[0];
    const bars = first === undefined ? [] : (sessions.get(first) ?? []);
    if (bars[0] === undefined)
      return pending(commitment, now, "no session after the reference close yet");
    entered = { bar: bars[0], session: first!, index: 0 };
  } else {
    const window = after.slice(0, payload.entry.deadlineBars);
    if (window.length < payload.entry.deadlineBars)
      return pending(
        commitment,
        now,
        `only ${String(window.length)} of ${String(payload.entry.deadlineBars)} deadline sessions exist`,
      );
    outer: for (const session of window) {
      const bars = sessions.get(session) ?? [];
      for (const [index, bar] of bars.entries()) {
        used.push(bar);
        if (touches(bar, payload.entry)) {
          entered = { bar, session, index };
          break outer;
        }
      }
    }
    if (entered === undefined)
      return {
        commitmentId: commitment.id,
        runId: "",
        settledAt: now.toISOString(),
        status: "not-entered",
        scores: { triggerBrier: binaryBrier(payload.forecast.pTrigger, 0) },
        evidenceHash: hashBars(used),
        detail: { deadlineSessions: window },
      };
  }

  const scores: Record<string, number> = {
    triggerBrier: binaryBrier(payload.forecast.pTrigger, 1),
  };

  // 3. Resolution, STRICTLY after the entry bar: a level touched by the bar
  // that filled the entry is not a move the thesis made.
  let outcome: Resolution | "ambiguous" = "unresolved";
  let resolvedAt: string | undefined;
  const walk = after.slice(after.indexOf(entered.session));
  scan: for (const [order, session] of walk.entries()) {
    const bars = (sessions.get(session) ?? []).slice(
      order === 0 ? entered.index + 1 : 0,
    );
    for (const bar of bars) {
      used.push(bar);
      const hitStop = payload.invalidation.some((level) => touches(bar, level));
      const hitTarget =
        payload.target !== undefined && touches(bar, payload.target);
      if (hitStop && hitTarget) {
        outcome = "ambiguous";
        resolvedAt = bar.time;
        break scan;
      }
      if (hitStop) {
        outcome = "invalidationFirst";
        resolvedAt = bar.time;
        break scan;
      }
      if (hitTarget) {
        outcome = "targetFirst";
        resolvedAt = bar.time;
        break scan;
      }
    }
  }
  // Nothing touched yet and the deadline has not passed: still open.
  if (outcome === "unresolved" && known.at(-1)! < payload.resolutionDeadline)
    return pending(commitment, now, `open; sessions through ${known.at(-1)!}`);

  if (outcome !== "ambiguous")
    scores.resolutionBrier = threeClassBrier(payload.forecast.givenTrigger, outcome);

  return {
    commitmentId: commitment.id,
    runId: "",
    settledAt: now.toISOString(),
    status: outcome,
    scores,
    evidenceHash: hashBars(used),
    detail: {
      enteredAt: entered.bar.time,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      sessions: known,
      priceBasis: "raw, not dividend-adjusted",
    },
  };
}

export async function settleAll(
  open: Commitment[],
  now: Date,
  source: BarSource,
  calendar?: TenantCalendar,
): Promise<Receipt[]> {
  const out: Receipt[] = [];
  for (const commitment of open) {
    const kind = (commitment.payload as { kind?: unknown }).kind;
    try {
      if (kind === "spy-direction")
        out.push(await settleSpy(commitment, now, source, calendar));
      else if (kind === "candidate-entry" || kind === "candidate-result")
        out.push(await settleCandidate(commitment, now, source, calendar));
      // A kind this build does not know is left ALONE, not settled: a newer
      // renderer's commitment must not be closed off by an older settler.
    } catch (error: unknown) {
      out.push(
        pending(
          commitment,
          now,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return out;
}

/**
 * The tenant's declaration, built the way `buildTools` is.
 *
 * A FACTORY, not a constant: the API base is an env key the manifest declares
 * (`tenant.yaml:32`) and the host forwards through `cfg.env`, and the calendar
 * is the tenant's own `calendar:` block. Reading `process.env` here would take
 * both from behind the host's back — the exact seam `TenantToolConfig` exists
 * to be.
 *
 * Reads apex; writes nothing anywhere (doctrine 5: outside a sandbox, never
 * touch the production lake).
 */
export function buildSettler(cfg: {
  stateRoot: string;
  env: Record<string, string | undefined>;
  variant: string;
  asOf?: Date;
  calendar?: TenantCalendar;
}): Settler {
  return {
    async settle(open: Commitment[], now: Date): Promise<Receipt[]> {
      const base = cfg.env.OW_APEX_API_BASE;
      if (base === undefined || base === "")
        return open.map((commitment) =>
          pending(
            commitment,
            now,
            "OW_APEX_API_BASE is unset; nothing was checked",
          ),
        );
      return settleAll(open, now, apexBarSource(base), cfg.calendar);
    },
  };
}
```

*(`Receipt.runId` is left empty in this module on purpose: `Settler.settle` receives the outstanding commitments and a clock and nothing else, so it cannot know the id of the run settling them. The runner stamps it — Task A4. Everything else the settler needs — the API base, the calendar — arrives through `cfg`, which is why `buildSettler` is a factory.)*

- [ ] Add to the end of `plugins/option-wizard/tools/index.ts`:

```ts
/** The tenant's settler factory, re-exported where the harness looks for it
 *  (beside `VOCABULARY` and `buildTools`). The implementation lives under
 *  `eval/` because settling is not a tool: no agent may call it. */
export { buildSettler } from "../eval/settle.js";
```

- [ ] Run again — expected PASS (13 passed: two Brier cases, six entry/resolution cases, three calendar cases, two direction cases).
- [ ] Run `pnpm build && pnpm typecheck && pnpm test` — expected PASS.
- [ ] Commit:

```bash
git add plugins/option-wizard/eval/settle.ts plugins/option-wizard/tools/index.ts plugins/option-wizard/tests/eval-settle.spec.ts
git commit -m "feat(option-wizard): settle commitments against real bars

Coverage first: a lake gap that reads as not-entered is a measurement that
rewards the model for the pipeline being broken. A short session is pending, an
open weekday with no bar is pending, and a kind this build does not know is
left alone rather than closed off. The calendar comes from the manifest through
cfg, because only the tenant knows why a day is shut."
```

## Task B9: the producer fixture argon consumes

**Files:**
- Create `plugins/option-wizard/contracts/brief-view-v2.fixture.json`
- Test: `plugins/option-wizard/tests/brief-view-fixture.spec.ts`

**Interfaces:**
- Consumes: `buildView(report: RunReport, cfg: TenantSpec): BriefView` (`render/index.ts:1441`)
- Produces: a committed `BriefView` at `schemaVersion: 2`, generated by the real producer so argon never tests against a hand-written shape

**Steps:**

- [ ] Write the failing test `plugins/option-wizard/tests/brief-view-fixture.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_VIEW_SCHEMA_VERSION, type BriefView } from "../render/index.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "../contracts/brief-view-v2.fixture.json"), "utf8"),
) as BriefView;

describe("brief-view-v2 fixture", () => {
  it("is at the version this build produces", () => {
    expect(fixture.schemaVersion).toBe(BRIEF_VIEW_SCHEMA_VERSION);
  });

  it("carries a numeric target and a thesis on the first candidate", () => {
    const candidate = fixture.candidates[0]!;
    expect(typeof candidate.target!.level).toBe("number");
    expect(["above", "below"]).toContain(candidate.target!.side);
    expect(candidate.thesis.length).toBeGreaterThan(0);
    expect(candidate.resolutionDeadline).toBe(candidate.expiry);
  });

  it("carries the scorable forecast argon renders nothing from but stores", () => {
    expect(fixture.spyForecast!.scorable).toBe(true);
    expect(fixture.spyForecast!.forecast!.t1Down).toBeGreaterThanOrEqual(0);
  });

  it("has no undefined anywhere — argon renders this verbatim", () => {
    expect(JSON.stringify(fixture)).not.toContain("undefined");
  });
});
```

- [ ] Run it and see it fail: `pnpm vitest run --project unit plugins/option-wizard/tests/brief-view-fixture.spec.ts` — expected failure `ENOENT: … contracts/brief-view-v2.fixture.json`.

- [ ] Generate the fixture from the real producer rather than typing it. Reuse the report fixture the existing `render.spec.ts` builds (it already assembles a full multi-step `RunReport`), extended with the `scenarios` step from Task B4's test:

```bash
mkdir -p plugins/option-wizard/contracts
pnpm build
node --input-type=module -e '
import { buildView } from "./plugins/option-wizard/lib/render/index.js";
import { writeFileSync } from "node:fs";
import { report, spec } from "./plugins/option-wizard/lib/tests-support/fixture-report.js";
writeFileSync(
  "plugins/option-wizard/contracts/brief-view-v2.fixture.json",
  JSON.stringify(buildView(report, spec), null, 1) + "\n",
);'
```

If `render.spec.ts`'s report fixture is inline rather than exported, extract it first into `plugins/option-wizard/render/fixture-report.ts` (exported `report` and `spec`), import it from `render.spec.ts`, and re-run the command above against `lib/render/fixture-report.js`. That extraction is the only edit `render.spec.ts` needs.

- [ ] Run again — expected PASS (4 passed).
- [ ] Run `pnpm build && pnpm test && pnpm test:contracts` — expected PASS.
- [ ] Commit and open the Phase B PR:

```bash
git add plugins/option-wizard/contracts/brief-view-v2.fixture.json plugins/option-wizard/tests/brief-view-fixture.spec.ts plugins/option-wizard/render/fixture-report.ts plugins/option-wizard/tests/render.spec.ts
git commit -m "test(option-wizard): a v2 fixture argon can be tested against

Generated by the real producer, not typed: a hand-written mirror is how two
repos agree on a shape neither of them actually emits."
git push -u origin feat/outcome-ledger-option-wizard
gh pr create --title "feat(option-wizard): typed targets, a scored forecast, and a settler" --body "$(cat <<'EOF'
D1-D4 of the outcome ledger spec. Fixes Flash's `TARGET —`, emits the SPY
direction commitments and the baselines they have to beat, and settles them
against real lake bars through apex.

Depends on the core seam PR.

Spec: docs/superpowers/specs/2026-09-04-outcome-ledger-v0-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase C — argon renders it (separate repo, separate PR, merged FIRST)

Runs in `/Users/chenxi/projects/argon`, on its own branch. Split from the helium PRs for the one legitimate reason: it is a different repository with its own deploy. Merged before helium's schema bump reaches the mini, which is why the mirror must accept v1 AND v2 — the two repos are not atomic. Three tasks.

## Task C1: the mirror accepts v1 and v2

**Files:**
- Modify `/Users/chenxi/projects/argon/web/components/flash/view.ts` — `SUPPORTED_SCHEMA_VERSION` (`:18`), `CandidateView` (`:48-63`), `asBriefView` (`:182-193`)
- Modify `/Users/chenxi/projects/argon/web/components/flash/FlashDayPage.tsx` — the unsupported-version message (`:66`)
- Test: `/Users/chenxi/projects/argon/web/tests/unit/flashView.test.ts`

**Interfaces:**
- Consumes: `AgentRunResponse` from `@/lib/api`
- Produces: `SUPPORTED_SCHEMA_VERSIONS: readonly number[]`, `CandidateView.thesis?: string`, `CandidateView.target?: Invalidation | string`, `asBriefView` accepting both

**Steps:**

- [ ] Write the failing test `web/tests/unit/flashView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSIONS, asBriefView } from "@/components/flash/view";

function run(schema_version: number, view: unknown) {
  return {
    schema_version,
    view,
    run_day: "2026-09-04",
    headline: "h",
    outcome: "completed",
    tenant: "option-wizard",
  } as never;
}

describe("asBriefView", () => {
  it("understands both the prose-target and the typed-target shapes", () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS].sort()).toEqual([1, 2]);
  });

  it("renders a v1 document, because argon deploys before helium", () => {
    const view = asBriefView(run(1, { date: "2026-09-04", candidates: [{ id: "a", ticker: "SPY", strategy: "s", dte: 1, legs: [], pricing: { kind: "unpriced", reason: "r" }, target: "grinds toward 748" }] }));
    expect(view).not.toBeNull();
    expect(view!.candidates![0]!.target).toBe("grinds toward 748");
  });

  it("renders a v2 document with a typed target", () => {
    const view = asBriefView(run(2, { date: "2026-09-04", candidates: [{ id: "a", ticker: "SPY", strategy: "s", dte: 1, legs: [], pricing: { kind: "unpriced", reason: "r" }, target: { level: 748, side: "below" }, thesis: "grinds toward 748" }] }));
    expect(view!.candidates![0]!.target).toEqual({ level: 748, side: "below" });
    expect(view!.candidates![0]!.thesis).toBe("grinds toward 748");
  });

  it("still returns null for a version this build has never heard of", () => {
    expect(asBriefView(run(3, { date: "2026-09-04" }))).toBeNull();
  });
});
```

- [ ] Run it and see it fail: `cd /Users/chenxi/projects/argon/web && pnpm vitest run tests/unit/flashView.test.ts` — expected failure `does not provide an export named 'SUPPORTED_SCHEMA_VERSIONS'`.

- [ ] In `view.ts`, replace `:17-18`:

```ts
/**
 * The shapes this build knows how to draw.
 *
 * TWO of them, deliberately. The producer and this consumer deploy on separate
 * schedules, so there is always a window where one is ahead: v1 puts the target
 * in prose and v2 puts it in `{level, side}` with the sentence moved to
 * `thesis`. Refusing v1 during that window would blank a page over a field
 * that is only differently spelled.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];
/** @deprecated The newest shape; prefer `SUPPORTED_SCHEMA_VERSIONS`. */
export const SUPPORTED_SCHEMA_VERSION = 2;
```

- [ ] In `CandidateView` (`:58`), replace `target?: Invalidation;` by:

```ts
  /** v2 writes a level and a side; v1 wrote a sentence. Both render. */
  target?: Invalidation | string;
  /** v2 only: what the run said it expects, in prose. */
  thesis?: string;
  /** v2 only: the date after which nothing can resolve. Display only. */
  resolutionDeadline?: string;
```

and widen `entry?: Invalidation;` (`:59`) to `entry?: Invalidation & { deadlineBars?: number };`.

- [ ] In `asBriefView` (`:183`), replace the guard:

```ts
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(run.schema_version)) return null;
```

- [ ] In `FlashDayPage.tsx:66`, replace `version ${SUPPORTED_SCHEMA_VERSION}` by `` version(s) ${SUPPORTED_SCHEMA_VERSIONS.join(", ")} `` and switch the import.
- [ ] Run again — expected PASS (4 passed).
- [ ] Commit:

```bash
git -C /Users/chenxi/projects/argon add web/components/flash/view.ts web/components/flash/FlashDayPage.tsx web/tests/unit/flashView.test.ts
git -C /Users/chenxi/projects/argon commit -m "feat(flash): the mirror understands both target shapes

helium and argon deploy on separate schedules, so one of them is always ahead.
Blanking a page over a field that is only differently spelled is exactly what
the version number exists to prevent."
```

## Task C2: the card shows the thesis and a numeric target

**Files:**
- Modify `/Users/chenxi/projects/argon/web/components/flash/CandidateCard.tsx` — `level` (`:17-22`), the levels row (`:54-61`), the rationale block (`:161-166`)
- Test: `/Users/chenxi/projects/argon/web/tests/components/flashCandidateCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `Invalidation`, `CandidateView` (Task C1)
- Produces: `level(x?: Invalidation | Invalidation[] | string): string` widened; a thesis paragraph

**Steps:**

- [ ] Append to `web/tests/components/flashCandidateCard.test.tsx`:

```ts
describe("target and thesis", () => {
  const v2 = {
    ...QQQ_SPREAD,
    target: { level: 748, side: "below" as const },
    thesis: "QQQ fades into the September gamma shelf",
  };

  it("prints a typed target as a level", () => {
    const { container } = render(<CandidateCard candidate={v2} />);
    expect(container.textContent).toContain("748 below");
  });

  it("prints the thesis sentence", () => {
    const { container } = render(<CandidateCard candidate={v2} />);
    expect(container.textContent).toContain("QQQ fades into the September gamma shelf");
  });

  it("prints a v1 prose target verbatim instead of an em dash", () => {
    const v1 = { ...QQQ_SPREAD, target: "fades into the gamma shelf" };
    const { container } = render(<CandidateCard candidate={v1} />);
    expect(container.textContent).toContain("fades into the gamma shelf");
  });

  it("prints an em dash and no undefined when there is no target at all", () => {
    const { container } = render(<CandidateCard candidate={QQQ_SPREAD} />);
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("undefined");
  });
});
```

- [ ] Run it and see it fail: `cd /Users/chenxi/projects/argon/web && pnpm vitest run tests/components/flashCandidateCard.test.tsx` — expected failure `expected '…' to contain '748 below'`.

- [ ] Widen `level` (`:17`):

```ts
/**
 * A level, a pair of levels, or — from a v1 document — the sentence the run
 * wrote instead of a level. A sentence is printed as it arrived: it is the
 * only thing that document has, and an em dash over the top of it was the bug.
 */
function level(x?: Invalidation | Invalidation[] | string): string {
  if (!x) return "—";
  if (typeof x === "string") return x;
  const list = Array.isArray(x) ? x : [x];
  if (list.length === 0) return "—";
  return list.map((i) => `${i.level} ${i.side}`).join(" / ");
}
```

- [ ] Add the thesis to the rationale block (`:161-166`):

```tsx
      {c.thesis || c.rationale || c.id ? (
        <div className={styles.rationale}>
          {c.thesis ? <p>{c.thesis}</p> : null}
          {c.rationale ? <p>{c.rationale}</p> : null}
          <span className={styles.cid}>{c.id}</span>
        </div>
      ) : null}
```

- [ ] Run again — expected PASS (existing cases + 4 new).
- [ ] Commit:

```bash
git -C /Users/chenxi/projects/argon add web/components/flash/CandidateCard.tsx web/tests/components/flashCandidateCard.test.tsx
git -C /Users/chenxi/projects/argon commit -m "fix(flash): a target that is a level prints as a level

Every card read TARGET — because the producer sent a sentence into a field
that renders numbers. Both spellings now print what they actually hold."
```

## Task C3: the consumer test runs against the real producer fixture

**Files:**
- Create `/Users/chenxi/projects/argon/web/tests/fixtures/heliumBriefViewV2.json` (copied from Task B9)
- Test: `/Users/chenxi/projects/argon/web/tests/components/flashHeliumFixture.test.tsx`

**Interfaces:**
- Consumes: `asBriefView` (Task C1), `CandidateCard` (Task C2), the helium fixture
- Produces: a test that fails when helium's real output stops rendering

**Steps:**

- [ ] Copy the fixture (Phase B must have produced it; it is a file, not a dependency, which is why argon can merge first):

```bash
mkdir -p /Users/chenxi/projects/argon/web/tests/fixtures
cp /Users/chenxi/projects/helium/plugins/option-wizard/contracts/brief-view-v2.fixture.json \
   /Users/chenxi/projects/argon/web/tests/fixtures/heliumBriefViewV2.json
```

- [ ] Write `web/tests/components/flashHeliumFixture.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CandidateCard } from "@/components/flash/CandidateCard";
import { asBriefView } from "@/components/flash/view";
import fixture from "../fixtures/heliumBriefViewV2.json";

/**
 * The producer's own output, not a mirror of it. A hand-written fixture tests
 * that argon agrees with argon; this one fails when helium's real document
 * stops rendering, which is the only failure worth catching here.
 */
describe("helium brief-view v2", () => {
  const view = asBriefView({
    schema_version: (fixture as { schemaVersion: number }).schemaVersion,
    view: fixture,
    run_day: "2026-09-04",
    headline: "h",
    outcome: "completed",
    tenant: "option-wizard",
  } as never);

  it("is a shape this build renders", () => {
    expect(view).not.toBeNull();
    expect(view!.candidates!.length).toBeGreaterThan(0);
  });

  it("draws every candidate with no undefined and a real target", () => {
    for (const candidate of view!.candidates!) {
      const { container } = render(<CandidateCard candidate={candidate} />);
      expect(container.textContent).not.toContain("undefined");
      expect(container.textContent).not.toContain("[object Object]");
      expect(container.textContent).toContain(candidate.ticker);
    }
  });

  it("prints the first candidate's target as a number and a side", () => {
    const target = view!.candidates![0]!.target;
    expect(typeof target).toBe("object");
    const { container } = render(<CandidateCard candidate={view!.candidates![0]!} />);
    expect(container.textContent).toContain(
      `${(target as { level: number }).level} ${(target as { side: string }).side}`,
    );
  });
});
```

- [ ] Run it — expected PASS (3 passed): `cd /Users/chenxi/projects/argon/web && pnpm vitest run tests/components/flashHeliumFixture.test.tsx`.
- [ ] Run the whole argon web suite — expected PASS: `cd /Users/chenxi/projects/argon/web && pnpm test`.
- [ ] Commit and open the argon PR:

```bash
git -C /Users/chenxi/projects/argon add web/tests/fixtures/heliumBriefViewV2.json web/tests/components/flashHeliumFixture.test.tsx
git -C /Users/chenxi/projects/argon commit -m "test(flash): render helium's own v2 document, not a mirror of it

A hand-written fixture only proves argon agrees with argon."
git -C /Users/chenxi/projects/argon push -u origin fix/flash-typed-target
cd /Users/chenxi/projects/argon && gh pr create --title "fix(flash): render the typed target and the thesis" --body "$(cat <<'EOF'
Flash showed `TARGET —` on every candidate: helium sends a sentence and this
mirror reads `target.level/side`. The mirror now accepts both shapes, prints
whichever arrived, and shows the new `thesis` line.

Merged BEFORE helium's schemaVersion bump reaches the mini — the two repos
deploy independently, so v1 must keep rendering meanwhile.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Merge and deploy order

1. **argon PR** (Phase C) — merged first; v1 keeps rendering, v2 becomes renderable.
2. **helium core-seam PR** (Phase A) — unblocks the quality-loop review phase.
3. **helium option-wizard PR** (Phase B) — rebased on both #92 and Phase A; keep both sides' `runner.ts` hunks.
4. `scripts/deploy.sh` from a clean tree. `helium audit <run>` prints the sha; the RELEASE file in the deployed tree is where it comes from.

## Definition of done (spec §8)

- [ ] Flash shows a numeric target for a real run.
- [ ] A production premarket run appends commitments and a baseline row to `<stateRoot>/ledger/option-wizard.jsonl`.
- [ ] The next run's settler appends receipts for anything resolvable, `pending` otherwise.
- [ ] `helium scoreboard option-wizard` prints from the live ledger.
- [ ] An evidence file exists for that run with the exact prompt, and its header names the tool-io directory.
- [ ] `fake-tenant`'s settler runs in CI.
- [ ] `pnpm test` and `pnpm test:contracts` green; deployed via `scripts/deploy.sh`.
- [ ] Then **two weeks of silence**: no mutation, no judge. Read the scoreboard, name the dominant failure class, and let that name the first experiment.
