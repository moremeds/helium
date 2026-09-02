#!/usr/bin/env bash
# Deploy a tagged helium release to the mini. Run from the laptop:
#   scripts/release/deploy.sh v0.1.0
#
# Re-execs itself on the deploy host over stdin (`ssh "$HELIUM_HOST" ... bash -s`)
# so there is exactly one copy of this script to maintain; everything below
# the HELIUM_REMOTE guard runs on the mini, never on the laptop.
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: deploy.sh vX.Y.Z" >&2; exit 64; }

# The deploy host is the one thing not derivable, so it is the one knob.
# Everything else hangs off `$HOME`: these assignments run on both machines but
# are read only after the re-exec, so they resolve against the DEPLOY HOST's
# home, not the laptop's. That is the same expansion the ssh line below already
# depends on (it escapes \$HOME so the remote resolves ~/.local/bin), so no new
# assumption is introduced here.
HELIUM_HOST="${HELIUM_DEPLOY_HOST:-macmini}"
RELEASES="$HOME/projects/helium-releases"
SRC="$HOME/projects/helium"
DSH_HOME_DIR="$HOME/.helium/dsh-home"
STATE_ROOT="$HOME/.helium/state"
OPSD_PLIST="$HOME/Library/LaunchAgents/com.helium.opsd.plist"
DSH_PLIST="$HOME/Library/LaunchAgents/com.helium.dsh.plist"
OPSD_CONFIG="$HOME/.helium/ops/config/opsd.json"
OPSD_EVENT_LOG="$HOME/.helium/ops/state/events.jsonl"
RENDERED_PLIST="$RELEASES/.dsh-plist.$VERSION.rendered"
PLIST_BACKUP_DIR="$RELEASES/.dsh-plist-backups"
DSH_PIN=0.1.2-alpha.3
KEEP=5

if [ "${HELIUM_REMOTE:-0}" != "1" ]; then
  # shellcheck disable=SC2029 # $VERSION deliberately expands client-side: it
  # is the argv the mini's `bash -s --` receives, already validated above.
  # A non-interactive `ssh` gets PATH=/usr/bin:/bin:/usr/sbin:/sbin —
  # no Homebrew, so no `node` and no `pnpm` (verified on the mini: the 3.5 drill's
  # first deploy died at `pnpm: command not found`, exit 127). Only ~/.local/bin
  # was prepended here, which holds `claude` but not the toolchain. Both Homebrew
  # prefixes are listed so this does not silently depend on the CPU architecture.
  # It fails closed if ever dropped again: this runs before any flip, so a missing
  # toolchain aborts the deploy with `current` still pointing at the old release.
  ssh "$HELIUM_HOST" "export PATH=\"/Applications/ChatGPT.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH\"; HELIUM_REMOTE=1 bash -s -- $VERSION" < "$0"
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
  # Exclude only the MANIFEST that makes the seam fixture a tenant, never the
  # directory: plugins/fake-tenant is a workspace package the lockfile lists as
  # an importer, and dropping it fails `pnpm install --frozen-lockfile` on every
  # deploy. loadTenants globs plugins/*/tenant.yaml, so the package still
  # installs and builds while the release contains no such tenant at all.
  git -C "$SRC" archive "$VERSION" \
    | tar -x --exclude='plugins/fake-tenant/tenant.yaml' -C "$DEST.partial"
  mv "$DEST.partial" "$DEST"
fi
say "installing"
( cd "$DEST" && pnpm install --frozen-lockfile && pnpm build )
installed=$(node -p "require('$DEST/node_modules/@deepseek-ai/dsh/package.json').version")
[ "$installed" = "$DSH_PIN" ] || { echo "dsh pin drift: $installed" >&2; exit 66; }
say "dsh pin ok: $installed"
mcp_bin="$DEST/plugins/helium/lib/mcp/server.js"
[ -x "$mcp_bin" ] || {
  echo "release MCP boundary missing or not executable: $mcp_bin" >&2
  exit 76
}

