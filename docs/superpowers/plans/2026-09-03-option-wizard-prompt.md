# option-wizard prompt 重写 — five phases, one tenant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the user's `/execute-plan` skill (linear, in-session, milestone commits). Do NOT use subagent-driven-development or dispatching-parallel-agents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the option-wizard tenant from one daily one-sentence-prompt run into five phased runs (`premarket`, `intraday`, `close`, `weekly`, `frank`) whose prompts carry the salvaged hard rules, whose report/email names say which phase they are, and whose timestamps are provably verbatim copies of what a tool returned.

**Architecture:** One generic seam in core and the CLI — a run has a `phase` string, a team task may declare `phases: string[]`, and an output gate may see the run's tool outputs. Core learns no domain word: `phase` is a label core never interprets (doctrine 2). Everything phase-_specific_ — which five phases exist, what each one says, which tools it may call — lives in `plugins/option-wizard/` and in `launchd/` (doctrine 3: adding a phase is a new plist plus a `phases:` entry, never a core edit). Three new tenant tools and one new tenant gate; no new npm dependency, no new contract test, no new manifest (doctrine 6).

**Tech Stack:** TypeScript ESM, pnpm workspace, Node 22.19+, vitest, zod. Timezone formatting is `Intl.DateTimeFormat`; plist validation is `python3 -c 'import plistlib'`.

**Spec:** `docs/superpowers/specs/2026-09-03-option-wizard-prompt-design.md`
**Upstream (landed):** `docs/superpowers/plans/2026-09-02-option-wizard-render.md`

**Doctrine (binding, from `/Users/chenxi/projects/helium/AGENTS.md`):** point 2 — core knows no domain, no provider, no business word; point 3 — a role declares capabilities, never a model, and a new agent kind is a new directory; point 6 — ceremony must earn its keep, prefer deleting over certifying.

---

## Spec deviations

These review decisions **override** the spec where they differ. Anything not listed here follows the spec.

1. **§6 `markout` step timing.** Spec puts markout in `premarket` and `close`. Here markout runs **only in `close`** — that is where the settling prices are final, and running it twice was double work on the same numbers. Close's markout settles both yesterday's close report's numbered calls **and** each call in the latest weekly report.
2. **§6 `ow_uw_gex` field list.** Spec lists `spot / HVL / 0DTE HVL / Call Resistance / Put Support / Total GEX / Total DEX / 1D change / 1D Min / 1D Max`. The verified endpoint (`GET /api/stock/{ticker}/gex-levels?source=vol`) returns `call_wall`, `gamma_flip`, `gamma_magnet`, `nearby_flips`, `put_wall`, `date`, `time`, `source` and nothing else. The tool returns **those fields untouched**; net GEX/DEX totals stay in the existing `ow_argon_metrics`. No field is synthesised to match the spec's table.
3. **§4/§8 credit layer contradiction.** §4 requires HY OAS / CCC OAS and a hike probability; §8 defers the tools that would supply them to sub-project B. There is no tool. The prompt therefore renders the credit row as `skipped` in the Layer Coverage table, and **Task 7 edits the spec** to remove the contradiction rather than leaving a requirement no run can satisfy.
4. **§6 markout input path.** Spec says `reports/option-wizard-<date>-run-*.md`. After Task 2 the file is `reports/option-wizard-<date>-<phase>.md` and markout reads it through the new `ow_reports` tool, not by globbing a run id.
5. **§6 Frank enumeration.** Spec uses `--limit 5`. `ow_frank` uses `--limit 1` and reads only the newest post; five posts is five web reads for four articles nobody compares against.
6. **Frank's opencli binary.** The existing tools use `OPENCLI_BIN`. `ow_frank` reads **`OW_OPENCLI_BIN`** (default `opencli`) so the substack path can be pointed at a different build than the TradingView path without disabling both.
7. **Report naming.** Spec §7 does not name the file. Decision: `<tenant>-<date>-<phase>.md`, **overwritten** on a rerun of the same phase. A rerun of a phase is a correction, not a second opinion, and `ow_reports` must not have to choose between two files for one phase.

---

## Global Constraints

- **No new npm dependency.**
- **Core stays domain-free.** `contracts/tests/core-neutrality.contract.spec.ts` must still pass: `phase`, `phases`, `toolOutputs` are generic words; no ticker, vendor, "option", "market" or "gex" enters `packages/core/src`.
- **No quantity, no position sizing, no NLV anywhere** — carried over from the render plan. `team.yaml` must not contain the string `quantity`.
- **No run metadata in the email body** (run id, tokens, cost, step count). Those stay in the audit table and in the markdown report's header.
- **Never estimate, never convert a timestamp.** A timestamp in the briefing is a verbatim substring of a tool output or it is not written. This is what the new gate enforces.
- **Every proposal carries 失效价.** A proposal without an invalidation level is not output.
- **No fixture is invented.** The `ow_uw_gex` fixture is the live 2026-09-02 SPY response, verbatim. The as-of gate fixture uses `2026-09-02T12:45:00-04:00`, the real timestamp from the 2026-09-02 intraday bug.
- **Commit messages carry no `Co-Authored-By` and no AI/tool attribution trailer.**
- `lib/` is build output and is not committed; `pnpm build` before contract tests and before any deploy script.

---

### Task 1: Phase plumbing — core, CLI, runner

A run gains a label the core never interprets, and a team task may say which labels it belongs to. Everything after this task is a consumer of it.

**Files:**

- Modify: `packages/core/src/team.ts:47-53` (`TeamTaskSchema`)
- Modify: `packages/core/src/report.ts` (`RunReport` gains `phase`)
- Modify: `packages/cli/src/cli.ts:137-176` (`helium run <tenant> [--phase <p>]`)
- Modify: `packages/cli/src/runner.ts:160-182` (`RunOptions.phase`), `:298` (`runTenant`), `:412-419` (prompt assembly), `:239-250` (`handoff` tolerating a skipped dependency)
- Test: `packages/core/tests/team-phases.spec.ts` (new), `packages/cli/tests/runner-phase.spec.ts` (new)

**Interfaces:**

- Consumes: nothing.
- Produces: `TeamTask.phases?: string[]`; `RunReport.phase: string`; `RunOptions.phase?: string`; a `phase: …\nnow: …` preamble on every step prompt.

- [ ] **Step 1: `phases` on a team task**

`packages/core/src/team.ts`, in `TeamTaskSchema` (currently lines 47-53):

```ts
export const TeamTaskSchema = z.strictObject({
  id: z.string().min(1),
  role: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  requires: CapabilityList,
  prompt: z.string().max(20000).optional(),
  /**
   * Run labels this task belongs to. ABSENT means every label — a task that
   * does not care must not have to enumerate the ones it does not know about.
   * Core never interprets a label; it only compares strings, which is why a
   * tenant can add a sixth one without editing this file (doctrine 3).
   */
  phases: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
});
```

No change to `validateManifest`: a task whose `phases` exclude every configured run is a tenant's own mistake, and refusing to load the manifest over it would make an unused-in-this-phase task look like a broken one.

- [ ] **Step 2: `phase` on the run report**

`packages/core/src/report.ts`, in `RunReport`, next to `mode`:

```ts
/** The run label this run was started with. Opaque to core; the tenant and
 *  the delivery channels are the only things that know what it means. */
phase: string;
```

- [ ] **Step 3: parse `--phase` in the CLI**

`packages/cli/src/cli.ts`, inside the `if (command === "run")` block (currently starting at line 137). The flag is parsed off the remaining argv, and an unknown flag is an error rather than a silently ignored word:

```ts
  if (command === "run") {
    if (argument === undefined) {
      console.error("usage: helium run <tenant> [--phase <phase>]");
      return 2;
    }
    let phase = "premarket";
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--phase") {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) {
          console.error("--phase needs a value, e.g. --phase premarket");
          return 2;
        }
        phase = value;
        i += 1;
        continue;
      }
      console.error(`unknown argument: ${rest[i]}`);
      return 2;
    }
```

and pass it into the existing `runTenant({ … })` call: `phase,`.

Adjust `argv.slice(2)` to whatever the surrounding function already names its argument vector (the file destructures `command` and `argument` from it — reuse that same array, sliced past those two).

**Default is `premarket`** so an operator who types `helium run option-wizard` gets the same run they got before this change.

- [ ] **Step 4: thread it through the runner**

`packages/cli/src/runner.ts`, `RunOptions` (line 160):

