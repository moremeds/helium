# Ops observe-only rollout

This is the reversible packaging procedure for the standalone operations
collector. It does not certify any mutating SOP and it does not authorize a
Mac mini change.

## Current boundary

- The operator's 2026-08-30 weekend commissioning waiver decouples one
  reversible, isolated observe-only install from AC#1. AC#1 is left uncredited,
  not called PASS. The waiver does not authorize a Helium release flip, DSH or
  legacy-controller restart, SOP grant, repair, ownership handoff or controlled
  drill. After the first valid opsd event, the waiver permits the separate,
  reversible `com.helium.opsd-deadman` integration described below.
- Merging or deploying the repository does not install `opsd`.
- The committed authority manifest grants no mutation authority. The unresolved
  production script paths, hashes, owners, live postconditions, drill evidence,
  and real operator signature in [script-inventory.md](./script-inventory.md)
  keep Task 16 open. Do not replace those values by inference.
- A separate post-freeze approval is required before every command in the next
  section. The packaging tests use redirected temporary directories and are
  safe during the freeze.

## Pre-deployment verification

From the release source on a developer machine:

```bash
pnpm install --frozen-lockfile
pnpm build
bash scripts/ops/install-observe-only.test.sh
```

The test renders into a temporary root, never calls `launchctl`, verifies the
freeze refusal, and removes the fixture on exit.

## Operator procedure

Only after separate approval, on the mini and through the currently selected
release:

```bash
bash /Users/moremeds/projects/helium-ops-candidates/<commit>/scripts/ops/install-observe-only.sh \
  --release /Users/moremeds/projects/helium-ops-candidates/<commit> \
  --root /Users/moremeds/.helium/ops \
  --launchd-root /Users/moremeds/Library/LaunchAgents \
  --commissioning-waiver ops-phase-d-weekend-2026-08-30
```

The waiver flag is required only through 2026-08-31. It is accepted solely for
the exact operator decision recorded in
`docs/evidence/ac1-weekend-commissioning-waiver-2026-08-30.md`.

The weekend waiver uses an immutable candidate separate from the selected
Helium `current` release. After the Phase D PR is merged and a normal release is
selected, reinstall the observe-only package against `current`; deploy and
rollback then validate and move the collector/plugin pair together.

The first transition is intentionally a one-time two-stage release because the
currently selected v0.1.5 predates `opsd` and cannot run the current-bound
package. Keep the event/evidence state in place throughout:

1. unload only `com.helium.opsd-deadman` and `com.helium.opsd`;
2. deploy the first normal release while those labels are absent;
3. run `scripts/ops/rebind-observe-only.sh apply` from that release with
   `--release /Users/moremeds/projects/helium-releases/current`, the existing
   ops and LaunchAgents roots, and a new private backup directory below
   `~/.helium/ops/rebind-backups`;
4. inspect and bootstrap `com.helium.opsd`, prove a fresh cycle whose
   `releaseRef` is the real current release, then bootstrap and prove the
   independent deadman label;
5. retain the hashed backup until a later compatible release rollback has been
   drilled.

The rebind tool refuses to run while either label is loaded, changes only the
active config and the two installer-owned plists, and never changes state or
calls launchctl. `restore` verifies the backup hashes before replacing those
three files. If the first normal release must be abandoned, keep both labels
unloaded, remove the active packaging with `uninstall-observe-only.sh`, roll DSH
back to v0.1.5, restore the candidate binding from the backup, and explicitly
bootstrap the two labels again. Do not ask v0.1.5 to start a current-bound
`opsd`; it contains no Ops Agent binary or bundle.

The command only creates private ops directories, one `0600` configuration,
`com.helium.opsd.plist`, and `com.helium.opsd-deadman.plist`. It does not write
the authority manifest, call `launchctl`, or start a process. Before continuing,
inspect the rendered JSON and plists, confirm `mode` is `observe`, and verify all
release/event paths point inside the intended candidate and private state root.

Loading is a second, explicit operator action:

```bash
plutil -lint /Users/moremeds/Library/LaunchAgents/com.helium.opsd.plist
launchctl bootstrap "gui/$(id -u)" \
  /Users/moremeds/Library/LaunchAgents/com.helium.opsd.plist
launchctl print "gui/$(id -u)/com.helium.opsd"
```

