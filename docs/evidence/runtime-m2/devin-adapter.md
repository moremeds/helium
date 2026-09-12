# Task 2 — opt-in Devin evaluation adapter

Status: adapter delivered, verified offline end-to-end, exercised live twice
under the documented isolation configuration. This is a controlled evaluation
seam only — not a production provider route and not M2 acceptance.

Private evidence root: `tmp/herd-m2/task2/` (absolute paths live only in the
private manifest; public references below use `task2/...` IDs). Full SHA-256
manifest: `task2/evidence-manifest.json` (see bottom of this file).

## What was built

`plugins/provider-devin-subscription/` — an evaluation-only package:

- `src/acp.ts` — stdlib NDJSON JSON-RPC client over `devin acp` stdio.
  `initialize` advertises no fs/terminal capabilities; `session/new` passes
  `mcpServers: []`; `session/prompt`, `session/cancel`, bounded `open()`/
  `close()`. Raw stdout/stderr chunks reach the caller as `Buffer` before any
  decoding; a `StringDecoder` feeds the line parser so multibyte splits are
  safe; the decoder tail flushes on `close` (after pipe drain, not `exit`);
  a spawn `error` settles every pending request so `open()` cannot hang.
- `src/evaluation.ts` — `createDevinEvaluation({outputDir, model, env, limits})`,
  the exact shape `runtime-evaluate` dynamic-imports from `lib/evaluation.js`.
  `Provider.run` wraps the role prompt in a fixed JSON envelope
  (`{"final":...}` / `{"tool_calls":[...]}`), offers only the role's declared
  tools, executes calls host-side via `provider-sdk` `runToolCall` +
  `toolCallEvents`, and feeds results back as the next prompt body. The agent
  has no tools of its own — no shell/MCP/fs access is delegated to Devin.
- `src/acp.test.ts`, `src/evaluation.test.ts` — 20 offline checks against a
  stub stdio child (no network).

No `lib/provider.js` export exists — nothing can enter normal provider
discovery or routing. `packages/cli` source is untouched; the existing
`RuntimeInference` seam needed no changes.

## Limits actually enforced

`{maxRequests, timeoutMs, maxRequestBytes}` — positive safe integers, all
checked before the first dispatch. `session/prompt` dispatches, wall-clock
deadline, and outbound body size are the only things ACP lets this transport
bound, so any other limit field (e.g. `maxOutputTokens`) is rejected as an
unknown field rather than silently unenforced. There is no USD ceiling —
the route is `unmetered` subscription and no fabricated price is reported.

Every `session/prompt` is reserved with an UNKNOWN `request-N.json` written
synchronously before the frame goes on the wire; a `request-N-response.json`
records the outcome. Timeout, abort, missing usage, lost terminal response,
malformed envelope, trailing output, and write failure all stop the run and
leave the trial UNKNOWN (a post-dispatch failure marks the trial UNKNOWN even
when per-request usage arrived — an incomplete run is not a clean
measurement). No retries, no overwrites (`wx` + append-only streams).

## Isolation: proven and remaining

The child environment is an allowlist (~20 names incl. the proxy vars this
machine needs; `process.env` is never spread). Scratch `XDG_CONFIG_HOME` and
`CHISEL_SESSION_DB` point inside the evidence dir; the session cwd is a fresh
`/private/tmp/helium-devin-m2-*` outside repository ancestors. The written
`devin/config.json` sets every `read_config_from` importer to `false` plus
`subagents_enabled: false`.

Preflight evidence (`task2/preflight/`, `task2/preflight-2/` —
initialize/session-new only, zero prompts) on the server log and wire:

- `rules discovery ... loaded=0`; hooks `loaded=0`; `plugins discovery:
  active_plugins=0 skills=0 hooks=0 rules=0 mcp_servers=0 agents=0`.
- `mcp/serversChanged` notifications carry empty params; no MCP connection
  output; no fs/terminal requests from the agent side.
- Assembled context for the prompted sessions (`export-message_nodes` under
  `task2/probe-b/` and `task2/probe-c/`) contains **no** `<rules>` block —
  the ~31KB ambient import observed in task 1 is gone; input tokens fell
  from 8,892 to ~1,500.

