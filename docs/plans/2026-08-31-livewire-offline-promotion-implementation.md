# Livewire Shepherd Offline Promotion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Safely sign and deploy the exact Mac mini Livewire Shepherd runtime from an off-mini operator workstation.

**Architecture:** The Mac mini exports an unsigned content-addressed evidence bundle whose manifest preserves production paths. The operator signer verifies copied bytes plus a clean local release checkout, then signs the unchanged production promotion input. Process-group locks and a required full-stack deployment matrix prevent overlapping writers and false-green releases.

**Tech Stack:** Node.js ESM, TypeScript, Vitest, shell, Ed25519, SHA-256, launchd, Python/pytest, DuckDB/Parquet.

---

### Task 1: Keep the lock while an adopted writer group is alive

**Files:**
- Modify: `plugins/ops-agent/src/action-runner.ts`
- Modify: `plugins/ops-agent/src/component-action-lock.ts`
- Test: `plugins/ops-agent/src/action-runner.test.ts`
- Test: `plugins/ops-agent/src/script-executor.test.ts`

**Step 1: Write the failing integration test**

Run an action whose detached wrapper starts a redirected descendant, closes the
execution gate, and is then killed. Wait for `ScriptExecutor` to resolve and
assert that a second `CertifiedActionRunner` cannot acquire the same component.

**Step 2: Verify the test fails**

Run: `pnpm vitest run --project unit plugins/ops-agent/src/action-runner.test.ts`

Expected: FAIL because `finally` releases the component receipt while the process group is alive.

**Step 3: Implement group-aware release**

Return an adopted process-group identity from the executor result. Before normal
lock release, ask the component lock implementation whether that group is dead.
Retain the receipt for cold reconciliation when any member survives. Do not use
TTL to reclaim a live group.

**Step 4: Verify focused race tests**

Run: `pnpm vitest run --project unit plugins/ops-agent/src/action-runner.test.ts plugins/ops-agent/src/script-executor.test.ts`

Expected: PASS, including redirected-descendant and two-runner cases.

### Task 2: Export content-addressed Mac mini promotion evidence

**Files:**
- Create: `scripts/ops/livewire-promotion-evidence.mjs`
- Create: `scripts/ops/livewire-promotion-evidence.test.mjs`
- Modify: `package.json`

**Step 1: Write failing export tests**

Cover exact production-path mapping, blob deduplication, `0600`/read-only output,
missing byte refusal, symlink refusal, duplicate path refusal, path traversal,
extra blob refusal, and tampered blob detection.

**Step 2: Verify failure**

Run: `node --test scripts/ops/livewire-promotion-evidence.test.mjs`

Expected: FAIL because the exporter does not exist.

**Step 3: Implement the exporter and verifier**

Export every `runtimeFiles`, `pythonRuntimeFiles`, promotion file, registered
probe inventory, source manifest, and every source file named by it to
`blobs/<sha256>`. Write a canonical manifest that binds `promotionInputSha256`,
release commit, production path, hash, size, mode, and kind. Use exclusive files,
fsync, and refuse symlinks or non-regular inputs.

**Step 4: Verify tests**

Run: `node --test scripts/ops/livewire-promotion-evidence.test.mjs`

Expected: PASS.

### Task 3: Add offline evidence verification to the authority signer

**Files:**
- Modify: `scripts/ops/sign-authority-manifest.mjs`
- Modify: `scripts/ops/sign-authority-manifest.test.mjs`
- Modify: `scripts/ops/prepare-livewire-shepherd-promotion.test.mjs`

**Step 1: Write failing signer tests**

Add `--offline-evidence` tests proving that operator-local blob paths can differ
from production paths, while missing/extra/tampered blobs, wrong commit,
promotion drift, executor drift, and runtime inventory drift are refused.

**Step 2: Verify failure**

Run: `node --test scripts/ops/sign-authority-manifest.test.mjs`

Expected: FAIL because the signer still reads Mac mini absolute paths.