```ts
  /** The run label. Core-neutral; forwarded to prompts, gates and delivery. */
  phase?: string;
```

In `runTenant` (line 298), beside `runId`:

```ts
const phase = options.phase ?? "premarket";
```

and add `phase,` to the `report: RunReport = { … }` literal.

- [ ] **Step 5: filter tasks by phase, tolerate the gap**

In the `tasks:` loop, immediately after `const task = manifest.tasks.find(…)!;`:

```ts
// A task that names phases and does not name THIS one does not run. It is
// not a failure and it is not a gate refusal: it is a task that belongs to
// a different time of day. It contributes no `produced` entry, so every
// dependent sees exactly what it would see if the step had never been
// written — `handoff` already drops dependencies with no text.
if (task.phases !== undefined && !task.phases.includes(phase)) continue;
```

`handoff` (lines 239-250) already skips a `dependsOn` id that is absent from `produced`, so a skipped dependency needs no change there. Add the reason to its doc comment so the next reader does not "fix" it:

```ts
/** Dependencies with no text are dropped, not rendered as an empty section.
 *  That is also what makes a phase-skipped dependency harmless: it produced
 *  nothing, so it forwards nothing. */
```

Check `topologicalOrder`: it orders ids from the manifest and must keep listing a skipped task's dependents. It orders, it does not execute, so nothing changes there — confirm with the test in Step 7 rather than by reading.

- [ ] **Step 6: prepend `phase` and `now` to every step prompt**

Above `runTenant`, a formatter with no dependency:

```ts
/**
 * `2026-09-03T18:00:12+08:00` in Asia/Hong_Kong. Written out by hand from the
 * parts `Intl` gives, because `toISOString()` is UTC and no runtime formats a
 * zoned offset ISO string directly. The offset is derived, never hardcoded:
 * HK does not observe DST today, and a literal +08:00 would make that a
 * property of this file instead of a property of the zone.
 */
export function zonedNow(now: Date, timeZone = "Asia/Hong_Kong"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  const local = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  const offsetMin = Math.round((local - now.getTime()) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
```

In the prompt assembly (lines 412-419), the preamble goes **first**, before the budget line:

```ts
    const line = budgetLine(budget, spec.budget);
    const clock = `phase: ${phase}\nnow: ${zonedNow(options.now?.() ?? new Date())}`;
    const work: WorkOrder = WorkOrderSchema.parse({
      …
      inputs: {
        artifacts: task.dependsOn.map((id) => `step:${id}`),
        prompt: [clock, line, role.persona ?? "", handoff(task, produced), task.prompt ?? taskId]
          .filter((part) => part !== "")
          .join("\n\n"),
      },
```

Add `now?: () => Date;` to `RunOptions` so the test can freeze it.

Why the model is told the time at all: without it, every "as of" the model writes is a guess, and §1 of the spec is two bugs caused by exactly that guess.

- [ ] **Step 7: tests**

`packages/core/tests/team-phases.spec.ts`:

```ts
it("accepts a task with no phases and a task with phases", () => { … });
it("rejects an empty phases array", () => { … });   // min(1)
```

`packages/cli/tests/runner-phase.spec.ts` — mirror the setup of the existing runner tests (injected `tools`, `providers: []`, `renderer: null`, a temp `stateRoot`):

```ts
it("skips a task whose phases exclude the run phase, and its dependent still runs", async () => {
  const report = await runTenant({ …, phase: "close" });
  expect(report.steps.map((s) => s.task)).toEqual(["universe", "markout"]);
});

it("prepends phase and a zoned now to the step prompt", async () => {
  // now frozen at 2026-09-03T10:00:00Z = 18:00 HKT
  expect(seenPrompt).toContain("phase: premarket");
  expect(seenPrompt).toContain("now: 2026-09-03T18:00:00+08:00");
});
```

**Test command:** `pnpm vitest run --project unit packages/core/tests/team-phases.spec.ts packages/cli/tests/runner-phase.spec.ts && pnpm typecheck`

**Commit:** `feat(core,cli): a run has a phase, and a task may declare which phases it belongs to`

---

### Task 2: Report and email named by phase

Five runs a day into one directory need five distinct, stable names. The run id in the filename was there so two runs could not overwrite each other; the phase now carries that, and a rerun of one phase **should** overwrite — it is a correction of the same report.

**Files:**

- Modify: `packages/core/src/plugins.ts:140-160` (`DeliveryPayload` gains `phase`)
- Modify: `packages/cli/src/runner.ts:786-795` (payload), `:840-849` (`deliverySubject`)
- Modify: `plugins/delivery-markdown/src/channel.ts` (`reportPath`)
- Modify: `plugins/delivery-markdown/src/channel.test.ts:41-50` (the "run id in the FILENAME" test becomes the phase test)

**Interfaces:**

- Consumes: `RunReport.phase` from Task 1.
- Produces: `DeliveryPayload.phase?: string`; files at `<stateRoot>/reports/<tenant>-<date>-<phase>.md`; email subject `[option-wizard] <phase> <date>`.

- [ ] **Step 1: `phase` on the payload**

`packages/core/src/plugins.ts`, in `DeliveryPayload`:

```ts
  /** The run label. A channel may name its artifact after it; core does not
   *  interpret it. */
  phase?: string;
```

- [ ] **Step 2: runner supplies it, and the subject uses it**

In the delivery loop (line ~789), add `phase: report.phase,` to the payload literal. Then:

```ts
function deliverySubject(report: RunReport): string {
  const day = new Date().toISOString().slice(0, 10);
  const tag =
    report.outcome === "failed"
      ? "[FAILED] "
      : report.mode === "tool-only"
        ? "[DEGRADED] "
        : "";
  // The tenant name is already the subject prefix configured in tenant.yaml
  // ("[option-wizard]"), so repeating it here read as "[option-wizard] helium
  // option-wizard 2026-09-03". Phase and date are what tell two of the day's
  // five emails apart.
  return `${tag}${report.phase} ${day}`;
}
```

Existing tests asserting `helium option-wizard <date>` in a subject must be updated in the same commit; grep for `"helium "` under `packages/cli/tests` and `plugins/delivery-email`.

- [ ] **Step 3: the markdown filename**

`plugins/delivery-markdown/src/channel.ts`:

```ts
/** `<dir>/<tenant>-<yyyy-mm-dd>-<phase>.md`.
 *
 *  The PHASE is in the name, not the run id. Five scheduled runs a day need
 *  five stable names a later run can find by name (that is what the tenant's
 *  own report-reading tool does), and a second run of the SAME phase is a
 *  correction of that report — overwriting is the intent, not a collision.
 *  The run id lives in the file's header line and in the audit table, which is
 *  where a reader chasing a surprising number goes anyway. A run with no phase
 *  falls back to the run id, so a tenant that never sets one is unchanged. */
function reportPath(dir: string, payload: DeliveryPayload, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const tail = payload.phase ?? payload.runId;
  return join(dir, `${payload.tenant}-${day}-${tail}.md`);
}
```

- [ ] **Step 4: rewrite the collision test**

`plugins/delivery-markdown/src/channel.test.ts`, replacing the block at lines 41-50:

```ts
it("names the file by PHASE, so a rerun of one phase corrects it in place", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "helium-md-"));
  const channelUnderTest = new MarkdownChannel({ now, stateRoot });
  await channelUnderTest.deliver({ ...payload, phase: "premarket" }, {});
  await channelUnderTest.deliver({ ...payload, phase: "close", runId: "run-2" }, {});
  await channelUnderTest.deliver({ ...payload, phase: "premarket", runId: "run-3" }, {});
  expect(readdirSync(join(stateRoot, "reports")).sort()).toEqual([
    "option-wizard-2026-09-02-close.md",
    "option-wizard-2026-09-02-premarket.md",
  ]);
  expect(readFileSync(join(stateRoot, "reports", "option-wizard-2026-09-02-premarket.md"), "utf8"))
    .toContain("run-3");
});

it("falls back to the run id when no phase is set", async () => { … });
```

- [ ] **Step 5: leave `dir: reports` alone**

The mini already writes to `<stateRoot>/reports/` with `email-counters.json` beside the reports; `ow_reports` (Task 4) globs `option-wizard-*.md` so the counter file is never picked up. No tenant change.

**Test command:** `pnpm vitest run --project unit plugins/delivery-markdown packages/cli/tests && pnpm typecheck`

**Commit:** `feat(delivery): name the report and the email subject by phase`

