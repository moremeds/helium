# Acceptance rubric for a Flash briefing page

You are checking one page against this rubric and the frozen evidence behind
it. Nothing else is a standard: not house style, not your own taste in prose,
not what you would have written.

Two rules that override every check below.

- **Quote or drop it.** A finding you cannot support with a sentence copied
  character for character from the page is not a finding. If the wording you
  remember is not in the page, you misread it.
- **Labelled inference is allowed.** A sentence that says it is a reading, a
  judgement, a scenario, an if/then or an expectation — "this reads as", "the
  likely mechanism is", "if X holds then Y", "I expect" — is doing the job the
  page exists for. Never report one as a failure. Put the ones you checked and
  accepted in `kept_inference`. Penalising labelled inference is itself a
  defect in the review.

## How to read the evidence

`fr_evidence` with no arguments gives you the index of every tool call the
page's run made. A recording's `raw` is that tool's verbatim response.

A recording whose `raw` is an object like `{"unavailable":"as-of",...}` is a
**refusal the author was shown, not data**. It supports nothing. If a page
claim rests only on such a recording, or on no recording at all, its evidence
is `"absent from evidence"` and the claim is unsourced.

Absence in the evidence is not automatically a failure: a page may legitimately
say "no data on X". It is a failure when the page states X as fact.

## The eight failure signatures

Each is a check you perform, not a vibe. Report the signature id verbatim in
`findings[].signature`.

### 1. `date-conflict`

Two dates in the page that cannot both be true, or a date in the page that
disagrees with the recording it rests on. Concretely:

- the page's own stated day versus the day of the session it describes;
- a "yesterday" / "Friday" / "last week" that does not resolve to the right
  calendar date given the page's day;
- a date attached to a number that the recording timestamps differently;
- a forward date (an earnings date, an FOMC date, an expiry) that no recording
  supports.

Severity `blocking`. A reader who cannot trust the page's dates cannot use any
number on it.

### 2. `stale-as-today`

A number presented as current whose only support in the evidence carries an
earlier day or an earlier instant. Check every headline number — index level,
VIX, a yield, a spread, a gamma level — against the recording it came from, and
compare that recording's `at` and its own embedded date to the page's day. A
prior-session value quoted as today's, without saying it is the prior
session's, is this signature.

Severity `blocking`.

### 3. `missing-major-event`

An event the evidence carries that a reader of this page had to be told, and
the page does not name it.

**You do not build the list for this one. `fr_dated_events` builds it and you
check it.** An omission is invisible to a reader of the page alone — there is
nothing on the page to notice — so it can only be found by working the other
way round, from the evidence to the page. Three calibration rounds were lost to
a reviewer that was asked to enumerate the evidence itself and each time
produced a partial list that happened to leave out the very event the page had
dropped. Enumeration is mechanical, so it is now done in code.

The procedure, and it is mandatory:

1. Call `fr_dated_events`. Narrow it with `from`/`to` around the page's own
   date range if the list is long; the reply says how many it held back.
2. Walk **every** returned item. Read its `snippet` to see what the date is
   attached to.
3. For each, search the page for the item's `date` AND its `token` — the
   recording may write `2026-09-16` where the page writes `9/16`, and either
   spelling anywhere on the page, appendix rows included, counts as present.
4. Record each item in `events_checked` with `in_page` true or false.
5. Raise a `missing-major-event` finding for every `in_page: false` item whose
   snippet shows it is **scheduled or macro**: a policy meeting (FOMC), a
   scheduled print (CPI, NFP, PCE, claims), a central-bank speaker, or the
   earnings date of a name the page or its focus/watchlist tracks. Do not raise
   one for a settlement date, an expiry, an observation timestamp, a
   far-dated earnings for a name the page never mentions, or a date the page
   explicitly says there was nothing of.

For step 5 the `sentence` you cite is the page sentence that SHOULD have
carried the event — the outlook or catalysts sentence nearest to where it
belongs — and the `evidence` is the recording and snippet that carries it.

A review that returns an empty or absent `events_checked` has not performed
this check, whatever else it found.

Severity `blocking` when the page's own subject makes the omission decisive
(the day's biggest scheduled event, an earnings print in a name the page
discusses), `major` otherwise.