# An already-installed opsd follows the same immutable `current` release as
# the collector/plugin. Refuse the flip if the new release cannot provide the
# pair. This does not install or load opsd; installation remains a separate
# post-AC#1 operator command.
if [ -f "$OPSD_PLIST" ]; then
  for required in \
    "$DEST/plugins/ops-agent/lib/bin/opsd.js" \
    "$DEST/scripts/ops/run-opsd.sh" \
    "$DEST/ops/authority-manifest.json" \
    "$DEST/ops/authority-manifest.pub.pem" \
    "$OPSD_CONFIG"; do
    [ -f "$required" ] || {
      echo "installed opsd is incompatible with $VERSION: required asset missing: $required" >&2
      exit 76
    }
  done
  for required_dir in "$DEST/ops/components" "$DEST/ops/dependencies" "$DEST/ops/checks" "$DEST/ops/sops" "$DEST/ops/executors"; do
    [ -d "$required_dir" ] || {
      echo "installed opsd is incompatible with $VERSION: required bundle directory missing: $required_dir" >&2
      exit 76
    }
  done
  node "$DEST/plugins/ops-agent/lib/bin/opsd.js" \
    --check-config "$OPSD_CONFIG" --release "$DEST" || {
      echo "installed opsd configuration is invalid for $VERSION" >&2
      exit 76
    }
fi

# Validate every tenant BEFORE the flip, through loadValidatedTenants() -- the
# SAME entry point startup uses. At runtime a bad tenant is skipped and the rest
# keep running, which is right for availability and wrong for a deploy: a
# silently skipped tenant is its own hazard. Here any skip fails the deploy with
# `current` untouched, instead of being discovered after the launchd flip.
# (3.7 AC#2 drill: a stray `dedup_ttl:` key crash-looped the daemon for 2m12s.)
say "validating tenant files"
if ! node "$DEST/scripts/release/validate-tenants.mjs" "$DEST"; then
  echo "tenant validation FAILED — aborting before flip" >&2
  exit 75
fi

# The plist is the KEY SET the daemon runs with, and launchd only re-reads it on
# bootout+bootstrap. Until v0.1.13 the deploy never owned this file: the operator
# installed it by hand, so v0.1.13's code started with v0.1.11's environment (no
# HELIUM_TENANTS_DIR), the plugin's config parse failed, not one heartbeat was
# written, and the health window rolled a good release back. The deploy now
# renders the plist from the release it is about to install.
say "rendering the DSH plist from $VERSION"
if ! bash "$DEST/scripts/release/install-dsh-plist.sh" render \
  --release-dir "$DEST" --releases-dir "$RELEASES" \
  --out "$RENDERED_PLIST" --installed "$DSH_PLIST"; then
  echo "could not render the DSH plist for $VERSION — aborting before flip" >&2
  exit 76
fi

# A release that moves or deletes a path the plist names leaves the daemon
# pointing at nothing. launchd restarts it, the process looks alive, and it serves
# zero tools -- silently, which is the worst shape a production failure can take.
# (v0.1.11 -> the tenant lane: HELIUM_MCP_BIN pointed into packages/v1-compat,
# which that release deletes.) Checked against the RENDERED plist -- the file
# about to be installed -- not the stale installed one.
say "checking the rendered DSH plist against $VERSION"
if ! node "$DEST/scripts/release/check-plist-paths.mjs" \
  "$RENDERED_PLIST" "$RELEASES" "$DEST"; then
  echo "DSH plist references paths $VERSION does not ship — aborting before flip" >&2
  exit 76
fi

say "provider smoke (one live Codex gpt-5.6-sol/high read-only call)"
if ! CODEX_HOME="$HOME/.codex" \
  node "$DEST/scripts/release/codex-preflight.mjs"; then
  echo "Codex provider smoke FAILED — aborting before flip" >&2
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

opsd_is_loaded() {
  [ -f "$OPSD_PLIST" ] && launchctl print "gui/$(id -u)/com.helium.opsd" >/dev/null 2>&1
}

restart_opsd_if_loaded() {
  [ -f "$OPSD_PLIST" ] || return 0
  opsd_is_loaded || return 0
  if launchctl kickstart -k "gui/$(id -u)/com.helium.opsd"; then
    return 0
  fi
  say "opsd kickstart failed once — retrying after 3s"
  sleep 3
  launchctl kickstart -k "gui/$(id -u)/com.helium.opsd"
}

# launchd caches a label's configuration from bootstrap time, so `kickstart -k`
# restarts the PROCESS but leaves it on the OLD plist. Only bootout+bootstrap
# makes launchd re-read the file. Same shape as configure-review-canary.sh.
reload_dsh() {
  local domain
  domain="gui/$(id -u)"
  if launchctl print "$domain/com.helium.dsh" >/dev/null 2>&1; then
    launchctl bootout "$domain/com.helium.dsh" || return 1
    local end=$((SECONDS + 15))
    while launchctl print "$domain/com.helium.dsh" >/dev/null 2>&1; do
      [ $SECONDS -lt $end ] || {
        echo "com.helium.dsh did not unload within 15s" >&2
        return 1
      }
      sleep 1
    done
  fi
  launchctl bootstrap "$domain" "$DSH_PLIST"
}

