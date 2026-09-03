#!/usr/bin/env bash
# Receive one built helium tree and make it live. Runs ON the mini.
#
#   receive-deploy.sh <sha> [phase]   < tree.tar.gz
#
# This file is the source of truth; the mini runs a copy installed by hand at
# ~/.config/helium/receive-deploy.sh (same class as run-option-wizard.sh), and
# scripts/deploy.sh on the laptop names that path over ssh.
#
# The tree arrives BUILT and with node_modules already in it — laptop and mini
# are both arm64 macOS on node 25.x — so there is no install step here and the
# mini needs no pnpm, no repository and no network. It untars and moves a
# symlink. The two arguments are still validated before anything else happens:
# they are the sender's entire vocabulary and the whole surface of this path.
#
# The mini's ~/.config/helium/helium.env must set HELIUM_DEPLOYMENT=production
# alongside HELIUM_TENANT_DELIVERY=1. That variable is the ONLY thing that
# removes the `[TEST] ` prefix from a delivered subject, and it defaults to
# test on purpose: an unset variable makes a production mail look like a drill,
# never the reverse.
set -euo pipefail

# Overridable so scripts/receive-deploy.test.sh can stub the three binaries
# that would otherwise talk to a real launchd and a real plist.
LAUNCHCTL="${HELIUM_LAUNCHCTL:-launchctl}"
PLUTIL="${HELIUM_PLUTIL:-plutil}"
PYTHON3="${HELIUM_PYTHON3:-python3}"

RELEASES="${HELIUM_RELEASES_DIR:-$HOME/projects/helium-releases}"
STATE_ROOT="${HELIUM_STATE_ROOT:-$HOME/.helium/state}"
COUNTERS="$STATE_ROOT/reports/email-counters.json"
KEEP=5
# The five phased agents. Adding a phase is a new plist plus an entry here --
# never an edit anywhere else in this script.
PHASES=(premarket frank intraday close weekly)

say() { printf '[receive] %s\n' "$*"; }

# Printed, never assumed: a binary reported "absent" because a non-login ssh
# dropped /opt/homebrew/bin has already cost this project a debugging session.
say "PATH=$PATH"

SHA="${1:-}"
PHASE="${2:-premarket}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "bad sha: '$SHA'" >&2; exit 2; }
valid_phase=0
for phase in "${PHASES[@]}"; do
  if [ "$phase" = "$PHASE" ]; then valid_phase=1; fi
done
[ "$valid_phase" = 1 ] || { echo "bad phase: '$PHASE'" >&2; exit 2; }

mkdir -p "$RELEASES"
TARGET="$RELEASES/$SHA"
CURRENT="$RELEASES/current"

# Idempotent. Re-running a deploy of the same commit used to reset the daily
# email cap a second time and `kickstart -k` an in-flight run out from under
# itself; the same sha now changes nothing at all.
if [ -L "$CURRENT" ] && [ "$(basename "$(readlink "$CURRENT")")" = "$SHA" ]; then
  say "$SHA is already current — nothing to do"
  exit 0
fi

# Extract beside the final name, never into it: a half-unpacked tree that a
# launchd phase could `cd` into is the torn deploy this whole layout exists to
# prevent. Only the mv and the ln below are visible to anything else.
TMP="$RELEASES/$SHA.tmp"
rm -rf "$TMP"
mkdir -p "$TMP"
say "extracting $SHA"
tar -xzf - -C "$TMP"

rm -rf "$TARGET"
mv "$TMP" "$TARGET"

say "pointing current at $SHA"
ln -sfn "$SHA" "$CURRENT"

# The daily cap is counted from this one file, so deleting it IS the reset. A
# missing file caps LOW by design (it re-counts from zero), which is why
# removing it is safe and why nobody has to hand-edit a counter again.
say "resetting the email daily cap: $COUNTERS"
rm -f "$COUNTERS"

say "installing launch agents"
mkdir -p "$HOME/Library/LaunchAgents"
for phase in "${PHASES[@]}"; do
  label="com.helium.option-wizard-$phase"
  src="$TARGET/launchd/$label.plist"
  dst="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 66; }
  # plutil accepts files launchd rejects, so the file is parsed with plistlib
  # too before it is installed. This has already cost a debugging session.
  "$PLUTIL" -lint "$src" >/dev/null
  "$PYTHON3" -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$src"
  cp "$src" "$dst"
  "$LAUNCHCTL" bootout "gui/$(id -u)/$label" 2>/dev/null || true
  "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$dst"
done

say "kicking com.helium.option-wizard-$PHASE"
"$LAUNCHCTL" kickstart -k "gui/$(id -u)/com.helium.option-wizard-$PHASE"

# Rollback is `ln -sfn <previous sha> current` by hand, so the previous trees
# are the whole rollback mechanism -- keep enough of them to reach back past a
# bad day, and no more.
say "pruning to the newest $KEEP releases"
live="$(basename "$(readlink "$CURRENT")")"
kept=0
# `current` is a symlink, so -d skips it; a leftover .tmp is not a release.
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  case "$dir" in *.tmp) continue ;; esac
  [ -d "$RELEASES/$dir" ] && [ ! -L "$RELEASES/$dir" ] || continue
  if [ "$kept" -lt "$KEEP" ] || [ "$dir" = "$live" ]; then
    kept=$((kept + 1))
    continue
  fi
  say "pruning $dir"
  rm -rf "${RELEASES:?}/$dir"
done < <(ls -1t "$RELEASES" 2>/dev/null)

say "done: $SHA ($PHASE)"
