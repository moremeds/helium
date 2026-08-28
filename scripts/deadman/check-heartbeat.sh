#!/usr/bin/env bash
# External liveness check for the helium daemon. Runs from its own launchd agent
# every 30 minutes. Emails once per staleness episode, re-alerting at most every 6h.
# Runs BOTH checks: the global process heartbeat, then — only once that is
# fresh — a per-tenant liveness check, because the global one is satisfied by
# ANY tenant's heartbeat and so stays green while one tenant is silent.
# Exit: 0 fresh, 10 stale+alerted, 11 stale+suppressed, 12 stale+alert failed,
#       13 tenant stale+alerted, 14 tenant stale+suppressed,
#       15 tenant stale+alert failed, 2 config.
set -euo pipefail

STATE_ROOT="${HELIUM_STATE_ROOT:-/Users/moremeds/.helium/state}"
NODE_BIN="${HELIUM_NODE_BIN:-node}"
ENV_FILE="${HELIUM_ENV_FILE:-/Users/moremeds/.config/helium/helium.env}"
STALE_S="${HELIUM_DEADMAN_STALE_S:-600}"
REALERT_S="${HELIUM_DEADMAN_REALERT_S:-21600}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALERT_CMD="${HELIUM_DEADMAN_ALERT_CMD:-$NODE_BIN $script_dir/send-alert.mjs}"
JOBS_DIR="${HELIUM_JOBS_DIR:-$script_dir/../../jobs}"

command -v "${NODE_BIN%% *}" >/dev/null 2>&1 || {
  echo "no node at $NODE_BIN" >&2
  exit 2
}

sentinel_dir="$STATE_ROOT/deadman"
sentinel="$sentinel_dir/alerted-at"
tenant_sentinel="$sentinel_dir/tenant-alerted-at"
mkdir -p "$sentinel_dir" "$STATE_ROOT/jsonl"

newest=$(find "$STATE_ROOT/jsonl" -name 'heartbeat-*.jsonl' -type f 2>/dev/null |
  sort | tail -1)
now=$(date -u +%s)

if [ -z "$newest" ]; then
  last_epoch=0
  last_iso="(no heartbeat file)"
else
  last_iso=$("$NODE_BIN" -e '
    const {readFileSync}=require("node:fs");
    const lines=readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);
    let out="";
    for(let i=lines.length-1;i>=0;i--){
      try{const ts=JSON.parse(lines[i]).ts; if(ts){out=ts;break;}}catch{}
    }
    process.stdout.write(out);' "$newest")
  if [ -z "$last_iso" ]; then
    last_epoch=0
    last_iso="(unparseable)"
  else
    last_epoch=$("$NODE_BIN" -e \
      'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)||0))' "$last_iso")
  fi
fi

# Per-tenant liveness. Deliberately NOT folded into the global check above: a
# tenant is healthy only on the strength of its OWN heartbeat, and the global
# check cannot express that. Same alert/dedup discipline as the global path,
# with its own sentinel so one episode does not suppress the other.
check_tenants() {
  if [ ! -d "$JOBS_DIR" ]; then
    echo "tenant check: SKIPPED — no jobs directory at $JOBS_DIR" >&2
    return 0
  fi
  set +e
  tenant_out=$(
    HELIUM_JOBS_DIR="$JOBS_DIR" \
      HELIUM_STATE_ROOT="$STATE_ROOT" \
      HELIUM_DEADMAN_STALE_S="$STALE_S" \
      "$NODE_BIN" "$script_dir/check-tenant-heartbeats.mjs" 2>&1
  )
  tenant_rc=$?
  set -e
  echo "$tenant_out"
  if [ "$tenant_rc" -eq 0 ]; then
    rm -f "$tenant_sentinel"
    return 0
  fi

  if [ -f "$tenant_sentinel" ]; then
    tprev=$(cat "$tenant_sentinel")
    if [ $((now - tprev)) -lt "$REALERT_S" ]; then
      echo "tenant check failed but alerted $((now - tprev))s ago — suppressed"
      return 14
    fi
  fi

  tbody=$(mktemp -t helium-deadman-tenant)
  {
    echo "helium: the process is alive, but at least one TENANT is not."
    echo
    echo "$tenant_out"
    echo
    echo "checked at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "jobs dir:   $JOBS_DIR"
  } >"$tbody"
  if $ALERT_CMD --env-file "$ENV_FILE" \
    --subject "[helium] tenant heartbeat missing" \
    --body-file "$tbody"; then
    echo "$now" >"$tenant_sentinel"
    rm -f "$tbody"
    echo "tenant check failed — alert sent"
    return 13
  fi
  rm -f "$tbody"
  echo "tenant check failed — alert FAILED" >&2
  return 15
}

age=$((now - last_epoch))
if [ "$last_epoch" -gt 0 ] && [ "$age" -lt "$STALE_S" ]; then
  rm -f "$sentinel"
  echo "fresh: last heartbeat ${age}s ago ($last_iso)"
  set +e
  check_tenants
  rc=$?
  set -e
  exit $rc
fi

if [ -f "$sentinel" ]; then
  prev=$(cat "$sentinel")
  if [ $((now - prev)) -lt "$REALERT_S" ]; then
    echo "stale (${age}s) but alerted $((now - prev))s ago — suppressed"
    exit 11
  fi
fi

body_file=$(mktemp -t helium-deadman)
trap 'rm -f "$body_file"' EXIT
{
  echo "helium heartbeat is stale."
  echo "last heartbeat: $last_iso (${age}s ago; threshold ${STALE_S}s)"
  echo "heartbeat file: ${newest:-none}"
  echo "checked at:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "Check: ssh macmini 'launchctl print gui/\$(id -u)/com.helium.dsh'"
  echo "Logs:  /Users/moremeds/.helium/logs/dsh.err.log"
} >"$body_file"

if $ALERT_CMD --env-file "$ENV_FILE" \
  --subject "[helium] heartbeat stale since $last_iso" \
  --body-file "$body_file"; then
  echo "$now" >"$sentinel"
  echo "stale (${age}s) — alert sent"
  exit 10
fi
echo "stale (${age}s) — alert FAILED" >&2
exit 12
