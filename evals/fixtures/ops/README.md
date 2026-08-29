# Ops incident fixtures

Six frozen cases derived from the **read-only** audit of the Mac mini on
2026-08-25. That audit performed no production mutation, and neither does
anything here: these are static JSON files.

Every fixture's `observations` array holds real `Observation` values that parse
through `ObservationSchema` (`packages/core/src/operations/observation.ts`).
`packages/core/tests/ops-fixtures.spec.ts` enforces that, and was falsified
before being trusted — setting one `state` to `"healthy"` turns the suite red.

## Source

Each case is derived from a numbered section of
[the Ops Agent design](../../../docs/plans/2026-08-25-helium-ops-agent-design.md),
and the expected assertions mirror its section 3.6 decision table. Nothing here
is invented: where the audit did not establish something, the assertion is
`BLOCKED` or `PARTIAL` rather than a guess.

| Fixture | Source | What it pins |
|---|---|---|
| `colima-operator-recovery.json` | §3.1 | The watchdog reached its own failure path; the operator recovered Docker. Automation `FAILED`, attribution `operator`. |
| `livewire-parquet-corruption.json` | §3.2 | Integrity failure while the process is healthy, so a generic restart is `FAILED` as a repair. |
| `livewire-parser-drift.json` | §3.2 | The status surface disagrees with source logs that are newer than it implies. |
| `argon-backup-stale.json` | §3.3 | API serving, backup artifact from 2026-07-23, backup daemon exit `EX_CONFIG`. |
| `apex-healthy.json` | §3.4 | Serving and self-reporting healthy dependencies — self-report is not independent verification. |
| `host-memory-pressure.json` | §3.5 | Chronic capacity pressure, not an immediate outage. |

## What was removed or normalized

- **No host addresses.** No IP, hostname, or Tailscale address appears. The
  contract greps for the `100.66.` CGNAT prefix and fails on a match.
- **No credentials.** No key, token, or password, in any field. The contract
  greps for `api_key` / `apiKey` / `password` and fails on a match.
- **No raw log payloads.** Raw evidence is referenced by an
  `artifact://ops-fixture/...` URI rather than inlined. The URIs are stable
  identifiers for evidence that is not committed, not fetchable paths.
- **Absolute times normalized to UTC.** The Colima case is stamped
  `03:01:12Z` / `03:02:34Z`, matching the ~11:01 local observation in §3.1.

## Raw-to-schema state mapping

`ObservationSchema.state` is a closed four-value enum. Vendor vocabulary from
the incident is preserved verbatim inside `value` and `evidenceRefs`, where no
policy code branches on it, and the source tool becomes `probeId`. Admitting a
vendor word as a `state` would let a probe report something no policy code
handles.

| Raw vocabulary | Where it lives now | `state` |
|---|---|---|
| watchdog `recovery_exhausted` | `value.watchdogOutcome` | `failed` |
| status surface `healthy` | `value.reported*` | `ok` |
| coverage job `invalid parquet footer` | `value.latestFailure` | `failed` |
| backup daemon `EX_CONFIG` | `value.lastExit` | `failed` |
| 20 running containers | `value.containerCount` | `ok` |
| ~6.67 GiB swap allocated, no sustained burst | `value.swapAllocatedGiB`, `value.sustainedSwapBurstDuringSample` | `degraded` |

## The two terminal keys are separate planes

`expected.incidentTerminal` and `expected.actionOutcome` use disjoint
vocabularies (review XDOC-9). An incident ends `open | diagnosing |
action-eligible | recovering | verifying | recovered | failed | uncertain |
escalated`; an action ends `succeeded | failed | not-needed | uncertain |
superseded-by-operator | external-recovery`. `recovered` and `escalated` are
incident states and are never action outcomes.

Where Helium attempted no action at all, `actionOutcome` is `null` — not an
invented value. That is true of every fixture here, because the audit observed
a system with no Ops controller running.

## The claim these fixtures exist to block

> Time proximity is not action provenance.

`colima-operator-recovery.json` is the case: Docker did become healthy, and an
automatic action did run, and the action did **not** cause the recovery. A
controller that infers success from a later healthy reading gets this exactly
backwards, so the fixture records `automaticRecoverySucceeded: false` alongside
`finalDockerHealth: PROVEN`, and a dedicated test asserts that pairing.
