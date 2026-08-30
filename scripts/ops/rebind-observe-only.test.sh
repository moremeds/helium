#!/usr/bin/env bash
# Filesystem-only rebind/restore drill. The implementation must never start or
# stop launchd labels; the operator keeps that lifecycle explicit.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/helium-ops-rebind-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

root="$tmp/home/.helium/ops"
launchd_root="$tmp/home/Library/LaunchAgents"
candidate="$tmp/helium-ops-candidates/candidate"
current="$tmp/helium-releases/current"
backup="$root/rebind-backups/candidate-to-current"
mkdir -p "$(dirname "$candidate")" "$(dirname "$current")" "$launchd_root"
ln -s "$repo" "$candidate"
ln -s "$repo" "$current"
fake_launchctl="$tmp/fake-launchctl"
cat >"$fake_launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
# No labels are loaded in the filesystem-only fixture.
[ -z "${HELIUM_FAKE_LOADED_LABEL:-}" ] || exit 0
exit 1
LAUNCHCTL
chmod 700 "$fake_launchctl"
export HELIUM_LAUNCHCTL_BIN="$fake_launchctl"

installer="$tmp/install-observe-only.sh"
# shellcheck disable=SC2016 # The literal source expression is the sed target.
sed 's|now="$(/bin/date -u +%F)"|now="2026-09-01"|' \
  "$here/install-observe-only.sh" >"$installer"
chmod 700 "$installer"
bash "$installer" --release "$candidate" --root "$root" --launchd-root "$launchd_root" >/dev/null

config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
deadman_plist="$launchd_root/com.helium.opsd-deadman.plist"
printf 'durable-event-ledger\n' >"$root/state/events.jsonl"
digest() { shasum -a 256 "$1" | awk '{print $1}'; }
state_before="$(digest "$root/state/events.jsonl")"
config_before="$(digest "$config")"
plist_before="$(digest "$plist")"
deadman_before="$(digest "$deadman_plist")"

echo "case 0: apply refuses while either exact launchd label is loaded"
set +e
out=$(HELIUM_FAKE_LOADED_LABEL=com.helium.opsd bash "$here/rebind-observe-only.sh" apply \
  --release "$current" --root "$root" --launchd-root "$launchd_root" \
  --backup-dir "$backup" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ]
printf '%s\n' "$out" | grep -qi 'while.*loaded'
[ ! -e "$backup" ]
[ "$(digest "$config")" = "$config_before" ]

echo "case 1: apply backs up the exact old binding and preserves state"
bash "$here/rebind-observe-only.sh" apply \
  --release "$current" --root "$root" --launchd-root "$launchd_root" \
  --backup-dir "$backup"
[ "$(digest "$root/state/events.jsonl")" = "$state_before" ]
grep -Fq '"releaseDir": "'"$current"'"' "$config"
grep -Fq "$current/scripts/ops/run-opsd.sh" "$plist"
grep -Fq "$current/scripts/deadman/check-opsd-heartbeat.sh" "$deadman_plist"
[ "$(digest "$backup/opsd.json")" = "$config_before" ]
[ "$(digest "$backup/com.helium.opsd.plist")" = "$plist_before" ]
[ "$(digest "$backup/com.helium.opsd-deadman.plist")" = "$deadman_before" ]
[ -f "$backup/binding.json" ]

echo "case 2: apply refuses to overwrite an existing backup"
set +e
out=$(bash "$here/rebind-observe-only.sh" apply \
  --release "$current" --root "$root" --launchd-root "$launchd_root" \
  --backup-dir "$backup" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ]
printf '%s\n' "$out" | grep -qi 'backup.*exists'

echo "case 3: restore verifies and atomically restores the prior binding"
rm "$config" "$plist" "$deadman_plist"
bash "$here/rebind-observe-only.sh" restore \
  --root "$root" --launchd-root "$launchd_root" --backup-dir "$backup"
[ "$(digest "$config")" = "$config_before" ]
[ "$(digest "$plist")" = "$plist_before" ]
[ "$(digest "$deadman_plist")" = "$deadman_before" ]
[ "$(digest "$root/state/events.jsonl")" = "$state_before" ]

echo "case 4: a changed backup is rejected without changing active files"
active_before="$(shasum -a 256 "$config" "$plist" "$deadman_plist")"
printf 'tampered\n' >>"$backup/opsd.json"
set +e
out=$(bash "$here/rebind-observe-only.sh" restore \
  --root "$root" --launchd-root "$launchd_root" --backup-dir "$backup" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ]
printf '%s\n' "$out" | grep -qi 'hash'
[ "$(shasum -a 256 "$config" "$plist" "$deadman_plist")" = "$active_before" ]

echo "ALL PASS"
