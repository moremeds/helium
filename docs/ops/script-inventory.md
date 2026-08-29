# Operations script inventory

This is the pre-deployment inventory required by Ops Task 16. It is deliberately
truthful about the boundary of the 2026-08-25 sanitized audit: the evidence
proved incident symptoms, but did not retain executable paths, owners, release
hashes, or a successful controlled repair. AC#1 forbids refreshing those facts
from the mini before 2026-08-31, and any later host inspection still requires a
separate approved deployment plan.

The YAML registrations therefore use the impossible
`/__HELIUM_UNCERTIFIED__/` prefix. They exercise exact-argv and policy contracts
without making a guessed production path executable. The committed authority
manifest has no entries, and current mutation ownership is `external` or
`none`, so every mutating SOP is held at effective `observe`.

The signing-host policy remains deliberately uncommissioned. On 2026-08-30 the
approved off-mini operator workstation was recorded as a SHA-256 hardware hash
in `allowedOperatorHostHashes`; its raw hardware UUID was not retained. The mini
hash remains absent because reading it would start a process during AC#1 and
irreversibly contaminate that unattended window. After the freeze, the approved
inventory must place the mini hash only in `forbiddenMiniHostHashes`. Both
approval signing and authority-manifest signing continue to fail closed until
both lists are populated. The manifest signer also revalidates component
ownership, business postconditions, executor registration, and the executable
hash immediately before signing; a structurally uncertified SOP cannot enter
the manifest.

Executable ownership is likewise explicit: `expectedOwnerUid: 0` in the
committed sentinel registrations is not a guessed deployment owner. It keeps
the registrations non-executable until the post-freeze inventory replaces it
with the verified uid. The signer also requires a separately exported
`--registered-probes` inventory from the actual host probe registry; it never
derives runnable probe ids from the submitted check files. Until every
postcondition probe is present in that inventory, an above-observe grant cannot
be signed.

IB Gateway restart: forbidden. It is not registered as an executor or SOP.

## trading-stack-reconcile

- Repository owner: unresolved; the implementation is not present in this repository
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/trading-stack-reconcile`
- Release or hash identity: unresolved; zero digest is a non-deployable sentinel
- Argv schema: `trading-stack-reconcile-argv-v1`; fixed `--scope containers --pull false`
- Working directory: `/__HELIUM_UNCERTIFIED__/trading-stack`
- Environment profile: `ops-minimal`; only `/usr/bin:/bin:/usr/sbin:/sbin`
- Preflight: Docker reachable, DATA_LAKE mount identity correct, no image pull
- Postconditions: exact expected container set and business readiness
- Timeout: 120000 ms
- Attempt limit: 1
- Cooldown: 600000 ms
- Blast radius: container-only reconcile; no images, volumes, mounts, or IB Gateway
- Rollback or compensation: stop and return to the existing operator runbook; no blind retry
- Drill state: not run; production-derived fixture does not exercise this command
- Mutation owner: `colima=external` under `existing-colima-watchdog`
- Certification state: blocked

## colima-restart

- Repository owner: unresolved; the watchdog implementation is not present here
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/colima-restart`
- Release or hash identity: unresolved; zero digest is a non-deployable sentinel
- Argv schema: `colima-restart-argv-v1`; fixed mode plus attempt `1`
- Working directory: `/__HELIUM_UNCERTIFIED__/colima`
- Environment profile: `ops-minimal`; only `/usr/bin:/bin:/usr/sbin:/sbin`
- Preflight: single mutation owner, clear competing-label probe, bounded lease and budget
- Postconditions: VM/transport readiness and exact expected container set
- Timeout: 180000 ms
- Attempt limit: 1
- Cooldown: 1800000 ms
- Blast radius: one Colima VM; no prune, pull, data deletion, mount change, or IB Gateway
- Rollback or compensation: restore external ownership before re-enabling the legacy watchdog
- Drill state: observed watchdog exhaustion only; no successful automatic drill
- Mutation owner: `colima=external` under `existing-colima-watchdog`
- Certification state: blocked

## livewire-targeted-repair

- Repository owner: unresolved; no targeted repair implementation is present here
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/livewire-targeted-repair`
- Release or hash identity: unresolved; zero digest is a non-deployable sentinel
- Argv schema: `livewire-targeted-repair-argv-v1`; ISO date plus bounded partition id
- Working directory: `/__HELIUM_UNCERTIFIED__/livewire`
- Environment profile: `ops-minimal`; only `/usr/bin:/bin:/usr/sbin:/sbin`
- Preflight: damaged partition identified, source exists, DATA_LAKE identity correct
- Postconditions: Parquet integrity, target-date freshness, and coverage completeness
- Timeout: 900000 ms
- Attempt limit: 1
- Cooldown: 3600000 ms
- Blast radius: one named date and partition; no generic restart or deletion
- Rollback or compensation: preserve original artifact and escalate; no blind retry
- Drill state: corruption detection proven; exact repair remains BLOCKED
- Mutation owner: `livewire=none`
- Certification state: blocked

## colima-reconnect

- Repository owner: unresolved with its executor
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/colima-restart --mode transport --attempt 1`
- Release or hash identity: SOP digest is pinned; executable identity unresolved
- Argv schema: `colima-restart-argv-v1`
- Working directory: `colima-workdir`
- Environment profile: `ops-minimal`
- Preflight: VM healthy, controller probe clear, lease acquired
- Postconditions: transport and expected containers ready
- Timeout: 180000 ms
- Attempt limit: 1
- Cooldown: 600000 ms
- Blast radius: Colima transport only
- Rollback or compensation: release lease and escalate to operator
- Drill state: fixture-only policy path; real command not run
- Mutation owner: `colima=external`
- Certification state: blocked

## colima-bounded-restart

- Repository owner: unresolved with its executor
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/colima-restart --mode vm --attempt 1`
- Release or hash identity: SOP digest is pinned; executable identity unresolved
- Argv schema: `colima-restart-argv-v1`
- Working directory: `colima-workdir`
- Environment profile: `ops-minimal`
- Preflight: controller probe clear, DATA_LAKE identity correct, lease and budget acquired
- Postconditions: Colima readiness and exact expected containers
- Timeout: 180000 ms
- Attempt limit: 1
- Cooldown: 1800000 ms
- Blast radius: one Colima VM restart
- Rollback or compensation: restore external owner before legacy watchdog reload
- Drill state: watchdog failure fixture only; no successful automatic drill
- Mutation owner: `colima=external`
- Certification state: blocked

## livewire-targeted-parquet-repair

- Repository owner: unresolved with its executor
- Deployment owner: unresolved by the sanitized audit
- Exact path: `/__HELIUM_UNCERTIFIED__/livewire-targeted-repair` with typed target arguments
- Release or hash identity: SOP digest is pinned; executable identity unresolved
- Argv schema: `livewire-targeted-repair-argv-v1`
- Working directory: `livewire-workdir`
- Environment profile: `ops-minimal`
- Preflight: source and mount identity proven for the exact target
- Postconditions: integrity, target freshness, and coverage
- Timeout: 900000 ms
- Attempt limit: 1
- Cooldown: 3600000 ms
- Blast radius: one date and partition
- Rollback or compensation: retain original, mark uncertain, escalate; never generic restart
- Drill state: corrupted fixture detects failure; targeted repair not exercised
- Mutation owner: `livewire=none`
- Certification state: fixture-only
