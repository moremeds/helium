#!/usr/bin/env bash
# Stage-1 install of v3 on the mini, BESIDE the live v2 release:
#   scripts/install-mini-v3.sh [smoke]
#
# Writes only ~/projects/helium-v3-releases/<sha> and the separate DSH home
# ~/.helium-v3/dsh (profile, sessions, helium state db). It never touches
# ~/projects/helium-releases/current, the launchd agents or the hand-installed
# receive-deploy.sh: the v2 option-wizard keeps running until stage 2 cuts
# over. Ships node_modules like deploy.sh (both machines are arm64 macOS on
# node 25). `smoke` then runs the smoke bundle once with real Claude through
# the mini's proxy; it delivers markdown only.
set -euo pipefail
host="${HELIUM_DEPLOY_HOST:-macmini}"
root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$root"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing a dirty tree; commit first" >&2; git status --short >&2; exit 1
fi
pnpm build >/dev/null
pnpm test >/dev/null
sha="$(git rev-parse --short HEAD)"
printf '%s\n' "$sha" > RELEASE
trap 'rm -f RELEASE' EXIT
dest="projects/helium-v3-releases/$sha"
remote_env='export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH DSH_HOME=$HOME/.helium-v3/dsh'
echo "[v3] sending $sha to $host:~/$dest"
tar -cz --exclude=./.git --exclude=./.worktrees --exclude='./.helium*' --exclude=.DS_Store . \
  | ssh "$host" "$remote_env; mkdir -p ~/$dest && tar -xzf - -C ~/$dest && ~/$dest/scripts/install-profile.sh"
if [ "${1:-}" = smoke ]; then
  ssh "$host" "set -a; . ~/.config/helium/helium.env; . ~/.config/helium/claude-token.env; set +a; $remote_env; unset HELIUM_STATE_ROOT HELIUM_PROFILE;
    mkdir -p ~/.helium-v3/run && cd ~/.helium-v3/run && ~/$dest/scripts/helium run smoke --phase close"
fi
