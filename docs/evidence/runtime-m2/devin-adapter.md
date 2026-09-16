# Task 2 — opt-in Devin evaluation adapter

The original task-2 account below is retained. The appended 2026-09-13 repair record supersedes its Max-route, UNKNOWN classification, and isolation conclusions; see [current M2 status](execution-status.md).

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


## Provider repair — 2026-09-13 (supersedes the affected claims above)

The original task-2 account and artifacts above remain historical evidence.
The following corrections describe the repaired adapter; they do not upgrade
any original probe into final-tree validation or establish M2 quality.

- **FAILED versus UNKNOWN:** a malformed generation or a request-budget stop
  before the next dispatch is FAILED when all dispatched calls have settled
  responses and usage. The old outer catch incorrectly changed every
  post-dispatch failure to UNKNOWN. That overwrite is removed. Missing usage,
  ambiguous dispatch, timeout, cancellation and persistence failure still
  preserve UNKNOWN and stop continuation. Probe C's original UNKNOWN artifact
  is retained; its fully accounted budget stop is the regression being fixed.
- **High-only route:** `swe-2-max` is rejected. `swe-2-high` advertises
  `reason.deep` as a routing capability: [Cognition's SWE-2 model behavior](https://cognition.com/blog/swe-2)
  identifies High as a reasoning tier for complex planning and verification;
  the installed CLI catalog reports 262K context. Existing tenant role
  requirements are unchanged. Host tool use and JSON output are exercised
  below. None of these facts proves tenant answer quality.
- **Native isolation:** macOS `sandbox-exec` denies reads of the observed
  global agents skill directory, with HOME unchanged and scratch XDG config
  and session database. The native profile supplements the existing disabled
  importers, empty MCP selection and no-tools Summarizer. Unsupported native
  environments fail clearly; there is no unsandboxed default fallback.
  The launch artifact records argv and environment key names before spawn.

### New finite synthetic batch: two calls, both accounted

Logical evidence root: `provider-repair/` under the private M2 evidence root.
`preflight-1/` used initialization and session creation only: zero prompts,
zero imported rules/plugins/hooks/MCP, three builtin skills and zero user
skills. The original task-2 preflight loaded eight user skills; the native
profile is retained because it removes that observed input leak.

`probe-1/` then completed a real host-tool round trip in session
`humane-sailor`: one host tool execution, followed by final `TOKEN_7F3A`.
The new batch spent exactly **2 of 2 ACP invocations**, no retries:

| Invocation | Input tokens | Output tokens | Recorded state |
| --- | ---: | ---: | --- |
| Host tool request | 933 | 82 | RECORDED |
| Final answer | 1044 | 39 | RECORDED |
| Total | 1977 | 121 | Known; `unknown=false` |

User payload was bounded below 512 bytes; each invocation had a 120-second
latency bound, with a finite overall 240-second driver bound. The entire run
completed in 9.7 seconds. Requested model and session-recorded model are both
`swe-2-high`; the wire label remains `Summarizer`. Identity is still
**ROUTE_ONLY**, with no independently verified serving revision.

The exact session export contains only three builtin skill entries and the
builtin `subagent_explore`/`subagent_general` descriptions. No operator skill
inventory was imported. Intrinsic Summarizer instructions and `system_info`
remain; the preamble mentions rules tags as formatting instructions, which
must not be mistaken for imported user rules. No fs/terminal request or MCP
connection was observed. This proves the tested CLI session's input isolation,
not a universal guarantee about future CLI changes.

### Reproducibility and checks

Before dispatch, `predispatch-build-1/` copied 128 source/build files, including
all runnable core, provider-sdk and adapter JavaScript. Manifest SHA-256:
`18f34031b2fa4f582b5487c106d9afde8c36e6921d1e430f081f5f0c97a1970c`.
Post-probe hashes match. Exact requests, raw stdout/stderr bytes, session DB
and exports, command outputs, errors and exit codes are retained separately
from original task-2 evidence. `provider-repair/evidence-manifest-1.json`
contains 279 file entries; its SHA-256 is
`3aa4fc55c60f0b00a87bec9f2e87551724917bc1d6de53a32c0059235a490dc0`.

Provider offline suite: **22 passed**. Provider build: passed. The existing
runtime-pilot mechanism test was also run with its scratch PostgreSQL gate
enabled: **1 passed**, no live model. Initial missing-build failures and the
initial gated skip remain in the evidence; required workspace artifacts were
built before the passing run. Self-review and native-isolation ablation are
recorded in `provider-repair/review-1.md`. ACP byte capture, process drain and
bounded cancellation behavior remain covered by the existing tests.

No production route, dependency, core/CLI/campaign change, deployment, tenant
quality claim or scientific M2 acceptance is included. Router overhead stays
an uncalibrated zero placeholder; observed ACP usage is authoritative. The
new two-call development budget is exhausted and no further probe is implied.


### Lead transport review after the synthetic batch

Subsequent lifecycle corrections are **offline verified only**; no further
live call was made. The preceding live results and matching post-probe hashes
refer specifically to `predispatch-build-1`, not this later source revision.

- Decoder tail flush now appends the unfinished UTF-8 decoder bytes after
  already buffered text, preserving their original order.
- Child errors and stdin EPIPE fail pending requests promptly while raw-byte
  capture remains active until actual process close. An error event does not
  itself claim drained pipes.
- `close()` now returns whether close was observed. Every adapter run records
  that result in `close-N.json`; an unconfirmed close marks UNKNOWN and blocks
  continuation even if the completed invocation supplied known usage.

Final provider build passed; **26 offline tests passed**, including four new
lifecycle regressions. The scratch-PostgreSQL pilot mechanism passed earlier
and was not changed by these transport-only fixes. Final source/build copies
are in `post-review-build-1/`; they have zero live dispatches. Review notes are
`review-2.md`. The expanded immutable evidence manifest is
`provider-repair/evidence-manifest-2.json` (308 entries), SHA-256:
`b5839fc6bfdac289bce27e237afb77d5b3d452cf69c674f0db984b952527a298`.


### Concentrated review follow-up: final disposition and trust boundary

The native profile neutralizes the observed configuration/skill imports. It
is **not a sandbox for an untrusted or malicious provider binary**: the
installed Devin CLI and its authentication implementation remain trusted,
HOME is unchanged, and the CLI can read its existing credentials. The agent
receives no fs, terminal or MCP capability. Credentials were not copied and
HOME was not replaced. Unnecessary `SSH_AUTH_SOCK` inheritance is now removed.

`close-N.json` records the final classified state and references any earlier
failure artifact. If a known FAILED run cannot confirm direct-child close,
its original failure bytes remain unchanged and the close disposition records
UNKNOWN with `child-close-unconfirmed`; the latest summary also stays UNKNOWN.
This prevents the earlier known-failure snapshot from being mistaken for the
final disposition.

Close confirmation means the spawned process emitted close and its observed
pipes drained. The adapter signals that direct child; termination of an
arbitrary descendant process tree has **not** been independently proved.
There is no process-group or general descendant kill guarantee.

This follow-up made zero live calls. Build passed and **27 offline tests
passed**, including known FAILED bytes preserved before an undrained final
UNKNOWN and explicit SSH-agent exclusion. Evidence:
`provider-repair/grok-followup-1/manifest.json`, SHA-256
`144f7d478f5225939c130aa21ea5617b8d06809f448b6d5704098b235603c929`.
