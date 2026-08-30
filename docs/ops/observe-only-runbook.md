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

## Controlled mutation handoff (not yet commissioned)

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
   prove a fresh zero-action cycle;
3. the separately signed one-incident approval and controlled failure drill;
4. `rollback` — stop approve-mode opsd, restore the backed-up observe config,
   restore both exact legacy plists/labels, then restart observe-mode opsd.

The tool accepts no path flags or free-form command. It never deletes a source
plist. Every state-changing step is journaled and fsynced before and after, and
the fake-host suite injects a crash after every handoff prefix and requires
rollback convergence.

Before commissioning that key, generate the canonical logical promotion input
off-mini with `scripts/ops/export-promotion-input.mjs`. The exporter refuses a
release-commit mismatch, a changed bundle hash, probe-inventory drift,
non-`opsd` ownership, a stale SOP digest, or an executor/wrapper mismatch. Its
`0600` output binds the exact release, all promotion files, registered probes,
owner decision, executor, one-attempt SOP, expiry, and rollback reference.

`sign-authority-manifest.mjs --promotion-input ...` signs the SOP grant together
with that promotion id and canonical input hash. `sign-approval.mjs` requires
the same input and refuses any approval whose incident/SOP/digest/promotion/hash
or attempt differs. Private keys remain on the commissioned operator signing
host; deployment receives only the public key, signed manifest, signed approval
and reviewed promotion material.

Stage that canonical input at the fixed
`~/.helium/ops/promotions/trading-stack-reconcile/promotion-input.json` path.
On the mini, `promotion-package.mjs export` performs a read-only inventory of
the exact candidate config, promotion input, signed authority, public key,
wrapper/delegate, release opsd binary, current opsd plist and both legacy
plists. Transfer only that unsigned inventory and the canonical promotion input
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
