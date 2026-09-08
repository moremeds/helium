#!/bin/bash
# Run the flash-review tenant over one page.
#
#   flash-review.sh <page-path> <evidence-dir> <state-root> [label]
#
# The reviewer is handed the page, the frozen recordings behind it and its own
# rubric — nothing else. `label` names the run's variant so two reviews of one
# page stay apart in the audit table; it never reaches the model, because the
# variant is not part of the assembled prompt.
#
# The verdict, the routed model and the token counts are copied to
# <page-dir>/review/ so a page carries its own review beside it.
#
# Secrets are never echoed: HELIUM_ENV_FILE is referenced by path only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/lib/cli.js"

usage() {
  cat >&2 <<'EOF'
usage: flash-review.sh <page-path> <evidence-dir> <state-root> [label]

Needs HELIUM_ENV_FILE in the environment (path to the provider env file; its
contents are never printed).
EOF
  exit 2
}

[ $# -ge 3 ] && [ $# -le 4 ] || usage
page="$1"; evidence="$2"; state_root="$3"; label="${4:-calibration}"

[ -f "$page" ] || { echo "flash-review: no such page: $page" >&2; exit 2; }
[ -d "$evidence" ] || { echo "flash-review: no such evidence dir: $evidence" >&2; exit 2; }
if [ -z "${HELIUM_ENV_FILE:-}" ]; then
  echo "flash-review: HELIUM_ENV_FILE is unset. Export it with the path to the provider env file (its contents are never printed)." >&2
  exit 2
fi
[ -f "$HELIUM_ENV_FILE" ] || { echo "flash-review: HELIUM_ENV_FILE does not exist: $HELIUM_ENV_FILE" >&2; exit 2; }

set -a
# shellcheck disable=SC1090
. "$HELIUM_ENV_FILE"
set +a

# Absolute, because the CLI runs with the repo root as its cwd.
export FR_PAGE="$(cd "$(dirname "$page")" && pwd)/$(basename "$page")"
export FR_EVIDENCE_DIR="$(cd "$evidence" && pwd)"
export HELIUM_STATE_ROOT="$state_root"
export HELIUM_AUDIT_DB="$state_root/audit.db"
export HELIUM_TENANT_DELIVERY=1
mkdir -p "$state_root/logs"

log="$state_root/logs/$label.log"
status=0
( cd "$REPO_ROOT" && node "$CLI" run flash-review --phase review --variant "$label" ) >"$log" 2>&1 || status=$?
run_id="$(sed -n 's/^run \(run-[0-9a-f-]*\) .*/\1/p' "$log" | head -1)"
echo "log: $log"
echo "runId: ${run_id:-UNKNOWN}"
if [ "$status" -ne 0 ]; then
  echo "flash-review: run failed (exit $status); tail of the log:" >&2
  tail -20 "$log" >&2
  exit "$status"
fi

out="$(cd "$(dirname "$page")" && pwd)/review"
mkdir -p "$out"
# The delivered verdict, named for the page rather than for the run: a page
# reviewed twice keeps both under different labels.
report="$state_root/reports/flash-review-$(date -u +%Y-%m-%d)-review.md"
if [ -f "$report" ]; then
  cp "$report" "$out/$label.md"
else
  echo "flash-review: no delivered report at $report" >&2
fi

# Doctrine 4: the model and the tokens come out of the audit table, not out of
# the log. One row per span; the reviewer step is the one with a model on it.
if [ -n "${run_id:-}" ] && [ -f "$HELIUM_AUDIT_DB" ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const rows = db.prepare(
      "SELECT role, provider, model, SUM(input_tokens) tin, SUM(output_tokens) tout," +
      " SUM(cache_read_tokens) cache, SUM(cost_usd) usd, SUM(latency_ms)/1000.0 sec" +
      " FROM span WHERE run_id = ? GROUP BY role, provider, model ORDER BY usd DESC",
    ).all(process.argv[2]);
    console.log(JSON.stringify({ runId: process.argv[2], spans: rows }, null, 1));
  ' "$HELIUM_AUDIT_DB" "$run_id" >"$out/$label.audit.json" 2>/dev/null ||
    echo "flash-review: audit query failed; $out/$label.audit.json not written" >&2
fi
echo "review: $out/$label.md"
