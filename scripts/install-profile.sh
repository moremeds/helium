#!/usr/bin/env bash
# Install (or re-point) the `helium` DSH profile at this checkout's bundles.
#
#   scripts/install-profile.sh [bundle ...]     default: every bundles/*
#
# $DSH_HOME (sessions, storages, the helium state db) stays where it is; only
# the profile's links move. Run it after every deploy: the profile links to
# a release directory by path, and a new release is a new path.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
dsh="$repo/node_modules/.bin/dsh"
profile="${HELIUM_PROFILE:-helium}"
[ -x "$dsh" ] || { echo "no $dsh; run pnpm install first" >&2; exit 1; }
if [ "$#" -eq 0 ]; then set -- $(cd "$repo/bundles" && ls); fi
for b in "$@"; do
  [ -f "$repo/bundles/$b/lib/../package.json" ] || { echo "no bundle $b" >&2; exit 1; }
  [ -d "$repo/bundles/$b/lib" ] || { echo "bundle $b is not built; run pnpm build" >&2; exit 1; }
done
# helium-base first: product bundles patch on top of it.
ordered=(helium-base)
for b in "$@"; do [ "$b" = helium-base ] || ordered+=("$b"); done
for b in "${ordered[@]}"; do
  "$dsh" plugin --profile "$profile" add "link:$repo/bundles/$b" >/dev/null
done
echo "profile $profile -> $repo (${ordered[*]})"
