# Helium runtime self-improvement — reviewed plan

Version 1.2, 2026-09-12. Start with [PLAN.md](PLAN.md), then [KICKOFF.md](KICKOFF.md). [REVISION-v1.2.md](REVISION-v1.2.md) records this revision. [REVIEW.md](REVIEW.md) preserves the historical v1.1 review.

This is a documentation-only implementation package. It does not implement or authorize production changes. Source baseline: `e2175344525e355edc5662124712a7250a3d9b88`.

- `verification/checks.json`: the original 83 requirements plus 22 adversarial requirements; all 105 are NOT_RUN.
- `verification/legacy-mapping.json`: all 77 older V/RT requirements retain their mapping. No passing results are imported.
- `contracts/runtime-config-v1.schema.json`: proposed initial payload schema, not an activation policy.
- `examples/`: baseline, untested candidate and deliberately incomplete/disabled templates.
- `verification/validate_package.py`: local package-only checks; requires Python and jsonschema.
- `verification/counterexamples.py`: pure Python specification models, not PostgreSQL or Helium integration tests.

Run from this directory:

```bash
python verification/validate_package.py
python verification/counterexamples.py
```

Do not count either script as product verification. Integration, paid inference, database permissions, real reports and production deployment require their own evidence. No automatic Git, migration, delivery or trading permissions are granted.

M1: local single-worker/test-only mechanism. M2: calibrated real comparison and manual review. M3: later scoped automation. deliveryWave/applicability in checks.json govern sequencing; all original checks remain NOT_RUN. Original GitHub and validation records describe v1.1 only.
