# v1.2 revision — 2026-09-12

This is a documentation revision of the supplied v1.1 ZIP, based on local source baseline e2175344525e355edc5662124712a7250a3d9b88. Original standalone files/ZIP/patch are preserved outside this package. Historical REVIEW.md and verification/package-validation.json remain unchanged; neither validates v1.2.

## What changed

- M1 local mechanism, M2 measured comparison/manual review, M3 scoped automation now have separate exit criteria. A quality winner is not required to validate the mechanism.
- M1 uses one worker, no automatic takeover/retry, no event projection, no production delivery or automated promoter. Scope/input validation, actual DB role restrictions, evidence persistence, CAS and unknown-cost handling remain required. Deferred capabilities require their original safety checks before use.
- §11 makes the existing coverage.final objective executable through a preregistration checklist: calibrated thresholds/sample rationale, quality non-inferiority, resource limits, A/A noise, trial aggregation and failure rules. No invented numerical calibration has been added.
- Premarket-only wiring and third-row treatment slices are explicit. Original v1.1 already contained these ideas; this revision links them to staged acceptance rather than claiming newly discovered defects.
- Pilot template defaults to test and manual review, with explicit missing criteria. Production cannot reuse a relabeled test receipt.
- Stops, compatible rollback, in-flight runs, unknown requests, sunk cost and irreversible delivery are distinguished.
- All 105 original check objects retain their original fields and values; new deliveryWave/applicability metadata separates rollout order from historical requiredFor. All 77 legacy mappings remain unchanged.

## Verification scope

Package/static and pure Python specification models only. Implementation, PostgreSQL, paid models, mini, production and current GitHub permissions are not tested. No code, dependency, schema deployment, runtime setting or production authorization is changed. Original schema file is a proposed payload contract and remains unchanged.

The original root-level .patch is v1.1 only. Do not apply it over v1.2. This package's PLAN.md is the v1.2 source of truth; ZIP is a generated delivery copy.

## Independent revision review

A separate agent reviewed PLAN/KICKOFF/checks/pilot sequencing and found no blocking contradiction. Two clarifications were applied: certificationEpoch is M3-only with manual validity/exposure references in M2; A-11 has a test-only M1 sub-scope before full production receipt acceptance. This is document review, not an independent implementation audit.
