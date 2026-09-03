#!/usr/bin/env bash
# Deploy the option-wizard lane to the mini. Run from the laptop:
#   scripts/deploy.sh [phase]
#
# The optional argument names the phase to kickstart after install (default
# `premarket`); the five agents themselves are always installed.
#
# This is the SENDER and nothing else. It refuses a dirty tree, builds, tests,
# stamps the tree with a RELEASE file naming the commit, and pipes a tar of
# that tree over ssh into scripts/receive-deploy.sh on the mini. The receiver
# does everything else — extract into a release directory, flip `current`,
# reset the daily cap, reinstall the plists, kickstart, prune.
#
# The tar SHIPS node_modules and every lib/. Laptop and mini are both arm64
# macOS on node 25.x, so the installed tree — native addons included — is
# portable between them as-is. That is why the mini needs no pnpm, no node
# install step and no network during a deploy: it untars and points a symlink.
# If either machine ever stops being arm64 macOS on the same major node, this
# assumption is what breaks first, and the fix is an install step on the
# receiver, not a smarter tar.
#
# The mini's ~/.config/helium/helium.env must set HELIUM_DEPLOYMENT=production
# alongside HELIUM_TENANT_DELIVERY=1. That variable is the ONLY thing that
# removes the `[TEST] ` prefix from a delivered subject, and it defaults to
# test on purpose: an unset variable makes a production mail look like a drill,
# never the reverse.
set -euo pipefail

HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
RECEIVER="${HELIUM_RECEIVER:-\$HOME/.config/helium/receive-deploy.sh}"
PHASE="${1:-premarket}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '[deploy] %s\n' "$*"; }

# The sha names what was built, so an uncommitted edit would make the audit
# table's code_version a lie. Refusing is cheaper than wrong provenance.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy a dirty tree; commit or stash first" >&2
  git status --short >&2
  exit 1
fi

say "building"
pnpm build
say "testing"
pnpm test

SHA="$(git rev-parse --short HEAD)"
# Read by packages/cli at startup: the mini has no repository to ask, so the
# tarball has to carry its own provenance. Gitignored; never committed.
printf '%s\n' "$SHA" > RELEASE
say "sending $SHA ($PHASE) to $HELIUM_HOST"

# `git archive` cannot do this: lib/ and node_modules/ are both gitignored, and
# both are exactly what a release tree is. Excluded are the repository itself,
# the worktree backlog, the mini's own run state, and browser scratch.
tar -cz \
  --exclude='./.git' \
  --exclude='./.worktrees' \
  --exclude='./.helium*' \
  --exclude='./.playwright-mcp' \
  --exclude='.DS_Store' \
  . \
  | ssh "$HELIUM_HOST" "$RECEIVER $SHA $PHASE"

say "done"
