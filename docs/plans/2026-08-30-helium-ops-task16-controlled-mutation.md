# Helium Ops Task16 Controlled Mutation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Execute one reversible, operator-approved container-reconcile mutation through `opsd`, with a fresh failing baseline, single mutation ownership, exact executable identity, live postconditions, and a replayable recovery-evidence bundle.

**Architecture:** This is the production-promotion execution attachment required by `docs/plans/2026-08-25-helium-ops-agent-implementation.md`; it does not replace or widen that plan. The normal bundle stays observe-only with `colima` externally owned. A separate promotion bundle and runtime mode are staged fail-closed, activated only after both legacy Colima labels are unloaded, and rolled back to the prior observe-only release after the drill. Fresh baseline/postcondition checks reuse the real unpaced read-only observation probes and compiled TypeScript projections; YAML cannot introduce an expression or claim an unimplemented probe.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 3, Zod, macOS launchd, Ed25519 signatures, immutable release candidates, JSONL operations evidence.

---

## Authority and scope

- Authoritative parent: `docs/plans/2026-08-25-helium-ops-agent-implementation.md`, Task 16 and “Post-AC#1 production promotion plan”.
- Operator sequence: merge readiness code first, then perform the live mutation.
- First mutation: restore one deliberately stopped low-blast-radius monitoring container with `trading-stack-reconcile --scope containers --pull false`.
- Candidate failure target: `trading-cadvisor`; final live preflight must reconfirm that it remains non-critical and directly recoverable with `docker start trading-cadvisor`.
- No `auto` mode. The drill uses `approve`, a scoped signed approval, one attempt, and immediate rollback to observe/external ownership.
- No IB Gateway action, image pull, volume change, mount action, Colima VM restart, database write, or model-provider dependency.
- The active `e6b0a87` observe collector is not restarted while the current seven-day zero-action window is accruing. Live drill execution is a later gate; readiness code can merge beforehand.

## Hard stop conditions

Stop before any live write if any of these is true:

1. the seven-day observe gate has not been explicitly closed or waived with a durable operator record;
2. either wrapper or delegated script hash, owner, mode, or path differs from the recorded identity;
3. either legacy Colima label cannot be unloaded, reappears, or cannot be restored from the captured plist;
4. the actual runtime probe inventory differs from the signed inventory;
5. the pre-action baseline is `pass` or `unknown` instead of an evidenced `fail` for the exact expected-container check;
6. any provider/model result is required for eligibility or execution;
7. the expected container set, DATA_LAKE identity, Docker socket, or recovery target differs from the reviewed snapshot;
8. rollback cannot restore the previous observe-only config and both legacy labels before the controlled failure is introduced.

### Task 1: Separate live registrations from fixtures

**Files:**
- Create: `contracts/fixtures/ops-live-bundle/components/fixture.yaml`
- Create: `contracts/fixtures/ops-live-bundle/checks/fixture-readiness.yaml`
- Create: `contracts/fixtures/ops-live-bundle/sops/fixture-observe.yaml`
- Delete: `ops/components/fixture.yaml`
- Delete: `ops/checks/fixture-readiness.yaml`
- Delete: `ops/sops/fixture-observe.yaml`
- Modify: `plugins/ops-agent/src/bundle-loader.test.ts`
- Modify: `plugins/ops-agent/tests/script-certification.spec.ts`

**Step 1: Write the failing test**

Add a certification assertion that the production `ops/` bundle contains no `fixture-*` component, check, SOP, executor, or registered probe.

**Step 2: Verify RED**

Run: `pnpm exec vitest run --project unit plugins/ops-agent/tests/script-certification.spec.ts plugins/ops-agent/src/bundle-loader.test.ts`

Expected: FAIL because the live bundle still contains `fixture-service`, `fixture-readiness`, and `fixture-observe`.

**Step 3: Move the fixture bundle**

Move the three YAML documents byte-for-byte into the contract fixture and update loader tests to point at that directory. Do not replace the fixture with a special runtime exception.

**Step 4: Verify GREEN**

Run the same focused test command. Expected: PASS.

**Step 5: Commit**

`git commit -m "test: isolate ops bundle fixtures"`

