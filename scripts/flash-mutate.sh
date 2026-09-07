#!/bin/bash
# Build the Step 2 calibration set, deterministically.
#
#   flash-mutate.sh page   <report.md> <page.md>
#   flash-mutate.sh mutate <page.md> <out-dir>
#
# `page` strips a run's delivered markdown down to the text a READER gets. The
# reviewer must never see a model name, a metrics line, a gate refusal or a
# tool byte count — those are the author's self-report, and the whole point of
# Step 2 is a verdict reached without them. Doing it here, once, is what makes
# every calibration page blind by construction rather than by good intentions.
#
# `mutate` writes four single-defect copies of one page, each with a
# MUTATION.md naming exactly what changed. Every edit is a fixed substitution
# on a fixed anchor: a mutation that moved with the input would make a miss
# unexplainable.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  flash-mutate.sh page   <report.md> <page.md>
  flash-mutate.sh mutate <page.md> <out-dir>
EOF
  exit 2
}

# One awk pass. It keeps section bodies and drops everything that is about the
# RUN rather than about the market.
extract_page() {
  awk '
    # Everything before the first step heading is the delivery header: run id,
    # outcome, quality metrics, pit coverage, gate refusals. None of it is page
    # text and all of it names the author.
    !started && $0 !~ /^## / { next }
    /^## / {
      started = 1
      # "## weekly — weekly-analyst" -> "## weekly". The role is pipeline
      # vocabulary; a reader never sees it.
      sub(/ +— .*$/, "")
      # Hold the heading: a section that is nothing but tool lines is not a
      # section, and printing the heading before we know is what would leave
      # empty scaffolding behind.
      pending = $0
      body = 0
      next
    }
    started {
      # The routed target, printed by the runner as its own line.
      if ($0 ~ /^`[a-z-]+:[A-Za-z0-9._-]+`$/) next
      # Tool result lines a deterministic step emits.
      if ($0 ~ /^- [a-z_]+ — (ok, [0-9]+ bytes|FAILED)/) next
      if ($0 ~ /^[a-z_]+: (skipped|not built by this tenant)/) next
      # The audit pointer the runner appends after the last section.
      if ($0 ~ /^Full per-step tokens and cost: /) next
      if ($0 ~ /^[[:space:]]*$/ && body == 0) next
      if (pending != "") { if (out) printf "\n"; print pending; print ""; out = 1; pending = "" }
      body = 1
      print
    }
  ' "$1"
}

