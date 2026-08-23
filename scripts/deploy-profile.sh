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

echo "deploy-profile: building dsh-plugin-helium"
pnpm -C "$REPO_ROOT" -F dsh-plugin-helium build

PLUGIN_ABS="$(cd "$PLUGIN_DIR" && pwd)"
if [ ! -f "$PLUGIN_ABS/lib/index.js" ]; then
  echo "deploy-profile: $PLUGIN_ABS/lib/index.js missing after build" >&2
  exit 1
fi

PROFILE_DIR="$DSH_HOME_ABS/profiles/helium"
mkdir -p "$PROFILE_DIR"

sed "s|__HELIUM_PLUGIN_DIR__|$PLUGIN_ABS|" "$REPO_ROOT/profile/package.json" > "$PROFILE_DIR/package.json"
cp "$REPO_ROOT/profile/cordis.yml" "$PROFILE_DIR/cordis.yml"
cp "$REPO_ROOT/profile/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"

# dsh's own initProfile writes exactly this file
# (packages/boot/app-boot/src/profile.ts). A hand-built profile that omits it
# gets duplicate cordis copies instead of the installation's single instance.
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML

rm -rf "$PROFILE_DIR/node_modules" "$PROFILE_DIR/pnpm-lock.yaml"

echo "deploy-profile: installing profile at $PROFILE_DIR"
pnpm -C "$PROFILE_DIR" install

echo "deploy-profile: helium profile ready at $PROFILE_DIR"
