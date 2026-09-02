## v0.1.14 — 2026-09-02

- fix(release): start the health window after the old daemon is gone
- fix(release): make the deploy own the DSH plist

## v0.1.13 — 2026-09-01

- fix(release): let a deliberately disabled tenant ship

## v0.1.12 — 2026-09-01

- feat(release): refuse the flip when the DSH plist names paths the release drops
- fix(release): finish the canary rename from jobs to tenants
- chore: drop the session scratch baselines that were committed by mistake
- docs: describe the tenant lane instead of the retired v1 job lane
- feat(ops): move release, launchd and deadman onto the tenant directory
- fix(ops): let the observed fleet be empty now that no tenant is enabled
- refactor: delete the v1 job lane and @helium/v1-compat
- refactor: move the livewire-shepherd manifests into its plugin as a disabled tenant
- test: retarget team-manifest fixtures off teams/macro.yaml
- test(tenants): prove the tenant seam with plugins/fake-tenant in CI
- feat(tenants): add the delivered promotion mode behind HELIUM_TENANT_DELIVERY
- feat(tenants): drive team runs from per-tenant cron triggers
- feat(tenants): merge per-tenant tool vocabularies and validate team role tools
- feat(tenants): discover plugins/*/tenant.yaml with per-tenant isolation
- chore: prepare the repository for public release
- chore(deps): upgrade dsh to 0.1.2-alpha.3
- test: await process group reaping
- ci: run livewire recovery contract on macOS
- style: normalize deployment gate files
- feat: package autonomous livewire recovery
- test: require livewire deployment recovery matrix
- feat: verify livewire promotion evidence offline
- fix: retain repair lock for live process groups
- docs: design offline livewire promotion
- feat: bound recurring Shepherd repair authority
- feat: commission exact automatic Ops authority
- feat: run scoped Shepherd repairs through Ops
- refactor: expose the certified action transaction
- test: freeze Ops action boundary behavior
- docs: tighten Shepherd repair contracts
- feat: isolate unavailable Livewire sources
- feat: route Shepherd research by cost and capability
- feat: define Livewire Shepherd team variants
- feat: add the Shepherd Livewire bridge
- feat: schedule Shepherd work without global blockers
- feat: add durable Shepherd work units
- refactor: share immutable artifact storage
- docs: harden Livewire Shepherd execution plan
- docs: plan Livewire Shepherd implementation
- docs: design Livewire Shepherd autonomous recovery
- docs: record P4 suggest-only evidence

## v0.1.11 — 2026-08-30

- fix(ops): reset attempt budget after recovery

## v0.1.10 — 2026-08-30

- feat(ops): enable signed suggest-only review

## v0.1.9 — 2026-08-30

- fix(release): reload canary launchd environment
- fix(p4): preserve bounded canary retries

## v0.1.8 — 2026-08-30

- fix(ops): rebind observe-only package to current

## v0.1.7 — 2026-08-30

- fix(release): validate jobs through v1 compat

## v0.1.6 — 2026-08-30

- feat: add bounded P4 review-only canary
- feat: add capability-routed ops team
- feat: inhibit team fan-out under host pressure
- feat: evaluate routing and team quality
- feat: run macro team in shadow mode
- fix: require execution identity for accepted claims
- feat: define capability-based macro team
- feat: adjudicate agent claims through evidence
- fix: hold senior capacity through cancellation
- test: align Codex boundary proof with current CLI
- fix: certify and recover provider capacity
- fix: compose the production provider plane
- chore: keep branch diff clean
- fix: tolerate instant provider completion
- fix: reap orphan provider processes
- fix: enforce DeepSeek effort and quota facts
- fix: persist and wire provider availability
- fix: persist immutable artifact content
- fix: close routing and task state bypasses
- fix: enforce process executor boundaries
- test: require provider-owned quota restoration
- feat: dispatch team work through provider executors
- feat: add preference fallback ordering and audited exact target override
- feat: register certified provider targets
- feat: invoke exact provider targets
- feat: add provider-owned model effort catalogs
- feat: validate provider effort catalogs
- test: protect provider effort boundary
- feat: reconcile team budgets and cancellation
- feat: add durable task DAG and artifact handoff
- feat: persist restart-safe team state
- feat: add durable team event model
- fix(ops): preserve forward-compatible observe rollback
- fix(ops): distinguish derived provenance from raw evidence
- fix(ops): verify handoff from an event snapshot
- fix(ops): match approvals to proposed incident ids
- fix(ops): treat stopped containers as missing
- fix(ops): wait for approve cycle proof
- fix(ops): bind controlled handoff to signed release
- fix: bind handoff to candidate opsd plist
- fix: verify remote promotion from local signing checkout
- chore: commission controlled mutation trust root
- docs: prove offline mutation readiness
- docs: record mutation readiness preflight
- feat: close signed promotion package chain
- feat: bind signed approvals to promotion inputs
- feat: add reversible mutation ownership handoff
- feat: compose approve-only controlled recovery
- feat: define approved container reconcile promotion
- fix: bind checks to registered runtime probes
- feat: run fresh production postcondition checks
- test: isolate ops bundle fixtures
- docs: define controlled mutation execution gate
- feat: pin staged container reconcile identity
- feat: stage ops wrappers by content hash
- feat: add bounded container reconcile wrapper
- test: wait for restriction fixture shutdown
- docs: record live production observations
- feat: measure livewire parquet integrity
- fix: classify live dependency observations
- feat: compose production ops observations
- fix: align live ops evidence hashes
- docs: record repeated opsd deadman run
- docs: record independent opsd deadman
- feat: add independent opsd deadman
- docs: pin candidate opsd deadman check
- docs: authorize reversible opsd deadman wiring
- docs: record live ops commissioning
- fix: parse live macos cpu process names
- ops: authorize reversible weekend commissioning
- docs: permit bounded read-only ac1 inspection
- chore: register ops signing workstation
- docs: record ops phase d offline evidence
- fix: persist ops verification policy
- fix: make ops reconciliation race safe
- fix: harden ops crash recovery evidence
- fix: close ops phase d safety gaps
- feat: package ops observe-only rollout
- test: adversarially verify ops recovery
- docs: inventory blocked operations scripts
- feat: run ops in observe and suggest modes
- docs: re-record ops phase c ci evidence
- docs: record ops phase c evidence
- fix: keep ops bundles and evidence self-contained
- test: remove runtime watcher timing race
- fix: make ops observations replayable
- fix: close ops phase c runtime gaps
- feat: group ops alerts and decide admission under pressure
- feat: observe colima postgres and helium
- feat: observe livewire argon and apex
- feat: collect host operations observations
- docs: authorize p4 takeover and separate p5 p6
- docs: hand Ops Phase C over to codex mid-task
- feat: probe host memory, volumes and process liveness
- feat: load pluggable operations components
- docs: re-record ops phase B evidence from the merging tree
- docs: record phase 2.5a Ops Phase B evidence from ci
- test: drive the phase B persisted crash matrix
- feat: verify and attribute operations recovery
- feat: enforce single mutation ownership per component
- feat: execute certified ops scripts
- feat: lease and bound recovery actions
- feat: persist operations incidents and actions
- feat: authorize exact operations SOPs
- docs: correct an unrunnable reproduction command in the phase one record
- feat: correlate dependency-aware incidents
- test: freeze ops incident fixtures
- feat: define generic operations observations
- docs: re-record phase one evidence from the merging tree
- fix: stop the event-store suite contending on fsync in ci
- docs: record phase one evidence from ci
- ci: prove the fake executor packages install and remove with no core edit
- feat: preserve v1 through work-order adapter
- test: guard the sensor-to-executor topology edge statically
- feat: add opaque executor leases and isolation classes
- feat: select execution targets by capability hard filter
- feat: add opaque target registry with capability tags
- feat: define model-blind work and evidence contracts
- refactor: isolate v1 model-specific job contract
- docs: record phase zero evidence hashes from ci
- ci: run the phase zero gate commands ci never reached
- feat: monitor liveness per tenant
- fix: validate execution tool contracts
- test: add reusable execution-boundary conformance harness
- docs: correct the e2e exclusion snippet that dropped vitest defaults
- fix: isolate senior execution capabilities
- fix: write delivery intent before side effects
- docs: regenerate the phase zero handoff for revision three
- docs: resync phase zero handoff to the revised plan set
- docs: record claude phase zero dispatch
- docs: hand off multi-agent phase zero
- docs: correct task five's claim about the dead-man test
- docs: close the blockers a pre-execution readiness pass found
- docs: make the revised plan executable end to end
- docs: close the review's blockers and adjudicate what round 1 surfaced
- docs: surface the canonical topology in readme
- docs: visualize canonical agent topology
- docs: make agent verification evidence explicit
- docs: add pluggable ops agent program
- docs: plan provider effort implementation
- docs: define provider effort selection
- docs: record model selection probe
- docs: add executable multi-agent implementation plan
- docs: define model-blind multi-agent architecture
- docs: record phase 3 acceptance results and start the AC#1 window

## v0.1.5 — 2026-08-24

- fix(script): kill the script's process group, not just the direct child
- test(script): stop the SIGTERM timeout test racing the test runner
- docs(canary): record the dsh rc.2 interactive tool-execution defect

## v0.1.4 — 2026-08-24

- feat(jobs): add apex-health tenant

## v0.1.3 — 2026-08-24

- fix(jobs): stop one malformed job file from killing every tenant

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