---

### Task 3: `ow_uw_gex`

**Files:**

- Modify: `plugins/option-wizard/tools/index.ts` (`VOCABULARY` line ~41-51; a new entry in `buildTools`)
- Test: `plugins/option-wizard/tests/tools-uw-gex.spec.ts` (new)

**Interfaces:**

- Consumes: `uwGet(env, tool, path, query, ctx)` (`tools/index.ts:352-368`), `OW_UW_API_KEY`.
- Produces: tool `ow_uw_gex`, args `{ tickers?: string[] }`.

- [ ] **Step 1: vocabulary entry**

```ts
  ["ow_uw_gex", { mutating: false, requiresEnv: "OW_UW_API_KEY" }],
```

- [ ] **Step 2: the tool**

In `buildTools`, next to the other UW tools:

```ts
const GexParams = z.object({
  tickers: z.array(z.string().min(1).max(8)).max(12).optional(),
});
```

```ts
    {
      // GET /api/stock/{ticker}/gex-levels?source=vol
      // Verified against the live response 2026-09-02 (SPY):
      //   {"date":"2026-09-02","time":"2026-09-02T17:31:16.000000Z",
      //    "source":"vol","call_wall":"766","gamma_flip":"764.77",
      //    "gamma_magnet":"766","nearby_flips":["764.77","765.16","770.49",
      //    "758.3","771.37"],"put_wall":"764"}
      // Every level is a STRING in the response and stays a string here: the
      // model quotes the level it was given, and a Number() round-trip is how
      // "764.77" becomes 764.7699999 in a trading email.
      // `source=vol` is volume-derived exposure — the same basis UW's own
      // levels page shows. There is no net GEX/DEX total on this endpoint;
      // those stay in ow_argon_metrics (uw_scan.greek_exposure_daily).
      name: "ow_uw_gex",
      description:
        "Unusual Whales GEX levels per ticker: call wall, put wall, gamma flip, gamma magnet, nearby flips, with the as-of time UW returned.",
      paramsSchema: GexParams,
      mutating: false,
      dshParams: {
        tickers: {
          type: "array",
          description: "Tickers, e.g. [\"SPY\",\"QQQ\"]. Defaults to SPY and QQQ.",
        },
      },
      async run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string> {
        const { tickers } = GexParams.parse(args);
        const wanted = (tickers ?? ["SPY", "QQQ"]).map((t) => symbolLiteral(t, "ow_uw_gex"));
        const levels: unknown[] = [];
        const unavailable: Array<{ ticker: string; reason: string }> = [];
        for (const ticker of wanted) {
          try {
            const raw = (await uwGet(
              env,
              "ow_uw_gex",
              `/api/stock/${encodeURIComponent(ticker)}/gex-levels`,
              { source: "vol" },
              ctx,
            )) as Record<string, unknown>;
            const body = (raw.data ?? raw) as Record<string, unknown>;
            levels.push({
              ticker,
              // Untouched, in UW's own words and UW's own types.
              date: body.date,
              asOf: body.time,
              source: body.source,
              callWall: body.call_wall,
              putWall: body.put_wall,
              gammaFlip: body.gamma_flip,
              gammaMagnet: body.gamma_magnet,
              nearbyFlips: body.nearby_flips,
            });
          } catch (error: unknown) {
            // One ticker's outage is not the tool's outage; a fabricated level
            // would be. The absent one is NAMED so the reader can see the gap.
            unavailable.push({
              ticker,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (levels.length === 0) {
          throw new Error(
            `ow_uw_gex: no ticker returned levels — ${unavailable
              .map((entry) => `${entry.ticker}: ${entry.reason}`)
              .join("; ")}`,
          );
        }
        return JSON.stringify({ levels, unavailable });
      },
    },
```

- [ ] **Step 3: test against the frozen live response**

`plugins/option-wizard/tests/tools-uw-gex.spec.ts`:

```ts
/** The real 2026-09-02 SPY response, captured live. Not a shape, the body. */
const SPY_GEX = {
  date: "2026-09-02",
  time: "2026-09-02T17:31:16.000000Z",
  source: "vol",
  call_wall: "766",
  gamma_flip: "764.77",
  gamma_magnet: "766",
  nearby_flips: ["764.77", "765.16", "770.49", "758.3", "771.37"],
  put_wall: "764",
};

it("returns UW's levels verbatim, as strings, with the as-of time", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: URL) => {
    calls.push(url.toString());
    return new Response(JSON.stringify(SPY_GEX), { status: 200 });
  };
  const tool = buildTools({ stateRoot, env: { OW_UW_API_KEY: "k" } })
    .find((t) => t.name === "ow_uw_gex")!;
  const out = JSON.parse(await tool.run({ tickers: ["SPY"] }, { fetchImpl }));
  expect(calls[0]).toBe("https://api.unusualwhales.com/api/stock/SPY/gex-levels?source=vol");
  expect(out.levels[0]).toEqual({
    ticker: "SPY",
    date: "2026-09-02",
    asOf: "2026-09-02T17:31:16.000000Z",
    source: "vol",
    callWall: "766",
    putWall: "764",
    gammaFlip: "764.77",
    gammaMagnet: "766",
    nearbyFlips: ["764.77", "765.16", "770.49", "758.3", "771.37"],
  });
});

it("names the ticker that failed and still returns the one that worked", async () => { … });
it("throws rather than returning an empty level set", async () => { … });
```

Match the fetch-injection style the existing UW tool tests already use (`ToolRunContext.fetchImpl`); if they stub differently, follow theirs rather than introducing a second style.

**Test command:** `pnpm vitest run --project unit plugins/option-wizard/tests/tools-uw-gex.spec.ts`

**Commit:** `feat(option-wizard): ow_uw_gex reads UW gex-levels and quotes them verbatim`

---

### Task 4: `ow_reports`

The tenant reads its own past reports. This is what makes markout and the weekly possible without a database.

**Files:**

- Modify: `plugins/option-wizard/tools/index.ts`
- Test: `plugins/option-wizard/tests/tools-reports.spec.ts` (new)

**Interfaces:**

- Consumes: `cfg.stateRoot` (already a `buildTools` argument), the Task 2 filename.
- Produces: tool `ow_reports`, args `{ phase?: string; days: number }` (`days` max 10), returning `[{ date, phase, text }]` newest first.

- [ ] **Step 1: vocabulary entry** — `["ow_reports", { mutating: false }]`. No `requiresEnv`: the state root is always known, and an empty directory is a real answer, not a misconfiguration.

- [ ] **Step 2: the tool**

```ts
const ReportsParams = z.object({
  phase: z.string().min(1).max(64).optional(),
  days: z.number().int().min(1).max(10),
});

/** `option-wizard-2026-09-02-premarket.md` -> {date, phase}. Anything that does
 *  not match is not one of our reports and is ignored rather than guessed at. */
const REPORT_NAME = /^option-wizard-(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/;
```

```ts
    {
      // Reads what THIS tenant wrote on earlier runs (delivery-markdown,
      // <stateRoot>/reports). It is the only way a later phase can grade
      // an earlier one, and it needs no database: the report file IS the
      // record. `days` is capped at 10 because the whole point of the cap is
      // to keep a markout step from pulling a fortnight of prose into context
      // (doctrine 4).
      name: "ow_reports",
      description:
        "This tenant's own past daily reports, newest first. Filter by phase; `days` bounds how far back to look.",
      paramsSchema: ReportsParams,
      mutating: false,
      dshParams: {
        phase: { type: "string", description: "premarket | intraday | close | weekly | frank" },
        days: { type: "number", description: "How many days back, 1-10." },
      },
      async run(args: Record<string, unknown>): Promise<string> {
        const { phase, days } = ReportsParams.parse(args);
        const dir = join(cfg.stateRoot, "reports");
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          // No directory yet means no report yet — the first ever run of a
          // phase is a legitimate empty answer, not a broken tool.
          return JSON.stringify({ dir, reports: [] });
        }
        const rows = [];
        for (const name of names.sort().reverse()) {
          const match = REPORT_NAME.exec(name);
          if (match === null) continue;
          const [, date, found] = match;
          if (date < cutoff) continue;
          if (phase !== undefined && found !== phase) continue;
          rows.push({ date, phase: found, text: await readFile(join(dir, name), "utf8") });
        }
        return JSON.stringify({ dir, reports: rows });
      },
    },
```