### Task 2: Implement the actual runtime check-probe inventory

**Files:**
- Create: `plugins/ops-agent/src/production-checks.ts`
- Create: `plugins/ops-agent/src/production-checks.test.ts`
- Modify: `plugins/ops-agent/src/production-observations.ts`
- Modify: `plugins/ops-agent/src/index.ts`
- Modify: `ops/checks/colima-container-set.yaml`
- Modify: `ops/checks/colima-transport-ready.yaml`
- Modify: `ops/checks/colima-vm-healthy.yaml`
- Modify: `ops/checks/data-lake-mounted.yaml`
- Modify: `ops/checks/livewire-coverage-complete.yaml`
- Modify: `ops/checks/livewire-input-available.yaml`
- Modify: `ops/checks/livewire-target-freshness.yaml`

**Step 1: Write failing projection tests**

Define the wished-for API:

```ts
const runtime = createProductionCheckRuntime(targets, productionRuntime);
expect(runtime.probeIds()).toContain("colima.container-inventory.v1");
const samples = await runtime.sample([containerSetCheck], "baseline", runner, now);
expect(samples).toEqual([{
  checkId: "colima-container-set",
  state: "fail",
  observedAt: now.toISOString(),
  evidenceRefs: expect.arrayContaining([expect.stringMatching(/^artifact:\/\/ops\/raw\//)]),
}]);
```

Cover exact projections for:

- `colima.container-inventory.v1`: `expected-set = missing.length === 0`;
- `colima.guest-runtime.v1`: `readiness = ready`;
- `colima.vm-state.v1`: `readiness = vmState === "running"`;
- `host.volume.data-lake.v1`: `mount-identity = identity.ok`;
- `livewire.status-parser.v1`: `source-available = found`, plus numeric `coverage`;
- `livewire.parquet-integrity.v1`: `integrity = valid`;
- `livewire.coverage-freshness.v1`: `target-freshness = observation.state === "ok"`.

Assert an absent projection, mismatched dimension, expired observation, empty evidence refs, parser failure, timeout, and `unknown` observation can never return `pass`. Assert one underlying snapshot command group runs once when several checks share it.

**Step 2: Verify RED**

Run: `pnpm exec vitest run --project unit plugins/ops-agent/src/production-checks.test.ts`

Expected: FAIL because no runtime check inventory exists.

**Step 3: Implement minimal compiled projections**

Export unpaced production snapshot probes from `production-observations.ts`. Implement a closed projection registry in TypeScript keyed by actual probe id; do not read a field path or expression from YAML. `sample()` must take fresh observations, evaluate each `CheckDefinition` with core `evaluateCheck`, and preserve the raw command evidence refs. A probe exception rejects the sample operation so baseline cannot admit a mutation; post-action replay remains non-terminal until a later fresh sample succeeds.

Update YAML probe ids and dimensions to the real inventory. Change Livewire coverage to `operator: gte` and a reviewed numeric threshold only after the live status value is recorded; otherwise leave that SOP uncertified.

**Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run --project unit plugins/ops-agent/src/production-checks.test.ts plugins/ops-agent/src/production-observations.test.ts packages/core/tests/operations-check.spec.ts
```

Expected: PASS.

**Step 5: Commit**

`git commit -m "feat: run fresh production postcondition checks"`

### Task 3: Make runtime probe registration non-tautological

**Files:**
- Modify: `plugins/ops-agent/src/bin/opsd.ts`
- Modify: `plugins/ops-agent/src/bin/opsd.test.ts`
- Modify: `plugins/ops-agent/tests/script-certification.spec.ts`
- Create: `ops/registered-probes.json`

**Step 1: Write failing registration tests**

Assert `validateOpsdRelease()` and daemon composition reject a check whose `probeId` appears in YAML but is absent from `createProductionCheckRuntime(...).probeIds()`. Assert the exported `ops/registered-probes.json` exactly equals the compiled runtime inventory and is suitable for `sign-authority-manifest.mjs --registered-probes`.

**Step 2: Verify RED**

Run: `pnpm exec vitest run --project unit plugins/ops-agent/src/bin/opsd.test.ts plugins/ops-agent/tests/script-certification.spec.ts`

Expected: FAIL because `discoverConfiguredProbeIds()` currently derives registration from the submitted checks.

**Step 3: Replace self-registration**

Build the check runtime before `OpsBundleLoader`. Pass its compiled probe ids to the loader. Keep a separate observe-only fallback only when `observationTargetsPath` is absent, and require that such a bundle contain no runnable checks. Export the inventory deterministically and test drift in both directions.

**Step 4: Verify GREEN**

Run the same focused command plus `node --test scripts/ops/sign-authority-manifest.test.mjs`. Expected: PASS.

**Step 5: Commit**

`git commit -m "fix: bind checks to registered runtime probes"`

### Task 4: Add the exact container-reconcile promotion bundle

**Files:**
- Create: `ops/promotions/trading-stack-reconcile/components/colima.yaml`
- Create: `ops/promotions/trading-stack-reconcile/checks/colima-container-set.yaml`
- Create: `ops/promotions/trading-stack-reconcile/checks/colima-transport-ready.yaml`
- Create: `ops/promotions/trading-stack-reconcile/checks/data-lake-mounted.yaml`
- Create: `ops/promotions/trading-stack-reconcile/executors/trading-stack-reconcile.yaml`
- Create: `ops/promotions/trading-stack-reconcile/sops/trading-stack-container-reconcile.yaml`
- Create: `plugins/ops-agent/tests/container-reconcile-promotion.spec.ts`
- Modify: `docs/ops/script-inventory.md`

**Step 1: Write the failing promotion test**

Require one mutating SOP with:

- component `colima`, promotion-bundle owner `opsd`, and both legacy labels in `competingLabels`;
- authority `approve`, never `auto`;
- exact executor path/hash/UID 501;
- exact argv schema `--scope containers --pull false`;
- preconditions `data-lake-mounted` and `colima-transport-ready`;
- postcondition `colima-container-set`;
- `maxAttempts: 1`, `cooldownMs >= 1800000`, and a bounded grace window;
- a digest equal to canonical content;
- no IB, pull, volume, mount, shell, or free-form command surface.

Assert the normal `ops/components/colima.yaml` remains externally owned and the normal authority manifest remains empty.

**Step 2: Verify RED**

Run: `pnpm exec vitest run --project unit plugins/ops-agent/tests/container-reconcile-promotion.spec.ts`

Expected: FAIL because the promotion bundle does not exist.

**Step 3: Add the minimal bundle**

Copy only the exact component/check/executor documents required for this SOP. The promotion component's `changeRef` must name the eventual signed handoff evidence, not claim that handoff already happened. Keep the normal live bundle fail-closed.

**Step 4: Verify GREEN**

Run the focused promotion and certification tests. Expected: PASS.

**Step 5: Commit**

`git commit -m "feat: define approved container reconcile promotion"`

### Task 5: Compose an approve-only production daemon

**Files:**
- Modify: `plugins/ops-agent/src/bin/opsd.ts`
- Modify: `plugins/ops-agent/src/bin/opsd.test.ts`
- Modify: `plugins/ops-agent/src/index.ts`
- Modify: `scripts/ops/install-observe-only.sh`
- Modify: `scripts/ops/install-observe-only.test.sh`

**Step 1: Write failing composition tests**

Test a new `composeOpsDaemon()` with `mode: observe | suggest | approve` and no `auto`. For `approve`, require all of:

- an explicit promotion-bundle directory set;
- a non-empty, valid signed authority entry for the exact SOP digest;
- an actual `ScriptRegistry` identity match;
- the compiled check runtime;
- a persisted `launchdControllerProbe` sampled before baseline and immediately before spawn;
- `ScriptExecutor` created lazily only after approval and admission;
- exact argv `['--scope', 'containers', '--pull', 'false']`.

Assert observe/suggest cannot instantiate or call the executor. Assert approve with a missing signature, external owner, loaded competing label, unknown baseline, mismatched wrapper hash, or unsupported SOP returns no mutation.

**Step 2: Verify RED**

Run: `pnpm exec vitest run --project unit plugins/ops-agent/src/bin/opsd.test.ts plugins/ops-agent/src/controller.test.ts`

Expected: FAIL because the packaged runtime accepts only observe and hardcodes unavailable checks/no executor.

**Step 3: Implement the minimal composition**

Keep `composeObserveOnlyOpsDaemon()` as a compatibility wrapper. Add `composeOpsDaemon()` and a strict promotion configuration. Do not accept `auto`. Use the existing durable approvals, component locks, recovery-evidence store, persisted raw runner, script executor, and launchd probe; do not add a second action path.

**Step 4: Verify GREEN**

Run the focused tests with `HELIUM_TEST_NO_PROVIDERS=1`. Expected: PASS and zero provider calls.

**Step 5: Commit**

`git commit -m "feat: compose approve-only controlled recovery"`

### Task 6: Add reversible ownership-handoff tooling

**Files:**
- Create: `scripts/ops/controlled-mutation.mjs`
- Create: `scripts/ops/controlled-mutation.test.mjs`
- Modify: `docs/ops/observe-only-runbook.md`
- Modify: `.github/workflows/ci.yml`

**Step 1: Write failing state-machine tests**

The tool exposes only `preflight`, `handoff`, and `rollback`. Test against a fake host root and fake literal-argv runner. Require:

1. hashes and owner/modes for wrapper, delegate, config, candidate, public key, signed manifest, and both plists;
2. a durable backup plus directory fsync before any unload;
3. exact bootout of both legacy labels, then proof both are absent;
4. atomic config switch and exact opsd restart only after absence proof;
5. proof approve-mode opsd completed a fresh zero-action cycle before a failure may be introduced;
6. rollback stops approve-mode opsd, derives and validates observe mode on the
   signed candidate parser, restores both exact legacy plists/labels, and only
   then restarts observe-mode opsd; the prior bytes remain in the durable
   backup but are not executed against a forward-only newer event ledger;
7. interruption after every step converges through `rollback` without leaving two mutation owners.

Reject symlinks, wrong UID/mode/hash, future timestamps, missing backups, extra labels, unknown subcommands, arbitrary paths, and rollback after identity drift.

**Step 2: Verify RED**

Run: `node --test scripts/ops/controlled-mutation.test.mjs`

Expected: FAIL because the tool does not exist.

**Step 3: Implement literal-argv orchestration**

Use no shell and accept no free-form command. Pin the two legacy labels, plist paths, expected hashes captured in live preflight, opsd label, state paths, and promotion id. `preflight` is read-only. `handoff` and `rollback` append/fsync a state journal before and after each step. Never delete a source plist; bootout is the ownership release, and rollback bootstraps the same captured files.

**Step 4: Verify GREEN**

Run the node test plus packaging tests. Expected: PASS.

**Step 5: Commit**

`git commit -m "feat: add reversible mutation ownership handoff"`

### Task 7: Export and sign exact promotion inputs off-mini

**Files:**
- Create: `scripts/ops/export-promotion-input.mjs`
- Create: `scripts/ops/export-promotion-input.test.mjs`
- Create: `scripts/ops/promotion-package.mjs`
- Create: `scripts/ops/promotion-package.test.mjs`
- Modify: `scripts/ops/sign-authority-manifest.mjs`
- Modify: `scripts/ops/sign-authority-manifest.test.mjs`
- Modify: `scripts/ops/sign-approval.mjs`
- Modify: `scripts/ops/sign-approval.test.mjs`
- Modify: `docs/ops/observe-only-runbook.md`

**Step 1: Write failing export/signing tests**

Require one canonical logical promotion input containing release commit, bundle file hashes, compiled registered-probe inventory hash, component owner decision, executor identity, SOP digest, expiry, and rollback reference. Require a separate host-exported deployment package that binds every staged artifact to that same logical input and is signed only on the registered operator host. Signing must reject a package whose release, probes, owner, SOP, executor, expiry, rollback reference, staged artifact set, or promotion-input hash differs. Approval signing must bind the live incident id, SOP id/digest, exact promotion id, nonce, issue/expiry time, and one attempt.

**Step 2: Verify RED**

Run the three node test files. Expected: FAIL because no canonical promotion exporter exists and approval lacks promotion binding.

**Step 3: Implement minimal canonical export**

Keep the private key off-mini and outside Git. Export public material only. The mini exports exact staged artifact identities read-only; the registered operator host signs that inventory only after matching it to the canonical logical input; live preflight re-hashes every artifact and runs the candidate opsd config check before launchd changes. Output files use exclusive create, mode 0600, fsync, and refuse overwrite. Do not generate or copy a private key from deployment code.

**Step 4: Verify GREEN**

Run signing/export tests and authority-manifest unit tests. Expected: PASS.

**Step 5: Commit**

`git commit -m "feat: bind signed approvals to promotion inputs"`

### Task 8: Run the offline promotion gate and merge by PR

**Files:**
- Modify: `docs/evidence/claims.yaml`
- Modify: `docs/evidence/p2.5a-manifest.yaml`
- Create: `docs/evidence/p2.5a/phase-d-mutation-readiness-2026-08-30.log`

**Step 1: Run focused adversarial repetitions**

Repeat the check sampler, controller admission, stale-lock, evidence-tamper, handoff interruption, and rollback tests 20 times.

**Step 2: Run the full clean gate**

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
bash scripts/ops/install-observe-only.test.sh
node --test scripts/ops/controlled-mutation.test.mjs scripts/ops/export-promotion-input.test.mjs
git diff --check
```

