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

# Serialize everything from here on (flip, kickstart, health window, any
# flip-back, prune) against a concurrent deploy.sh or rollback.sh (fix
# round 1, IMPORTANT 3). macOS has no `flock` command — confirmed absent on
# this machine (util-linux only, not BSD/macOS userland) — so this uses
# `mkdir`'s atomicity instead: POSIX mkdir(2) is a single atomic
# create-or-EEXIST syscall, the same mutual-exclusion guarantee flock(1)
# would give here. Released automatically on any exit path via the trap.
LOCK_DIR="$RELEASES/.flip.lock"
lock_tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  lock_tries=$((lock_tries + 1))
  if [ "$lock_tries" -ge 300 ]; then
    echo "FATAL: could not acquire $LOCK_DIR after 5 minutes — another deploy/rollback appears to be stuck holding it. Investigate; remove the lock dir by hand only once you have confirmed that process is dead." >&2
    exit 73
  fi
  sleep 1
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

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

# `deploy-profile.sh` is always invoked with an explicit `--plugin-dir
# <release>/plugins/helium` — the SPECIFIC release directory, never through
# the mutable `current` symlink. That means the profile re-deploy below is
# REQUIRED on every flip, forward or back, regardless of whether pnpm's
# `file:` install symlinks or copies the plugin (the open question from
# Task 3.3 Step 10 does not change this): the release directory itself
# changes on a flip-back, so the profile must be re-pointed at the (old)
# plugin path either way. Decided and documented here per fix round 1's
# IMPORTANT 2; the simpler "flip symlink + kickstart only" alternative does
# not apply.
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
  say "HEALTH WINDOW FAILED"
  # fix round 1, IMPORTANT 1: on a bootstrap/first-ever deploy `current` had
  # no prior target, so prev_target is empty here. `flip_to ""` would
  # "succeed" (ln -sfn "" tmp; mv -fh tmp current both exit 0, and the
  # got==target check passes because both sides are "") while leaving
  # `current` as a BROKEN empty symlink — reproduced empirically on this
  # OS. Guard it explicitly and refuse to touch the symlink at all.
  if [ -z "$prev_target" ]; then
    echo "FATAL: no previous release to flip back to (this looks like a bootstrap/first-ever deploy — 'current' had no prior target). Leaving current -> $VERSION UNCHANGED (new release, but it failed its health window) rather than risk corrupting the symlink with an empty flip. An operator must investigate $VERSION by hand (heartbeat/runs JSONL, the daemon's own logs) before retrying." >&2
    exit 69
  fi
  say "flipping back to $prev_target"
  # fix round 1, IMPORTANT 2: the flip-back is 3 non-atomic steps under
  # set -e (symlink flip, profile re-deploy, kickstart). Each is checked
  # individually below with a message naming the exact inconsistency, so a
  # partial failure is loud and unambiguous rather than a bare set -e exit.
  if ! flip_to "$prev_target"; then
    echo "FATAL: flip-back symlink update to $prev_target FAILED — current=<unknown, verify by hand> but the daemon is still running $VERSION. MANUAL INTERVENTION REQUIRED: inspect $RELEASES/current, re-point it at $prev_target if needed (ln -sfn $prev_target $RELEASES/current), then run: launchctl kickstart -k gui/$(id -u)/com.helium.dsh" >&2
    exit 70
  fi
  if ! bash "$prev_target/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
       --plugin-dir "$prev_target/plugins/helium"; then
    echo "FATAL: current=$prev_target but the profile re-deploy FAILED — the running daemon may still be $VERSION (its profile was never re-pointed at $prev_target). MANUAL INTERVENTION REQUIRED: re-run 'bash $prev_target/scripts/deploy-profile.sh --dsh-home $DSH_HOME_DIR --plugin-dir $prev_target/plugins/helium' by hand, then 'launchctl kickstart -k gui/$(id -u)/com.helium.dsh'." >&2
    exit 71
  fi
  if ! launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"; then
    say "kickstart failed once — retrying after 3s"
    sleep 3
    if ! launchctl kickstart -k "gui/$(id -u)/com.helium.dsh"; then
      echo "FATAL: current=$prev_target and the profile was re-deployed, but 'launchctl kickstart -k' FAILED twice — the daemon may still be RUNNING the unhealthy $VERSION build even though current and the profile now point at $prev_target. MANUAL INTERVENTION REQUIRED: run 'launchctl kickstart -k gui/$(id -u)/com.helium.dsh' by hand, then verify with 'launchctl print gui/$(id -u)/com.helium.dsh'." >&2
      exit 72
    fi
  fi
  say "flip-back to $prev_target complete: symlink flipped, profile re-deployed, daemon kickstarted"
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
