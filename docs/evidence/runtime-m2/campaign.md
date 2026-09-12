# M2 sequential campaign executor

`scripts/runtime-campaign.mjs` runs one frozen comparison campaign in its registered order. It composes the existing runtime-control test pointer and `runtime-evaluate`; it does not schedule, score, retry, resume, activate production, or deliver output.

Run after building the repository:

```text
node scripts/runtime-campaign.mjs execution.json admin-connection.json runner-connection.json new-output-directory
```

`execution.json` has this strict shape:

```json
{
  "schemaVersion": "runtime-campaign-execution-v1",
  "comparisonRegistration": "registration.json",
  "referencesDir": "refs",
  "configPayloads": {
    "champion": "champion.json",
    "candidate": "candidate.json"
  },
  "limits": {
    "maxRequests": 2,
    "timeoutMs": 60000,
    "maxRequestBytes": 1048576
  },
  "admin": {
    "pointerApproval": "approved-test-operation-id",
    "initializeApproval": null
  },
  "cases": [
    {
      "caseId": "registered-case-id",
      "inputDir": "frozen-input-directory",
      "capture": "capture.json",
      "asOf": "2026-09-12T00:00:00.000Z"
    }
  ],
  "order": [
    { "caseId": "registered-case-id", "arm": "champion", "replicate": 1 },
    { "caseId": "registered-case-id", "arm": "candidate", "replicate": 1 }
  ]
}
```

The referenced `runtime-comparison-registration-v1` bytes remain the authority for the experiment ID, arm hashes and versions, changed path, ordered case/world cohort, clusters, contiguous repeat count, Devin route, qualification and lineage references, statistical rules, and resource budget. The execution file only locates those frozen inputs, supplies Devin's supported `{maxRequests, timeoutMs, maxRequestBytes}` policy, fixes the registered order, and carries test-admin approvals. Calls are counted in `ACP_INVOCATION`; ACP does not expose hidden HTTP requests or an enforceable output-token/USD ceiling.

Before any pointer or model side effect, the runner freezes the registration, references, arm payloads, case inputs, and captures into the new output directory, then validates and executes only those retained bytes. It rejects an incomplete or duplicate case × arm × replicate inventory, changed input/capture hashes, a stale built engine identity, a non-2-versus-3 confirmation, mismatched limits, missing qualification/calibration/holdout bytes, or an unfunded full inventory. A/A and confirmation are distinct registrations; A/A completion cannot authorize confirmation.

Each trial has a fresh `TMPDIR`. The runner fsyncs its reservation and prepared identity before pointer work, then fsyncs dispatch intent before `runtime-evaluate`. It streams complete stdout/stderr bytes to exclusive files, records argv and exit status, and retains the entire runtime state directory, snapshot, result or failure, DB inspection, inference accounting, and any derived text. Timeout terminates the subprocess group and bounds final pipe draining. `UNKNOWN`, ambiguous DB/admin acknowledgement, malformed outcome, or exhausted budget stops the loop without advancing another pointer. A known generation failure, whether represented by `failure.json` or a failed `result.json`, remains a trial and follows the exact registered no-retry continuation rule.

`trial.json` and `usage.json` are analysis-compatible only when an actual snapshot, outcome, and named attempt exist. Serving identity remains `ROUTE_ONLY`; ACP wire labels stay in raw inspection and `reportedId` remains null. Manual review, claims, coverage, and `observedThirdRow` remain absent or null until trustworthy independent artifacts exist.

The revision-46 refresh produced a `COMPLETE` 90-source/zero-failure capture with input hash `2351da70e29b3993fabd7a66270d3376ce27d854389e68069c46b4ec3c592a89`. Its declared eligibility remains `DIAGNOSTIC_ONLY`, so it does not authorize confirmation. No M2 A/A result or confirmation claim exists until eligible inputs and all registered references are supplied.
