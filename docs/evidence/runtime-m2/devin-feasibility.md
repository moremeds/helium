# Devin M2 inference-seam feasibility — Task 1 evidence

2026-09-12. Baseline: `b632dba6393ec98b59f0aadfd391b49a5a554221`.
This is **transport feasibility only**: not A/A, not report-quality, not M2
acceptance. At most two tiny synthetic probe requests were authorized; one
dispatched, one was interrupted before dispatch. Raw prompts, wire frames,
stderr, timing, usage and errors are retained privately and unmodified as
logical evidence IDs `task1/...`; the ID→path map is private
(`task1/evidence-map.json`), and the complete untruncated SHA-256 manifest is
`task1/evidence-manifest.json`, itself SHA-256
`3e43fc3b3e1c7e0ca5f1cf8b3e6a9686124e9003769e4e00dadb3d5fec902def`.
No secrets and no host paths appear in this file.

## Interface inventory (documented surface, installed `devin 3000.10.21`)

- `devin acp` runs a documented **Agent Client Protocol server over stdio**
  (NDJSON JSON-RPC): `initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/cancel`, `session/update` notifications.
  `--agent-type summarizer` is a documented agent with **no tools**;
  `--model` sets the default model per session (`DEVIN_MODEL` also honored).
- `devin -p` + `--export` writes ATIF transcripts; `devin models list
  --format json` is a read-only model inventory (48 families with
  `model_uid`, context/output limits, price strings).
- The permissions config supports tool-based `deny` of
  `read/edit/grep/glob/exec`, `Fetch()` URL rules, `mcp__*` rules;
  `--sandbox` (macOS seatbelt) exists for exec processes.
  `XDG_CONFIG_HOME` redirection is honored (observed: the `initialize`
  response's `_meta.mcpConfigPath` pointed at the scratch dir and the CLI
  wrote a migrated config there).

## Probe 1 — dispatched, completed (off-target model; feasibility-only)

`devin acp --agent-type summarizer --model gpt-5-6-luna-none`, scratch cwd,
`mcpServers: []`, minimal client capabilities (fs/terminal off). Session id
`visual-bronze`. Evidence IDs: `task1/probe-1-*`.

Observed on the wire (`task1/probe-1-wire.ndjson`, 126 parsed frames):

- `session/prompt` returned `stopReason: end_turn` with reported usage
  `{inputTokens 8892, outputTokens 102, totalTokens 8994, cachedReadTokens 495}`
  and a `cognition.ai/userMessageId`; agent text was `PROBE_OK`.
- `usage_update` notifications and `_cognition.ai/agent_stopped` carry
  `requestId`, `ttftMs`, `totalTimeMs`, `toolCalls: 0`; `turn_stats` carries a
  per-turn `Model` display field (value `Summarizer`).
- Auth: `authenticate {methodId: devin-browser}` succeeded against stored CLI
  credentials (server stderr: falls back to stored credentials; PKCE
  success) — no interactive prompt.
- Session-recorded context: the local session store's per-session message
  rows contained the assembled input (system prompts incl. the Summarizer
  "you have no tools" instruction, injected always-on rules, environment
  block) and the user prompt; the output text was persisted by a post-agent
  step to the documented summaries path. These source records were exported
  for exactly this session into `task1/exports/visual-bronze-*` so mutable
  local stores cannot lose them.
- Isolation: **zero tool calls** appeared on the wire; fs/terminal delegation
  was refused at the capability level (the client advertised neither).

Accuracy notes (limits of this evidence):

- The wire log records every **parsed** NDJSON frame; byte-completeness of a
  truncated trailing stdout line was not captured for probe 1 (the tail-flush
  exists only in the probe-2 client), so "every byte" is unproven.
- The reported usage is **invocation-level** accounting the ACP server
  returned for the prompt call. It is not proof that every internal upstream
  HTTP attempt was recorded — internal retries, if any, are not visible at
  this layer.

## Limitations — measured, not assumed

1. **Model pinning on the summarizer agent is disproven as observed.**
   Requested `gpt-5-6-luna-none`; the session's recorded `model` field was
   `swe-2-high`. That field is the session's *recorded configuration* — it
   shows the request did not take effect, but it is not independent
   verification of which serving revision actually produced the tokens.
   Requested vs session-recorded identity can both be retained (Codex-style
   `ROUTE_ONLY` grade); whether `--model swe-2-max` pins on this agent type
   is **UNVERIFIED** (probe 2 never dispatched).
2. **Ambient context injection is real.** Reported input was 8892 tokens for
   a ~110-token prompt; the session-recorded input includes ~31KB of imported
   always-on rules (`read_config_from` pulls another agent tool's global
   rules file) plus environment context. `XDG_CONFIG_HOME` redirection did
   **not** prevent it. An ambient MCP server entry (imported config) was
   discovered and a connection attempted; it failed, and the summarizer has
   no tools to use it regardless. Whether the documented config keys fully
   neutralize this is **unproven** — it is a Task 2 proposal, not a measured
   result.
3. `devin acp` has no `--config` flag; isolation would have to come from env
   (`XDG_CONFIG_HOME`; `XDG_DATA_HOME` effect unverified) plus the config's
   own `read_config_from`/permission keys.
4. `session/cancel` is documented but unexercised; deadline kill is
   process-level. `agent_stopped.cause` distinguishes `complete`;
   refusal/cancel/error causes are unexercised.