**Step 3: Implement offline mode**

When `--offline-evidence` is present, verify the evidence bundle locally and use
its exact bytes for Node/Python/runtime-manifest checks. Verify release-relative
entries against the clean operator checkout at the same commit. Keep all signed
paths and the promotion input unchanged. Preserve the existing direct mode for
same-host tests.

**Step 4: Verify focused tests**

Run: `node --test scripts/ops/sign-authority-manifest.test.mjs scripts/ops/livewire-promotion-evidence.test.mjs scripts/ops/prepare-livewire-shepherd-promotion.test.mjs`

Expected: PASS.

### Task 4: Make the real deployment gate complete and non-skippable

**Files:**
- Modify: `contracts/tests/livewire-shepherd-recovery.contract.spec.ts`
- Modify: `package.json`

**Step 1: Add failing table-driven cases**

Use the pinned actual Livewire checkout for packaged success, independent
rollback, two-process race, action-boundary SIGKILL/cold resume, IB
`AWAITING_USER` with Massive/DuckDB continuity, quota-local continuation, and
changed manifest/hash/owner/executable refusal.

**Step 2: Verify missing coverage fails**

Run: `HELIUM_REQUIRE_LIVEWIRE_CONTRACT=1 HELIUM_LIVEWIRE_ROOT=<ABS> HELIUM_LIVEWIRE_COMMIT=<SHA> pnpm test:livewire-deploy`

Expected: FAIL until every required case executes with zero skips.

**Step 3: Complete the production wiring/fixtures**

Use actual packaged wrappers and the pinned Livewire transaction wherever the
case mutates bytes. Fake only external provider responses and clocks; do not fake
the Ops transaction, lock, evidence store, or verifier.

**Step 4: Verify the deployment gate**

Run the same command.

Expected: PASS with zero skipped required cases.

### Task 5: Run full validation and independent review

**Files:**
- Review all files changed by Tasks 1-4.

**Step 1: Run Helium gates**

Run: `pnpm build && pnpm typecheck && pnpm test:unit -- --maxWorkers=4 && pnpm test:contracts`

Expected: PASS; document any intentionally skipped live-provider tests separately.

**Step 2: Run Livewire gates**

Run the repository's Ruff, Pyright, and full pytest commands from the pinned checkout.

Expected: PASS with no new warning or failure.

**Step 3: Run adversarial review**

Require a frozen-byte review of process ownership, offline evidence completeness,
signing-host separation, deployment gate coverage, installer ordering, and
rollback.

Expected: no Important-or-higher finding.

### Task 6: PR, merge, package, sign, and deploy

**Files:**
- No direct changes to `master` or `main`.

**Step 1: Commit and create PRs**

Commit feature branches, push them, create Livewire and Helium PRs, wait for
required checks, and merge the PRs. Fetch and align both local default branches
to their remote merge commits.

**Step 2: Build immutable Mac mini releases**

Create new release directories from the merge commits, install/build from lock
files, remove caches/bytecode, and make the completed trees read-only. Do not
change current service symlinks.

**Step 3: Prepare and export evidence on the Mac mini**

Prepare the unsigned promotion with exact production paths, then export the
content-addressed evidence directory. Copy it read-only to the operator host.

**Step 4: Verify and sign off-mini**

Verify the evidence using the clean local merge checkout and commissioned host,
then sign with the off-mini Ed25519 key. Return only the authority manifest.

**Step 5: Install and start**

Run the filesystem-only installer, verify ownership/modes/config, explicitly
bootstrap `com.helium.livewire-opsd`, and confirm heartbeat, logs, socket, state,
and zero unexpected mutation.

**Step 6: Verify rollback**

Boot out the new label in a controlled drill, confirm the daemon and writers are
gone while evidence remains, then bootstrap it again and confirm cold resume.

Expected: live monitor healthy; no repair executes without an exact
`REPAIR_READY` work unit; rollback remains available.

