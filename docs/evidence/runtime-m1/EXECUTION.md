# Runtime improvement M1 — local mechanism acceptance

Plan: [v1.2](../../plans/2026-09-11-runtime-self-improvement/PLAN.md). Execution base: `fd78edcdf7623d48b3910af4b8fc28299045ca42` (the plan branch, PR #127); source baseline: `e2175344525e355edc5662124712a7250a3d9b88`. The implementation worktree began clean. Unrelated files in the primary checkout were preserved.

## Delivered

- The tenant validates the complete registered payload and injects only premarket `perStock` in {1,2,3}; default 2 and other phases remain unchanged. Generic strict JSON parsing/canonical identity is shared by its two real consumers, not duplicated.
- `runtime-control` uses the already-installed `psql`, four tables and one transaction function. Test roles, immutable version identity, idempotent manual operations, expected-revision CAS, append-only operation records and once-only attempt finalization are exercised against a new PostgreSQL cluster. No external dependency, event consumer, automatic grant or worker scheduler was added.
- The M1 composition resolves and stores the database snapshot before tool construction, creates a fresh output/audit/ledger namespace, copies frozen inputs, rebuilds the real session frame, and records downstream assembled prompts. No model/provider is discovered or called and delivery is disabled. The ordinary run command remains on its existing path.
- Missing/corrupted replay input is refused; query occurrences and recorded source failures are retained. A frame exception now marks the pilot step/report/DB attempt failed instead of merely embedding FAILED text in a successful report. Crashed/UNKNOWN attempts block new starts; there is no automatic takeover or blind retry.
- The experiment writes config/build/input identities, snapshots, input copies, evidence, final results and real audit rows. Mechanism tests do not stand in for report-quality or provider-context verification.

## Acceptance evidence

| Claim / plan sub-scope | Evidence | Re-verify from repository root |
|---|---|---|
| P0 baseline | 29 existing CLI/replay/news tests passed in the unchanged primary checkout; pre-existing calendar-sensitive failure independently reproduced | `pnpm vitest run --project unit packages/cli/tests/run-as-of.spec.ts packages/cli/tests/runner-evidence.spec.ts plugins/option-wizard/tests/quality-news-overview.spec.ts` |
| P1, A-15, A-21: strict payload, default/phase isolation, actual third-row treatment | `plugins/option-wizard/tests/runtime-config.spec.ts`; captured citation rows and explicit synthetic integration world; no runtime network | `pnpm vitest run --project unit plugins/option-wizard/tests/runtime-config.spec.ts packages/core/tests/strict-json.spec.ts` |
| P2 and test portions of P6: ACL/version/CAS/idempotency/snapshot/failure/rollback | `plugins/runtime-control/tests/store.spec.ts`; actual local PostgreSQL, owner/administrator/runner roles | `HELIUM_RUNTIME_PG_TEST=1 pnpm vitest run --project unit plugins/runtime-control/tests/store.spec.ts` |
| P3, A-19 and test switch/rollback: DB -> actual tenant builder -> downstream prompt | `packages/cli/tests/runtime-pilot.spec.ts`; 2 -> 3 -> 2 with revision 1 -> 2 -> 3, prior snapshots unchanged; malformed source leads to FAILED | `HELIUM_RUNTIME_PG_TEST=1 pnpm vitest run --project unit packages/cli/tests/runtime-pilot.spec.ts` |
| Strict input replay and retention | `packages/cli/tests/replay-strict.spec.ts` plus pilot input-hash equality after archiving | `pnpm vitest run --project unit packages/cli/tests/replay-strict.spec.ts` |
| Built modules and types | Passed | `pnpm build && pnpm typecheck` |
| Unit regression | 1302 passed, 5 skipped (including the two opt-in PostgreSQL tests run separately) | `pnpm test` |
| Existing contracts | 5 passed, 3 opt-in tests skipped | `pnpm test:contracts` |
| Real DB integration | Both store and runner scenarios passed; isolated clusters stopped, scratch evidence retained | `HELIUM_RUNTIME_PG_TEST=1 pnpm vitest run --project unit plugins/runtime-control/tests/store.spec.ts packages/cli/tests/runtime-pilot.spec.ts` |
| Independent native source review | One success-misclassification finding fixed and re-reviewed with no remaining blocker | Inspect regression and rerun the pilot integration test; cross-model tribunal not run |

Command results and log digests: [verification.json](verification.json). The pre-existing earnings-batching regression used a Sep 10 future event against the wall clock. Only that test's Date is now frozen at its original Sep 6 context; product logic and its assertions are unchanged.

## Running the test-only entry

Build first. Follow [control-store setup and administrative requests](../../../plugins/runtime-control/README.md) against a new isolated database. Use a runner-role connection file, not administrator credentials. The administrative CLI accepts JSON files; version creation, initialization, activation and rollback do not require source edits. Seed the exact payload in the plan's baseline/candidate examples under the scope `{tenant:"option-wizard",phase:"premarket",kind:"product",environment:"test"}`.

```sh
node packages/cli/lib/cli.js runtime-pilot option-wizard --connection RUNNER_CONNECTION.json --input FROZEN_TOOL_IO_DIRECTORY --as-of 2026-09-09T13:07:00Z --phase premarket
```

Paths and the instant above are operator inputs; use the recorded world's actual instant. The entry prints its new evidence directory. The original outer-frame-only recording is not a sufficient raw input world: missing exact source occurrences make the run NOT_COMPARABLE. The integration check uses a small two-step deterministic DAG with the real builder; it is not acceptance of the full production team's output. A pilot snapshot records the effective team hash as well as the original file hash.

## Remaining phases and limits

M1 local mechanism is verified. M2 still needs a real corpus and independent confirmation cohort, calibrated evaluator/thresholds/sample rationale and an agreed inference budget before confirmation. The synthetic data, deterministic handoff and zero model calls here cannot demonstrate quality improvement, actual provider context, latency of real inference, alpha, or an acceptable production configuration.

M3 (production-like shadow, production authorization, automated promotion/recovery and delivery) and P8/P9/C extensions have not run. Database tests use local trust authentication to exercise SQL role permissions, not to certify production authentication or hostile-provider isolation. No normal database, mini, market-data write, formal email, order, merge or deployment was touched. The original 105 checklist entries remain NOT_RUN: this evidence records their M1 sub-scopes rather than falsely marking multi-phase requirements complete.