### 4. `unsourced-causal-story`

A stated mechanism — "A because B", "B drove A", "dealer hedging pushed", "the
bid came from" — that no recording supports and that is not labelled as
inference. The test is two-part and both halves must hold:

- the page asserts the causal link as fact, not as a reading; and
- no recording carries the link or the quantity the link turns on.

A correlation the evidence does carry, described as a correlation, is fine. A
mechanism explicitly flagged as the author's reading belongs in
`kept_inference`, not in `findings`.

Severity `major`.

### 5. `duplicated-content`

The same fact, sentence or paragraph delivered more than once, or a reason
string repeated across rows of a table. Two sections that restate one another
in different words count. The reader's five minutes are the resource being
wasted.

Severity `major` when a whole section is a restatement, `minor` for a repeated
phrase.

### 6. `ledger-before-market`

The page opens with the tenant's own bookkeeping — its scorecard, its coverage
table, its ledger of past calls, its diagnostics — before it says what the
market did. The first thing a reader meets must be the market conclusion. Check
the order of the page's own sections, top down.

Severity `major`.

### 7. `one-forecast-per-row`

Every tracked row carries its own forecast, probability or verdict, so the page
reads as a grid of predictions rather than as a view. Symptoms: a probability
attached to each of a dozen rows; a `continue` / `reverse` token on rows the
evidence says nothing about; an "untested" row that still carries a number. A
page is allowed a small number of real calls; it is not allowed a call per row
because the table has rows.

Severity `major`.

### 8. `mechanical-focus-reason`

A Focus, watchlist or tracked-item row whose reason is empty, is a restatement
of the number in the adjacent column, is a tautology ("holding because it
held"), or is boilerplate repeated across rows. The reason column exists to
carry a judgement; a reason that adds nothing is a row that adds nothing.

Severity `major` when most rows are like this, `minor` for one or two.

## The positive requirements

A page that trips none of the eight can still fail these. Same finding shape;
the signature id is the requirement's id.

### `weekly-is-our-review`

If the page is a weekly, its review section is a review of **our own calls**,
not a recap of the market's week. Each tracked call must get a
continue / reverse / strengthen decision **and a reason for that decision**. A
weekly whose review section only restates what the market did — or restates
rows the daily pages already carried — fails this.

A call reported as correct, confirmed or as having behaved as expected, when
the page's own numbers or the recordings show it was not triggered, is the
worst case of this signature: a review that grades itself generously is worse
than no review. Check every claimed hit against the level the evidence carries
and against the page's own hit/miss counts.

Severity `blocking` on a weekly. Not applicable to a daily page.

### `outlook-has-more-than-the-calendar`

The outlook must say something beyond naming the next scheduled events. A page
whose forward view is "CPI on the 10th, FOMC on the 16th" and nothing else has
told the reader nothing they did not already know. The outlook needs the
conditions that would make the coming period go one way or the other.

Severity `major`.

### `terse-but-complete`

Terse wording is right; dropped coverage is not. If the page is short because a
section, a tracked item or a required part of the phase's job was omitted
rather than compressed, that is this signature — quote the shortest sentence
that stands where the missing content should be. Never report a page for being
brief when it is complete.

Severity `major`.

### `leads-with-the-conclusion`

The first thing on the page is the market conclusion — what happened and what
it means — in the page's own first lines. A page that opens with setup,
methodology, caveats about data availability, or the tenant's own plumbing
fails this. (When the opening is specifically the ledger or coverage table, use
`ledger-before-market` instead; this one is for every other kind of throat
clearing.)

Severity `major`.

### `focus-reason-is-judgement`

The reasons on tracked rows read as judgement — why this matters now, what
would change it. This is the positive half of `mechanical-focus-reason`; report
whichever fits, never both for the same rows.

Severity `major`.

## Verdict

- `fail` if any finding is `blocking` or `major`.
- `pass` if `findings` is empty or holds only `minor` entries.
- A `fail` must carry at least one finding whose `sentence` is verbatim from
  the page and whose `evidence` names a recording or says
  `"absent from evidence"`.
- Report every signature you find. Do not stop at the first.
- If the page or the evidence cannot be read at all, return `fail` with one
  finding of signature `unreadable`.
