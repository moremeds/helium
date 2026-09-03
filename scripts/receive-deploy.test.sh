#!/usr/bin/env bash
# Tests for scripts/receive-deploy.sh. Plain bash, no framework:
#
#   bash scripts/receive-deploy.test.sh
#
# The receiver is the one piece of the release path that runs unattended on the
# mini, so its argument validation, its idempotence and its pruning are worth a
# test that runs in CI, where a real launchd and a real plutil are absent.
# Everything it shells out to is overridable (HELIUM_LAUNCHCTL and friends)
# exactly so this file can stub it.
set -uo pipefail

RECEIVER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/receive-deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

ok() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: expected '$3', got '$2'"; fi; }

# --- stubs -------------------------------------------------------------------
BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/launchctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG/launchctl"
STUB
cat > "$BIN/plutil" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG/plutil"
STUB
chmod +x "$BIN/launchctl" "$BIN/plutil"
export STUB_LOG="$WORK/log"
mkdir -p "$STUB_LOG"

# --- a minimal release tarball ----------------------------------------------
# Only what the receiver reads: the five plists. They must be real plists,
# because the receiver parses each with plistlib and that is not stubbed.
TREE="$WORK/tree"
mkdir -p "$TREE/launchd"
for phase in premarket frank intraday close weekly; do
  cat > "$TREE/launchd/com.helium.option-wizard-$phase.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.helium.option-wizard-$phase</string>
</dict></plist>
PLIST
done
TARBALL="$WORK/tree.tar.gz"
tar -cz -C "$TREE" -f "$TARBALL" .

# --- a fresh $HOME per case --------------------------------------------------
HOMEDIR=""
reset_home() {
  HOMEDIR="$WORK/home"
  rm -rf "$HOMEDIR"
  mkdir -p "$HOMEDIR/projects/helium-releases" "$HOMEDIR/.helium/state/reports"
  printf '{}\n' > "$HOMEDIR/.helium/state/reports/email-counters.json"
  rm -rf "$STUB_LOG"
  mkdir -p "$STUB_LOG"
}

receive() { # receive <sha> [phase] -- feeds the tarball on stdin
  HOME="$HOMEDIR" \
  HELIUM_RELEASES_DIR="$HOMEDIR/projects/helium-releases" \
  HELIUM_STATE_ROOT="$HOMEDIR/.helium/state" \
  HELIUM_LAUNCHCTL="$BIN/launchctl" \
  HELIUM_PLUTIL="$BIN/plutil" \
    bash "$RECEIVER" "$@" < "$TARBALL" > "$WORK/out" 2>&1
}

counters() { [ -f "$HOMEDIR/.helium/state/reports/email-counters.json" ] && echo present || echo gone; }
current() { basename "$(readlink "$HOMEDIR/projects/helium-releases/current" 2>/dev/null)" 2>/dev/null; }

# --- 1. a sha that is not a sha is refused before anything happens -----------
reset_home
receive "not-a-sha" premarket; check "bad sha exits 2" "$?" "2"
receive "deadbee" "wednesday"; check "bad phase exits 2" "$?" "2"
receive "" ; check "missing sha exits 2" "$?" "2"
check "a refused deploy touched no counters" "$(counters)" "present"

# --- 2. a new sha goes live --------------------------------------------------
reset_home
receive "aaaaaaa" close; check "first deploy succeeds" "$?" "0"
check "current points at the new sha" "$(current)" "aaaaaaa"
check "the release tree landed" "$([ -f "$HOMEDIR/projects/helium-releases/aaaaaaa/launchd/com.helium.option-wizard-close.plist" ] && echo yes || echo no)" "yes"
check "no .tmp directory was left behind" "$([ -e "$HOMEDIR/projects/helium-releases/aaaaaaa.tmp" ] && echo yes || echo no)" "no"
check "the daily cap was reset" "$(counters)" "gone"
check "all five plists were installed" "$(ls -1 "$HOMEDIR/Library/LaunchAgents" | wc -l | tr -d ' ')" "5"
check "the requested phase was kickstarted" \
  "$(grep -c 'kickstart -k gui/.*/com.helium.option-wizard-close$' "$STUB_LOG/launchctl")" "1"

# --- 3. the same sha again is a no-op ---------------------------------------
printf '{}\n' > "$HOMEDIR/.helium/state/reports/email-counters.json"
rm -f "$STUB_LOG/launchctl"
receive "aaaaaaa" close; check "same sha exits 0" "$?" "0"
check "same sha did not reset the cap" "$(counters)" "present"
check "same sha kickstarted nothing" "$([ -f "$STUB_LOG/launchctl" ] && echo yes || echo no)" "no"

# --- 4. pruning keeps the newest five ---------------------------------------
reset_home
for n in 1 2 3 4 5 6 7; do
  mkdir -p "$HOMEDIR/projects/helium-releases/000000$n"
  # Distinct mtimes so `ls -t` has a real order to work with.
  touch -t "20260101000${n}" "$HOMEDIR/projects/helium-releases/000000$n"
done
receive "bbbbbbb" premarket; check "deploy over seven old releases succeeds" "$?" "0"
kept="$(find "$HOMEDIR/projects/helium-releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
check "pruned to five release directories" "$kept" "5"
check "the live release survived pruning" "$(current)" "bbbbbbb"
check "the oldest release was pruned" "$([ -d "$HOMEDIR/projects/helium-releases/0000001" ] && echo yes || echo no)" "no"

if [ "$failures" -ne 0 ]; then
  printf '\n%s test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall receive-deploy tests passed\n'
