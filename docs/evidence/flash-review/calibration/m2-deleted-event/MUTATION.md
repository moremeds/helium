# M2 — the main event deleted

Four substitutions, and nothing else. Together they remove every mention of the
2026-09-16 FOMC from the page:

1. catalysts — drop `FOMC 9/16 with 55.7% hike probability will reset terminal
   rate expectations.`
2. review — `the 9/16 hike probability coin-flip did not resolve` becomes
   `the hike probability coin-flip did not resolve`
3. the `policy.path` coverage row — `"observable": "FOMC 9/16 resolves by
   2026-09-17."` becomes `"observable": ""`
4. the 10-session week-review body — the quoted cause `Vol bleeding to a
   three-week low as a live FOMC stays a coin flip,` becomes `Vol bleeding to a
   three-week low on the week,`

The generator refuses to write the file if `FOMC` or `9/16` survives anywhere
in it.

The evidence is untouched: `00001-ow_session_frame.json.gz` and
`00003-…` carry `2026-09-16` and the FOMC hike probability, and
`00009-ow_review_window.json.gz` carries the FOMC cause line. So the page's
forward view no longer names the one policy event its own evidence says is
coming.

Signature the reviewer must return: `missing-major-event` (or
`outlook-has-more-than-the-calendar`, which is the same omission read from the
outlook's side).

## Why the first version of this mutation was replaced

It deleted only substitution 1. The page went on naming `9/16` in three other
places, so there was no missing event to find, and the round-1 reviewer was
right not to report one. Recorded rather than quietly fixed: a calibration item
that cannot be failed teaches the rubric nothing.
