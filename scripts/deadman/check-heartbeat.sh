#!/usr/bin/env bash
# External liveness check for the helium daemon. Runs from its own launchd agent
# every 30 minutes. Emails once per staleness episode, re-alerting at most every 6h.
# Runs all independent checks: the global DSH heartbeat, then — only once that
# is fresh — expected opsd observations, then per-tenant liveness. A healthy
# DSH heartbeat must never conceal a dead standalone controller.
# Exit: 0 fresh, 10 stale+alerted, 11 stale+suppressed, 12 stale+alert failed,
#       13 tenant stale+alerted, 14 tenant stale+suppressed,
#       15 tenant stale+alert failed, 16 opsd stale+alerted,
#       17 opsd stale+suppressed, 18 opsd stale+alert failed, 2 config.
set -euo pipefail

STATE_ROOT="${HELIUM_STATE_ROOT:-$HOME/.helium/state}"
NODE_BIN="${HELIUM_NODE_BIN:-node}"
ENV_FILE="${HELIUM_ENV_FILE:-$HOME/.config/helium/helium.env}"
STALE_S="${HELIUM_DEADMAN_STALE_S:-600}"
REALERT_S="${HELIUM_DEADMAN_REALERT_S:-21600}"
OPSD_EXPECTED="${HELIUM_OPSD_EXPECTED:-0}"
OPSD_STALE_S="${HELIUM_OPSD_STALE_S:-$STALE_S}"
OPSD_EVENT_LOG="${HELIUM_OPSD_EVENT_LOG:-$STATE_ROOT/opsd/events.jsonl}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ALERT_CMD="${HELIUM_DEADMAN_ALERT_CMD:-$NODE_BIN $script_dir/send-alert.mjs}"
TENANTS_DIR="${HELIUM_TENANTS_DIR:-$script_dir/../../plugins}"

command -v "${NODE_BIN%% *}" >/dev/null 2>&1 || {
  echo "no node at $NODE_BIN" >&2
  exit 2
}

sentinel_dir="$STATE_ROOT/deadman"
sentinel="$sentinel_dir/alerted-at"
tenant_sentinel="$sentinel_dir/tenant-alerted-at"
opsd_sentinel="$sentinel_dir/opsd-alerted-at"
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
  if [ ! -d "$TENANTS_DIR" ]; then
    echo "tenant check: SKIPPED — no tenants directory at $TENANTS_DIR" >&2
    return 0
  fi
  set +e
  tenant_out=$(
    HELIUM_TENANTS_DIR="$TENANTS_DIR" \
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

  tbody=$(mktemp "${TMPDIR:-/tmp}/helium-deadman-tenant.XXXXXX")
  {
    echo "helium: the process is alive, but at least one TENANT is not."
    echo
    echo "$tenant_out"
    echo
    echo "checked at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "tenants dir: $TENANTS_DIR"
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

# opsd owns a separate event stream and can fail while DSH continues emitting
# global and tenant heartbeats. This check is enabled only after the operator
# has separately installed and started opsd; source deployment alone cannot
# change that expectation.
check_opsd() {
  [ "$OPSD_EXPECTED" = "1" ] || return 0
  local events="$OPSD_EVENT_LOG"
  local last_iso="" last_epoch=0 age=0
  if [ -f "$events" ]; then
    last_iso=$(
      "$NODE_BIN" -e '
        const {readFileSync}=require("node:fs");
        let text="";
        try{text=readFileSync(process.argv[1],"utf8");}catch{}
        const lines=text.trim().split("\n").filter(Boolean);
        let out="";
        for(let i=lines.length-1;i>=0;i--){
          try{
            const row=JSON.parse(lines[i]);
            const record=row?.record;
            if(record?.type!=="observation-recorded") continue;
            const ts=record.observation?.observedAt ?? record.at;
            if(typeof ts==="string" && Number.isFinite(Date.parse(ts))){out=ts;break;}
          }catch{}
        }
        process.stdout.write(out);' "$events"
    )
  fi
  if [ -n "$last_iso" ]; then
    last_epoch=$("$NODE_BIN" -e \
      'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)||0))' "$last_iso")
  else
    last_iso="(no valid opsd observation)"
  fi
  age=$((now - last_epoch))
  if [ "$last_epoch" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -lt "$OPSD_STALE_S" ]; then
    rm -f "$opsd_sentinel"
    echo "opsd fresh: last observation ${age}s ago ($last_iso)"
    return 0
  fi

  if [ -f "$opsd_sentinel" ]; then
    local previous
    previous=$(cat "$opsd_sentinel")
    if [ $((now - previous)) -lt "$REALERT_S" ]; then
      echo "opsd stale (${age}s) but alerted $((now - previous))s ago — suppressed"
      return 17
    fi
  fi

  local body
  body=$(mktemp "${TMPDIR:-/tmp}/helium-deadman-opsd.XXXXXX")
  {
    echo "helium opsd observations are stale."
    echo "last observation: $last_iso (${age}s ago; threshold ${OPSD_STALE_S}s)"
    echo "event log:        $events"
    echo "checked at:       $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$body"
  if $ALERT_CMD --env-file "$ENV_FILE" \
    --subject "[helium] opsd observation stale since $last_iso" \
    --body-file "$body"; then
    echo "$now" >"$opsd_sentinel"
    rm -f "$body"
    echo "opsd stale (${age}s) — alert sent"
    return 16
  fi
  rm -f "$body"
  echo "opsd stale (${age}s) — alert FAILED" >&2
  return 18
}

age=$((now - last_epoch))
if [ "$last_epoch" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -lt "$STALE_S" ]; then
  rm -f "$sentinel"
  echo "fresh: last heartbeat ${age}s ago ($last_iso)"
  set +e
  check_opsd
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || exit "$rc"
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

body_file=$(mktemp "${TMPDIR:-/tmp}/helium-deadman.XXXXXX")
trap 'rm -f "$body_file"' EXIT
{
  echo "helium heartbeat is stale."
  echo "last heartbeat: $last_iso (${age}s ago; threshold ${STALE_S}s)"
  echo "heartbeat file: ${newest:-none}"
  echo "checked at:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "Check: ssh ${HELIUM_DEPLOY_HOST:-macmini} 'launchctl print gui/\$(id -u)/com.helium.dsh'"
  echo "Logs:  $HOME/.helium/logs/dsh.err.log"
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
