# option-wizard deterministic renderer + HTML email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the user's `/execute-plan` skill (linear, in-session, milestone commits). Do NOT use subagent-driven-development or dispatching-parallel-agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic run-transcript email for the `option-wizard` tenant with a deterministic renderer that computes every number itself and ships an HTML + plain-text email.

**Architecture:** One tiny domain-neutral seam (a tenant may ship `render/index.ts`; `DeliveryPayload` gains `rendered?`), plus a tenant-owned renderer under `plugins/option-wizard/render/` that parses the `review` step's JSON and the `regime` step's prose, prices each structure with a pure payoff engine, and emits html + text. Core never parses a report body — it only learns that a tenant may render its own delivery (doctrine 2). No ceremony is added: no new gate, no new contract test, no new manifest (doctrine 6).

**Tech Stack:** TypeScript ESM, pnpm workspace, Node 22.19+, vitest. **No new npm dependency** — the html is a template literal, the payoff maths is arithmetic, the timezone formatting is `Intl.DateTimeFormat`.

**Spec:** `docs/superpowers/specs/2026-09-02-option-wizard-render-design.md`

**Doctrine (binding, from `/Users/chenxi/projects/helium/AGENTS.md`):** point 2 — core knows no domain, no provider, no business word; point 4 — token/context accounting stays in the audit table, not in the email; point 6 — ceremony must earn its keep, prefer deleting over certifying.

## Global Constraints

- **No new npm dependency.** Not mjml, not juice, not a chart library, not a date library.
- **No images of any kind.** No `<img>`, no data-URI, no inline `<svg>` — Gmail turns a data-URI `src` into `nosrc` and deletes inline svg with its fallback (caniemail, verified 2026-09-02).
- **No quantity, no position sizing, no NLV anywhere.** Every number is per contract, multiplier 100. `quantity` and `limitPrice` leave the designer's JSON schema in Task 6; the renderer must still ignore them without error when an older proposal carries them.
- **No charts beyond one table-cell bar** (credit-vs-width). No sparklines, no gamma bars, no calendar, no levels ladder, no events strip.
- **No run metadata in the email body.** No run id, no token counts, no cost, no step count, no `helium audit …` command, no footer. Those stay in the audit table and the markdown report.
- **`toolsUnconfigured` is never shown in the email** (known false positive; its root fix belongs to sub-project B).
- **Never estimate a price.** A leg without `mid` renders as `未定价`; a structure with an uncovered short leg renders as `结构不合规`.
- **All CSS in px** (Yahoo does not support `rem`), **no `box-shadow`** (Gmail web: n), **no `position`** (Gmail: n), **no `<picture>`** (Gmail rewrites to `<u>`).
- **Dark mode is three layers**: mid-tone inline colours that survive Gmail's own inversion, `@media (prefers-color-scheme: dark)` for Apple Mail, `[data-ogsc]` / `[data-ogsb]` attribute selectors for Outlook.com. Responsive breakpoint is `max-width: 359px` (390pt iPhone must keep its two-column rows).
- **Copy is Chinese headings with English technical terms.**
- **Commit messages carry no `Co-Authored-By` and no AI/tool attribution trailer.**
- Build before contract tests: `lib/` is build output and is not committed.

---

### Task 1: Move `RunReport`/`StepReport` into core and add `rendered` to `DeliveryPayload`

A tenant's renderer must import the report type without depending on `@helium/cli`. `plugins/option-wizard` already depends on `@helium/core` only (`plugins/option-wizard/package.json`), so the types move to core and `packages/cli/src/runner.ts` re-exports them so every existing importer (`packages/cli/src/cli.ts:24`) keeps compiling.

**Files:**
- Create: `packages/core/src/report.ts`
- Modify: `packages/core/src/index.ts:25` (add the export line)
- Modify: `packages/core/src/plugins.ts:135-142` (`DeliveryPayload`)
- Modify: `packages/cli/src/runner.ts:51-83` (delete the interface declarations, re-export from core)
- Test: no new test file — this task is proved by `pnpm typecheck` and the existing suites staying green.

**Interfaces:**
- Consumes: nothing.
- Produces: `StepReport`, `DeliveryReport`, `RunReport` (with the new `rendererSkipped?: { reason: string }`), `RenderedReport`, `TenantRenderer` exported from `@helium/core`; `DeliveryPayload.rendered?: RenderedReport`.

- [ ] **Step 1: Create the core report module**

Create `packages/core/src/report.ts`:

```ts
/**
 * What one run produced, as a value. It lives in core rather than in the CLI
 * for one reason: a tenant that renders its own delivery must be able to name
 * this type, and a tenant may not depend on the CLI.
 *
 * Core does not INTERPRET any of it. `text` is an opaque string here; whoever
 * wrote it is the only one who knows what it means (doctrine 2).
 * @module @helium/core/report
 */
import type { TenantSpec } from "./tenant.js";

export interface StepReport {
  task: string;
  role: string;
  mode: "model" | "tool-only" | "deterministic";
  targetId?: string;
  downgradeReason?: string;
  text: string;
  failure?: string;
  /** Gates that said no. An input refusal means no model call was made. */
  gateRefusals?: Array<{ id: string; reason: string }>;
}

export interface DeliveryReport {
  channel: string;
  state: "sent" | "skipped" | "rate-capped" | "failed";
  detail?: string;
}

export interface RunReport {
  runId: string;
  tenant: string;
  mode: "model" | "tool-only";
  providersLive: string[];
  providersSkipped: Array<{ id: string; reason: string }>;
  steps: StepReport[];
  outcome: "completed" | "failed";
  failure?: { class: string; detail: string };
  /** Gates that failed to LOAD. A gate that stopped loading stopped guarding. */
  gatesSkipped: Array<{ id: string; reason: string }>;
  /**
   * Set when a tenant ships a renderer and it failed to load or threw. Its own
   * field, not a row in `gatesSkipped`: a gate that stopped loading stopped
   * GUARDING, while a renderer that stopped loading only costs the reader the
   * pretty form. Folding the two together would make an email-formatting bug
   * look like a safety check went missing.
   */
  rendererSkipped?: { reason: string };
  /** One entry per `delivery:` block in tenant.yaml. Empty when none declared. */
  delivery: DeliveryReport[];
  /** Tools this machine cannot serve: their `requiresEnv` key is unset. */
  toolsUnconfigured: string[];
}

/** What a tenant's own renderer produces. `html` is optional; `text` is not. */
export interface RenderedReport {
  subject: string;
  text: string;
  html?: string;
}

/**
 * `plugins/<tenant>/render/index.ts`, `export default`. Optional: a tenant that
 * ships none gets the generic transcript, unchanged.
 */
export type TenantRenderer = (
  report: RunReport,
  cfg: TenantSpec,
) => RenderedReport;
```

- [ ] **Step 2: Export it from the core barrel**

In `packages/core/src/index.ts`, after the `export * from "./config.js";` line, add:

```ts
export * from "./report.js";
```

- [ ] **Step 3: Add `rendered` to `DeliveryPayload`**

In `packages/core/src/plugins.ts`, replace the `DeliveryPayload` interface with:

```ts
export interface DeliveryPayload {
  tenant: string;
  runId: string;
  subject: string;
  body: string;
  /** Absolute paths of files the channel may attach or reference. */
  artifacts?: string[];
  /**
   * What the tenant's own renderer produced, when it ships one. `subject`/
   * `body` above stay the generic transcript — that is the durable record and
   * it keeps every piece of run metadata — so a channel that wants the
   * readable form opts in, and one that wants the record does nothing.
   */
  rendered?: RenderedReport;
}
```

and add the import at the top of the file, beside the other core imports:

```ts
import type { RenderedReport } from "./report.js";
```

- [ ] **Step 4: Re-export from the runner instead of declaring**

In `packages/cli/src/runner.ts`, delete the `StepReport`, `DeliveryReport` and `RunReport` interface declarations (currently lines 51-83) and put in their place:

```ts
// These moved to `@helium/core` so a tenant's own renderer can name them
// without depending on the CLI. Re-exported here because every existing
// importer (cli.ts, the tests) reaches them through this module.
export type {
  DeliveryReport,
  RenderedReport,
  RunReport,
  StepReport,
} from "@helium/core";
```

Then add `type RunReport`, `type StepReport`, `type DeliveryReport` and `type RenderedReport` to the existing `import { … } from "@helium/core";` block at the top of the file (the file uses these types internally, and a re-export does not bring them into scope).

- [ ] **Step 5: Typecheck and run the whole unit suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, no diagnostics. If `runner.ts` reports "Cannot find name 'RunReport'", the import in Step 4 was not added.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/report.ts packages/core/src/index.ts packages/core/src/plugins.ts packages/cli/src/runner.ts
git commit -m "feat(core): move RunReport into core and let a payload carry a rendered form"
```

---

### Task 2: Renderer discovery and runner wiring

**Correction to the spec, deliberate:** spec §1 calls this "core seam", but `tools/` and `gates/` are NOT discovered in `packages/core/src/tenant.ts` — they are discovered in `packages/cli/src/discovery.ts` (`loadTenantTools`, `loadGates`). "Discovered the same way `tools/` and `gates/` are" therefore means `discovery.ts`, and that is where `loadRenderer` goes. Core's share of the seam is only the two types from Task 1. This keeps doctrine 2 exactly as the spec intends.

**Files:**
- Modify: `packages/cli/src/discovery.ts` (append `loadRenderer` after `loadGates`, which ends at line 186)
- Modify: `packages/cli/src/runner.ts` (`RunOptions` at lines 179-197; the delivery loop at lines 753-800; `deliveryBody` at lines 852-877)
- Test: `packages/cli/src/discovery.test.ts` (append a `describe("loadRenderer")` block)
- Test: `packages/cli/src/runner.test.ts` (append two tests)

**Interfaces:**
- Consumes: `TenantRenderer`, `RenderedReport`, `RunReport` from `@helium/core` (Task 1).
- Produces: `loadRenderer(tenantDir: string): Promise<{ renderer: TenantRenderer | null; skipped: Skipped[] }>` from `./discovery.js`; `RunOptions.renderer?: TenantRenderer | null` for tests.

- [ ] **Step 1: Write the failing discovery tests**

Append to `packages/cli/src/discovery.test.ts`:

```ts
describe("loadRenderer", () => {
  /** A tenant directory with a built `lib/render/index.js` holding `body`. */
  function tenantWithRender(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "helium-render-"));
    mkdirSync(join(dir, "lib", "render"), { recursive: true });
    writeFileSync(join(dir, "lib", "render", "index.js"), body);
    return dir;
  }

  it("returns null for a tenant that ships no renderer", async () => {
    const found = await loadRenderer(mkdtempSync(join(tmpdir(), "t-")));
    expect(found).toEqual({ renderer: null, skipped: [] });
  });

  it("loads a default-exported render function", async () => {
    const dir = tenantWithRender(
      `export default (report) => ({ subject: "s:" + report.tenant, text: "t" });`,
    );
    const { renderer, skipped } = await loadRenderer(dir);
    expect(skipped).toEqual([]);
    expect(renderer?.({ tenant: "demo" } as never, {} as never)).toEqual({
      subject: "s:demo",
      text: "t",
    });
  });

  it("skips a module that throws on import, with its reason", async () => {
    const { renderer, skipped } = await loadRenderer(
      tenantWithRender("throw new Error('bad render');"),
    );
    // A renderer that cannot load must not take the run down and must not go
    // unmentioned: the run falls back to the generic transcript and says why.
    expect(renderer).toBeNull();
    expect(skipped[0]?.id).toBe("render");
    expect(skipped[0]?.reason).toContain("bad render");
  });

  it("skips a module whose default export is not a function", async () => {
    const { renderer, skipped } = await loadRenderer(
      tenantWithRender("export default { subject: 'oops' };"),
    );
    expect(renderer).toBeNull();
    expect(skipped).toEqual([
      { id: "render", reason: "default export is not a render function" },
    ]);
  });
});
```

Add `loadRenderer` to the existing `import { … } from "./discovery.js";` block at the top of that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project unit packages/cli/src/discovery.test.ts`
Expected: FAIL — no exported member `loadRenderer`.

