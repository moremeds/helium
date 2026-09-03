#!/usr/bin/env bash
# Deploy the v2 lane (option-wizard) to the mini. Run from the laptop:
#   scripts/deploy-v2.sh [phase]
#
# The optional argument names the phase to kickstart after install (default
# `premarket`); the five agents themselves are always installed.
#
# Re-execs itself on the deploy host over stdin (`ssh "$HOST" ... bash -s`) so
# there is exactly one copy of this script to maintain; everything below the
# HELIUM_REMOTE guard runs on the mini and never on the laptop.
#
# No version keying and no release directory: the v2 lane deploys the tip of
# master in one checkout (doctrine 5 — deploy is minutes, not days).
#
# The mini's ~/.config/helium/helium.env must set HELIUM_DEPLOYMENT=production
# alongside HELIUM_TENANT_DELIVERY=1. That variable is the ONLY thing that
# removes the `[TEST] ` prefix from a delivered subject, and it defaults to
# test on purpose: an unset variable makes a production mail look like a drill,
# never the reverse.
set -euo pipefail

HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
# These expand on the MINI: they are read only after the re-exec.
CHECKOUT="$HOME/projects/helium-v2"
STATE_ROOT="${HELIUM_STATE_ROOT:-$HOME/.helium/state-v2}"
COUNTERS="$STATE_ROOT/reports/email-counters.json"
# The five phased agents. Adding a phase is a new plist plus an entry here --
# never an edit anywhere else in this script.
PHASES=(premarket frank intraday close weekly)
KICK_PHASE="${1:-premarket}"

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # A non-interactive ssh gets PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew,
  # so no node and no pnpm. Both prefixes are listed so this does not silently
  # depend on the CPU architecture.
  ssh "$HELIUM_HOST" \
    "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\"; HELIUM_REMOTE=1 bash -s -- \"$KICK_PHASE\"" \
    < "$0"
  exit $?
fi

# ---- everything below runs ON the mini ----
say() { printf '[deploy-v2] %s\n' "$*"; }

# Printed, never assumed: a binary reported "absent" because a non-login ssh
# dropped /opt/homebrew/bin has already cost this project a debugging session.
say "PATH=$PATH"
say "node=$(command -v node || echo MISSING) pnpm=$(command -v pnpm || echo MISSING)"
command -v node >/dev/null || { echo "node not on PATH" >&2; exit 127; }
command -v pnpm >/dev/null || { echo "pnpm not on PATH" >&2; exit 127; }

[ -d "$CHECKOUT/.git" ] || { echo "no checkout at $CHECKOUT" >&2; exit 66; }
say "updating $CHECKOUT"
git -C "$CHECKOUT" pull --ff-only
say "at $(git -C "$CHECKOUT" rev-parse --short HEAD) on $(git -C "$CHECKOUT" rev-parse --abbrev-ref HEAD)"

say "installing and building"
pnpm --dir "$CHECKOUT" install --frozen-lockfile
pnpm --dir "$CHECKOUT" build

# The daily cap is counted from this one file, so deleting it IS the reset. A
# missing file caps LOW by design (it re-counts from zero), which is why
# removing it is safe and why nobody has to hand-edit a counter again.
say "resetting the email daily cap: $COUNTERS"
rm -f "$COUNTERS"

say "installing launch agents"
mkdir -p "$HOME/Library/LaunchAgents"
for phase in "${PHASES[@]}"; do
  label="com.helium.option-wizard-$phase"
  src="$CHECKOUT/launchd/$label.plist"
  dst="$HOME/Library/LaunchAgents/$label.plist"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 66; }
  # plutil accepts files launchd rejects, so the file is parsed with plistlib
  # too before it is installed. This has already cost a debugging session.
  plutil -lint "$src" >/dev/null
  python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$src"
  cp "$src" "$dst"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
done

# The single old agent is replaced by the five phased ones. Unloading it here
# rather than by hand is what keeps a second scheduler from firing an unphased
# run alongside them.
launchctl bootout "gui/$(id -u)/com.helium.option-wizard" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.helium.option-wizard.plist"

say "kicking com.helium.option-wizard-$KICK_PHASE"
launchctl kickstart -k "gui/$(id -u)/com.helium.option-wizard-$KICK_PHASE"
say "done"
