#!/bin/bash
# Point-in-time runs of a tenant, in two modes.
#
#   pit-replay.sh record <YYYY-MM-DD> <premarket|intraday|close|weekly> <state-root>
#   pit-replay.sh replay <sample-dir> <state-root>
#
# `record` is a run pinned to the phase's as-of instant. Every tool call is
# written to <state-root>/runs/<runId>/tool-io/ by the runner itself.
#
# `replay` seeds a fresh state root from a frozen sample under
# docs/evidence/flash-samples/<sample>/ and re-runs it with --replay-from, so a
# tool answers from the recording instead of the network. Missing calls refuse.
#
# Secrets are never echoed: HELIUM_ENV_FILE is referenced by path only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/lib/cli.js"
TENANT="${PIT_TENANT:-option-wizard}"
ARGON_ENV_FILE="${HELIUM_ARGON_ENV_FILE:-$HOME/.config/helium/argon-local.env}"

usage() {
  cat >&2 <<'EOF'
usage:
  pit-replay.sh record <YYYY-MM-DD> <premarket|intraday|close|weekly> <state-root>
  pit-replay.sh replay <sample-dir> <state-root>

record needs HELIUM_ENV_FILE in the environment (path to the tenant's env
file). Optional: HELIUM_ARGON_ENV_FILE (default ~/.config/helium/argon-local.env),
PIT_TENANT (default option-wizard).
EOF
  exit 2
}

# The instant each phase replays. 08:45 / 13:00 / 16:15 ET, in UTC (EDT).
phase_instant() {
  case "$1" in
    premarket) echo "12:45:00Z" ;;
    intraday)  echo "17:00:00Z" ;;
    close)     echo "20:15:00Z" ;;
    weekly)    echo "12:00:00Z" ;;
    *) echo "pit-replay: unknown phase: $1" >&2; exit 2 ;;
  esac
}

load_env() {
  if [ -z "${HELIUM_ENV_FILE:-}" ]; then
    echo "pit-replay: HELIUM_ENV_FILE is unset. Export it with the path to the tenant env file (its contents are never printed)." >&2
    exit 2
  fi
  if [ ! -f "$HELIUM_ENV_FILE" ]; then
    echo "pit-replay: HELIUM_ENV_FILE does not exist: $HELIUM_ENV_FILE" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  . "$HELIUM_ENV_FILE"
  # argon-local.env carries ARGON_BASE_URL; the tenant declares the tool's own
  # name for it. Mapped here, in the runner, not in the tenant.
  if [ -f "$ARGON_ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ARGON_ENV_FILE"
  fi
  set +a
  export OW_ARGON_API_BASE="${OW_ARGON_API_BASE:-${ARGON_BASE_URL:-}}"
  # A replay is a local artifact, never an email or production publication.
  export HELIUM_TENANT_DELIVERY=0
}

# $1 state root, $2 log path, then the run's own flags.
run_cli() {
  local state_root="$1" log="$2"
  shift 2
  export HELIUM_STATE_ROOT="$state_root"
  export HELIUM_AUDIT_DB="$state_root/audit.db"
  export HELIUM_RENDER_DUMP="$state_root/render-dump"
  mkdir -p "$state_root/logs" "$HELIUM_RENDER_DUMP"
  local status=0
  ( cd "$REPO_ROOT" && node "$CLI" run "$TENANT" "$@" ) >"$log" 2>&1 || status=$?
  return "$status"
}

mode="${1:-}"
case "$mode" in
  record)
    [ $# -eq 4 ] || usage
    day="$2"; phase="$3"; state_root="$4"
    instant="$(phase_instant "$phase")"
    load_env
    log="$state_root/logs/$day-$phase.log"
    args=(--phase "$phase" --variant "$(basename "$state_root")")
    if [ -n "$instant" ]; then args+=(--as-of "${day}T${instant}"); fi
    status=0
    run_cli "$state_root" "$log" "${args[@]}" || status=$?
    run_id="$(sed -n 's/^run \(run-[0-9a-f-]*\) .*/\1/p' "$log" | head -1)"
    grep -m1 '^pit coverage:' "$log" || true
    echo "log: $log"
    echo "runId: ${run_id:-UNKNOWN}"
    if [ "$status" -ne 0 ]; then
      echo "pit-replay: run failed (exit $status); tail of the log:" >&2
      tail -20 "$log" >&2
      exit "$status"
    fi
    ;;
  replay)
    [ $# -eq 3 ] || usage
    sample="$2"; state_root="$3"
    [ -f "$sample/run.json" ] || { echo "pit-replay: no $sample/run.json" >&2; exit 2; }
    run_id="$(jq -r '.runId' "$sample/run.json")"
    day="$(jq -r '.date' "$sample/run.json")"
    phase="$(jq -r '.phase' "$sample/run.json")"
    as_of="$(jq -r '.asOf // empty' "$sample/run.json")"
    if [ -z "$as_of" ] && [ -f "$sample/steps.json" ]; then
      as_of="$(jq -r '.run.startedAt // empty' "$sample/steps.json")"
    fi
    [ -n "$as_of" ] || { echo "pit-replay: sample has no recorded clock; refusing a live-clock replay" >&2; exit 2; }
    [ -d "$sample/tool-io" ] || { echo "pit-replay: sample has no tool-io" >&2; exit 2; }
    load_env
    # The runner looks for recordings at <stateRoot>/runs/<runId>/tool-io, so
    # the sample is copied there and nowhere else. Fresh mtimes on purpose:
    # the runner prunes run directories older than 30 days before it reads one.
    mkdir -p "$state_root/runs/$run_id"
    [ ! -e "$state_root/runs/$run_id/tool-io" ] || { echo "pit-replay: recorded input already exists; use a fresh state root" >&2; exit 2; }
    cp -R "$sample/tool-io" "$state_root/runs/$run_id/tool-io"
    log="$state_root/logs/$day-$phase-replay.log"
    args=(--phase "$phase" --variant "$(basename "$state_root")" --replay-from "$run_id")
    if [ -n "$as_of" ]; then args+=(--as-of "$as_of"); fi
    status=0
    run_cli "$state_root" "$log" "${args[@]}" || status=$?
    new_id="$(sed -n 's/^run \(run-[0-9a-f-]*\) .*/\1/p' "$log" | head -1)"
    grep -m1 '^pit coverage:' "$log" || echo "pit coverage: (none reported)"
    echo "log: $log"
    echo "runId: ${new_id:-UNKNOWN}  replayed-from: $run_id"
    if [ "$status" -ne 0 ]; then
      echo "pit-replay: replay failed (exit $status); tail of the log:" >&2
      tail -20 "$log" >&2
      exit "$status"
    fi
    ;;
  *) usage ;;
esac