- [ ] **Step 3: Implement `loadRenderer`**

Append to `packages/cli/src/discovery.ts` (after `loadGates`):

```ts
/**
 * A tenant's own renderer: `<tenant>/render/index.ts`, built to
 * `lib/render/index.js`, `export default` a `TenantRenderer`.
 *
 * Optional by construction. A tenant that ships none gets the runner's generic
 * transcript, which is what every tenant got before this existed. A renderer
 * that throws on import is a SKIP with a reason, exactly like a gate: the run
 * still delivers, in the plain form, and the reason travels in the report
 * rather than into a silence.
 */
export async function loadRenderer(
  tenantDir: string,
): Promise<{ renderer: TenantRenderer | null; skipped: Skipped[] }> {
  const entry = join(tenantDir, "lib", "render", "index.js");
  if (!existsSync(entry)) return { renderer: null, skipped: [] };
  try {
    const module = (await import(pathToFileURL(entry).href)) as {
      default?: TenantRenderer;
    };
    if (typeof module.default !== "function") {
      return {
        renderer: null,
        skipped: [{ id: "render", reason: "default export is not a render function" }],
      };
    }
    return { renderer: module.default, skipped: [] };
  } catch (error: unknown) {
    return {
      renderer: null,
      skipped: [
        { id: "render", reason: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}
```

and add `TenantRenderer` to the existing type import at the top of `discovery.ts`:

```ts
import type { Channel, EcosystemTool, Gate, Provider, TenantRenderer } from "@helium/core";
```

- [ ] **Step 4: Run the discovery tests to verify they pass**