Import `readdir`/`readFile` from `node:fs/promises` and `join` from `node:path` at the top of the file (check which are already imported before adding).

- [ ] **Step 3: test with two real files in a temp dir**

`plugins/option-wizard/tests/tools-reports.spec.ts`:

```ts
const stateRoot = mkdtempSync(join(tmpdir(), "ow-reports-"));
const dir = join(stateRoot, "reports");
mkdirSync(dir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
writeFileSync(join(dir, `option-wizard-${yesterday}-close.md`), "# close\n\n## markout\n");
writeFileSync(join(dir, `option-wizard-${today}-premarket.md`), "# premarket\n\n## 分化\n");

it("returns both reports newest first", …);          // [today/premarket, yesterday/close]
it("filters by phase", …);                            // phase: "close" -> one row
it("ignores a file that is not one of our reports", …); // touch `notes.md`
it("returns an empty list when the directory does not exist", …);
```

**Test command:** `pnpm vitest run --project unit plugins/option-wizard/tests/tools-reports.spec.ts`

**Commit:** `feat(option-wizard): ow_reports lets a later phase read the earlier ones`

---

### Task 5: `ow_frank`

**Files:**

- Modify: `plugins/option-wizard/tools/index.ts`
- Modify: `plugins/option-wizard/tenant.yaml` (`env:` gains `OW_OPENCLI_BIN`)
- Test: `plugins/option-wizard/tests/tools-frank.spec.ts` (new)

**Interfaces:**

- Consumes: `OW_OPENCLI_BIN` (default `opencli`), `cfg.stateRoot`.
- Produces: tool `ow_frank`, no args, returning `{ url, publishedAt, markdown }`.

- [ ] **Step 1: vocabulary entry** — `["ow_frank", { mutating: false }]`. No `requiresEnv`: the binary has a working default, and `requiresEnv` on a key with a default reports a working machine as broken (the comment at `tools/index.ts:34-40` is the precedent).

- [ ] **Step 2: the tool**

```ts
const FRANK_PUBLICATION = "https://franktrading.substack.com";
```

