# M2 closeout

Status: `CLOSED_DIAGNOSTIC / NOT_QUALIFIED`

M2 established the controlled evaluation and input-repair seams, but did not
produce a qualified coverage improvement claim. The frozen weekly runs and
paired packets remain the evidence of record:

- `tmp/herd-m2/weekly-aa-1/`: two reps on the frozen weekly world;
- `tmp/herd-m2/weekly-input-repair-ab-1/` and `weekly-input-repair-ab-2/`:
  repaired-input preflight and subsequent schema-invalid candidate;
- `tmp/herd-m2/weekly-protocol-route-diagnosis-1/` and
  `tmp/herd-m2/devin-model-selection-2/`: requested SWE route unresolved;
- `tmp/herd-m2/devin-route-guard-1/`: route guard implementation and review;
- `tmp/herd-m2/weekly-development-review-2/`: coverage/depth packet with no
  scores promoted to qualification.

The qualification prerequisites were not met: serving identity was not bound,
the candidate arm did not yield a comparable valid report, and no independent
confirmation cohort exists. Further full weekly calls would repeat route and
envelope failures without adding causal evidence. All artifacts are retained;
M3 owns the next experiment contract.

