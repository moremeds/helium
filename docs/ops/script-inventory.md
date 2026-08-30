# Operations script inventory

This is the pre-deployment inventory required by Ops Task 16. It is deliberately
truthful about the boundary of the 2026-08-25 sanitized audit: the evidence
proved incident symptoms, but did not retain executable paths, owners, release
hashes, or a successful controlled repair. The 2026-08-30 operator amendment
permits bounded read-only identity/configuration inspection during AC#1, while
installation, repair, deployment, service lifecycle changes and application/
configuration/state writes remained frozen until the separately recorded
weekend commissioning waiver. That waiver permits only the isolated
empty-authority observe-only install and does not certify any script below.

The unresolved Colima-restart and Livewire registrations retain the impossible
`/__HELIUM_UNCERTIFIED__/` prefix. The reviewed container-only reconcile
wrapper is now staged at an immutable, content-addressed production path but is
not loaded by the active collector and has never been invoked on the mini. The
committed authority manifest has no entries, and current mutation ownership is
`external` or `none`, so every mutating SOP is still held at effective
`observe`.

The signing-host identity boundary is now commissioned. On 2026-08-30 the
approved off-mini operator workstation was recorded as a SHA-256 hardware hash
in `allowedOperatorHostHashes`, and the mini was independently recorded only in
`forbiddenMiniHostHashes`; neither raw hardware UUID was retained. Approval and
authority-manifest signing therefore accept only the operator workstation and
explicitly refuse the mini. The manifest signer also revalidates component
ownership, business postconditions, executor registration, and the executable
hash immediately before signing; a structurally uncertified SOP cannot enter
the manifest.

Executable ownership is likewise explicit: live inspection confirmed operator
UID 501. The two sentinel registrations retain `expectedOwnerUid: 0`; the
container-only registration pins UID 501 and its staged wrapper hash, while the
wrapper independently pins the mode, SHA-256 and path of the legacy script it
delegates to. This closes executable identity only. With no SOP referencing the
executor, no signed grant and external Colima mutation ownership, it remains
outside every executable action path.
The signer also requires a separately exported `--registered-probes` inventory
from the actual host probe registry; it never derives runnable probe ids from
the submitted check files. Until every postcondition probe is present in that
inventory, an above-observe grant cannot be signed.

IB Gateway restart: forbidden. It is not registered as an executor or SOP.

## 2026-08-30 live identity capture

- Host: `moremeds-Mini`, operator UID 501; only the SHA-256 hardware identity is
  retained in policy.
- Selected Helium release: `/Users/moremeds/projects/helium-releases/v0.1.5`.
- Selected Livewire release:
  `/Users/moremeds/market-warehouse/releases/4d533f4fded9000ed69c525ff2274de397f0d8ba`.
- Active Colima controllers: `com.moremeds.colima-runtime-watchdog` and
  `com.moremeds.colima-after-datalake`.
- Active Livewire controllers: daily update, daily-update watchdog, intraday
  catch-up, coverage and release promotion labels recorded in the evidence log.
- No `com.helium.opsd` label or plist existed at capture time.
- Exact plist/script owners, modes and SHA-256 values are in
  `docs/evidence/p2.5a/phase-d-live-identity-2026-08-30.log`.
- `trading-stack/scripts/reconcile.sh` exposes a bounded `--containers` mode.
  The Helium wrapper translates only the registered fixed `--scope containers
  --pull false` contract to that mode after rechecking the inspected legacy
  script identity. The Colima runtime watchdog has its own stateful automatic
  restart behavior and remains the external mutation owner; it is not
  repurposed as an opsd executor.
- Livewire exposes several repair families, but no inspected entry point matches
  the proposed exact `--target-date` plus `--partition` generic Parquet contract.
  The target data layer and repair family must be chosen from a real incident;
  certification remains blocked rather than guessing.

## trading-stack-reconcile

- Repository owner: Helium wrapper; pinned trading-stack target outside this repository
- Deployment owner: UID 501
- Exact path: `/Users/moremeds/.helium/ops/actions/sha256-15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074/trading-stack-reconcile.mjs`
- Release or hash identity: SHA-256 `15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074`
- Wrapper source: `scripts/ops/actions/trading-stack-reconcile.mjs`
- Wrapper installer: `scripts/ops/actions/install-action-wrapper.mjs`
- Wrapper source identity: SHA-256 `15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074`
- Planned immutable path: `$OPS_ROOT/actions/sha256-15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074/trading-stack-reconcile.mjs`
- Underlying target identity: `/Users/moremeds/trading-stack/scripts/reconcile.sh` owned by UID 501, non-group/world-writable, SHA-256 `3da35c87a76a90a55669c5e86db038e92fb21f6ff737526a0a1d6dc1c613da2e`
- Deployment state: staged at the immutable path; not loaded by the active e6b0a87 collector and never invoked
- Staging evidence: `docs/evidence/p2.5a/phase-d-action-wrapper-2026-08-30.log`
- Argv schema: `trading-stack-reconcile-argv-v1`; fixed `--scope containers --pull false`
- Working directory: `/Users/moremeds/trading-stack`
- Environment profile: the wrapper internally fixes HOME, Colima Docker socket, trading-stack root, and bounded system/Homebrew PATH; no inherited environment
- Preflight: wrapper and delegated script identities match; Docker reachable; DATA_LAKE mount identity correct; no image pull
- Postconditions: exact expected container set and business readiness
- Timeout: 120000 ms
- Attempt limit: 1
- Cooldown: 600000 ms
- Blast radius: container-only reconcile; no images, volumes, mounts, or IB Gateway
- Rollback or compensation: stop and return to the existing operator runbook; no blind retry
- Drill state: fake delegated-script contract passes; wrapper is staged but no production command has run
- Mutation owner: `colima=external` under
  `com.moremeds.colima-runtime-watchdog`, with
  `com.moremeds.colima-after-datalake` also competing
- Certification state: blocked

## colima-restart

- Repository owner: trading-stack (outside this repository)
- Deployment owner: UID 501
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
- Mutation owner: `colima=external` under
  `com.moremeds.colima-runtime-watchdog`, with
  `com.moremeds.colima-after-datalake` also competing
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
