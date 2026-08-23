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

tmp="$RELEASES/.current.$$"
ln -sfn "$target" "$tmp"
mv -fh "$tmp" "$RELEASES/current"
[ "$(readlink "$RELEASES/current")" = "$target" ] || { echo "flip failed" >&2; exit 66; }
tmp="$RELEASES/.previous.$$"
ln -sfn "$current" "$tmp"
mv -fh "$tmp" "$RELEASES/previous"

bash "$target/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
  --plugin-dir "$target/plugins/helium"
launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"

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