After the first valid observation is present at
`/Users/moremeds/.helium/ops/state/events.jsonl`, load the independent label:

```bash
plutil -lint /Users/moremeds/Library/LaunchAgents/com.helium.opsd-deadman.plist
launchctl bootstrap "gui/$(id -u)" \
  /Users/moremeds/Library/LaunchAgents/com.helium.opsd-deadman.plist
launchctl print "gui/$(id -u)/com.helium.opsd-deadman"
```

Do not modify or reload `com.helium.deadman`; live commissioning proved its
selected v0.1.5 script lacks the opsd check, while the candidate replacement
also changes tenant policy. The standalone label reads no DSH/tenant state and
has its own dedupe sentinel. Do not credit it until a real run exits 0 and its
stdout contains `opsd fresh:`.

Observe for at least seven days before considering any authority promotion.
Track observation freshness, collection failures, incident noise, daemon
restarts, log rotation, and dead-man delivery. Provider/model availability is
irrelevant to the deterministic collector path.

## Suggest-only promotion

Suggest-only is a non-executing runtime cap, not mutation authority. Production
loads it only from an exact signed promotion bundle: the same certifiable SOP
identity that could later enter approve mode, but with no executor reachable
from the running daemon. An empty authority manifest cannot produce a
suggestion and must not be represented as a successful suggest rollout.

Use `scripts/ops/configure-suggest-only.mjs` to prepare the configuration. The
tool exposes only `preflight`, `apply`, `restore`, and `status`. `preflight`
validates the signed bundle with the selected release without changing the
active config. `apply` and `restore` refuse while `com.helium.opsd` is loaded,
store an exact hash-backed observe config for rollback, and never call
`launchctl` themselves.

The operator sequence is:

1. stage an operator-signed authority manifest and public key for the exact
   selected release and the one-attempt promotion bundle;
2. run `preflight` while observe-only remains live;
3. boot out only `com.helium.opsd`, run `apply`, and bootstrap the unchanged
   installed plist;
4. require a fresh target-release cycle before introducing a controlled
   suggestion case;
5. verify a durable `action-proposed` record and the complete absence of
   authorization, intent, receipt, executor, or terminal-action records;
6. create an exact `suggestion-decision` envelope naming the proposal's action,
   incident, component, SOP version, and SOP digest; sign it off-mini with
   `scripts/ops/sign-suggestion-decision.mjs`; and submit it through
   `opsctl record-suggestion-decision`; and
7. to leave suggest-only, boot out `com.helium.opsd`, run `restore`, bootstrap
   the same plist, and prove a fresh observe cycle.

Both legacy Colima controllers remain loaded throughout suggest-only. A
suggestion never asserts or transfers mutation ownership. The independent
dead-man remains loaded and watches the short opsd restart window.
Suggestion decisions use their own private, hash-chained event store below the
Ops state directory. They do not add a new record type to the main operations
log, so rollback to the prior observe-only release does not fail while replaying
a decision that release did not yet know.

## Controlled mutation handoff

`scripts/ops/controlled-mutation.mjs` pins the public-key fingerprint
commissioned on the registered operator workstation; the private key remains
off-mini and outside Git. Production preflight still refuses unless every
artifact is bound by that key. The 2026-08-30 controlled-mutation waiver permits
one approve-only, one-attempt drill during the weekend window; it earns no
seven-day observation credit and does not authorize suggest or auto mode.

After that gate closes and the signed promotion package is independently
reviewed, the only accepted sequence is:

1. `preflight` — read-only identity, expiry, label and candidate validation;
2. `handoff` — fsynced backup, bootout both exact legacy labels, prove absence,
   switch to the exact approve config, restart only `com.helium.opsd`, then
   wait up to 30 seconds for and prove a fresh zero-action cycle;
3. the separately signed one-incident approval and controlled failure drill;
4. `rollback` — stop approve-mode opsd, derive a fail-closed observe config
   from the signed candidate and backed-up observe settings, validate it with
   the signed candidate binary, restore both exact legacy plists/labels, then
   restart that candidate in observe mode.