Expected: PASS with live mutation claim still `BLOCKED` and offline readiness recorded separately as `PROVEN`.

**Step 3: Independent review**

Review the committed branch for Important-or-higher gaps. No live mutation occurs during review.

**Step 4: PR and merge**

Push the branch, create a PR that explicitly says “readiness only; zero live mutation”, wait for all CI jobs, merge by PR, fetch, and fast-forward local `master`.

### Task 9: Execute the controlled live mutation after the live gate

**Files:**
- Create after execution: `docs/evidence/p2.5a/phase-d-controlled-mutation-<date>.log`
- Modify after execution: `docs/evidence/claims.yaml`
- Modify after execution: `docs/evidence/p2.5a-manifest.yaml`
- Modify after execution: `docs/ops/script-inventory.md`

**Step 1: Reconfirm read-only preflight**

Verify all hard stop conditions, current zero-action count, current full-cycle health, two exact legacy label hashes, exact wrapper/delegate identities, candidate rollback availability, and a fresh restorable backup. Record the result before any live write.

**Step 2: Prepare signed material off-mini**

Generate or use the operator-held Ed25519 key only on the commissioned workstation. Sign the exact promotion package and authority entry. Copy only the public key and signed artifacts to a private immutable Mini path.

**Step 3: Perform the single-owner handoff**