Residual ambient surface (honest limitation): `system_info`, the Summarizer
preamble, an "Available subagent profiles" block, and `<available_skills>`
remain injected. The skills block lists the operator's global
`~/.agents/skills` inventory (~3.6KB including absolute source paths) and the
subagent block persists even with `subagents_enabled: false` — there is no
documented config key covering devin's own global skill dirs, and `HOME` was
not overridden. These blocks are passive context the no-tools agent cannot
invoke; they are non-frozen inputs and are disclosed, not hidden.

## Live evidence (2 dispatches = the task-2 budget)

- `task2/probe-a/` — interrupted during initialize/authenticate; reconciled
  in `RECONCILIATION.md`: zero `session/prompt` dispatched, zero budget spent.
- `task2/probe-b/` — session `superb-lemon`, completed run: envelope
  `{"final":"PROBE_OK"}` → text `PROBE_OK`, usage `{in:1500, out:159}`.
  Reported usage equals `num_tokens_preceding` recorded in the session store.
- `task2/probe-c/` — session `proud-part`, bounded tool-loop check with
  `maxRequests: 1`: the model emitted
  `{"tool_calls":[{"name":"helium.probe-token",...}]}`, the host executed the
  tool once, and the second dispatch was stopped by the limit; the trial is
  UNKNOWN by design (`failure-4.json`). Host-loop completion across two turns
  is proven by the offline stub tests, not claimed from this probe.

## Identity honesty

- Requested model: `swe-2-max` (argv `--model`), recorded in every request
  artifact and the summary's `requestedModel`.
- Session-recorded model column: `swe-2-high` in both prompted sessions —
  `--model` does not pin the summarizer's recorded configuration. This is
  reported configuration, **not** an independently verified serving revision.
- Wire `responseDimensions` label: `Summarizer` — an agent-type display label,
  recorded separately in `reportedModelLabels`.
- `identityGrade` is `ROUTE_ONLY`, matching the existing seam.

## Accounting honesty

Usage is invocation-level ACP-reported token totals (unit `ACP_INVOCATION`).
It is not proof that internal upstream HTTP attempts were individually
metered — those remain outside visibility.

## Offline checks run

- `vitest run --project unit plugins/provider-devin-subscription` — 20/20
  (split-UTF-8 byte preservation, trailing-after-exit capture, spawn-error
  rejection, hung-initialize timeout + killable child, wedged-child SIGKILL,
  fs/permission refusal; envelope round-trip, one host tool round, unoffered-
  call rejection, missing-usage/timeout/abort/malformed UNKNOWN, tail
  retention, no artifact reuse, limit validation, model-id refusal,
  capability-shortage before dispatch, PATH-scoped probe).
- `pnpm -F @helium/provider-devin-subscription build` — clean.
- `vitest run --project unit packages/cli` — 145 passed, 1 skipped
  (`runtime-pilot.spec.ts` is gated behind `HELIUM_RUNTIME_PG_TEST=1`,
  unchanged); `runtime-pilot.ts` remains model-free — it only knows the
  `RuntimeInference` interface.

## Known gaps / not claimed

- No A/A, A/B, or quality claim: these were transport probes on synthetic
  inputs, not report-quality runs.
- The two-turn tool loop's second dispatch was intentionally not spent live;
  it is stub-proven. A live multi-turn loop is a later-task decision.
- Actual serving revision: unknown by construction (reported `swe-2-high`,
  requested `swe-2-max`; no pin verified).
- `overheadTokens` is 0 as a router-input placeholder; the measured preamble
  (~1.4–1.5K input tokens before our text) is visible in the probe usage but
  not yet folded back into the constant — a proposal, not measured-truth
  plumbing.
- The residual skills/subagent context blocks cannot be disabled via
  documented config without touching `HOME`; recorded as a limitation.

## Evidence manifest

`task2/evidence-manifest.json` holds full SHA-256 digests for every retained
file (217 entries). Manifest file's own SHA-256:
`0474ba56402285f606e14b4439fdaa80fabdfb8fd2b21b556ef868a72773a75b`.
