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
