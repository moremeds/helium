#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/helium-opsd-deadman-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

events="$tmp/events.jsonl"
state="$tmp/state"
calls="$tmp/alert-calls"
env_file="$tmp/empty.env"
touch "$env_file"

cat >"$tmp/fake-alert" <<'ALERT'
#!/usr/bin/env bash
set -eu
printf 'alert\n' >>"$HELIUM_TEST_ALERT_CALLS"
exit 0
ALERT
chmod 700 "$tmp/fake-alert"

run_check() {
  HELIUM_OPSD_EVENT_LOG="$events" \
  HELIUM_OPSD_DEADMAN_STATE_DIR="$state" \
  HELIUM_OPSD_STALE_S=180 \
  HELIUM_OPSD_REALERT_S=3600 \
  HELIUM_OPSD_ALERT_CMD="$tmp/fake-alert" \
  HELIUM_ENV_FILE="$env_file" \
  HELIUM_NODE_BIN="$(command -v node)" \
  HELIUM_TEST_ALERT_CALLS="$calls" \
    bash "$here/check-opsd-heartbeat.sh"
}

write_event() {
  local at="$1"
  printf '{"v":1,"seq":1,"hash":"fixture","record":{"v":1,"id":"event-1","at":"%s","type":"observation-recorded","observation":{"observedAt":"%s"}}}\n' "$at" "$at" >"$events"
}

fresh="$(node -e 'process.stdout.write(new Date().toISOString())')"
write_event "$fresh"
out="$(run_check)"
printf '%s\n' "$out" | grep -q 'opsd fresh:'
[ ! -e "$calls" ] || { echo "FAIL: fresh opsd alerted"; exit 1; }

# This unrelated file is deliberately stale/malformed. The standalone opsd
# deadman must never inspect tenant or DSH state.
printf 'not a tenant heartbeat\n' >"$tmp/tenant-health.jsonl"
out="$(run_check)"
printf '%s\n' "$out" | grep -q 'opsd fresh:'
[ ! -e "$calls" ] || { echo "FAIL: unrelated tenant state alerted"; exit 1; }

future="$(node -e 'process.stdout.write(new Date(Date.now()+3600e3).toISOString())')"
write_event "$future"
set +e
out="$(run_check 2>&1)"
rc=$?
set -e
[ "$rc" -eq 16 ] || { echo "FAIL: future observation returned $rc"; exit 1; }
printf '%s\n' "$out" | grep -q 'opsd stale'
[ "$(wc -l <"$calls" | tr -d ' ')" = "1" ] || { echo "FAIL: future observation did not alert once"; exit 1; }

set +e
out="$(run_check 2>&1)"
rc=$?
set -e
[ "$rc" -eq 17 ] || { echo "FAIL: repeated stale observation returned $rc"; exit 1; }
printf '%s\n' "$out" | grep -q 'suppressed'
[ "$(wc -l <"$calls" | tr -d ' ')" = "1" ] || { echo "FAIL: stale alert was not deduplicated"; exit 1; }

fresh="$(node -e 'process.stdout.write(new Date().toISOString())')"
write_event "$fresh"
out="$(run_check)"
printf '%s\n' "$out" | grep -q 'opsd fresh:'
[ ! -e "$state/alerted-at" ] || { echo "FAIL: fresh observation did not clear sentinel"; exit 1; }

echo "ALL PASS"
