#!/usr/bin/env bash
# Local drill for check-heartbeat.sh. No network, no real SMTP.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp=$(mktemp -d -t helium-deadman-test)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/state/jsonl"
cat >"$tmp/fake-mailer" <<'EOS'
#!/usr/bin/env bash
printf '{"ok":true,"fake":true}\n'
printf '%s\n' "$*" >> "$FAKE_MAIL_LOG"
EOS
chmod +x "$tmp/fake-mailer"
export FAKE_MAIL_LOG="$tmp/mail.log"
export HELIUM_STATE_ROOT="$tmp/state" HELIUM_DEADMAN_ALERT_CMD="$tmp/fake-mailer"
export HELIUM_ENV_FILE="$tmp/helium.env"
: >"$tmp/helium.env"
run() {
  set +e
  bash "$here/check-heartbeat.sh" >/dev/null 2>&1
  echo $?
  set -e
}

echo "case 1: no heartbeat file at all -> 10"
[ "$(run)" = 10 ] || {
  echo FAIL-1
  exit 1
}
echo "case 2: immediately again -> 11 (6h dedup)"
[ "$(run)" = 11 ] || {
  echo FAIL-2
  exit 1
}
echo "case 3: fresh heartbeat -> 0 and sentinel cleared"
printf '{"ts":"%s","job":"macro-watch","status":"ok"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$tmp/state/jsonl/heartbeat-$(date -u +%F).jsonl"
[ "$(run)" = 0 ] || {
  echo FAIL-3
  exit 1
}
[ ! -f "$tmp/state/deadman/alerted-at" ] || {
  echo FAIL-3b
  exit 1
}
echo "case 4: 20-minute-old heartbeat -> 10"
printf '{"ts":"%s","job":"macro-watch","status":"ok"}\n' \
  "$(date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)" \
  >"$tmp/state/jsonl/heartbeat-$(date -u +%F).jsonl"
[ "$(run)" = 10 ] || {
  echo FAIL-4
  exit 1
}
echo "case 5: jsonl/ subdirectory never created (state root exists, jsonl/ does not) -> 10, not a crash"
tmp5=$(mktemp -d -t helium-deadman-test-nojsonl)
mail5="$tmp5/mail.log"
: >"$tmp5/helium.env"
[ ! -d "$tmp5/state/jsonl" ] || {
  echo FAIL-5-precondition
  exit 1
}
run5() {
  set +e
  FAKE_MAIL_LOG="$mail5" \
    HELIUM_STATE_ROOT="$tmp5/state" \
    HELIUM_DEADMAN_ALERT_CMD="$tmp/fake-mailer" \
    HELIUM_ENV_FILE="$tmp5/helium.env" \
    bash "$here/check-heartbeat.sh" >/dev/null 2>&1
  echo $?
  set -e
}
[ "$(run5)" = 10 ] || {
  echo FAIL-5
  exit 1
}
[ -s "$mail5" ] || {
  echo FAIL-5b-no-alert-attempted
  exit 1
}
rm -rf "$tmp5"

echo "mail log:"
cat "$FAKE_MAIL_LOG"
echo "ALL PASS"
