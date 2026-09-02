#!/usr/bin/env bash
# Deploy the v2 lane (option-wizard) to the mini. Run from the laptop:
#   scripts/deploy-v2.sh
#
# Re-execs itself on the deploy host over stdin (`ssh "$HOST" ... bash -s`) so
# there is exactly one copy of this script to maintain; everything below the
# HELIUM_REMOTE guard runs on the mini and never on the laptop.
#
# No version keying and no release directory: the v2 lane deploys the tip of
# master in one checkout (doctrine 5 — deploy is minutes, not days).
set -euo pipefail

HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
# These expand on the MINI: they are read only after the re-exec.
CHECKOUT="$HOME/projects/helium-v2"
STATE_ROOT="${HELIUM_STATE_ROOT:-$HOME/.helium/state-v2}"
COUNTERS="$STATE_ROOT/reports/email-counters.json"
LABEL="com.helium.option-wizard"

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # A non-interactive ssh gets PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew,
  # so no node and no pnpm. Both prefixes are listed so this does not silently
  # depend on the CPU architecture.
  ssh "$HELIUM_HOST" \
    "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\"; HELIUM_REMOTE=1 bash -s" \
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

say "kicking $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
say "done"