Rollback deliberately does not restart an older opsd binary after the new
release has appended action events. The event ledger is forward-only: an old
strict schema may be unable to replay newer event fields. The prior config and
plist remain in the fsynced backup, but safe-mode ownership rollback keeps the
signed candidate parser, removes all promotion/approve fields, restores both
legacy mutation owners, and remains available even after the mutation package
expiry. Expiry closes new handoffs; it must never disable rollback.

The controlled container drill stops one expected container. Production
inventory uses running-only `docker ps`; a stopped container is therefore a
failed expected-set observation, while the certified reconcile can restore it
with the pinned no-pull compose path.

The tool accepts no path flags or free-form command. It never deletes a source
plist. Every state-changing step is journaled and fsynced before and after, and
the fake-host suite injects a crash after every handoff prefix and requires
rollback convergence.

Cycle proof reads a complete event-log snapshot before taking its clock upper
bound. A concurrently appended incomplete tail is deferred to the next poll;
complete events beyond that upper bound remain a hard refusal.

Before commissioning that key, generate the canonical logical promotion input
off-mini with `scripts/ops/export-promotion-input.mjs`. The exporter refuses a
release-commit mismatch, a changed bundle hash, probe-inventory drift,
non-`opsd` ownership, a stale SOP digest, or an executor/wrapper mismatch. Its
`0600` output binds the exact release, all promotion files, registered probes,
owner decision, executor, one-attempt SOP, expiry, and rollback reference.

`sign-authority-manifest.mjs --promotion-input ... --release-checkout ...
--executor-source ...` signs the SOP grant together with that promotion id and
canonical input hash. The checkout and source are the operator workstation's
clean local bytes for the Mini-bound release commit and executor identity; the
signed manifest still names the Mini production path and UID. This separation
lets the signer independently verify code without pretending the Mini's
absolute paths exist on the operator workstation. `sign-approval.mjs` requires
the same input and refuses any approval whose incident/SOP/digest/promotion/hash
or attempt differs. Private keys remain on the commissioned operator signing
host; deployment receives only the public key, signed manifest, signed approval
and reviewed promotion material.

The approval `incidentId` is copied verbatim from the persisted
`action-proposed` event. The controller resolves that public id back to its
internal correlation key only after the durable approval ledger has matched the
signed envelope; operators never sign an unpublished internal key.

Stage that canonical input at the fixed
`~/.helium/ops/promotions/trading-stack-reconcile/promotion-input.json` path.
On the mini, `promotion-package.mjs export` performs a read-only inventory of
the exact candidate config, promotion input, signed authority, public key,
wrapper/delegate, release opsd binary, release runner, controlled-handoff tool,
current observe opsd plist, separate
candidate approve plist and both legacy plists. The candidate plist must point
to the exact candidate release runner and the stable active config path;
preflight parses and rejects any old-release runner before launchd changes. It
also requires the candidate checkout HEAD to equal the signed release commit
and refuses a dirty worktree.
Transfer only that unsigned inventory and the canonical promotion input
to the registered operator workstation. There,
`promotion-package.mjs sign` checks that the inventory is bound to the same
release, expiry, rollback reference and promotion-input hash before signing it.
Return only the signed package to the fixed `promotion-package.json` path. The
live `preflight` re-hashes every staged artifact, verifies the independent
signature, and runs the candidate release's own `--check-config` path before
any launchd write.

## Rollback and uninstall

Release rollback validates that the target contains both the ops-agent plugin
and runner, flips the immutable release pair, and restarts an already-loaded
`com.helium.opsd`. It never installs or loads the label.

To remove observe-only, unload the two exact new labels, then remove only
installer-owned files:

```bash
launchctl bootout "gui/$(id -u)/com.helium.opsd-deadman"
launchctl bootout "gui/$(id -u)/com.helium.opsd"
bash scripts/ops/uninstall-observe-only.sh \
  --root /Users/moremeds/.helium/ops \
  --launchd-root /Users/moremeds/Library/LaunchAgents
```

The uninstaller does not invoke `launchctl`, recursively delete anything, or
remove non-empty neighboring directories. Preserve the event log and approval
artifacts separately if they are needed for audit before removing state.