Run: `pnpm vitest run --project unit packages/cli/src/discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing runner-wiring tests**

Append to `packages/cli/src/runner.test.ts`:

```ts
describe("tenant renderer", () => {
  function capturing(seen: Array<Record<string, unknown>>): Channel {
    return {
      id: "capture",
      external: false,
      async deliver(payload) {
        seen.push(payload as unknown as Record<string, unknown>);
        return { state: "sent" };
      },
    };
  }

  it("puts the tenant's rendered form on the payload, leaving body the transcript", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const report = await runTenant({
      tenant: tenant(1, "delivery:\n  - channel: capture\n    config: {}\n"),
      audit: new AuditStore(":memory:"),
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      tools: [echo],
      channels: [capturing(seen)],
      renderer: (run) => ({
        subject: `brief ${run.tenant}`,
        text: "plain",
        html: "<p>rich</p>",
      }),
    });
    expect(report.delivery[0]?.state).toBe("sent");
    expect(seen[0]?.rendered).toEqual({
      subject: "brief demo",
      text: "plain",
      html: "<p>rich</p>",
    });
    // The transcript is still there. It is the durable record, and it is the
    // only place the run metadata lives once the email stops carrying it.
    expect(String(seen[0]?.body)).toContain("**Outcome:**");
  });

  it("falls back to the transcript and records the reason when the renderer throws", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const report = await runTenant({
      tenant: tenant(1, "delivery:\n  - channel: capture\n    config: {}\n"),
      audit: new AuditStore(":memory:"),
      pluginsDir: "/nonexistent",
      stateRoot: "/tmp",
      tools: [echo],
      channels: [capturing(seen)],
      renderer: () => {
        throw new Error("render blew up");
      },
    });
    expect(seen[0]?.rendered).toBeUndefined();
    // Its own field, never a row in gatesSkipped: a formatting failure must not
    // read like a safety gate that stopped guarding.
    expect(report.rendererSkipped?.reason).toContain("render blew up");
    expect(report.gatesSkipped).toEqual([]);
    // And the transcript that DID go out says why the pretty form is missing.
    expect(String(seen[0]?.body)).toContain("**renderer failed to load:**");
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts -t "tenant renderer"`
Expected: FAIL — `renderer` is not a known property of `RunOptions`.

- [ ] **Step 7: Wire the renderer into the runner**

In `packages/cli/src/runner.ts`:

(a) add to `RunOptions`, after the `channels?` field:

```ts
  /** Injected in tests; loaded from the tenant's `lib/render/` when absent.
   *  `null` means "explicitly none", which is how a test asks for the
   *  generic transcript without putting a file on disk. */
  renderer?: TenantRenderer | null;
```

(b) inside `runTenant`, immediately after the `loadedChannels` block, add:

```ts
  // Loaded once per run, not once per channel: two channels must not disagree
  // about what today's report says.
  const loadedRenderer =
    options.renderer === undefined
      ? await loadRenderer(options.tenant.dir)
      : { renderer: options.renderer, skipped: [] as Skipped[] };
```

and add `loadRenderer` plus `type Skipped` to the existing `import { … } from "./discovery.js";` block, and `type TenantRenderer` to the `@helium/core` import block.

(c) record a renderer that failed to LOAD in its own field, by adding one line to the `report` initialiser immediately after `gatesSkipped: loadedGates.skipped,` (leave `gatesSkipped` itself alone):

```ts
    ...(loadedRenderer.skipped[0] === undefined
      ? {}
      : { rendererSkipped: { reason: loadedRenderer.skipped[0].reason } }),
```

(d) immediately before the `const brake = env.HELIUM_TENANT_DELIVERY === "1";` line, add:

```ts
  // Rendering happens ONCE, before the delivery loop, and a renderer that
  // throws costs the run its rich email and nothing else: delivery still
  // happens with the generic transcript. Losing the send because the pretty
  // version failed would trade a readable email for no email at all.
  let rendered: RenderedReport | undefined;
  if (loadedRenderer.renderer !== null) {
    try {
      rendered = loadedRenderer.renderer(report, spec);
    } catch (error: unknown) {
      report.rendererSkipped = {
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
```

(f) make the transcript say so. In `deliveryBody`, immediately after the
`for (const skip of report.gatesSkipped) …` line, add:

```ts
  if (report.rendererSkipped !== undefined) {
    lines.push(`- **renderer failed to load:** ${report.rendererSkipped.reason}`);
  }
```

This line exists only on the transcript branch, which is the only branch that
runs when the renderer failed — the rendered email does not exist to carry it.

(e) in the `channel.deliver({ … })` call, add one line after `body: deliveryBody(report),`:

```ts
          ...(rendered === undefined ? {} : { rendered }),
```

- [ ] **Step 8: Run the runner tests to verify they pass**

Run: `pnpm vitest run --project unit packages/cli/src/runner.test.ts`
Expected: PASS, including the two new tests.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/discovery.ts packages/cli/src/discovery.test.ts packages/cli/src/runner.ts packages/cli/src/runner.test.ts
git commit -m "feat(cli): discover a tenant's own renderer and carry its output on the payload"
```

---

### Task 3: `delivery-email` sends the rendered form; `delivery-markdown` keeps the transcript

**Files:**
- Modify: `plugins/delivery-email/src/channel.ts:130-143` (subject + mail object)
- Test: `plugins/delivery-email/src/channel.test.ts` (append two tests)
- Test: `plugins/delivery-markdown/src/channel.test.ts` (append one test)

**Interfaces:**
- Consumes: `DeliveryPayload.rendered` (Task 1).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing email tests**

Append inside the existing `describe("EmailChannel", …)` in `plugins/delivery-email/src/channel.test.ts`:

```ts
  it("prefers the tenant's rendered subject, text and html over the transcript", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const outcome = await channel(sendMail).deliver(
      {
        ...payload(),
        rendered: {
          subject: "option-wizard 2026-09-02",
          text: "今日候选 5 个",
          html: "<table><tr><td>候选</td></tr></table>",
        },
      },
      CONFIG,
    );
    expect(outcome.state).toBe("sent");
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      subject: "[helium] option-wizard 2026-09-02",
      text: "今日候选 5 个",
      html: "<table><tr><td>候选</td></tr></table>",
    });
  });

  it("sends text-only when the rendered form carries no html", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await channel(sendMail).deliver(
      { ...payload(), rendered: { subject: "s", text: "plain only" } },
      CONFIG,
    );
    // An `html: undefined` key would still make nodemailer build a multipart
    // with an empty alternative; the key must be absent, not empty.
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("html");
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ text: "plain only" });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project unit plugins/delivery-email/src/channel.test.ts`
Expected: FAIL — the mail still carries `subject: "daily"` and the transcript body.

- [ ] **Step 3: Implement**

In `plugins/delivery-email/src/channel.ts`, replace the `const subject = …` / `const mail = { … }` block with:

```ts
    // The tenant's own renderer wins when it ran: the transcript is the record,
    // the rendered form is what a person reads. Artifact paths stay on the
    // transcript form only — a rendered brief is a finished document and a
    // local absolute path is not part of it.
    const base = payload.rendered?.subject ?? payload.subject;
    const subject =
      email.subjectPrefix === undefined ? base : `${email.subjectPrefix} ${base}`;
    const text =
      payload.rendered === undefined
        ? [
            payload.body,
            "",
            ...(payload.artifacts ?? []).map((path) => `Artifact: ${path}`),
          ].join("\n")
        : payload.rendered.text;
    const mail = {
      from: smtp.from,
      to: email.to,
      subject,
      text,
      ...(payload.rendered?.html === undefined ? {} : { html: payload.rendered.html }),
    };
```

- [ ] **Step 4: Run the email tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/delivery-email/src/channel.test.ts`
Expected: PASS, including the pre-existing prefix, cap, retry and instance tests.

- [ ] **Step 5: Write and run the markdown regression test**

Append inside the existing top-level `describe` in `plugins/delivery-markdown/src/channel.test.ts`:

```ts
  it("ignores `rendered` and keeps writing the transcript body", async () => {
    // The markdown file is the durable record. If it followed the email into
    // the rendered form, the run's own metadata would exist nowhere on disk.
    const dir = mkdtempSync(join(tmpdir(), "helium-md-"));
    const outcome = await new MarkdownChannel({
      stateRoot: dir,
      now: () => new Date("2026-09-02T12:00:00Z"),
    }).deliver(
      {
        tenant: "demo",
        runId: "r1",
        subject: "generic subject",
        body: "**Outcome:** completed, 4 steps.",
        rendered: { subject: "pretty", text: "pretty text", html: "<p>x</p>" },
      },
      {},
    );
    expect(outcome.state).toBe("sent");
    const written = readFileSync(String(outcome.detail), "utf8");
    expect(written).toContain("# generic subject");
    expect(written).toContain("**Outcome:** completed, 4 steps.");
    expect(written).not.toContain("pretty");
  });
```

Add `readFileSync`, `mkdtempSync`, `tmpdir` and `join` to that test file's imports if they are not already there.

Run: `pnpm vitest run --project unit plugins/delivery-markdown/src/channel.test.ts`
Expected: PASS with no source change — the markdown channel already reads only `payload.body`, and this test is what stops a later edit from changing that.

- [ ] **Step 6: Commit**

```bash
git add plugins/delivery-email/src/channel.ts plugins/delivery-email/src/channel.test.ts plugins/delivery-markdown/src/channel.test.ts
git commit -m "feat(delivery-email): send the tenant's rendered subject, text and html"
```

---

### Task 4: `render/math.ts` — the payoff engine

Pure arithmetic, no I/O, no dependency. This is the file that stops the arithmetic errors the 2026-09-02 runs shipped (max loss printed as max gain, put-spread direction inverted, `limitPrice` disagreeing with the rationale).

**Files:**
- Create: `plugins/option-wizard/render/math.ts`
- Create: `plugins/option-wizard/tests/math.spec.ts`
- Modify: `plugins/option-wizard/tsconfig.json` (add `render` to `include`)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface Leg { right: "call" | "put"; action: "buy" | "sell"; strike: number; expiry: string; ratio?: number; mid?: number }
export type Priced = { kind: "priced"; net: number /* +credit, -debit, per share */; maxGain: number | null; maxLoss: number | null; breakevens: number[]; pnlAt: Array<{ pct: -20|-10|-5|5|10|20; spot: number; pnl: number }> } /* all per contract, ×100 */
export type Unpriced = { kind: "unpriced"; reason: string }
export type Invalid = { kind: "invalid"; reason: string }  // uncovered short, unknown shape
export function priceStructure(legs: Leg[], spot: number): Priced | Unpriced | Invalid
export function width(legs: Leg[]): number   // widest strike span, per share
```

`maxGain` is the best P&L per contract (positive). `maxLoss` is the MAGNITUDE of the worst P&L per contract (positive). `null` means unbounded — for a defined-risk structure it never happens, but it is computed honestly rather than assumed.

- [ ] **Step 1: Write the failing tests**

Create `plugins/option-wizard/tests/math.spec.ts`:

```ts
/**
 * Every expected value here is hand-computed and written out, not captured from
 * the implementation. The failure this file exists to stop reached a reader on
 * 2026-09-02: a max loss printed as the max gain (6x), and a put spread whose
 * direction was inverted.
 */
import { describe, expect, it } from "vitest";
import { priceStructure, width, type Leg } from "../render/math.js";

const EXP = "2026-09-30";
const leg = (
  right: "call" | "put",
  action: "buy" | "sell",
  strike: number,
  mid?: number,
): Leg => ({ right, action, strike, expiry: EXP, ...(mid === undefined ? {} : { mid }) });

describe("priceStructure", () => {
  it("prices a put credit spread: sell 100P @2.00 / buy 95P @0.80", () => {
    // net = +2.00 - 0.80 = +1.20 credit; width 5.00
    // max gain = 1.20 x 100 = 120 (spot >= 100)
    // max loss = (5.00 - 1.20) x 100 = 380 (spot <= 95)
    // breakeven = 100 - 1.20 = 98.80
    const priced = priceStructure([leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)], 100);
    expect(priced).toMatchObject({
      kind: "priced",
      net: 1.2,
      maxGain: 120,
      maxLoss: 380,
      breakevens: [98.8],
    });
  });

  it("prices a call debit spread: buy 100C @3.00 / sell 105C @1.20", () => {
    // net = -3.00 + 1.20 = -1.80 debit
    // max gain = (5.00 - 1.80) x 100 = 320; max loss = 180; breakeven 101.80
    const priced = priceStructure([leg("call", "buy", 100, 3.0), leg("call", "sell", 105, 1.2)], 100);
    expect(priced).toMatchObject({
      kind: "priced",
      net: -1.8,
      maxGain: 320,
      maxLoss: 180,
      breakevens: [101.8],
    });
  });

  it("prices an iron condor with two breakevens", () => {
    // sell 95P @1.00 / buy 90P @0.40 / sell 105C @1.00 / buy 110C @0.40
    // net = 1.00 - 0.40 + 1.00 - 0.40 = +1.20; each wing 5 wide
    // max gain 120 (95 <= spot <= 105); max loss (5 - 1.20) x 100 = 380
    // breakevens 95 - 1.20 = 93.80 and 105 + 1.20 = 106.20
    const priced = priceStructure(
      [
        leg("put", "sell", 95, 1.0),
        leg("put", "buy", 90, 0.4),
        leg("call", "sell", 105, 1.0),
        leg("call", "buy", 110, 0.4),
      ],
      100,
    );
    expect(priced).toMatchObject({
      kind: "priced",
      net: 1.2,
      maxGain: 120,
      maxLoss: 380,
      breakevens: [93.8, 106.2],
    });
  });

  it("refuses an uncovered short call as an invalid structure", () => {
    expect(priceStructure([leg("call", "sell", 100, 2.0)], 100)).toEqual({
      kind: "invalid",
      reason: "结构不合规：call 腿净空头，短腿无同权利的长腿覆盖",
    });
  });

  it("refuses an uncovered short put as an invalid structure", () => {
    expect(priceStructure([leg("put", "sell", 100, 2.0)], 100)).toEqual({
      kind: "invalid",
      reason: "结构不合规：put 腿净空头，短腿无同权利的长腿覆盖",
    });
  });

  it("returns unpriced, never an estimate, when a leg has no mid", () => {
    expect(priceStructure([leg("put", "sell", 100, 2.0), leg("put", "buy", 95)], 100)).toEqual({
      kind: "unpriced",
      reason: "未定价：put 95 缺少 mid",
    });
  });

  it("returns unpriced for a multi-expiry structure rather than mispricing it", () => {
    const far: Leg = { right: "put", action: "buy", strike: 95, expiry: "2026-10-30", mid: 1.1 };
    expect(priceStructure([leg("put", "sell", 100, 2.0), far], 100)).toEqual({
      kind: "unpriced",
      reason: "未定价：多个到期日，无法按单一到期损益计算",
    });
  });

  it("computes the +/-5/10/20% expiry P&L row against the given spot", () => {
    const priced = priceStructure([leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)], 100);
    if (priced.kind !== "priced") throw new Error("expected priced");
    expect(priced.pnlAt.map((p) => [p.pct, p.spot, p.pnl])).toEqual([
      // spot 80 and 90: below the long strike, spread at full width -> -380
      [-20, 80, -380],
      [-10, 90, -380],
      // spot 95: at the long strike, still full width -> -380
      [-5, 95, -380],
      // spot 105, 110, 120: both puts expire worthless -> keep the credit
      [5, 105, 120],
      [10, 110, 120],
      [20, 120, 120],
    ]);
  });

  it("reports an unbounded max gain as null rather than as a number", () => {
    // A lone long call is not something this tenant proposes, but the engine
    // must say "unbounded" instead of quietly reporting a far evaluation point
    // as if it were the maximum.
    const priced = priceStructure([leg("call", "buy", 100, 3.0)], 100);
    expect(priced).toMatchObject({ kind: "priced", maxGain: null, maxLoss: 300 });
  });
});

describe("width", () => {
  it("is the widest strike span, per share", () => {
    expect(width([leg("put", "sell", 100, 2.0), leg("put", "buy", 95, 0.8)])).toBe(5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/math.spec.ts`
Expected: FAIL — cannot resolve `../render/math.js`.

- [ ] **Step 3: Implement `math.ts`**

Create `plugins/option-wizard/render/math.ts`:

```ts
/**
 * Expiry payoff for a multi-leg defined-risk structure. Pure arithmetic: no
 * I/O, no dependency, no model.
 *
 * Why the renderer computes this instead of printing what a role wrote: on
 * 2026-09-02 five of five proposals carried a `limitPrice` that disagreed with
 * their own rationale, one printed its max loss as its max gain (6x), and one
 * put spread was described in the wrong direction. Every one of those numbers
 * is derivable from the legs and the NBBO mids, so the reader gets the derived
 * one and the prose stays prose.
 *
 * The payoff is piecewise linear with kinks exactly at the strikes, so
 * evaluating at {0, every strike} finds the true extrema of the BOUNDED part,
 * and the sign of the slope above the highest strike decides whether an
 * unbounded part exists at all. Nothing is sampled or approximated.
 * @module dsh-plugin-tenant-option-wizard/render/math
 */

export interface Leg {
  right: "call" | "put";
  action: "buy" | "sell";
  strike: number;
  expiry: string;
  ratio?: number;
  /** NBBO mid, per share, as read from the chain. Never estimated. */
  mid?: number;
}

export interface PnlPoint {
  pct: -20 | -10 | -5 | 5 | 10 | 20;
  spot: number;
  pnl: number;
}

export interface Priced {
  kind: "priced";
  /** Per share. Positive is a credit received, negative a debit paid. */
  net: number;
  /** Per contract (x100). `null` means unbounded. */
  maxGain: number | null;
  /** Per contract (x100), as a POSITIVE magnitude. `null` means unbounded. */
  maxLoss: number | null;
  breakevens: number[];
  pnlAt: PnlPoint[];
}

export interface Unpriced {
  kind: "unpriced";
  reason: string;
}

export interface Invalid {
  kind: "invalid";
  reason: string;
}

export type Pricing = Priced | Unpriced | Invalid;

/** Every US equity option this tenant deals in. */
const MULTIPLIER = 100;
const PCTS = [-20, -10, -5, 5, 10, 20] as const;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const qty = (leg: Leg): number => leg.ratio ?? 1;
/** +1 long, -1 short. */
const side = (leg: Leg): number => (leg.action === "buy" ? 1 : -1);

/** The widest strike span, per share. Zero for a single-strike structure. */
export function width(legs: Leg[]): number {
  const strikes = legs.map((leg) => leg.strike);
  return round2(Math.max(...strikes) - Math.min(...strikes));
}

/** Intrinsic value of the whole structure at expiry, per share, signed. */
function intrinsic(legs: Leg[], spot: number): number {
  return legs.reduce((total, leg) => {
    const payoff =
      leg.right === "call"
        ? Math.max(spot - leg.strike, 0)
        : Math.max(leg.strike - spot, 0);
    return total + side(leg) * qty(leg) * payoff;
  }, 0);
}

/** P&L per contract at an expiry spot, including the premium paid or received. */
function pnlAtSpot(legs: Leg[], net: number, spot: number): number {
  return round2((intrinsic(legs, spot) + net) * MULTIPLIER);
}

export function priceStructure(legs: Leg[], spot: number): Pricing {
  if (legs.length === 0) return { kind: "invalid", reason: "结构不合规：没有任何腿" };

  // Defined-risk only. This duplicates the ib-preflight gate on purpose: the
  // renderer is the LAST reader-facing check, and a structure that slipped past
  // the gate must not reach the reader looking like a trade.
  for (const right of ["call", "put"] as const) {
    const net = legs
      .filter((leg) => leg.right === right)
      .reduce((total, leg) => total + side(leg) * qty(leg), 0);
    if (net < 0) {
      return {
        kind: "invalid",
        reason: `结构不合规：${right} 腿净空头，短腿无同权利的长腿覆盖`,
      };
    }
  }

  if (new Set(legs.map((leg) => leg.expiry)).size > 1) {
    return { kind: "unpriced", reason: "未定价：多个到期日，无法按单一到期损益计算" };
  }

  const missing = legs.find((leg) => leg.mid === undefined || !Number.isFinite(leg.mid));
  if (missing !== undefined) {
    return {
      kind: "unpriced",
      reason: `未定价：${missing.right} ${String(missing.strike)} 缺少 mid`,
    };
  }

  // Sell brings cash in, buy takes it out.
  const net = round2(
    legs.reduce((total, leg) => total - side(leg) * qty(leg) * (leg.mid ?? 0), 0),
  );

  const strikes = [...new Set(legs.map((leg) => leg.strike))].sort((a, b) => a - b);
  const bounded = [0, ...strikes];
  const boundedPnl = bounded.map((point) => pnlAtSpot(legs, net, point));

  // Above the highest strike every call is exercised or expired, so the slope
  // is constant: the signed call quantity. Puts contribute nothing there. Below
  // the lowest strike the domain itself is bounded (spot >= 0), so the S = 0
  // evaluation already holds that end.
  const slopeUp = legs
    .filter((leg) => leg.right === "call")
    .reduce((total, leg) => total + side(leg) * qty(leg), 0);

  const maxGain = slopeUp > 0 ? null : Math.max(...boundedPnl);
  const worst = Math.min(...boundedPnl);
  const maxLoss = slopeUp < 0 ? null : worst < 0 ? round2(-worst) : 0;

  // One extra point past the last strike so a crossing on the final ray is
  // found too. With slopeUp === 0 the ray is flat and no crossing can hide
  // there, so the extra point costs nothing.
  const scan = [...bounded, strikes[strikes.length - 1]! * 2 + 100];
  const scanPnl = scan.map((point) => pnlAtSpot(legs, net, point));
  const breakevens: number[] = [];
  for (let i = 0; i < scan.length - 1; i += 1) {
    const a = scanPnl[i]!;
    const b = scanPnl[i + 1]!;
    if (a === 0) breakevens.push(round2(scan[i]!));
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      breakevens.push(round2(scan[i]! + ((scan[i + 1]! - scan[i]!) * -a) / (b - a)));
    }
  }
  if (scanPnl[scanPnl.length - 1]! === 0) breakevens.push(round2(scan[scan.length - 1]!));

  return {
    kind: "priced",
    net,
    maxGain,
    maxLoss,
    breakevens: [...new Set(breakevens)].sort((a, b) => a - b),
    pnlAt: PCTS.map((pct) => {
      const at = round2(spot * (1 + pct / 100));
      return { pct, spot: at, pnl: pnlAtSpot(legs, net, at) };
    }),
  };
}
```

- [ ] **Step 4: Add `render` to the tenant's tsconfig and run the tests**

In `plugins/option-wizard/tsconfig.json`, change the `include` line to:

```json
  "include": ["tools", "gates", "render"]
```

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/math.spec.ts`
Expected: PASS, all ten tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/option-wizard/render/math.ts plugins/option-wizard/tests/math.spec.ts plugins/option-wizard/tsconfig.json
git commit -m "feat(option-wizard): compute expiry payoff, breakevens and P&L from the legs"
```

---

### Task 5: `render/index.ts` parse + `render/text.ts`

**Files:**
- Create: `plugins/option-wizard/render/index.ts`
- Create: `plugins/option-wizard/render/text.ts`
- Create: `plugins/option-wizard/tests/render.spec.ts` (fixture + parse/text assertions; Task 6 appends the html ones)
- Modify: `plugins/option-wizard/package.json` (`exports`, `files`)

**Interfaces:**
- Consumes: `priceStructure`, `width`, `Leg`, `Pricing` from `./math.js` (Task 4); `RunReport`, `TenantSpec`, `RenderedReport` from `@helium/core` (Task 1).
- Produces, from `render/index.ts`:

```ts
export interface CandidateView { ticker: string; strategy: string; expiry: string; dte: number | null; legs: Leg[]; pricing: Pricing; width: number; rationale: string }
export interface RegimeView { paragraph: string; direction?: string; volatility?: string; hedge?: string }
export interface BriefView { dateHkt: string; dateEt: string; tenant: string; outcome: "completed" | "DEGRADED" | "FAILED"; regime: RegimeView; candidates: CandidateView[]; riskList: Array<{ ticker: string; reason: string }>; degradation?: string; empty?: string }
export function extractJson(text: string): Record<string, unknown> | null
export function buildView(report: RunReport, cfg: TenantSpec, now: Date): BriefView
export default function renderReport(report: RunReport, cfg: TenantSpec): RenderedReport
```

and, from `render/text.ts`: `export function renderText(view: BriefView): string`.

- [ ] **Step 1: Write the failing parse/text tests with the real-run fixture**

Create `plugins/option-wizard/tests/render.spec.ts`. The tickers, strikes, expiries and spot below are the real ones from the 2026-09-02 `run-84a83ad2` report; the `mid` values are the per-leg quotes that run's own rationales cited.

```ts
/**
 * Fixture built from the real successful run of 2026-09-02 (`run-84a83ad2`):
 * the review step's JSON, verbatim except for the `mid` fields, which that run
 * did not yet carry and which are taken from the same proposals' own quoted
 * bid/ask. Prose trimmed; tickers, strikes and expiries untouched.
 *
 * `quantity` and `limitPrice` are kept here on purpose even though Task 6 takes
 * them out of the designer's schema: this fixture is the proof that a proposal
 * in the OLD shape still renders, with those fields ignored rather than
 * rejected. Do not tidy them away.
 */
import { describe, expect, it } from "vitest";
import type { RunReport, TenantSpec } from "@helium/core";
import renderReport, { buildView } from "../render/index.js";

const REVIEW_JSON = {
  proposals: [
    {
      ticker: "SPY",
      strategy: "put_debit_spread_hedge",
      legs: [
        { right: "put", expiry: "2026-09-30", strike: 740, action: "buy", ratio: 1, mid: 5.14 },
        { right: "put", expiry: "2026-09-30", strike: 750, action: "sell", ratio: 1, mid: 6.42 },
      ],
      quantity: 5,
      limitPrice: 3.8,
      rationale: "Defensive hedge aligned with bearish-tilt regime.",
    },
    {
      ticker: "QQQ",
      strategy: "put_debit_spread_hedge",
      legs: [
        { right: "put", expiry: "2026-09-30", strike: 695, action: "buy", ratio: 1, mid: 9.57 },
        { right: "put", expiry: "2026-09-30", strike: 680, action: "sell", ratio: 1, mid: 6.26 },
      ],
      quantity: 4,
      limitPrice: 5.75,
      rationale: "Tech hedge: elevated IV rank (24%), sensitive to yield moves.",
    },
    {
      ticker: "TLT",
      strategy: "put_debit_spread_hedge",
      legs: [
        { right: "put", expiry: "2026-09-30", strike: 80, action: "buy", ratio: 1 },
        { right: "put", expiry: "2026-09-30", strike: 81, action: "sell", ratio: 1, mid: 0.56 },
      ],
      quantity: 2,
      limitPrice: 0.22,
      rationale: "Bond duration hedge: minimal cost insurance.",
    },
  ],
  riskList: [
    {
      ticker: "GLD",
      reason: "Call spread income overlay creates portfolio concentration in GLD.",
    },
  ],
};

const REGIME_TEXT = `# Regime Verdict — as of 2026-09-02

**Direction bias: cautiously risk-off / defensive.** The whole Treasury curve is live-bid today — 2y at **4.371%**, 10y **4.772%**.

**Volatility stance: neutral-to-firming, cheap but rising.** VIX is live **16.02** today.

**Hedge posture: keep hedges on, modest.** Credit is still calm.`;

/** The reviewer answers with prose first and a fenced JSON object after; that is
 *  what the live run produced and what the parser has to survive. */
const REVIEW_TEXT = `Now I'll evaluate each proposal against the spot prices:

**SPY (spot 761.78):** Both strikes are 2.9-3.8% below spot.

Actually, let me simplify the selection.

\`\`\`json
${JSON.stringify(REVIEW_JSON, null, 2)}
\`\`\``;

const SPEC = { tenant: "option-wizard" } as unknown as TenantSpec;

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run-84a83ad2-a5cd-49d9-b41d-1fbc55236128",
    tenant: "option-wizard",
    mode: "model",
    providersLive: ["dsh"],
    providersSkipped: [],
    outcome: "completed",
    gatesSkipped: [],
    delivery: [],
    toolsUnconfigured: ["ow_macro_rates (OW_ARGON_PG_URL unset)"],
    steps: [
      { task: "universe", role: "universe-builder", mode: "deterministic", text: "SPY QQQ TLT" },
      { task: "regime", role: "regime-analyst", mode: "model", text: REGIME_TEXT },
      { task: "design", role: "structure-designer", mode: "model", text: "{}" },
      { task: "review", role: "risk-reviewer", mode: "model", text: REVIEW_TEXT },
    ],
    ...overrides,
  } as RunReport;
}

const NOW = new Date("2026-09-02T10:00:00Z");

describe("buildView", () => {
  it("parses the fenced JSON out of the reviewer's prose", () => {
    const view = buildView(report(), SPEC, NOW);
    expect(view.candidates.map((c) => c.ticker)).toEqual(["SPY", "QQQ", "TLT"]);
    expect(view.riskList).toEqual([
      {
        ticker: "GLD",
        reason: "Call spread income overlay creates portfolio concentration in GLD.",
      },
    ]);
  });

  it("prices the SPY spread from the mids, not from the role's limitPrice", () => {
    // sell 750P @6.42 / buy 740P @5.14 -> net +1.28 credit, width 10.
    // max gain 128, max loss (10 - 1.28) x 100 = 872, breakeven 748.72.
    // The role called this a debit spread and wrote limitPrice 3.80; both are
    // wrong, and neither reaches the reader.
    const spy = buildView(report(), SPEC, NOW).candidates[0]!;
    expect(spy.pricing).toMatchObject({
      kind: "priced",
      net: 1.28,
      maxGain: 128,
      maxLoss: 872,
      breakevens: [748.72],
    });
  });

  it("marks a leg with no mid as unpriced instead of estimating it", () => {
    const tlt = buildView(report(), SPEC, NOW).candidates[2]!;
    expect(tlt.pricing).toEqual({ kind: "unpriced", reason: "未定价：put 80 缺少 mid" });
  });

  it("takes the regime verdict paragraph and the three stances", () => {
    const view = buildView(report(), SPEC, NOW).regime;
    expect(view.paragraph).toContain("Direction bias: cautiously risk-off");
    expect(view.direction).toBe("cautiously risk-off / defensive");
    expect(view.volatility).toBe("neutral-to-firming, cheap but rising");
    expect(view.hedge).toBe("keep hedges on, modest");
  });

  it("dates the brief in both HKT and ET", () => {
    const view = buildView(report(), SPEC, NOW);
    expect(view.dateHkt).toBe("2026-09-02 (HKT)");
    expect(view.dateEt).toBe("2026-09-02 (ET)");
  });

  it("computes DTE from the expiry against the ET date", () => {
    expect(buildView(report(), SPEC, NOW).candidates[0]!.dte).toBe(28);
  });

  it("never shows toolsUnconfigured, which is a known false positive", () => {
    expect(buildView(report(), SPEC, NOW).degradation).toBeUndefined();
  });

  it("says so in one line when a gate or a provider actually failed", () => {
    const view = buildView(
      report({
        providersSkipped: [{ id: "local-llm", reason: "no credential" }],
        gatesSkipped: [{ id: "ib-preflight", reason: "module threw" }],
      }),
      SPEC,
      NOW,
    );
    expect(view.degradation).toBe(
      "数据降级：provider local-llm 不可用（no credential）；gate ib-preflight 未加载（module threw）",
    );
  });

  it("returns 今日无候选 with the reason when the run failed", () => {
    const view = buildView(
      report({ outcome: "failed", failure: { class: "budget-exhausted", detail: "no room" } }),
      SPEC,
      NOW,
    );
    expect(view.outcome).toBe("FAILED");
    expect(view.empty).toBe("今日无候选：budget-exhausted — no room");
  });

  it("returns 今日无候选 when no model ran", () => {
    const view = buildView(report({ mode: "tool-only", providersLive: [] }), SPEC, NOW);
    expect(view.outcome).toBe("DEGRADED");
    expect(view.empty).toBe("今日无候选：无可用 provider，本次没有任何模型推理");
  });

  it("returns 今日无候选 when the review step's JSON cannot be parsed", () => {
    const broken = report();
    broken.steps[3]!.text = "I could not produce proposals today.";
    expect(buildView(broken, SPEC, NOW).empty).toBe("今日无候选：review 步骤没有可解析的 JSON");
  });
});

describe("renderReport (text part)", () => {
  it("carries every computed number and none of the transcript", () => {
    const { subject, text } = renderReport(report(), SPEC);
    expect(subject).toContain("option-wizard");
    expect(text).toContain("SPY");
    expect(text).toContain("748.72");
    expect(text).toContain("872");
    expect(text).toContain("未定价");
    // The reader never sees the model thinking out loud, its quantity guess, or
    // any run metadata.
    expect(text).not.toContain("Actually, let me");
    expect(text).not.toContain("quantity");
    expect(text).not.toContain("run-84a83ad2");
    expect(text).not.toContain("helium audit");
  });

  it("renders the empty brief as a short reason, not a transcript", () => {
    const { text } = renderReport(
      report({ outcome: "failed", failure: { class: "budget-exhausted", detail: "no room" } }),
      SPEC,
    );
    expect(text).toContain("今日无候选");
    expect(text).not.toContain("Actually, let me");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts`
Expected: FAIL — cannot resolve `../render/index.js`.

- [ ] **Step 3: Implement `render/text.ts`**

Create `plugins/option-wizard/render/text.ts`:

```ts
/**
 * The email's plain-text part. Same sections as the html, in the same order.
 *
 * It is not a fallback nobody reads: a text/plain alternative is what keeps the
 * message scoring like mail rather than like a flyer, and it is what a text
 * client shows. The markdown channel keeps writing the generic transcript, so
 * this file is never the durable record.
 * @module dsh-plugin-tenant-option-wizard/render/text
 */
import type { BriefView, CandidateView } from "./index.js";
import type { Pricing } from "./math.js";

const money = (value: number | null): string =>
  value === null ? "无上限" : `$${value.toFixed(2)}`;

function pricingLines(pricing: Pricing): string[] {
  if (pricing.kind !== "priced") return [`  ${pricing.reason}`];
  const flow = pricing.net >= 0 ? "净收权利金" : "净付权利金";
  const breakevens =
    pricing.breakevens.length === 0
      ? "无"
      : pricing.breakevens.map((value) => value.toFixed(2)).join(" / ");
  return [
    `  ${flow} $${Math.abs(pricing.net).toFixed(2)}/股`,
    `  max gain ${money(pricing.maxGain)} · max loss ${money(pricing.maxLoss)}`,
    `  breakeven ${breakevens}`,
    `  到期损益 ${pricing.pnlAt
      .map((point) => `${point.pct > 0 ? "+" : ""}${String(point.pct)}%: ${point.pnl.toFixed(0)}`)
      .join("  ")}`,
  ];
}

function candidateLines(candidate: CandidateView): string[] {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  return [
    `${candidate.ticker} — ${candidate.strategy}${dte}`,
    ...candidate.legs.map(
      (leg) =>
        `  ${leg.action} ${leg.right} ${String(leg.strike)} ${leg.expiry}` +
        (leg.mid === undefined ? " mid —" : ` mid ${leg.mid.toFixed(2)}`),
    ),
    ...pricingLines(candidate.pricing),
    `  ${candidate.rationale}`,
    "",
  ];
}

export function renderText(view: BriefView): string {
  const lines: string[] = [
    `${view.dateHkt} / ${view.dateEt} — ${view.tenant} [${view.outcome}]`,
    "",
  ];
  if (view.empty !== undefined) {
    lines.push(view.empty, "");
    if (view.degradation !== undefined) lines.push(view.degradation, "");
    return lines.join("\n");
  }
  lines.push("【今日 regime】", view.regime.paragraph, "");
  const stances = [
    view.regime.direction === undefined ? null : `direction: ${view.regime.direction}`,
    view.regime.volatility === undefined ? null : `volatility: ${view.regime.volatility}`,
    view.regime.hedge === undefined ? null : `hedge: ${view.regime.hedge}`,
  ].filter((entry): entry is string => entry !== null);
  if (stances.length > 0) lines.push(stances.join(" | "), "");
  lines.push("【候选结构】每张合约，不含数量", "");
  for (const candidate of view.candidates) lines.push(...candidateLines(candidate));
  if (view.riskList.length > 0) {
    lines.push("【风险清单】");
    for (const entry of view.riskList) lines.push(`- ${entry.ticker}: ${entry.reason}`);
    lines.push("");
  }
  if (view.degradation !== undefined) lines.push(view.degradation, "");
  return lines.join("\n");
}
```

- [ ] **Step 4: Implement `render/index.ts`**

Create `plugins/option-wizard/render/index.ts`. (Task 6 adds the `renderHtml` import and the `html` field; leave both out for now so this task's tests stand on their own.)

```ts
/**
 * The tenant's deterministic renderer: the report in, the email out.
 *
 * What it refuses to do is the point. It does not print the roles' prose as the
 * brief (the 2026-09-02 emails were four agents' raw text concatenated, opening
 * with "Actually, let me simplify"), it does not print any number a role
 * computed (five of five `limitPrice` values disagreed with their own
 * rationale), and it says nothing about the run itself — run id, tokens, cost
 * and step count live in the audit table and the markdown report, never in the
 * mail.
 * @module dsh-plugin-tenant-option-wizard/render
 */
import type { RenderedReport, RunReport, TenantSpec } from "@helium/core";
import { priceStructure, width, type Leg, type Pricing } from "./math.js";
import { renderText } from "./text.js";

export interface CandidateView {
  ticker: string;
  strategy: string;
  expiry: string;
  /** Calendar days to expiry against the ET date; null when unparseable. */
  dte: number | null;
  legs: Leg[];
  pricing: Pricing;
  /** Widest strike span, per share; 0 when single-strike. */
  width: number;
  rationale: string;
}

export interface RegimeView {
  paragraph: string;
  direction?: string;
  volatility?: string;
  hedge?: string;
}

export interface BriefView {
  dateHkt: string;
  dateEt: string;
  tenant: string;
  outcome: "completed" | "DEGRADED" | "FAILED";
  regime: RegimeView;
  candidates: CandidateView[];
  riskList: Array<{ ticker: string; reason: string }>;
  /** ONE line, present only when something actually failed. */
  degradation?: string;
  /** When set, the brief IS this line: no candidates, no sections. */
  empty?: string;
}

const RIGHTS = new Set(["call", "put"]);
const ACTIONS = new Set(["buy", "sell"]);

function dayIn(zone: string, now: Date): string {
  // en-CA gives YYYY-MM-DD, which is the only reason that locale is named here.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The last JSON object in a step's text, fenced or bare. */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  // Last resort: the widest brace span. A reviewer that forgets the fence still
  // gets read rather than costing the reader the whole brief.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function toLegs(raw: unknown): Leg[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const legs: Leg[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const leg = entry as Record<string, unknown>;
    if (typeof leg.right !== "string" || !RIGHTS.has(leg.right)) return null;
    if (typeof leg.action !== "string" || !ACTIONS.has(leg.action)) return null;
    if (typeof leg.strike !== "number" || typeof leg.expiry !== "string") return null;
    legs.push({
      right: leg.right as "call" | "put",
      action: leg.action as "buy" | "sell",
      strike: leg.strike,
      expiry: leg.expiry,
      ...(typeof leg.ratio === "number" ? { ratio: leg.ratio } : {}),
      ...(typeof leg.mid === "number" ? { mid: leg.mid } : {}),
    });
  }
  return legs;
}

/** Spot as the reviewer quoted it, e.g. "**SPY (spot 761.78):**". */
function spotsFrom(text: string): Map<string, number> {
  const spots = new Map<string, number>();
  for (const match of text.matchAll(/([A-Z]{1,6})\s*\(spot\s+([0-9]+(?:\.[0-9]+)?)\)/g)) {
    spots.set(match[1]!, Number(match[2]));
  }
  return spots;
}

function regimeFrom(text: string): RegimeView {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("#"));
  const stance = (label: string): string | undefined => {
    const found = new RegExp(`${label}:\\s*([^.*\\n]+)`).exec(text);
    return found === null ? undefined : found[1]!.trim();
  };
  const direction = stance("Direction bias");
  const volatility = stance("Volatility stance");
  const hedge = stance("Hedge posture");
  return {
    paragraph: paragraphs[0] ?? "",
    ...(direction === undefined ? {} : { direction }),
    ...(volatility === undefined ? {} : { volatility }),
    ...(hedge === undefined ? {} : { hedge }),
  };
}

function degradationFrom(report: RunReport): string | undefined {
  const parts = [
    ...report.providersSkipped.map((skip) => `provider ${skip.id} 不可用（${skip.reason}）`),
    ...report.gatesSkipped.map((skip) => `gate ${skip.id} 未加载（${skip.reason}）`),
    ...report.steps
      .flatMap((step) => step.gateRefusals ?? [])
      .map((refusal) => `gate ${refusal.id} 拒绝（${refusal.reason}）`),
    ...report.steps
      .filter((step) => step.failure !== undefined)
      .map((step) => `${step.task} 步骤失败（${step.failure ?? ""}）`),
  ];
  // `toolsUnconfigured` is NOT here. It is a known false positive today and its
  // root fix belongs to sub-project B; printing it would train the reader to
  // ignore the one line that is supposed to mean something.
  return parts.length === 0 ? undefined : `数据降级：${parts.join("；")}`;
}

export function buildView(report: RunReport, cfg: TenantSpec, now: Date): BriefView {
  const dateEtDay = dayIn("America/New_York", now);
  const degradation = degradationFrom(report);
  const base: BriefView = {
    dateHkt: `${dayIn("Asia/Hong_Kong", now)} (HKT)`,
    dateEt: `${dateEtDay} (ET)`,
    tenant: cfg.tenant,
    outcome:
      report.outcome === "failed"
        ? "FAILED"
        : report.mode === "tool-only"
          ? "DEGRADED"
          : "completed",
    regime: { paragraph: "" },
    candidates: [],
    riskList: [],
    ...(degradation === undefined ? {} : { degradation }),
  };

  if (report.outcome === "failed") {
    const failure = report.failure;
    return {
      ...base,
      empty: `今日无候选：${failure?.class ?? "unknown"} — ${failure?.detail ?? ""}`,
    };
  }
  if (report.mode === "tool-only") {
    return { ...base, empty: "今日无候选：无可用 provider，本次没有任何模型推理" };
  }

  const review = report.steps.find((step) => step.task === "review");
  const parsed = review === undefined ? null : extractJson(review.text);
  if (parsed === null || !Array.isArray(parsed.proposals)) {
    return { ...base, empty: "今日无候选：review 步骤没有可解析的 JSON" };
  }

  const regimeStep = report.steps.find((step) => step.task === "regime");
  const regime = regimeStep === undefined ? { paragraph: "" } : regimeFrom(regimeStep.text);
  const spots = spotsFrom(review?.text ?? "");

  const candidates: CandidateView[] = [];
  for (const entry of parsed.proposals) {
    if (entry === null || typeof entry !== "object") continue;
    const proposal = entry as Record<string, unknown>;
    const legs = toLegs(proposal.legs);
    if (legs === null || typeof proposal.ticker !== "string") continue;
    const expiry = legs[0]!.expiry;
    const spot = spots.get(proposal.ticker);
    const days = Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${dateEtDay}T00:00:00Z`)) / 86_400_000,
    );
    candidates.push({
      ticker: proposal.ticker,
      strategy: typeof proposal.strategy === "string" ? proposal.strategy : "",
      expiry,
      dte: Number.isFinite(days) ? days : null,
      legs,
      // Without a quoted spot the payoff extremes and breakevens are still
      // exact — only the +/-% row needs one, so it is anchored on the lowest
      // strike rather than on an invented price.
      pricing: priceStructure(legs, spot ?? Math.min(...legs.map((leg) => leg.strike))),
      width: width(legs),
      rationale: typeof proposal.rationale === "string" ? proposal.rationale : "",
    });
  }

  const riskList = Array.isArray(parsed.riskList)
    ? parsed.riskList.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        return typeof row.ticker === "string" && typeof row.reason === "string"
          ? [{ ticker: row.ticker, reason: row.reason }]
          : [];
      })
    : [];

  if (candidates.length === 0 && riskList.length === 0) {
    const reason = typeof parsed.reason === "string" ? parsed.reason : "reviewer 未给出候选";
    return { ...base, empty: `今日无候选：${reason}` };
  }
  // At most five reach the reader; the reviewer's own rule, enforced here too.
  return { ...base, regime, candidates: candidates.slice(0, 5), riskList };
}

export default function renderReport(report: RunReport, cfg: TenantSpec): RenderedReport {
  const view = buildView(report, cfg, new Date());
  const tag = view.outcome === "completed" ? "" : ` [${view.outcome}]`;
  return {
    subject: `${view.tenant} ${view.dateHkt.slice(0, 10)}${tag}`,
    text: renderText(view),
  };
}
```

- [ ] **Step 5: Add the render entry point to the tenant package**

In `plugins/option-wizard/package.json`, change `exports` and `files` to:

```json
  "exports": {
    ".": "./lib/tools/index.js",
    "./tools": "./lib/tools/index.js",
    "./gates/ib-preflight": "./lib/gates/ib-preflight.js",
    "./render": "./lib/render/index.js"
  },
  "files": ["lib", "tools", "gates", "render", "tenant.yaml", "team.yaml"],
```

- [ ] **Step 6: Run the render tests to verify they pass**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts`
Expected: PASS, all thirteen tests in this file.

- [ ] **Step 7: Commit**

```bash
git add plugins/option-wizard/render/index.ts plugins/option-wizard/render/text.ts plugins/option-wizard/tests/render.spec.ts plugins/option-wizard/package.json
git commit -m "feat(option-wizard): parse the review JSON and regime prose into a deterministic brief"
```

---

### Task 6: `render/html.ts` — the email template, and the designer schema (`mid` in, `quantity`/`limitPrice` out)

**Files:**
- Create: `plugins/option-wizard/render/html.ts`
- Modify: `plugins/option-wizard/render/index.ts` (import `renderHtml`, add the `html` field)
- Modify: `plugins/option-wizard/tests/render.spec.ts` (append the html assertions)
- Modify: `plugins/option-wizard/team.yaml:68-71` (the designer's JSON schema: legs gain `mid`, the proposal loses `quantity` and `limitPrice`)

**Interfaces:**
- Consumes: `BriefView`, `CandidateView` from `./index.js` (Task 5).
- Produces: `export function renderHtml(view: BriefView): string`; `export function esc(value: string): string`.

Sections, in order, and nothing else (spec §2): (1) header — date HKT + ET, tenant, outcome badge; (2) verdict — regime paragraph plus the stance badge line; (3) candidates, at most five — ticker + strategy + DTE, legs table, max gain / max loss / breakevens, the credit-vs-width bar, rationale, the ±5/10/20 % row; (4) risk list; (5) the one degradation line, only when present. **No footer.**

- [ ] **Step 1: Write the failing html tests**

Append to `plugins/option-wizard/tests/render.spec.ts`:

```ts
describe("renderReport (html part)", () => {
  it("carries the computed numbers and none of the transcript", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).toContain("SPY");
    expect(html).toContain("748.72");
    expect(html).toContain("872");
    expect(html).toContain("未定价");
    expect(html).not.toContain("Actually, let me");
    expect(html).not.toContain("quantity");
    expect(html).not.toContain("run-84a83ad2");
    expect(html).not.toContain("helium audit");
  });

  it("obeys the email constraints: no images, no svg, no box-shadow, no rem", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("box-shadow");
    expect(html).not.toMatch(/[0-9]rem/);
  });

  it("ships all three dark-mode layers and the 359px breakpoint", () => {
    const html = renderReport(report(), SPEC).html ?? "";
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("[data-ogsc]");
    expect(html).toContain("max-width: 359px");
  });

  it("escapes a rationale that contains markup", () => {
    const withMarkup = report();
    withMarkup.steps[3]!.text = REVIEW_TEXT.replace(
      "Bond duration hedge: minimal cost insurance.",
      "Bond <script>alert(1)</script> hedge",
    );
    const html = renderReport(withMarkup, SPEC).html ?? "";
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders the empty brief without any candidate section", () => {
    const html =
      renderReport(
        report({ outcome: "failed", failure: { class: "budget-exhausted", detail: "no room" } }),
        SPEC,
      ).html ?? "";
    expect(html).toContain("今日无候选");
    expect(html).not.toContain("【候选结构】");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/render.spec.ts -t "html part"`
Expected: FAIL — `renderReport(...).html` is `undefined`.

- [ ] **Step 3: Implement `render/html.ts`**

Create `plugins/option-wizard/render/html.ts`:

```ts
/**
 * The email's HTML part: one template literal, table layout, inline styles.
 *
 * Every constraint below was checked against caniemail.com data on 2026-09-02,
 * not remembered:
 *  - data-URI images have `src` rewritten to `nosrc` by all four Gmail
 *    channels, and inline <svg> is deleted WITH its fallback content. So there
 *    is no image and no svg here at all; the one chart is a table cell with a
 *    background colour and a percentage width.
 *  - `prefers-color-scheme` is unsupported across Gmail web/iOS/Android, so
 *    dark mode is three layers: mid-tone inline colours that survive Gmail's
 *    own inversion, the media query for Apple Mail, and `[data-ogsc]` /
 *    `[data-ogsb]` attribute selectors for Outlook.com.
 *  - `rem` is unsupported in Yahoo, `box-shadow` in Gmail web, `position`
 *    everywhere in Gmail. All sizes are px and cards use a 1px border.
 *  - The breakpoint is 359px, not 420px: an iPhone 15 is 390pt, and a 420px
 *    breakpoint stacked every multi-column row on the device the reader uses.
 * @module dsh-plugin-tenant-option-wizard/render/html
 */
import type { BriefView, CandidateView } from "./index.js";

const INK = "#232830";
const DIM = "#6b7484";
const RULE = "#e0e4eb";
const CARD = "#ffffff";
const PAGE = "#eef0f4";
const CHIP = "#f5f7fb";
const GREEN = "#1a7f47";
const RED = "#b3261e";
const AMBER = "#7a5300";
const SLATE = "#5a6376";

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const money = (value: number | null): string =>
  value === null ? "无上限" : `$${value.toFixed(2)}`;

function badge(text: string): string {
  return `<span class="chip" style="display:inline-block;padding:2px 8px;margin:0 6px 4px 0;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${INK};font-size:12px">${esc(text)}</span>`;
}

/** The credit-vs-width bar. A table cell with a background colour is the only
 *  chart primitive every mail client renders; there is no image to block. */
function bar(fraction: number, credit: boolean): string {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const fill = credit ? GREEN : SLATE;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0"><tr>
    <td class="track" width="${String(pct)}%" style="background-color:${fill};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
    <td class="track" width="${String(100 - pct)}%" style="background-color:${RULE};font-size:1px;line-height:8px;height:8px">&nbsp;</td>
  </tr></table>
  <div class="ink-dim" style="color:${DIM};font-size:12px">净权利金 / 价差宽度 = ${String(pct)}%</div>`;
}

function legRows(candidate: CandidateView): string {
  return candidate.legs
    .map(
      (leg) => `<tr>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};color:${leg.action === "buy" ? GREEN : RED};font-size:13px">${esc(leg.action)}</td>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${esc(leg.right)}</td>
        <td align="right" style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${leg.strike.toFixed(2)}</td>
        <td style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${esc(leg.expiry)}</td>
        <td align="right" style="padding:4px 6px;border-top:1px solid ${RULE};font-size:13px">${leg.mid === undefined ? "—" : leg.mid.toFixed(2)}</td>
      </tr>`,
    )
    .join("");
}

function pricingBlock(candidate: CandidateView): string {
  const pricing = candidate.pricing;
  if (pricing.kind !== "priced") {
    const colour = pricing.kind === "invalid" ? RED : AMBER;
    return `<div style="margin-top:8px;color:${colour};font-size:13px">${esc(pricing.reason)}</div>`;
  }
  const credit = pricing.net >= 0;
  const fraction = candidate.width === 0 ? 0 : Math.abs(pricing.net) / candidate.width;
  const cells = pricing.pnlAt
    .map(
      (point) => `<td align="center" style="padding:4px 2px;font-size:12px;color:${point.pnl >= 0 ? GREEN : RED}">
        <div class="ink-dim" style="color:${DIM}">${point.pct > 0 ? "+" : ""}${String(point.pct)}%</div>
        <div>${point.pnl.toFixed(0)}</div>
      </td>`,
    )
    .join("");
  const breakevens =
    pricing.breakevens.length === 0
      ? "无"
      : esc(pricing.breakevens.map((value) => value.toFixed(2)).join(" / "));
  return `<div class="ink" style="margin-top:8px;font-size:13px;color:${INK}">
      ${credit ? "净收权利金" : "净付权利金"} <strong>$${Math.abs(pricing.net).toFixed(2)}</strong>/股 ·
      max gain <strong style="color:${GREEN}">${money(pricing.maxGain)}</strong> ·
      max loss <strong style="color:${RED}">${money(pricing.maxLoss)}</strong>
    </div>
    <div class="ink-dim" style="font-size:13px;color:${DIM}">breakeven ${breakevens}</div>
    ${bar(fraction, credit)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border-top:1px solid ${RULE}"><tr>${cells}</tr></table>
    <div class="ink-dim" style="color:${DIM};font-size:11px;margin-top:2px">到期损益，每张合约，不含数量</div>`;
}

function candidateCard(candidate: CandidateView): string {
  const dte = candidate.dte === null ? "" : ` · ${String(candidate.dte)} DTE`;
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px">
      <tr><td class="pad" style="padding:12px 15px">
        <div class="ink" style="color:${INK};font-size:16px;font-weight:700">${esc(candidate.ticker)}</div>
        <div class="ink-dim" style="color:${DIM};font-size:13px">${esc(candidate.strategy)}${esc(dte)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ink" style="margin-top:8px;color:${INK}">
          <tr>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">action</th>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">right</th>
            <th align="right" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">strike</th>
            <th align="left" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">expiry</th>
            <th align="right" style="padding:0 6px 4px;color:${DIM};font-size:11px;font-weight:400">mid</th>
          </tr>
          ${legRows(candidate)}
        </table>
        ${pricingBlock(candidate)}
        <div class="ink-dim" style="color:${DIM};font-size:13px;margin-top:8px">${esc(candidate.rationale)}</div>
      </td></tr>
    </table>`;
}

export function renderHtml(view: BriefView): string {
  const outcomeColour =
    view.outcome === "completed" ? GREEN : view.outcome === "DEGRADED" ? AMBER : RED;
  const stances = [
    view.regime.direction === undefined ? "" : badge(`direction: ${view.regime.direction}`),
    view.regime.volatility === undefined ? "" : badge(`vol: ${view.regime.volatility}`),
    view.regime.hedge === undefined ? "" : badge(`hedge: ${view.regime.hedge}`),
  ].join("");

  const riskSection =
    view.riskList.length === 0
      ? ""
      : `<div class="ink-dim" style="color:${DIM};font-size:12px;margin:14px 0 8px">【风险清单】</div>
         <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px">
           ${view.riskList
             .map(
               (entry) => `<tr><td class="pad ink" style="padding:10px 15px;border-top:1px solid ${RULE};color:${INK};font-size:13px"><strong>${esc(entry.ticker)}</strong> — ${esc(entry.reason)}</td></tr>`,
             )
             .join("")}
         </table>`;

  const body =
    view.empty !== undefined
      ? `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px">
           <tr><td class="pad ink" style="padding:15px;color:${INK};font-size:15px">${esc(view.empty)}</td></tr>
         </table>`
      : `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CARD};border:1px solid ${RULE};border-radius:10px;margin-bottom:12px">
           <tr><td class="pad" style="padding:12px 15px">
             <div class="ink" style="color:${INK};font-size:14px;line-height:1.55">${esc(view.regime.paragraph)}</div>
             <div style="margin-top:8px">${stances}</div>
           </td></tr>
         </table>
         <div class="ink-dim" style="color:${DIM};font-size:12px;margin:14px 0 8px">【候选结构】每张合约，不含数量</div>
         ${view.candidates.map(candidateCard).join("")}
         ${riskSection}`;

  const degradationRow =
    view.degradation === undefined
      ? ""
      : `<tr><td class="pad" style="padding:12px 4px 0;color:${AMBER};font-size:12px">${esc(view.degradation)}</td></tr>`;

  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(view.tenant)} ${esc(view.dateHkt)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .bg { background-color: #12151a !important; }
  .card { background-color: #1b1f27 !important; border-color: #2c3340 !important; }
  .ink { color: #e6e9ef !important; }
  .ink-dim { color: #a2abbb !important; }
  .chip { background-color: #222836 !important; border-color: #2c3340 !important; }
}
[data-ogsc] .ink { color: #e6e9ef !important; }
[data-ogsc] .ink-dim { color: #a2abbb !important; }
[data-ogsb] .card { background-color: #1b1f27 !important; }
@media only screen and (max-width: 359px) {
  .stack { display: block !important; width: 100% !important; }
  .pad { padding-left: 12px !important; padding-right: 12px !important; }
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background-color:${PAGE}">
 <tr><td align="center" style="padding:16px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif">
   <tr><td class="pad" style="padding:0 4px 12px">
     <div class="ink" style="color:${INK};font-size:20px;font-weight:700">${esc(view.tenant)}</div>
     <div class="ink-dim" style="color:${DIM};font-size:13px">${esc(view.dateHkt)} · ${esc(view.dateEt)}
       <span class="chip" style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background-color:${CHIP};border:1px solid ${RULE};color:${outcomeColour};font-size:12px">${esc(view.outcome)}</span>
     </div>
   </td></tr>
   <tr><td style="padding:0 4px">${body}</td></tr>
   ${degradationRow}
  </table>
 </td></tr>
</table>
</body></html>`;
}
```

- [ ] **Step 4: Hook the html into the renderer**

In `plugins/option-wizard/render/index.ts`, add the import beside the others:

```ts
import { renderHtml } from "./html.js";
```

and change the return of `renderReport` to:

```ts
  return {
    subject: `${view.tenant} ${view.dateHkt.slice(0, 10)}${tag}`,
    text: renderText(view),
    html: renderHtml(view),
  };
```

- [ ] **Step 5: Add `mid` to the designer's leg schema and take `quantity` and `limitPrice` out of it**

Three fields change together and for one reason: the renderer derives the money
from the leg mids, so `mid` is the only price input that matters, and the two
fields it replaces were both wrong every time they shipped. `quantity` was a
guess with no NLV source behind it (user, 2026-09-02: position size is the
reader's), and `limitPrice` disagreed with its own rationale in five of five
proposals on 2026-09-02. A field the renderer never prints and the model cannot
get right is a field to delete, not to carry (doctrine 6).

In `plugins/option-wizard/team.yaml`, in the `structure-designer` persona, replace

```
      {"proposals":[{"ticker","strategy","legs":[{"right":"call"|"put",
      "expiry":"YYYY-MM-DD","strike","action":"buy"|"sell","ratio"}],
      "quantity","limitPrice","rationale"}]}
```

with

```
      {"proposals":[{"ticker","strategy","legs":[{"right":"call"|"put",
      "expiry":"YYYY-MM-DD","strike","action":"buy"|"sell","ratio","mid"}],
      "rationale"}]}
      `mid` is the NBBO mid you read from ow_uw_chain for that exact strike and
      expiry, per share. Never compute it and never round it to a nice number:
      a leg without a real `mid` is shown to the reader as 未定价, which is
      correct, whereas a guessed one is a made-up price in a trading email.
      There is no `quantity` and no `limitPrice`. Position size is the reader's
      and nothing in this harness knows the account's net liquidation value, so
      a number there would be a guess printed next to real strikes. The net
      debit or credit is computed from your `mid` values, per contract, and it
      is computed rather than quoted because five of five quoted limit prices
      on 2026-09-02 disagreed with their own rationale.
```

Check the `risk-reviewer` persona in the same file while you are there: as of
this change it says `{"proposals":[...kept, same shape you were given...]` and
names neither field, so it needs no edit — `mid` travels through on its own. If
a later edit ever spells the leg shape out there, it must match the block above.

**The renderer must tolerate the old shape.** A proposal that still carries
`quantity` and `limitPrice` — an in-flight run, a replayed report, a model that
kept its old habit — renders exactly the same: `buildView` reads only `ticker`,
`strategy`, `legs` and `rationale` off a proposal and never enumerates its keys,
so the extra fields are ignored rather than rejected. The Task 5 fixture is that
proof and is deliberately left as the real 2026-09-02 JSON, `quantity` and
`limitPrice` included, with the text and html suites both asserting the word
`quantity` never reaches the reader. Do not "tidy" those fields out of the
fixture: removing them would delete the only test of the old shape.

- [ ] **Step 6: Run the full tenant suite to verify it passes**

Run: `pnpm vitest run --project unit plugins/option-wizard/tests/`
Expected: PASS — the math suite, the parse/text suite and the five html tests.

- [ ] **Step 7: Commit**

```bash
git add plugins/option-wizard/render/html.ts plugins/option-wizard/render/index.ts plugins/option-wizard/tests/render.spec.ts plugins/option-wizard/team.yaml
git commit -m "feat(option-wizard): render the brief as HTML mail and read a real mid per leg"
```

---

### Task 7: `scripts/deploy-v2.sh` and the AGENTS.md command line

The v2 lane on the mini is its own checkout, its own state root and its own launchd label. The email counter file IS the daily cap, so deleting it is the reset — no version keying, nothing to hand-edit.

**Files:**
- Create: `scripts/deploy-v2.sh` (there is no `scripts/` directory on this branch; create it)
- Modify: `AGENTS.md` (the `### Release and ops` code block)
- Test: `bash -n`, plus `shellcheck` when available. This script talks to a real machine, so its real test is the acceptance run in Task 8.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `scripts/deploy-v2.sh`, run from the laptop with no arguments.

Mini facts this encodes: checkout `~/projects/helium-v2` on branch `master`; `HELIUM_STATE_ROOT=$HOME/.helium/state-v2`; counter file `$HELIUM_STATE_ROOT/reports/email-counters.json`; launchd label `com.helium.option-wizard` in the gui domain; env file `~/.config/helium/helium.env`; node at `/opt/homebrew/bin/node`; ssh host alias `macmini`.

- [ ] **Step 1: Write the script**

Create `scripts/deploy-v2.sh`:

```bash
#!/usr/bin/env bash
# Deploy the v2 lane (option-wizard) to the mini. Run from the laptop:
#   scripts/deploy-v2.sh
#
# Re-execs itself on the deploy host over stdin (`ssh "$HOST" ... bash -s`) so
# there is exactly one copy of this script to maintain; everything below the
# HELIUM_REMOTE guard runs on the mini and never on the laptop.
#
# No version keying and no release directory: the v2 lane deploys the tip of
# master in one checkout (doctrine 5 — deploy is minutes, not days).
set -euo pipefail

HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
# These expand on the MINI: they are read only after the re-exec.
CHECKOUT="$HOME/projects/helium-v2"
STATE_ROOT="${HELIUM_STATE_ROOT:-$HOME/.helium/state-v2}"
COUNTERS="$STATE_ROOT/reports/email-counters.json"
LABEL="com.helium.option-wizard"

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # A non-interactive ssh gets PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew,
  # so no node and no pnpm. Both prefixes are listed so this does not silently
  # depend on the CPU architecture.
  ssh "$HELIUM_HOST" \
    "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\"; HELIUM_REMOTE=1 bash -s" \
    < "$0"
  exit $?
fi

# ---- everything below runs ON the mini ----
say() { printf '[deploy-v2] %s\n' "$*"; }

# Printed, never assumed: a binary reported "absent" because a non-login ssh
# dropped /opt/homebrew/bin has already cost this project a debugging session.
say "PATH=$PATH"
say "node=$(command -v node || echo MISSING) pnpm=$(command -v pnpm || echo MISSING)"
command -v node >/dev/null || { echo "node not on PATH" >&2; exit 127; }
command -v pnpm >/dev/null || { echo "pnpm not on PATH" >&2; exit 127; }

[ -d "$CHECKOUT/.git" ] || { echo "no checkout at $CHECKOUT" >&2; exit 66; }
say "updating $CHECKOUT"
git -C "$CHECKOUT" pull --ff-only
say "at $(git -C "$CHECKOUT" rev-parse --short HEAD) on $(git -C "$CHECKOUT" rev-parse --abbrev-ref HEAD)"

say "installing and building"
pnpm --dir "$CHECKOUT" install --frozen-lockfile
pnpm --dir "$CHECKOUT" build

# The daily cap is counted from this one file, so deleting it IS the reset. A
# missing file caps LOW by design (it re-counts from zero), which is why
# removing it is safe and why nobody has to hand-edit a counter again.
say "resetting the email daily cap: $COUNTERS"
rm -f "$COUNTERS"

say "kicking $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
say "done"
```

Then: `chmod +x scripts/deploy-v2.sh`

- [ ] **Step 2: Syntax-check it**

Run: `bash -n scripts/deploy-v2.sh && (command -v shellcheck >/dev/null && shellcheck scripts/deploy-v2.sh || echo "shellcheck absent, skipped")`
Expected: no output from `bash -n`; shellcheck clean, or reported absent.

- [ ] **Step 3: Document it**

In `AGENTS.md`, in the `### Release and ops` bash block, add as the first line:

```bash
scripts/deploy-v2.sh                # v2 lane: laptop -> macmini over ssh stdin; pull, build,
                                    # DELETE the email counter file (that IS the daily-cap
                                    # reset), kickstart com.helium.option-wizard
```

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-v2.sh AGENTS.md
git commit -m "feat(ops): one-command v2 deploy that resets the email daily cap"
```

---

### Task 8: Full verification and live acceptance

**Files:**
- Modify: none. This task only runs things and records what it saw.

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: the evidence that the change works, and the go/no-go on the live send.

- [ ] **Step 1: Build and typecheck the workspace**

Run: `pnpm build && pnpm typecheck && ls plugins/option-wizard/lib/render/index.js`
Expected: PASS, and the file exists. Without `lib/render/index.js` discovery finds no renderer on the mini and the email silently stays the transcript.

- [ ] **Step 2: Run the whole unit suite**

Run: `pnpm test`
Expected: PASS — the pre-existing tests plus the new discovery, runner, email, markdown, math and render ones.

- [ ] **Step 3: Run the neutrality contract**

Run: `pnpm vitest run --project contracts contracts/tests/core-neutrality.contract.spec.ts`
Expected: PASS. `packages/core/src/report.ts` and the `rendered` field must name no provider and no business domain — the banned words are `deepseek, claude, anthropic, codex, openai, gpt-, gemini, livewire, argon, apex, colima, postgres`.

- [ ] **Step 4: Run the full contract suite**

Run: `pnpm build && pnpm test:contracts`
Expected: PASS. Build first — the contracts consume `lib/`.

- [ ] **Step 5: Eyeball the html at 390px (self-check only, nothing committed)**

Temporarily add one line to the first html test in `plugins/option-wizard/tests/render.spec.ts`:

```ts
    writeFileSync("/tmp/helium-brief.html", html, "utf8");
```

Run that one test, open `/tmp/helium-brief.html` in a browser sized to 390px, then REVERT the line and its import. Chromium proves the markup renders; it proves nothing about iOS Mail or Gmail — that is Step 7.

- [ ] **Step 6: Deploy to the mini**

Run: `scripts/deploy-v2.sh`
Expected: the script prints its PATH, both binary paths, the commit it landed on, the counter reset line and `done`. A `node not on PATH` exit 127 means the ssh PATH export was dropped — fix that, do not work around it.

- [ ] **Step 7: One live send, checked on two clients (manual, blocking)**

On the mini, trigger one run of the tenant with delivery armed, then open the mail in **iOS Mail** and in the **Gmail app**. Check, in this order:

1. the subject is `[option-wizard] option-wizard <date>`, with no `[FAILED]` / `[DEGRADED]` tag on a good day;
2. the body is the brief, not a transcript — no "Actually, let me", no JSON dump, no run id, no token or cost line;
3. every priced candidate shows max gain, max loss and breakeven, and max gain and max loss are not the same number;
4. a leg the designer left without a `mid` reads `未定价`, not a number;
5. the layout holds at 390pt in both clients — no horizontal scroll, no clipped row;
6. the colours stay legible in each client's dark mode.

Any of 1-4 failing is a bug in this change. 5 or 6 failing is a template fix in `html.ts`; redo Task 6 Steps 3-7 for it.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin "$(git branch --show-current)"
gh pr create --title "option-wizard: deterministic renderer and HTML email" \
  --body "Implements docs/superpowers/specs/2026-09-02-option-wizard-render-design.md (sub-project A). Core learns only that a tenant may render its own delivery; every option-specific rule stays in plugins/option-wizard/render/."
```

Wait for CI to be green before merging. Never land on `master` without a PR.