```ts
    {
      // Two opencli calls, verified locally 2026-09-03:
      //   opencli substack publication <url> --limit 1 -f json
      //     -> [{ "title", "url", "publish_time": "2026-08-31T12:37:14.509Z", … }]
      //   opencli web read --url <post url>
      //     -> writes web-articles/<title>/<title>.md under the CWD and prints
      //        a JSON envelope with status: success. 26.6 KB, no paywall cut,
      //        because the Chromium bridge carries the logged-in session — the
      //        mini's login is prepared by the operator, and its absence shows
      //        up here as a short or truncated markdown, never as an invention.
      // CWD is a scratch dir under the state root precisely BECAUSE `web read`
      // writes files where it stands: pointed at the repo it would litter the
      // checkout (doctrine 5 — blast radius is where it runs).
      name: "ow_frank",
      description:
        "Frank's latest Substack note: its url, publish time, and full markdown text.",
      paramsSchema: z.object({}),
      mutating: false,
      dshParams: {},
      async run(): Promise<string> {
        const bin = (env.OW_OPENCLI_BIN ?? "").trim() === "" ? "opencli" : env.OW_OPENCLI_BIN!;
        const cwd = join(cfg.stateRoot, "scratch", "frank");
        await mkdir(cwd, { recursive: true });
        const listArgv = ["substack", "publication", FRANK_PUBLICATION, "--limit", "1", "-f", "json"];
        let listed: string;
        try {
          ({ stdout: listed } = await execFileAsync(bin, listArgv, { cwd, timeout: 120_000 }));
        } catch (error: unknown) {
          throw new Error(
            `ow_frank: ${bin} ${listArgv.join(" ")} failed — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed: unknown = JSON.parse(listed.trim() === "" ? "[]" : listed);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const post = rows[0] as { url?: unknown; publish_time?: unknown; title?: unknown } | undefined;
        if (typeof post?.url !== "string") {
          throw new Error(`ow_frank: no post url in ${bin} substack publication output`);
        }
        const readArgv = ["web", "read", "--url", post.url];
        try {
          await execFileAsync(bin, readArgv, { cwd, timeout: 180_000 });
        } catch (error: unknown) {
          throw new Error(
            `ow_frank: ${bin} ${readArgv.join(" ")} failed — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // `web read` names the directory and the file after the article title,
        // and the exact slugging is opencli's business, not ours — so find the
        // one .md it just wrote rather than reconstructing its name.
        const markdown = await newestMarkdown(join(cwd, "web-articles"));
        if (markdown === undefined) {
          throw new Error(`ow_frank: ${bin} web read wrote no markdown under ${cwd}/web-articles`);
        }
        return JSON.stringify({
          url: post.url,
          publishedAt: typeof post.publish_time === "string" ? post.publish_time : undefined,
          title: typeof post.title === "string" ? post.title : undefined,
          markdown,
        });
      },
    },
```

with the helper beside the other file helpers:

```ts
/** The most recently modified `.md` under `<root>/<dir>/`. Absent root, absent
 *  file and an empty tree are all "no article", reported by the caller as the
 *  failure it is — never as an empty string that reads like a silent Frank. */
async function newestMarkdown(root: string): Promise<string | undefined> {
  let best: { path: string; mtimeMs: number } | undefined;
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return undefined;
  }
  for (const entry of dirs) {
    let names: string[];
    try {
      names = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = join(root, entry, name);
      const info = await stat(path);
      if (best === undefined || info.mtimeMs > best.mtimeMs)
        best = { path, mtimeMs: info.mtimeMs };
    }
  }
  return best === undefined ? undefined : readFile(best.path, "utf8");
}
```

- [ ] **Step 3: `OW_OPENCLI_BIN` in `tenant.yaml`**

```yaml
env:
  - OW_TV_ENABLED
  - OPENCLI_BIN
  # Frank's Substack path. Separate from OPENCLI_BIN so the substack/web reader
  # can be pointed at a different build without disabling TradingView too.
  - OW_OPENCLI_BIN
```

- [ ] **Step 4: test — mock `child_process`, no network**

`plugins/option-wizard/tests/tools-frank.spec.ts`:

```ts
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});
```

Drive the mocked `execFile` callback-style (it is wrapped in `promisify`): the first call returns the listing JSON on stdout, the second writes
`<cwd>/web-articles/08-31-2026-复盘与展望/08-31-2026-复盘与展望.md` and returns empty stdout. Then:

```ts
it("asks opencli for one post and reads it in the scratch cwd", async () => {
  const out = JSON.parse(await tool.run({}));
  expect(calls[0]).toEqual({
    bin: "opencli",
    argv: ["substack", "publication", "https://franktrading.substack.com", "--limit", "1", "-f", "json"],
    cwd: join(stateRoot, "scratch", "frank"),
  });
  expect(calls[1].argv).toEqual(["web", "read", "--url", "https://franktrading.substack.com/p/0831"]);
  expect(out.publishedAt).toBe("2026-08-31T12:37:14.509Z");
  expect(out.markdown).toContain("复盘与展望");
});

it("honours OW_OPENCLI_BIN", …);        // env: { OW_OPENCLI_BIN: "/usr/local/bin/opencli" }
it("throws when web read wrote no markdown", …);
```

The listing fixture uses the real observed post (`publish_time: "2026-08-31T12:37:14.509Z"`, title `08/31/2026 复盘与展望`), per spec §3 and §6.

**Test command:** `pnpm vitest run --project unit plugins/option-wizard/tests/tools-frank.spec.ts`

**Commit:** `feat(option-wizard): ow_frank reads Frank's latest note through opencli`

---

### Task 6: the `as-of-verbatim` output gate

The one bug in §1 that a reader cannot catch: a real number under a timestamp shifted four hours. A gate can catch it mechanically, because the timestamp either appears in a tool output or it does not.

**Files:**

- Modify: `packages/core/src/plugins.ts:116-121` (`GateCtx` gains `toolOutputs`)
- Modify: `packages/cli/src/runner.ts` (collect tool outputs per run; pass them at both `runGates(…, "output", …)` call sites, ~:522 and ~:683)
- Create: `plugins/option-wizard/gates/as-of-verbatim.ts`
- Test: `plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts` (new)

**Interfaces:**

- Consumes: `Gate` / `GateCtx` from `@helium/core` (shape: `plugins/option-wizard/gates/ib-preflight.ts:391-397`).
- Produces: gate id `as-of-verbatim`, `phase: "output"`, `appliesTo: ["regime-analyst", "gex-reporter", "risk-reviewer"]`.

- [ ] **Step 1: `toolOutputs` on the gate context**

`packages/core/src/plugins.ts`:

```ts
export interface GateCtx {
  runId: string;
  role: string;
  /** Remaining budget at the moment the gate runs. */
  remainingUsd?: number;
  /**
   * Everything the tools in this run returned, as raw strings, in order. Core
   * does not read inside them: it is the tenant's gate that decides what "the
   * output must be supported by what a tool said" means for its own domain.
   */
  toolOutputs?: string[];
}
```

- [ ] **Step 2: the runner collects them**

In `runTenant`, beside `const produced = new Map…`:

```ts
/** Raw tool returns, in call order, for gates that check the model's text
 *  against what it was actually given. Strings only — no summarising here,
 *  because a gate comparing against a summary would pass a hallucination
 *  that the summary happened to paraphrase. */
const toolOutputs: string[] = [];
```

At the tool-only step's `outputs.push(\`${name} -> ${value}\`)`(~line 500) add`toolOutputs.push(value);`. In the model path, push each tool span's raw result at the same place the span records `toolOutputBytes`(the model executor's tool results — locate it by`toolName`in the span assembly around lines 640-660 and push the same string it measures). Then add`toolOutputs,`to the ctx object at **both**`runGates(loadedGates.gates, "output", …)` call sites (~:522 and ~:683).

If the model path does not currently keep the tool result string in scope, keep it in a local when the span is built — do not re-run the tool.

- [ ] **Step 3: the gate**

`plugins/option-wizard/gates/as-of-verbatim.ts`:

```ts
/**
 * Every ISO-8601 timestamp in a briefing must be a VERBATIM copy of one a tool
 * returned.
 *
 * The bug this exists for (2026-09-02 intraday): UW returned
 * `2026-09-02T12:45:00-04:00` and $48.67M; the email wrote "+$49M into 16:28
 * ET". The money was right, the clock was four hours wrong — UTC read as ET.
 * A reader who checks the number can never catch that, and no prompt reliably
 * stops it, so it is checked here instead: a timestamp that is not a substring
 * of some tool output was computed, and computing one is exactly the mistake.
 * @module dsh-plugin-tenant-option-wizard/gates/as-of-verbatim
 */
import type { Gate, GateCtx } from "@helium/core";

/** ISO-8601 with an EXPLICIT zone: `…T12:45:00-04:00` or `…T17:31:16Z`.
 *  Fractional seconds optional (UW sends six digits). A bare date carries no
 *  clock to get wrong and is not matched. */
const ISO =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;

function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input !== null && typeof input === "object") {
    const record = input as { text?: unknown };
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

const gate: Gate = {
  id: "as-of-verbatim",
  phase: "output",
  appliesTo: ["regime-analyst", "gex-reporter", "risk-reviewer"],
  async check(
    input: unknown,
    ctx: GateCtx,
  ): Promise<{ pass: boolean; reason: string }> {
    const found = [...new Set(textOf(input).match(ISO) ?? [])];
    if (found.length === 0)
      return { pass: true, reason: "no explicit timestamp to check" };
    const sources = ctx.toolOutputs ?? [];
    if (sources.length === 0) {
      // No tool ran, yet the text carries a zoned timestamp. There was nothing
      // to copy it from, so it was written from the model's own head.
      return {
        pass: false,
        reason: `no tool output in this run, but the text carries ${found.length} timestamp(s): ${found.join(", ")}`,
      };
    }
    const invented = found.filter(
      (stamp) => !sources.some((out) => out.includes(stamp)),
    );
    if (invented.length === 0) {
      return {
        pass: true,
        reason: `${found.length} timestamp(s), each verbatim from a tool output`,
      };
    }
    return {
      pass: false,
      reason:
        `timestamp not found verbatim in any tool output: ${invented.join(", ")} — ` +
        "quote the tool's own string; never convert a timezone",
    };
  },
};

export default gate;
```

- [ ] **Step 4: test**

`plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts`:

```ts
const ctx = { runId: "run-1", role: "regime-analyst" };

it("passes when the timestamp is verbatim in a tool output", async () => {
  const result = await gate.check(
    { text: "tide last print 2026-09-02T12:45:00-04:00, +$48.67M" },
    { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T12:45:00-04:00","net_call_premium":48670000}'] },
  );
  expect(result.pass).toBe(true);
});

it("fails the four-hour shift that shipped on 2026-09-02", async () => {
  const result = await gate.check(
    { text: "tide into 2026-09-02T16:45:00-04:00" },
    { ...ctx, toolOutputs: ['{"timestamp":"2026-09-02T16:45:00Z"}'] },
  );
  expect(result.pass).toBe(false);
  expect(result.reason).toContain("2026-09-02T16:45:00-04:00");
});

it("passes text with no zoned timestamp", …);
it("fails a timestamp when no tool ran at all", …);
```

**Test command:** `pnpm build && pnpm vitest run --project unit plugins/option-wizard/tests/gate-as-of-verbatim.spec.ts packages/cli/tests`

**Commit:** `feat(option-wizard): refuse a timestamp no tool returned`

---

### Task 7: `team.yaml` — seven roles, seven phased tasks — plus the spec edit

**Files:**

- Rewrite: `plugins/option-wizard/team.yaml`
- Modify: `docs/superpowers/specs/2026-09-03-option-wizard-prompt-design.md` (§4 credit row, §8)
- Test: `plugins/option-wizard/tests/team-manifest.spec.ts` (new or extended)

**Interfaces:**

- Consumes: `phases:` (Task 1), `ow_uw_gex` (3), `ow_reports` (4), `ow_frank` (5), the gate (6).
- Produces: the five phases' actual behaviour.

- [ ] **Step 1: the spec edit (do it first, so the prompt is written against a spec that is true)**

In §4, the credit row becomes:

```
| ── 信用 | HYG（ow_spot 可取）；**HY OAS / CCC OAS 本期无工具**，Layer Coverage 里写 `skipped` | premarket、weekly |
```

and the 情景 row's "加息概率" gains `（无工具，skipped）`. In §8, add to the deferred list:

```
- 信用利差（HY / CCC OAS）与加息概率：无数据源，prompt 里显式 `skipped`，不许由模型估 → 子项目 B
```

The contradiction being removed: §4 demanded a number §8 had already deferred, and a required-but-unavailable number is how a model is trained to invent one.

- [ ] **Step 2: the manifest**

Replace `plugins/option-wizard/team.yaml` entirely:

```yaml
manifestVersion: "2"
name: option-wizard
# Source of truth: docs/superpowers/specs/2026-09-03-option-wizard-prompt-design.md.
#
# Five phases, one manifest. A task's `phases:` says which runs it belongs to;
# a task with no `phases:` runs in all of them. No role names a model or a
# vendor — `requires` is the only routing input (doctrine 3).
#
# Two rules bind every prompt below and are repeated in each persona on
# purpose, because a rule stated once in a shared preamble is the one a model
# drops when its context fills:
#   1. Quote a timestamp exactly as the tool returned it. Never convert a
#      timezone. The as-of-verbatim gate refuses the step otherwise.
#   2. No quantity, no position size, no account value. Anywhere.
roles:
  universe-builder:
    requires: []
    permissions:
      mutations: forbidden
      tools: [ow_tv_watchlist, ow_spot, ow_ib_positions]

  gex-reporter:
    requires: [structured.output, tool.use]
    permissions:
      mutations: forbidden
      tools: [ow_uw_gex, ow_argon_metrics, ow_spot]
    persona: >-
      You fill a fixed table and you do not interpret it. For each ticker you
      report: spot, gamma flip, gamma magnet, call wall, put wall, nearby
      flips, and the net GEX / net DEX from ow_argon_metrics with the date that
      tool gives them. Every level is printed as the tool returned it, digit
      for digit — ow_uw_gex hands you strings and they stay strings; do not
      round "764.77" to 765. End the table with one line: `as of <the tool's
      own time string>` for each source, copied character for character. If a
      ticker is in ow_uw_gex's `unavailable` list, write its row as `skipped —
      <reason>`; never fill it from another source.
      GEX DOES NOT GIVE DIRECTION. You write levels and nothing else: no bias,
      no "supportive", no target. Direction is the regime step's job, from tape
      and catalyst.

  markout-clerk:
    requires: [tool.use]
    permissions:
      mutations: forbidden
      tools: [ow_reports, ow_apex_bars, ow_spot]
    persona: >-
      You are a clerk, not an analyst. You read the reports you are given and
      settle every numbered call in them against the real close, one line each,
      in the order they were made. For each: what was proposed, what the
      trigger was, whether the trigger fired, whether the 失效价 was hit, and
      the mark-to-market at today's close. A losing call is written as a loss
      in the same words as a winning one; a call whose trigger never fired is
      `未触发`, which is neither. You never explain, excuse, or re-forecast —
      if a call was wrong, the sentence is "wrong, close X vs 失效价 Y" and
      that is the whole sentence. Quote every date and timestamp exactly as the
      tool returned it.

  regime-analyst:
    requires: [reason.deep, tool.use]
    permissions:
      mutations: forbidden
      tools: [ow_macro_rates, ow_uw_market_state, ow_apex_bars, ow_spot]
    persona: >-
      You state today's regime, in this order and no other:
      (1) 利率是第一因 — 2Y / 10Y absolute level, the bps change, the 2s10s
      shape. Then rank who is hurt by it, by cash-flow duration.
      (2) 今天最大的分化是什么 — one thing, the most ANOMALOUS one, not a list
      of who rose and who fell. Attribute a sector's divergence to the
      expectations bar it faced, not to "景气度".
      (3) 利好落地反而下跌 = 定价权耗尽 — name every beat-and-raise that closed
      down today, that combination is the tag.
      (4) A policy speech is stripped into a reaction function. You do not
      guess the next move.
      Then the Layer Coverage table: one row per layer — rates, credit, tape,
      flow/GEX, events — each with its SOURCE, its AS-OF (the tool's own
      string, copied) and ✓ or `skipped`. The credit layer has NO TOOL in this
      build: its row is `skipped — no HY/CCC OAS source`, and the same for a
      hike probability. Write `skipped`; never estimate one, and never leave a
      layer out of the table — a missing row is how a silent gap reads as
      coverage.
      ow_macro_rates returns a daily `series` that can be days behind next to a
      `liveNow` that is today's: quote the live level for where a number IS and
      the series only for where it has been, and say the lag in the same
      sentence when you cite a `staleSeries` entry.
      You do not propose trades.

  scenario-analyst:
    requires: [reason.deep, long.context]
    permissions:
      mutations: forbidden
      tools: [ow_uw_market_state, ow_macro_rates]
    persona: >-
      For the next dated event you write FOUR mutually exclusive paths A/B/C/D.
      Each path carries its 传导顺序 — what moves first, what moves because of
      it, what moves last. You then name the base case explicitly and give the
      REASON you chose it; a base case without a reason is a coin flip in a
      suit. For each catalyst you write what combination COUNTS AS 证实 and
      what combination counts as 证伪 — a single-point prediction is
      forbidden. Reverse risk gets its own paragraph, never a clause at the end
      of a bullish one. A single-name deep dive is only ever about a
      structural balance-sheet problem; you do not dig into EPS.

  structure-designer:
    requires: [reason.deep, tool.use, structured.output]
    permissions:
      mutations: forbidden
      tools:
        [
          ow_spot,
          ow_uw_chain,
          ow_argon_metrics,
          ow_uw_ticker_metrics,
          ow_apex_bars,
        ]
    persona: >-
      You turn a ticker plus its IV, skew and gamma state plus the regime
      verdict into concrete DEFINED-RISK proposals — legs and the NBBO mid of
      each leg. Every short leg is covered by a long leg of the same right and
      expiry. You never propose a naked short. You propose at most eight.
      Before you name a single strike you call ow_spot on every ticker you
      intend to propose, and every strike you write sits within a sensible
      distance of the price it returns. A strike you did not check against a
      real spot is a made-up number, and one has already shipped: a QQQ 420/410
      spread with QQQ at 707. If ow_spot reports a ticker under `noPrice`, drop
      it and say why in `reason`.
      ow_uw_chain gives you the strikes, NBBO bid/ask, open interest and greeks
      around today's spot. Before the open those quotes are the previous
      session's last NBBO — that is what a premarket quote IS, and it is enough
      to price a defined-risk spread.
      EVERY proposal carries all four of `entryTrigger`, `addLevel`,
      `invalidation` (失效价) and `target`, plus its own exit rule: take profit
      at 50% of max gain, stop at 2x the credit received. A proposal missing
      any of them is not a proposal and must not be emitted.
      Your whole reply is ONE JSON object and nothing else — no prose before
      or after it, no markdown fence:
      {"proposals":[{"ticker","strategy","legs":[{"right":"call"|"put",
      "expiry":"YYYY-MM-DD","strike","action":"buy"|"sell","ratio","mid"}],
      "entryTrigger","addLevel","invalidation","target","rationale"}]}
      `mid` is the NBBO mid you read from ow_uw_chain for that exact strike and
      expiry, per share. Never compute it and never round it: a leg without a
      real `mid` is shown as 未定价, which is correct, whereas a guessed one is
      a made-up price in a trading email.
      There is no size field of any kind and there is no limit price. Position
      size is the reader's, and nothing in this harness knows the account's net
      liquidation value.
      If you cannot produce a proposal, reply {"proposals":[],"reason":"..."}.

  risk-reviewer:
    requires: [reason.deep, long.context]
    permissions:
      mutations: forbidden
      tools: [ow_spot, ow_argon_metrics, ow_ib_positions]
    persona: >-
      You are the adversarial second pass. You keep at most five proposals,
      numbered 1-5, and move the rest to a risk list, naming for each the
      specific reason it was dropped. The risk list is an output in its own
      right.
      Your first check is arithmetic, not judgement: call ow_spot on every
      ticker and drop any proposal whose strikes do not sit near that spot.
      Your second is completeness: drop any proposal missing 失效价, entry
      trigger, add level or target. The preflight gate checks a STRUCTURE, not
      a level, so a strike 40% away passes it and reaches the reader looking
      like a real trade. You are the only thing between the two.
      You close with the 决策块, exactly these eight lines:
      当前判断 / 我的行动 / 进攻程度 / 为什么是现在 / 最大风险 / 失效条件 /
      下一步触发器 / 数据可信度。数据可信度 names the layers that were
      `skipped`.
      Your whole reply is ONE JSON object and nothing else:
      {"proposals":[...kept, same shape you were given...],
       "riskList":[{"ticker","reason"}],"decision":{"判断","行动","进攻程度",
       "为什么现在","最大风险","失效条件","下一步触发器","数据可信度"}}
      If there is nothing to review, reply {"proposals":[],"riskList":[],
      "reason":"..."}.

  weekly-analyst:
    requires: [tool.use, reason.deep, long.context]
    permissions:
      mutations: forbidden
      tools: [ow_reports]
    persona: >-
      You read ONLY this week's five close reports — nothing live, no other
      tool. You write the week: which calls worked, which did not, what the
      week's single largest divergence was, and what next week's A/B/C/D looks
      like with an explicit base case and the reason for it. You settle each of
      the week's numbered calls by name; a week with no losers in it is a week
      you did not read carefully. Every timestamp and price you quote comes out
      of those reports verbatim.

  frank-comparator:
    requires: [tool.use, reason.deep, long.context]
    permissions:
      mutations: forbidden
      tools: [ow_frank, ow_reports]
    persona: >-
      You compare two documents and nothing else: Frank's newest note, and our
      own weekly report from yesterday. Two sections.
      (1) 复盘对照 — his recap of last week against our weekly markout: where
      the two agree, where they disagree, and for each disagreement WHO WAS
      RIGHT, settled with the real prices already in our reports. Not "both
      have a point".
      (2) 展望对照 — his outlook against our Sunday base case: the specific
      claims that are incompatible, and the observable that will separate them.
      You do not adopt his view and you do not defend ours. Quote him with his
      own numbers; quote us with ours.
tasks:
  - id: universe
    role: universe-builder
    phases: [premarket, intraday, close]
    requires: []
    prompt: Merge the TradingView flag lists and the open IB positions into one deduplicated ticker set.

  - id: gex
    role: gex-reporter
    phases: [premarket, intraday, close]
    dependsOn: [universe]
    requires: [structured.output, tool.use]
    prompt: >-
      Fill the GEX table for SPY, QQQ and any ticker in the universe you were
      handed that carries an open position. Levels only, no direction, every
      number and every as-of copied from the tool verbatim.

  - id: markout
    role: markout-clerk
    phases: [close]
    requires: [tool.use]
    prompt: >-
      Call ow_reports with days:2 phase:close for yesterday's close report, and
      ow_reports with days:8 phase:weekly for the latest weekly. Settle every
      numbered call in BOTH against today's close: the daily ones first, then
      the weekly ones. One line per call, no commentary.

  - id: regime
    role: regime-analyst
    phases: [premarket, intraday, close]
    dependsOn: [universe]
    requires: [reason.deep]
    prompt: >-
      State today's regime in the fixed order — rates first, then the single
      most anomalous divergence, then the beat-and-raise-but-down names, then
      the reaction function — and close with the Layer Coverage table. The
      credit layer and any hike probability are `skipped`: there is no tool for
      them in this build, so say so rather than estimating.
      PREMARKET ONLY, and unconditionally: this run is 18:00 Asia/Hong_Kong =
      06:00 US/Eastern. Unusual Whales' market tide is FROZEN outside RTH — the
      tide, flow and tape numbers you get are the PREVIOUS session's, and the
      report must say so in its own sentence, naming the session date the tool
      returned. That is pitfall 07 and it is the exact bug that shipped on
      2026-09-02: a 09-02 yield printed as "live today" next to a 09-01 tide,
      in one paragraph, indistinguishable to the reader.

  - id: scenarios
    role: scenario-analyst
    phases: [premarket, weekly]
    dependsOn: [regime]
    requires: [reason.deep, long.context]
    prompt: >-
      Write A/B/C/D for the next dated event, each with its transmission order,
      then the explicit base case and the reason for it, then the 证实/证伪
      combination for each catalyst, then reverse risk as its own paragraph.

  - id: design
    role: structure-designer
    phases: [premarket, intraday, close]
    dependsOn: [universe, regime]
    requires: [structured.output]
    prompt: >-
      Pick the tickers yourself from the universe you were handed — there is no
      screening step and there is not meant to be one. Propose defined-risk
      structures consistent with the regime verdict, with legs, a real NBBO mid
      per leg, and all four of entry trigger, add level, 失效价 and target.

  - id: review
    role: risk-reviewer
    phases: [premarket, intraday, close]
    dependsOn: [design]
    requires: [long.context]
    prompt: >-
      Keep at most five proposals, numbered. Move the rest to the risk list
      with the reason each was dropped, drop anything missing a 失效价, and end
      with the 决策块.

  - id: weekly
    role: weekly-analyst
    phases: [weekly]
    requires: [tool.use, long.context]
    prompt: >-
      Call ow_reports with days:7 phase:close and write the week from those
      five reports alone. Settle each numbered call by name, then next week's
      A/B/C/D with an explicit base case and its reason.

  - id: frank
    role: frank-comparator
    phases: [frank]
    requires: [tool.use, long.context]
    prompt: >-
      Call ow_frank for his newest note, and ow_reports with days:3
      phase:weekly for ours. Compare his recap against our weekly markout and
      his outlook against our base case; settle each disagreement with the real
      prices already in our reports.
```

Every task carries `phases:`: the daily pipeline runs only in premarket/intraday/close, the weekly and frank phases run one tool-backed task each. (What "daily" means here.

- [ ] **Step 3: manifest test**

`plugins/option-wizard/tests/team-manifest.spec.ts`:

```ts
const manifest = parseTeamYaml(readFileSync("plugins/option-wizard/team.yaml", "utf8"));

it("names no model or vendor", …);                       // doctrine 3
it("never mentions quantity or position size", () => {
  expect(readFileSync(TEAM, "utf8")).not.toMatch(/quantity|position size|net liq(uidation)? value的/i);
});
it("every task's tools exist in the tool VOCABULARY", …);
it("each phase selects a non-empty task set", () => {
  for (const phase of ["premarket", "intraday", "close", "weekly", "frank"]) {
    const chosen = manifest.tasks.filter((t) => t.phases === undefined || t.phases.includes(phase));
    expect(chosen.length).toBeGreaterThan(0);
  }
});
it("close includes markout and weekly does not", …);
```

Adjust the `quantity` regex so it does not trip on the persona sentence that FORBIDS a size field; if that fight is not worth it, assert `not.toMatch(/"quantity"/)` and keep the prose ban to review.

**Test command:** `pnpm vitest run --project unit plugins/option-wizard && pnpm test:contracts`

**Commit:** `feat(option-wizard): five phases of prompt, and the spec no longer demands a number no tool provides`

---

### Task 8: `tenant.yaml`, five plists, the deploy script, and one stale sentence

**Files:**

- Modify: `plugins/option-wizard/tenant.yaml:43-46` (triggers), `:67` (`maxPerDay`)
- Create: `launchd/com.helium.option-wizard-{premarket,intraday,close,weekly,frank}.plist`
- Modify: `scripts/deploy-v2.sh`
- Modify: `AGENTS.md` (the "templates in `launchd/`" sentence)
- Test: `packages/cli/tests/launchd-plists.spec.ts` (new)

- [ ] **Step 1: triggers and the cap**

```yaml
# DECLARATIVE ONLY. Nothing in this repo runs a cron loop: launchd is the
# scheduler and `launchd/com.helium.option-wizard-<phase>.plist` is where the
# time actually lives. These five entries exist so the schedule is readable
# next to the tenant it schedules, and they must be kept in step with the
# plists BY HAND — a drift between the two is invisible until an email is
# missing. Timezone is named, never a UTC offset: HK does not observe DST, but
# writing +08:00 would make that a property of this file instead of the zone.
triggers:
  # 06:00 ET — the US tape is FROZEN at this hour; see the regime prompt.
  - kind: cron
    schedule: "0 18 * * *"
    timezone: Asia/Hong_Kong
    phase: premarket
  # Monday only, 09:00 ET. Frank posts 12:37 UTC = 20:37 HKT, two and a half
  # hours after Monday's premarket, so he cannot ride along with it.
  - kind: cron
    schedule: "0 21 * * 1"
    timezone: Asia/Hong_Kong
    phase: frank
  # 13:00 ET, mid-session: the tape is live here and nowhere else.
  - kind: cron
    schedule: "0 1 * * *"
    timezone: Asia/Hong_Kong
    phase: intraday
  # 16:15 ET, after the close: markout settles against final prints, not
  # estimates. The cost is that the reader sees it next morning.
  - kind: cron
    schedule: "15 4 * * *"
    timezone: Asia/Hong_Kong
    phase: close
  # Sunday 08:00 ET.
  - kind: cron
    schedule: "0 20 * * 0"
    timezone: Asia/Hong_Kong
    phase: weekly
```

`CronTriggerSchema` (`packages/core/src/tenant.ts`) is a `strictObject`, so `phase` must be added there as `phase: z.string().min(1).max(64).optional()` with a comment that core does not act on it — it is documentation of a schedule core does not run. If that reads as core learning a tenant concept, drop the `phase:` key from all five entries and put the phase in the comment above each instead; either is acceptable, the second is smaller.

`maxPerDay: 2` → `5`, with the boundary note the spec §3 already worked out:

```yaml
# Five, because the day now has five runs. The counter is per UTC day
# (delivery-email/src/channel.ts:120 uses toISOString().slice(0,10)), so
# the boundary is 00:00 UTC = 08:00 HKT and phases 1-4 all fall in the
# same UTC day: Monday 4 mails, other weekdays 3, Sunday 1. WHOEVER ADDS
# A SIXTH must first check it does not cross 08:00 HKT.
maxPerDay: 5
```

- [ ] **Step 2: the five plists**

`launchd/` does not exist yet — create it. Each file, e.g. `launchd/com.helium.option-wizard-premarket.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.helium.option-wizard-premarket</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>/Users/moremeds/.config/helium/run-option-wizard.sh</string>
    <string>premarket</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>18</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/moremeds/.helium/logs/option-wizard-premarket.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/moremeds/.helium/logs/option-wizard-premarket.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

The other four differ only in `Label`, the phase argument, the log path, and the calendar:

| file                | Hour | Minute | Weekday      |
| ------------------- | ---- | ------ | ------------ |
| `…-premarket.plist` | 18   | 0      | —            |
| `…-frank.plist`     | 21   | 0      | `1` (Monday) |
| `…-intraday.plist`  | 1    | 0      | —            |
| `…-close.plist`     | 4    | 15     | —            |
| `…-weekly.plist`    | 20   | 0      | `0` (Sunday) |

launchd's `StartCalendarInterval` is in the machine's local time, and the mini's local zone is Asia/Hong_Kong — that is why these are HKT numbers with no zone key: there is no zone key to write.

Copy the existing production `run-option-wizard.sh` from the mini before editing it; the version there must end with the phase passed through:

```zsh
phase="${1:-premarket}"
exec node "$CHECKOUT/packages/cli/lib/cli.js" run option-wizard --phase "$phase"
```

(keep whatever env sourcing and PATH the live script already has; only the last line changes).

- [ ] **Step 3: `deploy-v2.sh`**

```bash
LABELS=(premarket frank intraday close weekly)
KICK_PHASE="${1:-premarket}"
```

after the build and the counter reset:

```bash
say "installing launch agents"
mkdir -p "$HOME/Library/LaunchAgents"
for phase in "${LABELS[@]}"; do
  label="com.helium.option-wizard-$phase"
  src="$CHECKOUT/launchd/$label.plist"
  dst="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 66; }
  # plutil accepts files launchd rejects, so the file is parsed with plistlib
  # too before it is installed. This has already cost a debugging session.
  plutil -lint "$src" >/dev/null
  python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$src"
  cp "$src" "$dst"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
done

# The single old agent is replaced by the five phased ones. Unloading it here
# rather than by hand is what keeps a second scheduler from firing an unphased
# run alongside them.
launchctl bootout "gui/$(id -u)/com.helium.option-wizard" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.helium.option-wizard.plist"

say "kicking com.helium.option-wizard-$KICK_PHASE"
launchctl kickstart -k "gui/$(id -u)/com.helium.option-wizard-$KICK_PHASE"
```

The re-exec at the top passes the argument through: `HELIUM_REMOTE=1 bash -s -- "$KICK_PHASE"`, with `KICK_PHASE="${1:-premarket}"` read on the laptop side too.

- [ ] **Step 4: the plist test**

`packages/cli/tests/launchd-plists.spec.ts`:

```ts
// plutil -lint accepts plists launchd then rejects, so this parses with
// plistlib — the same parser the loader effectively is — and asserts the keys
// that actually decide whether the job runs.
const PHASES = {
  premarket: { Hour: 18, Minute: 0 },
  frank: { Hour: 21, Minute: 0, Weekday: 1 },
  intraday: { Hour: 1, Minute: 0 },
  close: { Hour: 4, Minute: 15 },
  weekly: { Hour: 20, Minute: 0, Weekday: 0 },
} as const;

for (const [phase, calendar] of Object.entries(PHASES)) {
  it(`${phase} plist parses and schedules ${JSON.stringify(calendar)}`, () => {
    const path = `launchd/com.helium.option-wizard-${phase}.plist`;
    const json = execFileSync("python3", [
      "-c",
      "import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))",
      path,
    ]).toString();
    const plist = JSON.parse(json);
    expect(plist.Label).toBe(`com.helium.option-wizard-${phase}`);
    expect(plist.StartCalendarInterval).toEqual(calendar);
    expect(plist.ProgramArguments.slice(0, 1)).toEqual(["/bin/zsh"]);
    expect(plist.ProgramArguments.at(-1)).toBe(phase);
  });
}
```

- [ ] **Step 5: the stale sentence in `AGENTS.md`**

Under "Release and ops", `Production is the Mac mini (macmini, user moremeds), driven by templates in launchd/.` was true of a directory that did not exist. It does now, so make the sentence say what is in it:

```
Production is the Mac mini (`macmini`, user `moremeds`). `launchd/` holds the
five `com.helium.option-wizard-<phase>.plist` agents `scripts/deploy-v2.sh`
installs; each runs `~/.config/helium/run-option-wizard.sh <phase>`, and the
phase is the only difference between them.
```

**Test command:** `pnpm vitest run --project unit packages/cli/tests/launchd-plists.spec.ts && bash -n scripts/deploy-v2.sh`

**Commit:** `feat(ops): five phased launch agents, and a deploy that installs them`

---

### Task 9: local preview of all five phases + evidence

Nothing here changes code. It is the check that the previous eight tasks produce five different, readable reports on a laptop, with no email leaving the machine.

- [ ] **Step 1: run each phase, delivery brake OFF**

```bash
pnpm build
export HELIUM_STATE_ROOT="$PWD/.helium-state"
unset HELIUM_TENANT_DELIVERY        # markdown only; nothing is emailed
for p in premarket intraday close weekly frank; do
  node packages/cli/lib/cli.js run option-wizard --phase "$p"
done
ls -1 "$HELIUM_STATE_ROOT/reports/"
```

- [ ] **Step 2: the evidence checklist** — record the answers in the PR body, each with the command that produced it:

1. Five files named `option-wizard-<today>-<phase>.md`, one per phase.
2. `premarket` contains: the frozen-tape sentence naming the previous session date, the Layer Coverage table with credit `skipped`, the single-divergence paragraph, A/B/C/D with a base case and its reason, the GEX table, numbered proposals each with 失效价, and the 决策块.
3. `close` contains a markout section settling yesterday's close calls and the weekly's calls; `premarket` does **not**.
4. `weekly` cites only close reports; `frank` cites Frank's note and our weekly.
5. `grep -ci quantity plugins/option-wizard/team.yaml` shows no size field.
6. Every ISO timestamp in each report appears in that run's audit tool spans: `helium audit <run-id> | grep -F "<timestamp>"`.
7. The as-of gate refused nothing — or, if it did, the refusal is quoted and the offending timestamp explained.
8. `pnpm typecheck && pnpm test && pnpm test:contracts` all green, pasted.

A phase whose report is empty because no provider was live is a **degraded** result, not a pass: say so explicitly rather than counting the file.

**Commit:** `test(option-wizard): five-phase local preview evidence` (only if a fixture or a doc changed; otherwise no commit)

---

### Task 10: mini deploy and one real premarket run

**Do not start this task without the user's explicit go-ahead, and never during an active acceptance window.** The operator prepares the opencli login on the mini first (`ow_frank` needs the Chromium bridge session, spec §6).

- [ ] **Step 1:** confirm with the user that the window is open and the opencli login is done.
- [ ] **Step 2:** `scripts/deploy-v2.sh premarket` from the laptop. Read its printed `PATH=` line before believing any "MISSING" it reports.
- [ ] **Step 3:** `ssh macmini launchctl list | grep option-wizard` — expect five labels and no bare `com.helium.option-wizard`.
- [ ] **Step 4:** read the delivered premarket email. It is acceptable when a human can read it end to end without opening the repo: no run id, no token count, no `toolsUnconfigured`, no timestamp that the audit table cannot produce verbatim.
- [ ] **Step 5:** record the outcome in the PR before merging.

**Commit:** none. Deployment is not a commit.

---

## Acceptance criteria

1. `pnpm typecheck`, `pnpm test` and `pnpm test:contracts` are green. **`contracts/tests/core-neutrality.contract.spec.ts` still passes** — `phase`, `phases` and `toolOutputs` are generic; no domain or vendor word entered `packages/core/src`.
2. A local run of each of the five phases writes `<stateRoot>/reports/option-wizard-<date>-<phase>.md`, five distinct files, and a rerun of one phase overwrites that one file only.
3. The email subject is `[option-wizard] <phase> <date>`.
4. The `as-of-verbatim` gate test passes both ways: `2026-09-02T12:45:00-04:00` passes when a tool output contains it, and fails when the only tool output holds `2026-09-02T16:45:00Z`.
5. `ow_uw_gex` returns the frozen 2026-09-02 SPY fields verbatim as strings, and calls exactly `https://api.unusualwhales.com/api/stock/SPY/gex-levels?source=vol`.
6. `ow_reports` returns two fixture reports newest first and filters by phase; `ow_frank`'s test asserts both opencli argv vectors and touches no network.
7. `plugins/option-wizard/team.yaml` contains no `quantity` and no position-size field; every proposal path requires 失效价.
8. All five plists parse under `python3 -c 'import plistlib'` with the scheduled `Hour`/`Minute`/`Weekday` above, and each passes its phase as the last `ProgramArguments` entry.
9. `tenant.yaml` has `maxPerDay: 5` and five documented triggers.
10. **One PR for all of it** — code, tests, plists, deploy script, spec edit and the `AGENTS.md` line. No `Co-Authored-By` trailer. Task 10 runs only after the user's go-ahead, and its result is recorded in the PR before merge.