Run `controlled-mutation.mjs handoff`. Verify both legacy labels are absent, approve-mode opsd is the sole owner, the controller probe is `clear`, and a fresh zero-action cycle completes.

**Step 4: Introduce one bounded failure**

Stop only `trading-cadvisor`. Immediately verify the exact container-set postcondition is `fail` with raw evidence and all unrelated expected containers remain present. If any unrelated state changes, run rollback and stop.

**Step 5: Approve and execute through opsd**

Sign the incident/SOP/digest/promotion-bound approval off-mini, submit it through `opsctl`, and allow one attempt. Require persisted proposal, authorization, failing baseline, controller probes, intent, execution receipt, postcondition samples, attribution, terminal evidence ref/hash, and replay success.

**Step 6: Verify recovery independently**

Require `trading-cadvisor` running, full expected container set present, Docker transport ready, DATA_LAKE identity correct, zero unrelated restarts/OOM, and recovery evidence schema/hash/raw-artifact verification pass. Executor exit 0 alone earns no credit.

**Step 7: Roll back ownership immediately**

Run `controlled-mutation.mjs rollback`: retain the signed candidate parser in
observe mode and restore both legacy owners in reverse order. Do not restart an
older strict event parser after newer action events exist. Verify exactly one
effective mutation owner, current observe cycle, deadman freshness, no residual
approve authority, and rollback availability after the signed mutation window
expires.

**Step 8: Publish evidence without overclaiming**

Record the drill outcome as `PROVEN`, `FAILED`, `PARTIAL`, or `BLOCKED` from evidence. A successful one-off approve drill does not satisfy the seven-day suggest gate and does not authorize `auto`.