# Keep the exact pre-flip plist so a flip-back or a later rollback.sh can restore
# the environment the previous release actually ran with, not a re-render of it.
install_dsh_plist() {
  mkdir -p "$PLIST_BACKUP_DIR" || return 1
  if [ -f "$DSH_PLIST" ]; then
    cp -p "$DSH_PLIST" "$PLIST_BACKUP_DIR/pre-$VERSION.plist" || return 1
  fi
  cp "$RENDERED_PLIST" "$DSH_PLIST"
}

opsd_cycle_after() {
  local target="$1" since="$2"
  node "$DEST/scripts/release/opsd-cycle-after.mjs" "$OPSD_EVENT_LOG" "$since" "$target"
}

opsd_required=0
if opsd_is_loaded; then
  opsd_required=1
fi

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

flip_start_ms=$(node -e 'process.stdout.write(String(Date.now()))')
flip_to "$DEST"
say "flipped current -> $VERSION; installing the plist and reloading the daemon"
if ! install_dsh_plist; then
  echo "FATAL: current=$VERSION but installing the rendered DSH plist FAILED — the daemon is still configured by the OLD plist at $DSH_PLIST. MANUAL INTERVENTION REQUIRED: copy $RENDERED_PLIST to $DSH_PLIST by hand, then run 'launchctl bootout gui/$(id -u)/com.helium.dsh' followed by 'launchctl bootstrap gui/$(id -u) $DSH_PLIST'." >&2
  exit 74
fi
# fix round 2, ITEM 2: match the flip-back path's restart handling here
# too — a bare set -e abort on an otherwise-healthy deploy (current already
# flipped to $VERSION) would leave the daemon running the OLD build with no
# clear signal why, and no automatic path back into the health window below.
if ! reload_dsh; then
  say "plist reload failed once — retrying after 3s"
  sleep 3
  if ! reload_dsh; then
    echo "FATAL: current=$VERSION and $DSH_PLIST is the $VERSION plist, but the bootout+bootstrap reload FAILED twice — the daemon may still be RUNNING the OLD release. MANUAL INTERVENTION REQUIRED: run 'launchctl bootout gui/$(id -u)/com.helium.dsh' then 'launchctl bootstrap gui/$(id -u) $DSH_PLIST' by hand (kickstart is NOT enough: launchd would keep the old key set), then verify with 'launchctl print gui/$(id -u)/com.helium.dsh'. If it comes up healthy, the deploy is fine; if not, run scripts/release/rollback.sh." >&2
    exit 74
  fi
fi
if ! restart_opsd_if_loaded; then
  echo "FATAL: current=$VERSION but installed com.helium.opsd did not restart. The collector/plugin release pair may be inconsistent; inspect both launchd labels before continuing." >&2
  exit 76
fi

