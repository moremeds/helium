#!/usr/bin/env bash
# Roll back to the previous helium release. Run from the laptop: rollback.sh
#
# Same self-ssh re-exec trick as deploy.sh. Measures and prints its own wall
# time because AC#6 is a stopwatch criterion (< 60s laptop-observed).
set -euo pipefail
# Same overrides as deploy.sh, same defaults. Keep the two in step: a rollback
# that resolves different paths than the deploy it is undoing is worse than no
# rollback at all.
HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
RELEASES="$HOME/projects/helium-releases"
DSH_HOME_DIR="$HOME/.helium/dsh-home"
OPSD_PLIST="$HOME/Library/LaunchAgents/com.helium.opsd.plist"
OPSD_CONFIG="$HOME/.helium/ops/config/opsd.json"
OPSD_EVENT_LOG="$HOME/.helium/ops/state/events.jsonl"

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # A non-interactive `ssh` gets PATH=/usr/bin:/bin:/usr/sbin:/sbin —
  # no Homebrew, so no `node` and no `pnpm` (verified on the mini: the 3.5 drill's
  # first deploy died at `pnpm: command not found`, exit 127). Only ~/.local/bin
  # was prepended here, which holds `claude` but not the toolchain. Both Homebrew
  # prefixes are listed so this does not silently depend on the CPU architecture.
  # It fails closed if ever dropped again: this runs before any flip, so a missing
  # toolchain aborts the deploy with `current` still pointing at the old release.
  ssh "$HELIUM_HOST" 'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"; HELIUM_REMOTE=1 bash -s' < "$0"
  exit $?
fi
started=$(date -u +%s)

# Serialize the read-then-flip sequence against a concurrent deploy.sh or
# rollback.sh (fix round 1, IMPORTANT 3) — same mkdir-based lock as
# deploy.sh (macOS has no `flock` command; POSIX mkdir(2) is atomic).
#
# Acquired BEFORE reading current/previous below (fix round 2, ITEM 1):
# fix round 1 read them first and only serialized the write, which is a
# TOCTOU — a deploy.sh that lands a flip in the window between this
# script's read and its own write would have its new release silently
# discarded (this script would flip back to the stale `target` it already
# read) and `previous` mis-stamped with stale data. Reading under the lock
# instead guarantees nothing changes out from under this script between
# the read and the flip.
LOCK_DIR="$RELEASES/.flip.lock"
lock_tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_tries=$((lock_tries + 1))
  if [ "$lock_tries" -ge 300 ]; then
    echo "FATAL: could not acquire $LOCK_DIR after 5 minutes — another deploy/rollback appears to be stuck holding it. Investigate; remove the lock dir by hand only once you have confirmed that process is dead." >&2
    exit 68
  fi
  sleep 1
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

target="$(readlink "$RELEASES/previous")" || { echo "no previous release" >&2; exit 65; }
current="$(readlink "$RELEASES/current")"
[ -d "$target" ] || { echo "previous release $target missing" >&2; exit 65; }
[ -x "$target/packages/v1-compat/lib/mcp/server.js" ] || {
  echo "previous release cannot restore the DSH MCP boundary: $target/packages/v1-compat/lib/mcp/server.js" >&2
  exit 71
}
opsd_loaded=0
if [ -f "$OPSD_PLIST" ]; then
  if launchctl print "gui/$(id -u)/com.helium.opsd" >/dev/null 2>&1; then
    opsd_loaded=1
  fi
  for required in \
    "$target/plugins/ops-agent/lib/bin/opsd.js" \
    "$target/scripts/ops/run-opsd.sh" \
    "$target/ops/authority-manifest.json" \
    "$target/ops/authority-manifest.pub.pem" \
    "$current/scripts/release/opsd-cycle-after.mjs" \
    "$OPSD_CONFIG"; do
    [ -f "$required" ] || {
      echo "previous release cannot restore installed opsd: required asset missing: $required" >&2
      exit 71
    }
  done
  for required_dir in "$target/ops/components" "$target/ops/dependencies" "$target/ops/checks" "$target/ops/sops" "$target/ops/executors"; do
    [ -d "$required_dir" ] || {
      echo "previous release cannot restore installed opsd: required bundle directory missing: $required_dir" >&2
      exit 71
    }
  done
  node "$target/plugins/ops-agent/lib/bin/opsd.js" \
    --check-config "$OPSD_CONFIG" --release "$target" || {
      echo "previous release opsd configuration is invalid" >&2
      exit 71
    }
