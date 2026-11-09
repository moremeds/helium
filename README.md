# Helium

Helium is a multipurpose, multi-agent harness that improves itself.

**Status: v3 — Helium is a DeepSeek Harness (DSH) distribution.** It is a DSH
profile (`helium`) plus bundles. DSH supplies sessions, subagents, tools,
the sandbox and the model routes; Helium adds a runner, the token audit, a
decision ledger, point-in-time enforcement and delivery. Plan of record:
`docs/plans/2026-11-08-helium-v3-dsh-distribution.md`. Stage 1 (this tree) is
the framework; product bundles are rebuilt in stage 2.

## Layout

- `bundles/helium-base` — the distribution layer, no business words:
  - `runner` — `dsh --profile helium run <pipeline> [--phase P] [--as-of D] [--timeout S]` and `audit <run>`
  - `run.agent({role, capability, prompt, schema})` — one child agent; the role is
    an agent preset that lists exactly its tools; the capability picks the model
    (`reason.quick` = Sonnet, `reason.deep` = Opus)
  - `spans` table — one row per model step: model, tokens in/out/cache, context, wall time, cost
  - `ledger` — `run.enter(key, due, payload)`; the pipeline's `settle` runs on due entries at the next run
  - `withAsOf` — tools get the run's as-of day from the framework; model-supplied dates are clamped to it
  - delivery — markdown, email (Resend), argon; each pipeline declares its channels and nothing else is allowed
- `bundles/smoke` — acceptance bundle on simulated data; its composition test boots the real `dsh` with a fake LLM
- `scripts/install-profile.sh` — install or re-point the `helium` profile at this checkout
- `scripts/helium` — `dsh --profile helium` with this checkout's `dsh`

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test            # unit
pnpm test:compose    # real dsh + fake LLM, throwaway $DSH_HOME
scripts/install-profile.sh && scripts/helium run smoke --phase close   # real Claude
scripts/helium audit <run-id>
```

State (SQLite db and reports) lives in `$HELIUM_STATE_ROOT`, default
`$DSH_HOME/helium`. Claude is reached through pi-ai with
`CLAUDE_CODE_OAUTH_TOKEN`; set `HELIUM_PROXY` where Anthropic is only reachable
through a proxy.

## Adding a product

A new directory `bundles/<name>/` with `package.json` (`dsh.bundle.patch`),
a `cordis.patch.yml` that inserts one agent preset per role and a plugin row
whose `apply` calls `definePipeline({name, channels, settle?, run})`.
Then `pnpm build && scripts/install-profile.sh`.
