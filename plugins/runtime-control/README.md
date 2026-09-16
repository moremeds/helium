# Runtime control: local M1 only

Stores opaque immutable version payloads, a test deployment pointer, atomic
manual operations, and frozen attempts. The tenant validates payload semantics.
This package does not dispatch providers, deliver output, or establish quality improvement.

Apply `schema.sql` once as the owner of a **new isolated test database**. It creates
`runtime_control_admin` and `runtime_control_runner`; neither can edit tables.
Only the admin can version/initialize/activate/rollback. Only the runner can
start/finalize. The runner connection must never be replaced with owner/admin
credentials. Do not put control connection files or PG credentials into any
provider environment. Production scope and TCP hosts are rejected.

`RuntimeControl.resolve(scope, metadata)` returns a detached snapshot.
`startAttempt({attemptId,snapshot,metadata})` stores it before execution and
rejects a changed pointer. After start, later activations affect the next run.
`finalizeAttempt({attemptId,status,evidence})` accepts SUCCEEDED, FAILED or UNKNOWN
once. Record unknown costs as `null`. DISPATCHED after a crash and UNKNOWN both
block all new starts. M1 provides no automatic retry, takeover, or clearing API.

After building, the explicit administrative entry is:

```sh
node plugins/runtime-control/lib/admin.js CONNECTION.json REQUEST.json
```

Connection fields: `host` (absolute Unix socket directory), `port`, `database`,
`user` (`runtime_control_admin`), optional `password` and `psqlPath`. Keep this
file private and outside the repo. Request examples (illustrative fixture data):

```json
{"action":"version","input":{"scope":{"tenant":"fixture","phase":"fixture","kind":"runtime","environment":"test"},"id":"baseline","payload":{"count":2}}}
```

```json
{"action":"initialize","input":{"scope":{"tenant":"fixture","phase":"fixture","kind":"runtime","environment":"test"},"versionId":"baseline","expectedRevision":0,"operationId":"init-baseline","approval":"Baseline test compatibility reviewed"}}
```

`activate` and `rollback` use the same input shape with the current expected
revision, a fresh operation ID and explicit review note. Rollback only accepts a
previously activated target; every change increments revision. Identical operation
replay returns its original result; changed content under that ID fails.

Run the actual PostgreSQL integration check from the repo root:

```sh
HELIUM_RUNTIME_PG_TEST=1 pnpm vitest run --project unit plugins/runtime-control/tests/store.spec.ts
```

It creates a fresh cluster under `/tmp`, binds only its private Unix socket,
stops it in `finally`, and retains data/logs for inspection. Override binary
directory with `HELIUM_RUNTIME_PG_BIN`; no normal database environment is read.
