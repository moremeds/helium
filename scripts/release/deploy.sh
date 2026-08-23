#!/usr/bin/env bash
# Deploy a tagged helium release to the mini. Run from the laptop:
#   scripts/release/deploy.sh v0.1.0
#
# Re-execs itself on the mini over stdin (`ssh macmini ... bash -s -- "$VERSION" < "$0"`)
# so there is exactly one copy of this script to maintain; everything below
# the HELIUM_REMOTE guard runs on the mini, never on the laptop.
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: deploy.sh vX.Y.Z" >&2; exit 64; }

RELEASES=/Users/moremeds/projects/helium-releases
SRC=/Users/moremeds/projects/helium
DSH_HOME_DIR=/Users/moremeds/.helium/dsh-home
STATE_ROOT=/Users/moremeds/.helium/state
DSH_PIN=0.1.1-rc.2
KEEP=5

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # shellcheck disable=SC2029 # $VERSION deliberately expands client-side: it
  # is the argv the mini's `bash -s --` receives, already validated above.
  ssh macmini "export PATH=\"\$HOME/.local/bin:\$PATH\"; HELIUM_REMOTE=1 bash -s -- $VERSION" < "$0"
  exit $?
fi
# ---- everything below runs ON the mini ----
say() { printf '[deploy %s] %s\n' "$VERSION" "$*"; }

say "fetching tags"
git -C "$SRC" fetch --tags --prune --quiet
git -C "$SRC" rev-parse -q --verify "refs/tags/$VERSION^{commit}" >/dev/null \
  || { echo "tag $VERSION not found in $SRC" >&2; exit 65; }

DEST="$RELEASES/$VERSION"
if [ -d "$DEST" ]; then
  say "release dir already exists — reusing (immutable by construction)"
else
  mkdir -p "$DEST.partial"
  git -C "$SRC" archive "$VERSION" | tar -x -C "$DEST.partial"
  mv "$DEST.partial" "$DEST"
fi
say "installing"
( cd "$DEST" && pnpm install --frozen-lockfile && pnpm build )
installed=$(node -p "require('$DEST/node_modules/@deepseek-ai/dsh/package.json').version")
[ "$installed" = "$DSH_PIN" ] || { echo "dsh pin drift: $installed" >&2; exit 66; }
say "dsh pin ok: $installed"

say "contract smoke (one live deepseek-v4-flash call)"
smoke_home="$(mktemp -d -t helium-smoke)"
if ! (
  cd "$DEST"
  set -a
  # shellcheck disable=SC1091 # mini-only secrets file, never present on the laptop.
  . /Users/moremeds/.config/helium/helium.env
  set +a
  HELIUM_LIVE=1 DSH_HOME="$smoke_home" pnpm -F @helium/contracts test
); then
  echo "contract smoke FAILED — aborting before flip" >&2
  exit 67
fi

say "deploying profile (plugin resolved from $DEST)"
bash "$DEST/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
  --plugin-dir "$DEST/plugins/helium"

say "draining in-flight dispatches (max 120s)"
end=$((SECONDS + 120))
while [ $SECONDS -lt $end ]; do
  n=$(HELIUM_STATE_ROOT="$STATE_ROOT" node "$DEST/scripts/release/inflight.mjs")
  [ "$n" = "0" ] && break
  say "  $n in flight"
  sleep 5
done
n=$(HELIUM_STATE_ROOT="$STATE_ROOT" node "$DEST/scripts/release/inflight.mjs")
[ "$n" = "0" ] || say "WARNING: proceeding with $n dispatch(es) still in flight"

# `mv -fh` is the macOS-correct idiom: `-h` stops `mv` from following the
# existing `current` symlink into its target directory, so the rename is
# atomic (a plain `mv` would instead move the new symlink INSIDE the old
# target directory when `current` already points at one).
flip_to() {
  local target="$1" tmp="$RELEASES/.current.$$"
  ln -sfn "$target" "$tmp"
  mv -fh "$tmp" "$RELEASES/current"
  local got; got="$(readlink "$RELEASES/current")"
  [ "$got" = "$target" ] || { echo "flip verification failed: current -> $got" >&2; return 1; }
}
prev_target="$(readlink "$RELEASES/current" || true)"
if [ -n "$prev_target" ]; then
  ln -sfn "$prev_target" "$RELEASES/.previous.$$"
  mv -fh "$RELEASES/.previous.$$" "$RELEASES/previous"
fi

flip_start=$(date -u +%s)
flip_to "$DEST"
say "flipped current -> $VERSION; restarting daemon"
launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"

say "post-flip health window (2 heartbeat intervals)"
ok=0; end=$((SECONDS + 180))
while [ $SECONDS -lt $end ]; do
  sleep 15
  fresh=$(HELIUM_STATE_ROOT="$STATE_ROOT" node -e '
    const {readFileSync,readdirSync}=require("node:fs");const {join}=require("node:path");
    const d=join(process.env.HELIUM_STATE_ROOT,"jsonl");
    const f=readdirSync(d).filter(x=>x.startsWith("heartbeat-")).sort().pop();
    const since=Number(process.argv[1])*1000;
    const n=readFileSync(join(d,f),"utf8").split("\n").filter(Boolean)
      .filter(l=>{try{return Date.parse(JSON.parse(l).ts)>since;}catch{return false;}}).length;
    console.log(n);' "$flip_start")
  say "  heartbeat rows since flip: $fresh"
  if [ "$fresh" -ge 2 ]; then
    ok=1
    break
  fi
done
if [ "$ok" != "1" ]; then
  say "HEALTH WINDOW FAILED — flipping back to $prev_target"
  flip_to "$prev_target"
  bash "$prev_target/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
    --plugin-dir "$prev_target/plugins/helium"
  launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"
  exit 68
fi

say "pruning old releases (keep $KEEP)"
keep_now="$(basename "$(readlink "$RELEASES/current")")"
keep_prev="$(basename "$(readlink "$RELEASES/previous" 2>/dev/null || echo "")")"
# shellcheck disable=SC2012 # release dir names are always `vX.Y.Z` (no
# whitespace/glob chars), and `ls -t` is the simplest correct mtime sort here.
ls -1dt "$RELEASES"/v*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  base="$(basename "$old")"
  [ "$base" = "$keep_now" ] && continue
  [ "$base" = "$keep_prev" ] && continue
  say "  removing $base"
  rm -rf "$old"
done
say "DEPLOY OK: $VERSION"
