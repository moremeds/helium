#!/usr/bin/env bash
# Independent opsd liveness check. It deliberately does not read DSH or tenant
# health, so a policy/config change in those planes cannot create an opsd alert.
set -euo pipefail
umask 077

EVENT_LOG="${HELIUM_OPSD_EVENT_LOG:-$HOME/.helium/ops/state/events.jsonl}"
STATE_DIR="${HELIUM_OPSD_DEADMAN_STATE_DIR:-$HOME/.helium/ops/state/deadman}"
STALE_S="${HELIUM_OPSD_STALE_S:-180}"
REALERT_S="${HELIUM_OPSD_REALERT_S:-3600}"
ALERT_CMD="${HELIUM_OPSD_ALERT_CMD:-}"
ENV_FILE="${HELIUM_ENV_FILE:-$HOME/.config/helium/helium.env}"
NODE_BIN="${HELIUM_NODE_BIN:-$(command -v node)}"

for value in "$STALE_S" "$REALERT_S"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "opsd deadman intervals must be positive integers" >&2
    exit 2
  }
done
[ -x "$NODE_BIN" ] || { echo "opsd deadman node is not executable: $NODE_BIN" >&2; exit 2; }
[ -n "$ALERT_CMD" ] && [ -x "$ALERT_CMD" ] || {
  echo "opsd deadman alert command is not executable: ${ALERT_CMD:-missing}" >&2
  exit 2
}

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
sentinel="$STATE_DIR/alerted-at"
now="$(date -u +%s)"

last_iso=""
if [ -f "$EVENT_LOG" ]; then
  last_iso=$(
    "$NODE_BIN" -e '
      const {readFileSync}=require("node:fs");
      let text="";
      try{text=readFileSync(process.argv[1],"utf8");}catch{}
      const lines=text.trim().split("\n").filter(Boolean);
      let out="";
      for(let i=lines.length-1;i>=0;i--){
        try{
          const record=JSON.parse(lines[i])?.record;
          if(record?.type!=="observation-recorded") continue;
          const at=record.observation?.observedAt ?? record.at;
          if(typeof at==="string" && Number.isFinite(Date.parse(at))){out=at;break;}
        }catch{}
      }
      process.stdout.write(out);' "$EVENT_LOG"
  )
fi

last_epoch=0
if [ -n "$last_iso" ]; then
  last_epoch=$(
    "$NODE_BIN" -e \
      'process.stdout.write(String(Math.floor(Date.parse(process.argv[1])/1000)||0))' \
      "$last_iso"
  )
else
  last_iso="(no valid opsd observation)"
fi
age=$((now - last_epoch))

if [ "$last_epoch" -gt 0 ] && [ "$age" -ge 0 ] && [ "$age" -lt "$STALE_S" ]; then
  rm -f "$sentinel"
  echo "opsd fresh: last observation ${age}s ago ($last_iso)"
  exit 0
fi

if [ -f "$sentinel" ]; then
  previous="$(cat "$sentinel" 2>/dev/null || true)"
  if [[ "$previous" =~ ^[0-9]+$ ]] && [ "$previous" -le "$now" ] && \
     [ $((now - previous)) -lt "$REALERT_S" ]; then
    echo "opsd stale (${age}s) but alerted $((now - previous))s ago — suppressed"
    exit 17
  fi
fi

body="$(mktemp "${TMPDIR:-/tmp}/helium-opsd-deadman.XXXXXX")"
trap 'rm -f "$body"' EXIT
{
  echo "helium opsd observations are stale or invalid."
  echo "last observation: $last_iso (${age}s relative to now; threshold ${STALE_S}s)"
  echo "event log:        $EVENT_LOG"
  echo "checked at:       $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$body"

if "$ALERT_CMD" --env-file "$ENV_FILE" \
  --subject "[helium] opsd observation stale since $last_iso" \
  --body-file "$body"; then
  printf '%s\n' "$now" >"$sentinel"
  echo "opsd stale (${age}s) — alert sent"
  exit 16
fi
echo "opsd stale (${age}s) — alert FAILED" >&2
exit 18