mode="${1:-}"
case "$mode" in
  page)
    [ $# -eq 3 ] || usage
    [ -f "$2" ] || { echo "flash-mutate: no such report: $2" >&2; exit 2; }
    mkdir -p "$(dirname "$3")"
    extract_page "$2" >"$3"
    echo "page: $3 ($(wc -l <"$3" | tr -d ' ') lines)"
    ;;
  mutate)
    [ $# -eq 3 ] || usage
    page="$2"; out="$3"
    [ -f "$page" ] || { echo "flash-mutate: no such page: $page" >&2; exit 2; }

    # --- M1: a swapped date -------------------------------------------------
    # The page's reference close is dated 2026-09-04 in both the prose and the
    # JSON that carries it. Changing ONLY the prose leaves the page
    # self-contradictory and contradicted by the recordings.
    mkdir -p "$out/m1-swapped-date"
    sed 's/final 2026-09-04 print/final 2026-09-02 print/' "$page" \
      >"$out/m1-swapped-date/page.md"
    cat >"$out/m1-swapped-date/MUTATION.md" <<'EOF'
# M1 — swapped date

One substitution, in the scenarios section only:

    the final 2026-09-04 print   ->   the final 2026-09-02 print

The value beside it (770.19) is unchanged, and the JSON later in the same
section still carries `"date":"2026-09-04"`. So the page now dates one number
to two different sessions, and the recordings date it to neither of the two
consistently.

Signature the reviewer must return: `date-conflict`.
Sentence it must cite: the sentence containing "the final 2026-09-02 print".
EOF

    # --- M2: the main event's paragraph deleted -----------------------------
    # The FOMC/hike-probability paragraph is the page's one forward catalyst.
    # Deleting the sentence that carries it leaves an outlook that names no
    # policy event at all, while the evidence still carries the probability.
    mkdir -p "$out/m2-deleted-event"
    sed 's/ FOMC 9\/16 with 55\.7% hike probability will reset terminal rate expectations\.//' "$page" \
      >"$out/m2-deleted-event/page.md"
    cat >"$out/m2-deleted-event/MUTATION.md" <<'EOF'
# M2 — the main event's paragraph deleted

One deletion, from the catalysts section:

    FOMC 9/16 with 55.7% hike probability will reset terminal rate expectations.

Nothing else changed. The evidence still carries the hike probability and the
FOMC date; the page no longer names the meeting anywhere in its forward view.

Signature the reviewer must return: `missing-major-event` (or
`outlook-has-more-than-the-calendar` if it reads the gap as an outlook that
lost its only policy anchor).
EOF

    # --- M3: an inserted, plausible, unsourced mechanism ---------------------
    # Appended to the outlook so it reads as the author's own causal claim, in
    # the page's own register, resting on no recording.
    mkdir -p "$out/m3-unsourced-mechanism"
    sed 's/Fed broad index strength at 118\.7 continued the dollar bid, limiting commodity upside\./Fed broad index strength at 118.7 continued the dollar bid, limiting commodity upside. Dealers rebalanced into the Friday close, and that hedging flow is what pushed the gamma flip 1.20 points higher./' "$page" \
      >"$out/m3-unsourced-mechanism/page.md"
    cat >"$out/m3-unsourced-mechanism/MUTATION.md" <<'EOF'
# M3 — inserted unsourced mechanism

One sentence appended to the outlook section:

    Dealers rebalanced into the Friday close, and that hedging flow is what
    pushed the gamma flip 1.20 points higher.

It is plausible, it is in the page's register, it is stated as fact rather than
as a reading, and no recording carries dealer rebalancing or attributes the
gamma move to hedging flow.

Signature the reviewer must return: `unsourced-causal-story`.
Sentence it must cite: the inserted sentence, verbatim.
EOF

    # --- M4: a miss rewritten as a hit --------------------------------------
    # The page's own review says yesterday's checks scored two misses. Turning
    # the vol miss into a confirmation is the failure mode a ledger exists to
    # prevent, and the numbers around it are left intact so the rewrite
    # contradicts them.
    mkdir -p "$out/m4-miss-as-hit"
    sed 's/vol failed to extend below 14\.25 or snap back toward 15, holding at 14\.32/vol behaved as called, extending below 14.25 as expected and confirming the compression read/' "$page" \
      >"$out/m4-miss-as-hit/page.md"
    cat >"$out/m4-miss-as-hit/MUTATION.md" <<'EOF'
# M4 — a not-triggered call rewritten as correct

One substitution, in the review section:

    vol failed to extend below 14.25 or snap back toward 15, holding at 14.32
    ->
    vol behaved as called, extending below 14.25 as expected and confirming the
    compression read

The page still says "2 misses" in the same sentence and still reports 14.32 as
the level elsewhere, so the rewrite contradicts both the count and the number,
and the recordings carry 14.32.

Signature the reviewer must return: `weekly-is-our-review` (the rubric makes a
call reported as correct that the evidence shows was not triggered a blocking
failure of that requirement).
Sentence it must cite: the rewritten sentence, verbatim.
EOF

    for dir in "$out"/m*/; do
      if cmp -s "$page" "$dir/page.md"; then
        echo "flash-mutate: $dir/page.md is identical to the source page — its anchor did not match" >&2
        exit 1
      fi
    done
    echo "mutations: $(ls -d "$out"/m*/ | wc -l | tr -d ' ') under $out"
    ;;
  *) usage ;;
esac
