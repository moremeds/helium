## v0.1.2 — 2026-08-24

- chore(canary): record the AC#4 drill
- fix(canary): install the candidate for real, and prove it landed
- chore(release): record the AC#6 drill

## v0.1.1 — 2026-08-24

- fix(release): give the remote shell a PATH that reaches node and pnpm

## v0.1.0 — 2026-08-24

- fix(deadman): resolve the alert recipient from the process env too
- chore: ignore playwright-mcp scratch output and handoff notes
- test(contracts): boot the helium profile on an ephemeral port
- fix(profile): ship the dsh web-app bundle, and allow its native builds
- fix(senior): read the result envelope out of claude's streamed JSON array
- fix(sensor): key the baseline per trigger URL, not per job
- fix(deploy): spawn the MCP server artifact directly instead of a pnpm bin shim
- fix(toolkit): reject encoded slashes in argon paths
- fix(release): close rollback.sh TOCTOU under the lock, retry deploy.sh's forward kickstart
- test(plugin): make the script-overlap guard test deterministic, fix two incidental flakes
- fix(release): guard bootstrap flip-back, harden flip-back atomicity, add mkdir lock
- fix(deadman): guard missing jsonl dir so check-heartbeat.sh cannot silently exit 1
- feat(canary): add dsh version sentinel, isolated contract run and diff intel
- feat(release): add cut/deploy/rollback scripts with atomic flip and health window
- feat(plugin): route job.script triggers to a script runner instead of the dsh engines
- feat(core): add optional script action to the job schema
- feat(deadman): add external heartbeat watchdog agent and staleness drill
- feat(deploy): add mini prereq check, launchd dsh agent template and entry point
- fix(jobs): align macro-watch prompt's section references to the real assembled prompt headers
- feat(jobs): add macro-watch tenant, senior prompt and US macro calendar review
- feat(plugin): wire umbrella runtime and add local e2e harness
- fix(tools): close two live bypasses found in security re-review (fix round 1)
- test(mcp): cover the unknown-tool-name silent-drop case in selected()
- fix(tools): extend livewire_sql's denied-token list to read_text/attach/copy
- fix(tools): add /backtest/results/ to apex_api's read prefixes
- fix(tools): cap HTTP tool response bodies at 64 KiB
- test(mcp): extract selected() into a testable module
- fix(tools): deny raw file-reading table functions in livewire_sql
- fix(tools): add GET /screener/results/{run_id} to apex_api's read prefixes
- fix(tools): send argon_rescan's required body; drop apex backtest from the allow-list
- fix(tools): reject path-traversal and double-slash before the allow-list check
- fix(ci): build @helium/core before typecheck/test; skip the stale effect-timer contract
- fix(plugin): resolve @helium/core via file: so file:-installed profiles work
- test(contracts): runtime proof that agentCtx.tools.restrict() denies a tool
- docs(context): write the v1 ecosystem context injected into every agent
- feat(tools): verify apex_compute's real screener/backtest routes from source
- feat(toolkit): register the ecosystem tools in-process on ctx.tools
- feat(mcp): serve the ecosystem toolkit over stdio with env filtering
- feat(tools): read-only livewire SQL and protected thesis read/write tools
- feat(tools): argon and apex tools with verified route allow-lists
- feat(core): versioned thesis store with size cap and unified diff
- chore(core): add duckdb node-api and diff with verified read-only and patch checks
- fix(delivery): guard the synthesis prune step and freeze test-clock dependence
- feat(plugin): wire delivery, heartbeats and the daily synthesis cron
- feat(delivery): JSONL-first delivery with reports, retried email and daily synthesis
- fix(dispatch): contain escaped errors so no dispatch can kill the daemon
- test(dispatch): assert ledger rows directly for timeout, suppression and the engine guard
- feat(plugin): route trigger events through the dispatcher
- feat(dispatch): orchestrator with single-flight, budgets, semaphore and ledger
- feat(dispatch): senior lane runner for claude -p with failure classification
- feat(dispatch): secrets-safe env-file reader
- fix(dispatch): flush the session unconditionally before dispose
- docs(dispatch): record dsh AgentHandle.dispose durability finding
- feat(dispatch): fresh-session triage lane with tool restriction and verdict retry
- feat(core): structured triage verdict parsing and threshold gate
- docs(dispatch): record the verified dsh agent and tool-restriction API
- feat(sensor): arm calendar windows and tighten polling inside them
- feat(calendars): add the verified US macro release calendar
- feat(sensor): timezone-explicit cron trigger on croner
- feat(sensor): calendar loader, window logic and once-per-window watcher
- chore(plugin): add croner and yaml with a verified timezone check
- fix(sensor): guard concurrent ticks and register the mcp-ping workspace member
- feat(plugin): wire state-change sensors onto ctx.effect intervals
- feat(sensor): state-change poller with baseline, dedup and unknown handling
- feat(sensor): dot-path field extraction and stable field hashing
- feat(plugin): pin the helium runtime config contract
- chore(core): expose a single @helium/core entry point
- fix(workspace): approve dsh native dependency builds for clean installs
- docs: record spike B verdict — MCP stdio round-trip to a claude -p child
- docs: record spike A verdict — dsh web UI and helium plugins in one process
- test(contracts): dsh API contract suite (mount, plugin add, ctx.effect, live agent turn)
- fix(profile): deploy-profile.sh builds the plugin dir being deployed
- feat(profile): dsh-plugin-helium placeholder, helium profile template, deploy-profile.sh
- feat(core): two-phase RunLedger with idempotent startup reconciliation
- feat(core): atomic file-backed StateStore
- test(core): cover cron trigger tz default; fix stale comment
- feat(core): job YAML schema with ms-normalized durations
- fix(core): never delete jsonl files with non-calendar dates in prune()
- feat(core): append-only daily JsonlWriter with retention prune
- feat(core): parseDuration and nowIso
- chore: bootstrap helium pnpm workspace and CI

# Changelog

Entries are prepended by `scripts/release/cut.sh` at tag time, newest first.
Each entry is the `git log --no-merges` one-liners since the previous tag,
under a `## vX.Y.Z — YYYY-MM-DD` heading.