# ONE row is the whole signal: the tenant runtime writes a runtime-level
# liveness row at start-up even with zero enabled tenants, so its presence proves
# the plugin loaded its config and the runtime started on the new plist.
say "post-flip health window (up to 180s for the start-up liveness row)"
ok=0; end=$((SECONDS + 180))
while [ $SECONDS -lt $end ]; do
  sleep 15
  fresh=$(HELIUM_STATE_ROOT="$STATE_ROOT" node -e '
    const {readFileSync,readdirSync}=require("node:fs");const {join}=require("node:path");
    const d=join(process.env.HELIUM_STATE_ROOT,"jsonl");
    const f=readdirSync(d).filter(x=>x.startsWith("heartbeat-")).sort().pop();
    const since=Number(process.argv[1]),now=Date.now();
    const n=readFileSync(join(d,f),"utf8").split("\n").filter(Boolean)
      .filter(l=>{try{const at=Date.parse(JSON.parse(l).ts);return at>since&&at<=now;}catch{return false;}}).length;
    console.log(n);' "$flip_start_ms")
  say "  heartbeat rows since flip: $fresh"
  opsd_fresh=1
  if [ "$opsd_required" = "1" ]; then
    opsd_fresh=$(opsd_cycle_after "$DEST" "$flip_start_ms")
    say "  opsd target-release observation cycle: $opsd_fresh"
  fi
  if [ "$fresh" -ge 1 ] && [ "$opsd_fresh" = "1" ]; then
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
    echo "FATAL: flip-back symlink update to $prev_target FAILED — current=<unknown, verify by hand> but the daemon is still running $VERSION. MANUAL INTERVENTION REQUIRED: inspect $RELEASES/current, re-point it at $prev_target if needed (ln -sfn $prev_target $RELEASES/current), restore $PLIST_BACKUP_DIR/pre-$VERSION.plist to $DSH_PLIST, then run: launchctl bootout gui/$(id -u)/com.helium.dsh && launchctl bootstrap gui/$(id -u) $DSH_PLIST" >&2
    exit 70
  fi
  if ! bash "$prev_target/scripts/deploy-profile.sh" --dsh-home "$DSH_HOME_DIR" \
       --plugin-dir "$prev_target/plugins/helium"; then
    echo "FATAL: current=$prev_target but the profile re-deploy FAILED — the running daemon may still be $VERSION (its profile was never re-pointed at $prev_target). MANUAL INTERVENTION REQUIRED: re-run 'bash $prev_target/scripts/deploy-profile.sh --dsh-home $DSH_HOME_DIR --plugin-dir $prev_target/plugins/helium' by hand, then restore $PLIST_BACKUP_DIR/pre-$VERSION.plist to $DSH_PLIST and run 'launchctl bootout gui/$(id -u)/com.helium.dsh && launchctl bootstrap gui/$(id -u) $DSH_PLIST'." >&2
    exit 71
  fi
  # The plist is part of the release. Restoring the profile without restoring
  # the plist leaves $prev_target running with $VERSION's key set.
  if [ -f "$PLIST_BACKUP_DIR/pre-$VERSION.plist" ]; then
    if ! cp -p "$PLIST_BACKUP_DIR/pre-$VERSION.plist" "$DSH_PLIST"; then
      echo "FATAL: current=$prev_target but restoring $PLIST_BACKUP_DIR/pre-$VERSION.plist to $DSH_PLIST FAILED — the daemon would come back on $VERSION's key set. MANUAL INTERVENTION REQUIRED: copy that file by hand, then run 'launchctl bootout gui/$(id -u)/com.helium.dsh && launchctl bootstrap gui/$(id -u) $DSH_PLIST'." >&2
      exit 72
    fi
  else
    say "no pre-$VERSION plist backup to restore; reloading $DSH_PLIST as it stands"
  fi
  if ! reload_dsh; then
    say "plist reload failed once — retrying after 3s"
    sleep 3
    if ! reload_dsh; then
      echo "FATAL: current=$prev_target and the profile and plist were restored, but the bootout+bootstrap reload FAILED twice — the daemon may still be RUNNING the unhealthy $VERSION build. MANUAL INTERVENTION REQUIRED: run 'launchctl bootout gui/$(id -u)/com.helium.dsh' then 'launchctl bootstrap gui/$(id -u) $DSH_PLIST' by hand (kickstart is NOT enough: launchd would keep the loaded key set), then verify with 'launchctl print gui/$(id -u)/com.helium.dsh'." >&2
      exit 72
    fi
  fi
  flip_back_start_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  if ! restart_opsd_if_loaded; then
    echo "FATAL: current=$prev_target and DSH restarted, but installed com.helium.opsd did not restart on the restored release. MANUAL INTERVENTION REQUIRED." >&2
    exit 76
  fi
  if [ "$opsd_required" = "1" ]; then
    restored=0; restore_end=$((SECONDS + 90))
    while [ $SECONDS -lt $restore_end ]; do
      sleep 10
      if [ "$(opsd_cycle_after "$prev_target" "$flip_back_start_ms")" = "1" ]; then
        restored=1
        break
      fi
    done
    if [ "$restored" != "1" ]; then
      echo "FATAL: current=$prev_target but restored opsd produced no target-release observation cycle. MANUAL INTERVENTION REQUIRED." >&2
      exit 76
    fi
  fi
  say "flip-back to $prev_target complete: symlink flipped, profile re-deployed, plist restored, daemon reloaded"
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
if [ "$opsd_required" = "1" ]; then
  say "installed opsd restarted on the compatible current release"
else
  say "opsd was not loaded; after AC#1 and separate approval use scripts/ops/install-observe-only.sh"
fi
