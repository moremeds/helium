#!/usr/bin/env bash
# Build dsh-plugin-helium and install the helium profile into a $DSH_HOME.
#
# Spec §9.2: plugins install with `file:` semantics and compiled JS. `file:`
# makes pnpm COPY the plugin, so the copy must be removed before reinstall or
# a rebuilt lib/ never reaches the profile — that is the build → remove → add
# loop the 2026-08-23 spike identified as the main friction point.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME_ARG=""
PLUGIN_DIR="$REPO_ROOT/plugins/helium"

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME_ARG="${2:-}"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="${2:-}"; shift 2 ;;
    *) echo "deploy-profile: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DSH_HOME_ARG" ]; then
  echo "deploy-profile: --dsh-home <dir> is required" >&2
  exit 2
fi

mkdir -p "$DSH_HOME_ARG"
DSH_HOME_ABS="$(cd "$DSH_HOME_ARG" && pwd)"

PLUGIN_ABS="$(cd "$PLUGIN_DIR" && pwd)"

echo "deploy-profile: building plugin at $PLUGIN_ABS"
pnpm -C "$PLUGIN_ABS" build

if [ ! -f "$PLUGIN_ABS/lib/index.js" ]; then
  echo "deploy-profile: $PLUGIN_ABS/lib/index.js missing after build" >&2
  exit 1
fi

PROFILE_DIR="$DSH_HOME_ABS/profiles/helium"
mkdir -p "$PROFILE_DIR"

# profile/package.json lists @deepseek-ai/dsh-web-app in BOTH dsh.profile.bundles
# and dependencies: the bundle list alone is not resolvable by pnpm, and without
# the bundle nothing serves :3080 — the daemon boots and runs jobs perfectly
# silently, which is how it went unnoticed until the mini brought it up (task
# 3.3 step 18). The version is pinned deliberately: the package's npm `latest`
# dist-tag (0.0.1-rc.1) is stale and 404s on a renamed dependency, so the build
# must be pinned to the same exact version as DSH_PIN rather than to a tag.
# Historical: Spike A (task 1.7) took the 0.1.1-rc.2-matching build from `next`.
# That instruction expired — re-measured 2026-09-01, dsh-web-app dist-tags are
# {latest: 0.0.1-rc.1, next: 0.1.1-rc.2, alpha: 0.1.2-alpha.3}, so following
# `next` today yields the PREVIOUS version. Track DSH_PIN, not a dist-tag.
sed "s|__HELIUM_PLUGIN_DIR__|$PLUGIN_ABS|" "$REPO_ROOT/profile/package.json" > "$PROFILE_DIR/package.json"
cp "$REPO_ROOT/profile/cordis.yml" "$PROFILE_DIR/cordis.yml"
cp "$REPO_ROOT/profile/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"

# dsh's own initProfile writes exactly this file
# (packages/boot/app-boot/src/profile.ts). A hand-built profile that omits it
# gets duplicate cordis copies instead of the installation's single instance.
# allowBuilds mirrors the root workspace's list (task 1.7 ruling: exactly these
# packages, never a wildcard). The profile install pulls the same dsh native
# tree, and pnpm 11 FAILS the install outright (ERR_PNPM_IGNORED_BUILDS) rather
# than warning when a dependency wants a build script and no policy covers it —
# so omitting them here aborts deploy-profile.sh under set -e.
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  esbuild: true
  koffi: true
  node-pty: true
  protobufjs: true
  "@google/genai": true
  "@deepseek-ai/dsh-subprocess-local": true
YAML

rm -rf "$PROFILE_DIR/node_modules" "$PROFILE_DIR/pnpm-lock.yaml"

echo "deploy-profile: installing profile at $PROFILE_DIR"
pnpm -C "$PROFILE_DIR" install

echo "deploy-profile: helium profile ready at $PROFILE_DIR"
