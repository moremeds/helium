#!/bin/bash
# One A/B/C draft: swap a team manifest in, run the sample, collect the draft.
#
#   flash-abc.sh <sample> <A|B|C|C-nonews> <state-root>
#
# <sample> is a directory name under docs/evidence/flash-samples/. A daily
# sample is replayed from its frozen tool-io; the weekly cannot be replayed
# (it runs with no --as-of, so --replay-from is inert) and is run LIVE.
#
# The swap is the only way to select a team file: tenant.yaml pins `team:` and
# there is no per-run manifest flag. team.yaml on disk IS variant A, so A runs
# with no swap at all. The trap restores the original bytes on every exit path,
# and the script fails loudly if the tree is not clean afterwards.
#
# Secrets are never echoed: HELIUM_ENV_FILE is referenced by path only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM="$REPO_ROOT/plugins/option-wizard/team.yaml"
SAMPLES="$REPO_ROOT/docs/evidence/flash-samples"
DRAFTS="$REPO_ROOT/docs/evidence/flash-drafts"

usage() {
  echo "usage: flash-abc.sh <sample> <A|B|C|C-nonews> <state-root>" >&2
  exit 2
}
[ $# -eq 3 ] || usage
sample="$1"; variant="$2"; state_root="$3"

sample_dir="$SAMPLES/$sample"
[ -f "$sample_dir/run.json" ] || { echo "flash-abc: no $sample_dir/run.json" >&2; exit 2; }

case "$variant" in
  A) swap_from="" ;;
  B|C|C-nonews) swap_from="$REPO_ROOT/plugins/option-wizard/team.$variant.yaml" ;;
  *) usage ;;
esac
if [ -n "$swap_from" ] && [ ! -f "$swap_from" ]; then
  echo "flash-abc: no such variant manifest: $swap_from" >&2
  exit 2
fi

out="$DRAFTS/$sample/$variant"
mkdir -p "$out" "$state_root/logs"

# ---- the swap, and its undo ------------------------------------------------
backup=""
restore() {
  if [ -n "$backup" ]; then
    cp "$backup" "$TEAM"
    rm -f "$backup"
    backup=""
  fi
  if ! git -C "$REPO_ROOT" diff --quiet -- plugins/option-wizard/team.yaml; then
    echo "flash-abc: FAILED TO RESTORE team.yaml — the tree is dirty" >&2
    exit 3
  fi
}
trap restore EXIT INT TERM
if [ -n "$swap_from" ]; then
  backup="$(mktemp -t flash-abc-team)"
  cp "$TEAM" "$backup"
  cp "$swap_from" "$TEAM"
fi

# ---- the run ---------------------------------------------------------------
day="$(jq -r '.date' "$sample_dir/run.json")"
phase="$(jq -r '.phase' "$sample_dir/run.json")"

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status=0
if [ "$phase" = "weekly" ]; then
  # LIVE. No as-of, no replay: see the sample's MISSING.md.
  "$REPO_ROOT/scripts/pit-replay.sh" record "$day" weekly "$state_root" \
    >"$out/pit-replay.out" 2>&1 || status=$?
  runlog="$state_root/logs/$day-$phase.log"
else
  "$REPO_ROOT/scripts/pit-replay.sh" replay "$sample_dir" "$state_root" \
    >"$out/pit-replay.out" 2>&1 || status=$?
  runlog="$state_root/logs/$day-$phase-replay.log"
fi
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_id="$(sed -n 's/^runId: \(run-[0-9a-f-]*\).*/\1/p' "$out/pit-replay.out" | head -1)"
# ponytail: no retry, no backoff, no partial-result salvage. A failed run is
# reported as a failed run and rerun by hand; 16 runs do not earn a state
# machine.

# ---- collect ---------------------------------------------------------------
cp "$runlog" "$out/run.log" 2>/dev/null || true

# The REPORT DAY is not the sample's day for a live weekly: with no --as-of the
# runner resolves the day from the tenant's timezone, i.e. today. Take it from
# the evidence header, which is found by run id, and fall back to the sample.
evidence="$(ls "$state_root"/evidence/*"$run_id".json 2>/dev/null | head -1)"
report_day="$day"
if [ -n "$evidence" ]; then
  report_day="$(jq -r '.run.day // empty' "$evidence")"
  report_day="${report_day:-$day}"
fi
cp "$state_root/reports/option-wizard-$report_day-$phase.md" "$out/report.md" 2>/dev/null || true
cp "$state_root/render-dump/option-wizard-$report_day-$phase.html" "$out/render.html" 2>/dev/null || true

author_task=$([ "$phase" = weekly ] && echo weekly || echo edit)
if [ -n "$evidence" ] && [ -f "$evidence" ]; then
  cp "$evidence" "$out/steps.json"
  jq -r --arg t "$author_task" '.steps[] | select(.task==$t) | .assembledPrompt // ""' \
    "$evidence" >"$out/author.prompt.txt"
  jq -r --arg t "$author_task" '.steps[] | select(.task==$t) | .output // ""' \
    "$evidence" >"$out/author.output.txt"
fi

# The audit table is the only place the model and the token counts live
# (doctrine 4). Cache reads are a separate column and are reported separately.
author_role=$([ "$phase" = weekly ] && echo weekly-analyst || echo editor)
tokens="$(sqlite3 "$state_root/audit.db" \
  "select model||'|'||sum(input_tokens)||'|'||sum(output_tokens)||'|'||sum(cache_read_tokens)
   from span where run_id='$run_id' and role='$author_role' and model<>'none' group by model;" \
  2>/dev/null | head -1)"

served="$(grep -m1 '^pit coverage:' "$out/pit-replay.out" || echo 'pit coverage: (none)')"
team_sha="$(jq -r '.run.teamYamlSha256 // "unknown"' "$out/steps.json" 2>/dev/null || echo unknown)"

{
  echo "sample: $sample"
  echo "variant: $variant"
  echo "manifest: ${swap_from:-$TEAM (variant A, unswapped)}"
  echo "teamYamlSha256: $team_sha"
  echo "runId: ${run_id:-UNKNOWN}"
  echo "reportDay: $report_day"
  echo "exit: $status"
  echo "startedAt: $started"
  echo "finishedAt: $finished"
  echo "authorTask: $author_task"
  echo "authorRole: $author_role"
  echo "authorModel: ${tokens%%|*}"
  rest="${tokens#*|}"
  echo "inputTokens: ${rest%%|*}"; rest="${rest#*|}"
  echo "outputTokens: ${rest%%|*}"; rest="${rest#*|}"
  echo "cacheReadTokens: ${rest%%|*}"
  echo "$served"
} >"$out/meta.txt"

cat "$out/meta.txt"
exit "$status"
