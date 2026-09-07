# M1 — swapped date

One substitution, in the scenarios section only:

    the final 2026-09-04 print   ->   the final 2026-09-02 print

The value beside it (770.19) is unchanged, and the JSON later in the same
section still carries `"date":"2026-09-04"`. So the page now dates one number
to two different sessions, and the recordings date it to neither of the two
consistently.

Signature the reviewer must return: `date-conflict`.
Sentence it must cite: the sentence containing "the final 2026-09-02 print".
