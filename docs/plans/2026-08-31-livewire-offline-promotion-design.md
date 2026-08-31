# Livewire Shepherd Offline Promotion Design

## Goal

Deploy the Livewire Shepherd to the Mac mini without moving the Ed25519 private
key off the commissioned operator workstation, while proving that the signed
promotion describes the exact bytes and production paths that the Mac mini will
execute.

## Constraints

- The private authority key never reaches the Mac mini or Git.
- The signed promotion keeps Mac mini absolute paths; operator-workstation paths
  are verification locations only.
- Installation and rollback remain reversible.
- A killed wrapper must not release the component lock while any writer in its
  adopted process group remains alive.
- The deployment gate uses the pinned Livewire commit and cannot skip the real
  packaged transaction tests.
- This release protects against accidental drift, stale writers, wrong owners,
  wrong manifests, and corrupt transfer. An already-compromised same-UID account
  racing an inode replacement after verification is outside this rollout's
  threat model; deployed release and promotion trees are made read-only.

## Data flow

1. The Mac mini prepares the unsigned promotion from the exact immutable Helium
   release, pinned Livewire checkout, Node binary, Python binary, promotion
   bundle, source manifest, and runtime dependency closures.
2. An exporter writes an immutable content-addressed evidence directory. Its
   manifest maps every production path to a SHA-256 blob and binds the complete
   promotion-input hash. Duplicate bytes share one blob. Symlinks, missing files,
   path traversal, duplicate production paths, and unlisted blobs are refused.
3. The evidence directory is copied to the commissioned operator workstation.
   The signer verifies every local blob, the exact file set, the canonical
   promotion-input hash, the clean local Helium release commit, all release-local
   bytes, promotion documents, executors, registered probes, source manifest,
   and Node/Python runtime inventories. It signs the original promotion input;
   it never rewrites production paths.
4. Only the signed authority manifest is returned to the Mac mini. Before any
   release JavaScript runs, the installer verifies the signed input and hashes
   the current production paths. Startup and every repair repeat the relevant
   closure checks.

## Process ownership

The action lock belongs to the adopted process group, not merely the wrapper
leader. Normal completion may release the lock only after the complete group is
dead. If the wrapper leader dies while a writer descendant survives, the action
is terminally uncertain but the lock receipt remains. Startup continues its
read-only monitor/projector path, refuses a second writer, and reclaims the lock
only after the group is confirmed dead.

## Verification and deployment

The required deployment command pins both the Helium merge commit and the
Livewire commit. It runs actual packaged success, independent-verifier rollback,
two-writer exclusion, process-boundary kill/restart, IB `AWAITING_USER` with
Massive/DuckDB continuity, quota-local continuation, and tampered manifest/hash/
owner/executable refusals. The deployment proceeds through PRs; no branch is
pushed directly to `master` or `main`. The Mac mini install is filesystem-only
until an explicit `launchctl bootstrap`, followed by heartbeat, state, log, and
zero-unexpected-mutation checks. Rollback boots out the new label and preserves
evidence.

