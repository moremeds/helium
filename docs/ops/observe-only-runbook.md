# Ops observe-only rollout

This is the reversible packaging procedure for the standalone operations
collector. It does not certify any mutating SOP and it does not authorize a
Mac mini change.

## Current boundary

- AC#1 freezes all Mac mini installs, starts, and configuration changes through
  **2026-08-31**. The installer also enforces this date.
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

## Post-AC#1 operator procedure

Only after separate approval, on the mini and through the currently selected
release:

```bash
bash /Users/moremeds/projects/helium-releases/current/scripts/ops/install-observe-only.sh \
  --release /Users/moremeds/projects/helium-releases/current \
  --root /Users/moremeds/.helium/ops \
  --launchd-root /Users/moremeds/Library/LaunchAgents
```

The `current` symlink is intentional: deploy and rollback validate the target
contains both the collector and plugin, flip that pair atomically, and restart
an already-installed daemon. Resolving it to one immutable version here would
strand opsd on the first installed release.

The command only creates four private directories, one `0600` configuration,
and `com.helium.opsd.plist`. It does not write the authority manifest, call
`launchctl`, or start a process. Before continuing, inspect the rendered JSON
and plist, confirm `mode` is `observe`, and verify both authority paths point
inside the intended immutable release.

Loading is a second, explicit operator action:

```bash
plutil -lint /Users/moremeds/Library/LaunchAgents/com.helium.opsd.plist
launchctl bootstrap "gui/$(id -u)" \
  /Users/moremeds/Library/LaunchAgents/com.helium.opsd.plist
launchctl print "gui/$(id -u)/com.helium.opsd"
```

After the first valid observation is present at
`/Users/moremeds/.helium/ops/state/events.jsonl`, enable the independent host
dead-man check by setting `HELIUM_OPSD_EXPECTED=1` and
`HELIUM_OPSD_EVENT_LOG=/Users/moremeds/.helium/ops/state/events.jsonl` in the
installed dead-man job, then reload that job. Do not declare the controller
expected until the log path has been verified. A fresh DSH heartbeat cannot
suppress an opsd-stale alert.

Observe for at least seven days before considering any authority promotion.
Track observation freshness, collection failures, incident noise, daemon
restarts, log rotation, and dead-man delivery. Provider/model availability is
irrelevant to the deterministic collector path.

## Rollback and uninstall

Release rollback validates that the target contains both the ops-agent plugin
and runner, flips the immutable release pair, and restarts an already-loaded
`com.helium.opsd`. It never installs or loads the label.

To remove observe-only, first disable the dead-man expectation and unload the
exact label, then remove only installer-owned files:

```bash
launchctl bootout "gui/$(id -u)/com.helium.opsd"
bash scripts/ops/uninstall-observe-only.sh \
  --root /Users/moremeds/.helium/ops \
  --launchd-root /Users/moremeds/Library/LaunchAgents
```

The uninstaller does not invoke `launchctl`, recursively delete anything, or
remove non-empty neighboring directories. Preserve the event log and approval
artifacts separately if they are needed for audit before removing state.