fi
echo "[rollback] $current -> $target"
flip_start_ms=$(node -e 'process.stdout.write(String(Date.now()))')

tmp="$RELEASES/.current.$$"
ln -sfn "$target" "$tmp"
mv -fh "$tmp" "$RELEASES/current"
if [ "$(readlink "$RELEASES/current")" != "$target" ]; then
  echo "FATAL: flip to $target FAILED — current=<unknown, verify by hand>, still expected to be $current. MANUAL INTERVENTION REQUIRED: inspect $RELEASES/current before doing anything else." >&2
  exit 66
fi
tmp="$RELEASES/.previous.$$"
ln -sfn "$current" "$tmp"
mv -fh "$tmp" "$RELEASES/previous"

# `deploy-profile.sh` is invoked with an explicit `--plugin-dir
# <release>/plugins/helium` — the specific release directory, never through
# the mutable `current` symlink — so the profile re-deploy is required on
# every rollback, independent of the still-open symlink-vs-copy question
# for pnpm's `file:` install (Task 3.3 Step 10). See deploy.sh's matching
# note for the full reasoning.
if ! bash "$target/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
     --plugin-dir "$target/plugins/helium"; then
  echo "FATAL: current=$target but the profile re-deploy FAILED — the running daemon may still be $current (its profile was never re-pointed at $target). MANUAL INTERVENTION REQUIRED: re-run 'bash $target/scripts/deploy-profile.sh --dsh-home $DSH_HOME_DIR --plugin-dir $target/plugins/helium' by hand, then 'launchctl kickstart -k gui/$(id -u)/com.helium.dsh'." >&2
  exit 69
fi
if ! launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"; then
  echo "[rollback] kickstart failed once — retrying after 3s"
  sleep 3
  if ! launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"; then
    echo "FATAL: current=$target and the profile was re-deployed, but 'launchctl kickstart -k' FAILED twice — the daemon may still be RUNNING $current. MANUAL INTERVENTION REQUIRED: run 'launchctl kickstart -k gui/$(id -u)/com.helium.dsh' by hand, then verify with 'launchctl print gui/$(id -u)/com.helium.dsh'." >&2
    exit 70
  fi
fi
if [ "$opsd_loaded" = "1" ]; then
  if ! launchctl kickstart -k "gui/$(id -u)/com.helium.opsd"; then
    echo "[rollback] opsd kickstart failed once — retrying after 3s"
    sleep 3
    if ! launchctl kickstart -k "gui/$(id -u)/com.helium.opsd"; then
      echo "FATAL: current=$target and DSH restarted, but com.helium.opsd did not restart on the compatible collector/plugin pair. MANUAL INTERVENTION REQUIRED." >&2
      exit 71
    fi
  fi
fi

end=$((SECONDS + 90)); ok=0
pid=""
while [ $SECONDS -lt $end ]; do
  sleep 10
  pid=$(launchctl print "gui/$(id -u)/com.helium.dsh" 2>/dev/null | awk '/pid =/{print $3}')
  opsd_fresh=1
  if [ "$opsd_loaded" = "1" ]; then
    opsd_fresh=$(node "$current/scripts/release/opsd-cycle-after.mjs" \
      "$OPSD_EVENT_LOG" "$flip_start_ms" "$target")
  fi
  if [ -n "$pid" ] && [ "$opsd_fresh" = "1" ]; then
    ok=1
    break
  fi
done
echo "[rollback] running pid=${pid:-none} elapsed=$(( $(date -u +%s) - started ))s"
[ "$ok" = "1" ] || exit 67
