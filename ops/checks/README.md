# Check registry

Checks are **data**. Each file here declares a `CheckDefinition`: a registered
read-only probe, structured arguments, and a comparison expressed as an
operator and a value.

```yaml
id: coverage-freshness
kind: business            # liveness | business
probe:
  probeId: fixture.coverage.v1
  args: { window: daily }
expect:
  dimension: freshness
  operator: lte           # eq | neq | gte | lte | contains
  value: 1
onUnavailable: unknown    # the only permitted value
timeoutMs: 30000
owner: operator
```

## This is the whole mechanism

There is no expression language, no check-authoring framework, and no dynamic
evaluation, and that is deliberate rather than a first version. An expression
string is a command surface; a comparison operator is not. Do not expand this.

## Three rules the registry enforces

1. **A check naming an unregistered probe fails registration.** It does not
   load with a dangling reference and fail later, on the recovery path.
2. **A `CheckRef` must resolve at registration.** The pre-action baseline has
   to *run* every postcondition before the side effect, so a postcondition
   cannot be an unresolved reference.
3. **A check that cannot run yields `unknown`, never `pass`.** Treating
   unavailable as passing is how a postcondition set certifies a repair that
   never happened. `onUnavailable` is closed to the single value `unknown` so
   this cannot be configured away.

## `kind` is load-bearing

`liveness` proves something is running. `business` proves it does its job.

**Every mutating SOP needs at least one `business` postcondition** — a mutating
SOP whose postconditions are all `liveness` fails certification. This is a
direct consequence of the audited integrity failure: the process was healthy
the whole time, and a restart-and-check-the-process repair would have reported
success while the data stayed corrupt.

## Ownership

`owner` is a human-readable owner for the check, carried into evidence. It is
not an authorization field and grants nothing.
