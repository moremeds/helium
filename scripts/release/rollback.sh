#!/usr/bin/env bash
# Roll back to the previous helium release. Run from the laptop: rollback.sh
#
# Same self-ssh re-exec trick as deploy.sh. Measures and prints its own wall
# time because AC#6 is a stopwatch criterion (< 60s laptop-observed).
set -euo pipefail
RELEASES=/Users/moremeds/projects/helium-releases
DSH_HOME_DIR=/Users/moremeds/.helium/dsh-home

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  ssh macmini 'export PATH="$HOME/.local/bin:$PATH"; HELIUM_REMOTE=1 bash -s' < "$0"
  exit $?
fi
started=$(date -u +%s)
target="$(readlink "$RELEASES/previous")" || { echo "no previous release" >&2; exit 65; }
current="$(readlink "$RELEASES/current")"
[ -d "$target" ] || { echo "previous release $target missing" >&2; exit 65; }
echo "[rollback] $current -> $target"

# Serialize the flip/kickstart sequence against a concurrent deploy.sh or
# rollback.sh (fix round 1, IMPORTANT 3) — same mkdir-based lock as
# deploy.sh (macOS has no `flock` command; POSIX mkdir(2) is atomic).
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

end=$((SECONDS + 90)); ok=0
pid=""
while [ $SECONDS -lt $end ]; do
  sleep 10
  pid=$(launchctl print "gui/$(id -u)/com.helium.dsh" 2>/dev/null | awk '/pid =/{print $3}')
  if [ -n "$pid" ]; then
    ok=1
    break
  fi
done
echo "[rollback] running pid=${pid:-none} elapsed=$(( $(date -u +%s) - started ))s"
[ "$ok" = "1" ] || exit 67