5. ACP sessions produced no ATIF transcript file here; session state lives in
   the local session DB rows (exported) plus the summaries path.

## Probe 2 — interrupted before dispatch, reconciled

`swe-2-max` pin attempt. `initialize` and `authenticate` completed (server
log: PKCE success); `session/new` and `session/prompt` were **never sent**;
the child process is gone and no probe-2 session row exists. **Zero model
requests dispatched — measured on the wire log, not estimated.** No retry was
performed; the run was stopped on the lead's safety correction (probe-1
evidence showed ambient MCP attempts under the same isolation approach).
Evidence IDs: `task1/probe-2/*` incl. `RECONCILIATION.md`.

## herd.toml worker args — verified against launched commands

- devin workers: `args = ["--permission-mode", "accept-edits"]` — live process
  list shows `devin --permission-mode accept-edits` for both devin workers;
  the flag is documented.
- cursor reviewer: `args = ["--force", "--model", "cursor-grok-4.6-high"]` —
  `cursor-agent --help` documents `-f/--force` and `--model`; the specific
  model id was not verified (no cursor invocation made).
- `helium-m2-analysis` (devin) added from the root roster, same verified flags.

## Mode observation (reported as asked; provenance UNKNOWN)

This worker's launch arg was `--permission-mode accept-edits`
(process-verified), yet the session store records `agent_mode: bypass` for
this and two sibling agent sessions and the pane shows "(bypass permissions
on)". No `/bypass` or `/mode` input exists in this session's prompt history;
this worker made no permission changes. The enabling mechanism is
**UNKNOWN**.

## Request-artifact history (disclosure)

`task1/request-probe-1.json` was created with a placeholder `createdAt`, then
reformatted once (`json.dump` + real timestamp) **before** the probe
dispatched — the executed run matches the rewritten content field-for-field.
The pre-rewrite bytes were later recovered from the originating worker's
retained write payload (see recovery below). This history is recorded in
`task1/correction-1.md` and corrected for ordering in
`task1/correction-2.md`.

### Original-write recovery

The lead's independent retention check recovered identical original write
payloads from two originating session nodes. The original file is 3,249 bytes,
SHA-256 `6af0c9669b595d1e96c551daf1e96e7205ba726ff7f305612cbc641c14b266f6`.
Private evidence IDs: `task1-original-write-recovery/request-probe-1.original.json`
and `task1-original-write-recovery/provenance.json`. These are additional
artifacts; neither the sent request nor the original manifest was replaced.

## Feasibility verdict

The smallest viable Devin seam is `devin acp --agent-type summarizer` driven
by a stdio ACP client we own. **Proven:** the documented protocol works
headless; per-invocation usage accounting, request ids, streamed output text,
session-recorded assembled input, and structural no-tool isolation were all
observed. **Not proven:** model pinning on this agent type (negative evidence
for a non-default model; `swe-2-max` untested), byte-level stdout-tail
completeness for probe 1, coverage of internal upstream attempts inside the
reported usage, and ambient-context/MCP neutralization — that last item is a
proposed config change awaiting verification, not an established control.

## Task 2 minimal proposal (not implemented here)

- `plugins/provider-devin-subscription/{provider.ts,invoke.ts,catalog.ts,evaluation.ts}`:
  Provider over `devin acp` mirroring the Codex adapter — an observer around
  each `session/prompt` frame giving reserve-before-dispatch UNKNOWN records
  and usage-backed completion; `catalog.ts` lists `swe-2-*` UIDs from the
  read-only model inventory. `maxOutputTokens` is not enforceable over ACP —
  declare it unenforced rather than claim a bound.
- Isolation fix to verify first (proposal, unproven): scratch
  `XDG_CONFIG_HOME` **with an explicit config.json** setting
  `read_config_from: {cursor:false, windsurf:false, claude:false}`,
  `permissions.deny` for all five tools + `mcp__*`, `subagents_enabled:
  false`; plus `XDG_DATA_HOME` scratch. Success criterion: a future probe's
  session-recorded input contains no imported rules and no MCP connection
  attempt appears on the wire.
- Checks: unit tests against a stub stdio child (no live calls), matching the
  existing provider test style; live probes remain opt-in.
- Open for lead decision: if `swe-2-max` does not pin on `summarizer`, the
  fallback is the default agent + `plan`/`ask` mode + deny-all rules —
  weaker isolation (ambient read tools exist) and must be measured, not
  assumed.

## Private evidence IDs (map and full hashes are private)

`task1/{request-probe-1.json, acp-probe.mjs, probe-1-wire.ndjson,
probe-1-stderr.log, probe-1-meta.json, probe-1-summary.json,
correction-1.md, correction-2.md, evidence-map.json, evidence-manifest.json}`,
`task1/probe-2/{request-probe-2.json, acp-probe-2.mjs, probe-2-wire.ndjson,
probe-2-stderr.log, RECONCILIATION.md}`,
`task1/exports/visual-bronze-{session.json, message-nodes.json,
prompt-history.json, summary.md, session.lock}`.

Manifest `task1/evidence-manifest.json` SHA-256:
`3e43fc3b3e1c7e0ca5f1cf8b3e6a9686124e9003769e4e00dadb3d5fec902def`.

## Subsequent work

This task-1 record and its proposals are preserved as history. See [the adapter and corrections](devin-adapter.md) for the implemented High-only route and isolation evidence, and [current execution status](execution-status.md) for the remaining M2 acceptance gaps.
