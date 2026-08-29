#!/usr/bin/env bash
# Local drill for check-heartbeat.sh. No network, no real SMTP.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/helium-deadman-test.XXXXXX")
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

# The wrapper now runs a per-tenant check too, and it defaults JOBS_DIR to the
# repository's real jobs/. Point it at a controlled fixture instead, so this
# drill keeps testing the wrapper rather than whatever tenants happen to be
# deployed. One tenant here; case 6 adds a second to exercise the tenant path.
export HELIUM_JOBS_DIR="$tmp/jobs"
mkdir -p "$HELIUM_JOBS_DIR"
write_job() {
  cat >"$HELIUM_JOBS_DIR/$1.yaml" <<EOJ
name: $1
enabled: true
triggers:
  - kind: cron
    schedule: "0 17 * * 1-5"
    tz: America/New_York
engine:
  triage: { engine: deepseek, model: deepseek-v4-flash }
  senior: { engine: claude-max }
escalate_when: severity >= material
session: fresh
memory: none
tools: [argon_api]
allowMutations: false
max_turns: { triage: 2, senior: 8 }
timeout: 10m
budget: { max_triage_per_hour: 30, max_senior_per_day: 12 }
delivery: { jsonl: true }
prompt: |
  Analyze.
EOJ
}
write_job macro-watch

# `date -v` is BSD-only and this drill now runs in CI on Linux, where GNU date
# has no such flag. node is already a hard dependency of the script under test,
# so use it for the one relative timestamp this drill needs.
iso_ago() {
  "${HELIUM_NODE_BIN:-node}" -e \
    'process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"))' \
    "$1"
}

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
  "$(iso_ago 1200)" \
  >"$tmp/state/jsonl/heartbeat-$(date -u +%F).jsonl"
[ "$(run)" = 10 ] || {
  echo FAIL-4
  exit 1
}
echo "case 5: jsonl/ subdirectory never created (state root exists, jsonl/ does not) -> 10, not a crash"
tmp5=$(mktemp -d "${TMPDIR:-/tmp}/helium-deadman-test-nojsonl.XXXXXX")
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

echo "case 6: process alive but a SECOND tenant silent -> 13, naming only that tenant"
# This is the blind spot the tenant check exists for: the global check is green
# (macro-watch heartbeat is fresh), yet apex-health has never heartbeat at all.
write_job apex-health
printf '{"ts":"%s","job":"macro-watch","status":"ok"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$tmp/state/jsonl/heartbeat-$(date -u +%F).jsonl"
out6=$(
  set +e
  bash "$here/check-heartbeat.sh" 2>&1
  echo "rc=$?"
)
case "$out6" in
*"rc=13"*) : ;;
*)
  echo "FAIL-6 (expected rc=13)"
  printf '%s\n' "$out6"
  exit 1
  ;;
esac
printf '%s\n' "$out6" | grep -q 'apex-health' || {
  echo FAIL-6b-not-named
  exit 1
}
# Never blame a healthy tenant: macro-watch must not appear on an offender line.
printf '%s\n' "$out6" | grep -E 'STALE|MISSING' | grep -q 'macro-watch' && {
  echo FAIL-6c-blamed-healthy-tenant
  exit 1
}

echo "case 7: immediately again -> 14 (tenant dedup, separate sentinel)"
out7=$(
  set +e
  bash "$here/check-heartbeat.sh" 2>&1
  echo "rc=$?"
)
case "$out7" in
*"rc=14"*) : ;;
*)
  echo "FAIL-7 (expected rc=14)"
  printf '%s\n' "$out7"
  exit 1
  ;;
esac

echo "case 8: a malformed tenant stays visible as invalid rather than vanishing"
printf 'this: [is not a job\n' >"$HELIUM_JOBS_DIR/b-broken.yaml"
rm -f "$tmp/state/deadman/tenant-alerted-at"
write_job apex-health
printf '{"ts":"%s","job":"macro-watch","status":"ok"}\n{"ts":"%s","job":"apex-health","status":"ok"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$tmp/state/jsonl/heartbeat-$(date -u +%F).jsonl"
out8=$(
  set +e
  bash "$here/check-heartbeat.sh" 2>&1
  echo "rc=$?"
)
printf '%s\n' "$out8" | grep -qi 'b-broken.*invalid' || {
  echo FAIL-8-malformed-tenant-not-reported
  printf '%s\n' "$out8"
  exit 1
}

echo "mail log:"
cat "$FAKE_MAIL_LOG"
echo "ALL PASS"
