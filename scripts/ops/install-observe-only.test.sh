#!/usr/bin/env bash
# Filesystem-only packaging drill. Never invokes launchctl or starts opsd.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/helium-ops-install-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

for script in install-observe-only.sh uninstall-observe-only.sh run-opsd.sh; do
  bash -n "$here/$script"
done
plutil -lint "$repo/launchd/com.helium.opsd.plist.template" >/dev/null

root="$tmp/home/.helium/ops"
launchd_root="$tmp/home/Library/LaunchAgents"
release="$tmp/releases/current"
mkdir -p "$root" "$launchd_root"
chmod 700 "$root"
mkdir -p "$tmp/releases"
ln -s "$repo" "$release"
printf 'neighbor-state\n' >"$root/existing-watchdog.state"
printf 'neighbor-plist\n' >"$launchd_root/com.existing.watchdog.plist"

snapshot() {
  find "$tmp/home" -type f -print0 | sort -z |
    xargs -0 shasum -a 256
}
before="$(snapshot)"
manifest_hash="$(shasum -a 256 "$repo/ops/authority-manifest.json")"

echo "case 0: an operator cannot override the host clock to bypass the freeze"
set +e
out=$(bash "$here/install-observe-only.sh" \
  --release "$release" --root "$root" --launchd-root "$launchd_root" \
  --now 2026-09-01 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: production date override succeeded"; exit 1; }
printf '%s\n' "$out" | grep -q 'usage:' || {
  echo "FAIL: date override refusal was not explicit"
  exit 1
}
[ "$(snapshot)" = "$before" ] || { echo "FAIL: date override refusal wrote files"; exit 1; }

installer_at() {
  local date="$1"
  local target="$tmp/install-observe-only-$date.sh"
  sed "s|now=\"\$(/bin/date -u +%F)\"|now=\"$date\"|" \
    "$here/install-observe-only.sh" >"$target"
  chmod 700 "$target"
  printf '%s\n' "$target"
}

pre_freeze_installer="$(installer_at 2026-08-30)"
post_freeze_installer="$(installer_at 2026-09-01)"

echo "case 1: freeze refuses before and through 2026-08-31 without writing"
set +e
out=$(bash "$pre_freeze_installer" \
  --release "$release" --root "$root" --launchd-root "$launchd_root" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: pre-freeze install succeeded"; exit 1; }
printf '%s\n' "$out" | grep -q 'freeze' || { echo "FAIL: refusal did not name freeze"; exit 1; }
[ "$(snapshot)" = "$before" ] || { echo "FAIL: freeze refusal wrote files"; exit 1; }

echo "case 2: only the recorded commissioning waiver bypasses the packaging freeze"
set +e
out=$(bash "$pre_freeze_installer" \
  --release "$release" --root "$root" --launchd-root "$launchd_root" \
  --commissioning-waiver not-the-recorded-waiver 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: unknown commissioning waiver succeeded"; exit 1; }
[ "$(snapshot)" = "$before" ] || { echo "FAIL: unknown waiver wrote files"; exit 1; }

bash "$pre_freeze_installer" \
  --release "$release" --root "$root" --launchd-root "$launchd_root" \
  --commissioning-waiver ops-phase-d-weekend-2026-08-30
config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
[ -f "$config" ] && [ -f "$plist" ] || { echo "FAIL: waiver install did not render files"; exit 1; }
bash "$here/uninstall-observe-only.sh" --root "$root" --launchd-root "$launchd_root"
[ "$(snapshot)" = "$before" ] || {
  echo "FAIL: waiver install/uninstall did not restore the redirected tree"
  exit 1
}

echo "case 3: post-freeze install renders exactly config and plist"
bash "$post_freeze_installer" \
  --release "$release" --root "$root" --launchd-root "$launchd_root"
config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
[ -f "$config" ] && [ -f "$plist" ] || { echo "FAIL: declared files missing"; exit 1; }
[ "$(stat -f '%Lp' "$root")" = "700" ] || { echo "FAIL: ops root is not 0700"; exit 1; }
[ "$(stat -f '%Lp' "$root/state")" = "700" ] || { echo "FAIL: state dir is not 0700"; exit 1; }
[ "$(stat -f '%Lp' "$config")" = "600" ] || { echo "FAIL: config is not 0600"; exit 1; }
files="$(find "$tmp/home" -type f | sed "s|$tmp/home/||" | sort)"
[ "$files" = "$(printf '%s\n' \
  '.helium/ops/config/opsd.json' \
  '.helium/ops/existing-watchdog.state' \
  'Library/LaunchAgents/com.existing.watchdog.plist' \
  'Library/LaunchAgents/com.helium.opsd.plist' | sort)" ] || {
  echo "FAIL: unexpected installed file set"
  printf '%s\n' "$files"
  exit 1
}
grep -q '"mode": "observe"' "$config"
grep -q 'authority-manifest.pub.pem' "$config"
grep -q 'authority-manifest.json' "$config"
grep -Fq "$release" "$config"
grep -Fq "$release/scripts/ops/run-opsd.sh" "$plist"
if grep -Eqi 'private.?key|password|secret|token' "$config"; then
  echo "FAIL: rendered config contains secret/private material"
  exit 1
fi
[ "$(shasum -a 256 "$repo/ops/authority-manifest.json")" = "$manifest_hash" ] || {
  echo "FAIL: installer changed the authority manifest"
  exit 1
}
plutil -lint "$plist" >/dev/null

echo "case 4: uninstall removes only the exact opsd files"
bash "$here/uninstall-observe-only.sh" --root "$root" --launchd-root "$launchd_root"
[ "$(snapshot)" = "$before" ] || {
  echo "FAIL: install/uninstall did not restore the redirected tree"
  diff <(printf '%s\n' "$before") <(snapshot) || true
  exit 1
}

echo "case 5: release scripts preserve a compatible opsd/plugin pair"
grep -q 'install-observe-only.sh' "$repo/scripts/release/deploy.sh"
grep -q 'com.helium.opsd' "$repo/scripts/release/rollback.sh"
grep -q 'plugins/ops-agent' "$repo/scripts/release/rollback.sh"
grep -q -- '--check-config' "$repo/scripts/release/deploy.sh"
grep -q -- '--check-config' "$repo/scripts/release/rollback.sh"
grep -q 'controller-cycle-recorded' "$repo/scripts/release/opsd-cycle-after.mjs"
grep -q 'opsd-cycle-after.mjs' "$repo/scripts/release/deploy.sh"
grep -Fq 'node "$current/scripts/release/opsd-cycle-after.mjs"' "$repo/scripts/release/rollback.sh"
if grep -Fq 'node "$target/scripts/release/opsd-cycle-after.mjs"' "$repo/scripts/release/rollback.sh"; then
  echo "FAIL: rollback depends on a helper the preceding target release may not contain"
  exit 1
fi
node --test "$repo/scripts/release/opsd-cycle-after.test.mjs"
grep -q 'ops/executors' "$repo/scripts/release/deploy.sh"
grep -q 'ops/executors' "$repo/scripts/release/rollback.sh"
grep -q 'restored opsd produced no target-release observation cycle' "$repo/scripts/release/deploy.sh"

echo "case 6: a fresh DSH heartbeat does not hide stale opsd observations"
state="$tmp/deadman-state"
mkdir -p "$state/jsonl" "$state/opsd" "$tmp/empty-jobs"
fresh="$(node -e 'process.stdout.write(new Date().toISOString())')"
stale="$(node -e 'process.stdout.write(new Date(Date.now()-3600e3).toISOString())')"
printf '{"ts":"%s","job":"fixture","status":"ok"}\n' "$fresh" \
  >"$state/jsonl/heartbeat-$(date -u +%F).jsonl"
printf '{"v":1,"seq":1,"hash":"fixture","record":{"v":1,"id":"event-1","at":"%s","type":"observation-recorded","observation":{"observedAt":"%s"}}}\n' \
  "$stale" "$stale" >"$state/opsd/events.jsonl"
cat >"$tmp/fake-mailer" <<'MAIL'
#!/usr/bin/env bash
exit 0
MAIL
chmod +x "$tmp/fake-mailer"
set +e
deadman_out=$(HELIUM_STATE_ROOT="$state" HELIUM_JOBS_DIR="$tmp/empty-jobs" \
  HELIUM_OPSD_EXPECTED=1 HELIUM_DEADMAN_ALERT_CMD="$tmp/fake-mailer" \
  HELIUM_ENV_FILE="$tmp/empty.env" \
  bash "$repo/scripts/deadman/check-heartbeat.sh" 2>&1)
deadman_rc=$?
set -e
[ "$deadman_rc" -eq 16 ] || {
  echo "FAIL: expected opsd stale rc=16, got $deadman_rc"
  printf '%s\n' "$deadman_out"
  exit 1
}
printf '%s\n' "$deadman_out" | grep -qi 'opsd.*stale' || {
  echo "FAIL: deadman did not name opsd staleness"
  exit 1
}

echo "ALL PASS"
