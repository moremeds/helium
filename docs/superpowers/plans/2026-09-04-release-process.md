# Release process — 2026-09-04

Status: approved design (conversation 2026-09-03/04), to implement.
Doctrine: `/Users/chenxi/projects/helium/AGENTS.md` points 5 and 6 govern —
deploy stays minutes-not-days, and every step below exists because it caught
(or will catch) a named defect. Nothing here adds semver, a CHANGELOG step,
or a version bump.

## Why (defects this fixes)

1. **Torn deploys.** `scripts/deploy.sh` does `git pull && pnpm build` _in
   place_ in `~/projects/helium-v2` — the directory the five launchd phases
   `cd` into. A build overlapping a run hands node a mix of two commits.
2. **No provenance.** Nothing records which commit produced a given report.
   `package.json.version` is stuck at 0.2.0 and lies.
3. **The mini pulls from git.** Operator decision: the mini must not run git
   or hold GitHub credentials. Build elsewhere, push the result.
4. **Non-idempotent deploy.** Re-running a deploy of the same commit resets
   the daily email cap again and `kickstart -k` kills an in-flight run.
5. **`-v2` names.** v1 is retired (its five launchd services were shut down
   2026-09-03 and archived to `~/Library/LaunchAgents/.retired-v1-2026-09-03/`).
   The suffix distinguishes nothing now.

## Design

### Layout on the mini (after cutover)

```
~/projects/helium-releases/<sha>/        one fully built tree per deploy
~/projects/helium-releases/current  ->   <sha>      (ln -sfn, atomic)
~/.helium/state/                         was state-v2
```

v1 leftovers are moved aside, not deleted:
`~/projects/helium-releases` (v1, `current -> v0.1.11`) →
`~/projects/helium-releases-v1-retired`; `~/.helium/state` (v1) →
`~/.helium/state-v1-retired`; `~/projects/helium-v2` is removed once
`current` points at a release built by the new path and one phase has run
from it.

### One sender, one receiver

**Sender — `scripts/deploy.sh`, run on the laptop, the only sender.**
Refuses a dirty tree (the sha must name what was built), `pnpm build &&
pnpm test`, writes `RELEASE`, then

```
tar -cz --exclude=… . | ssh macmini "\$HOME/.config/helium/receive-deploy.sh <sha> <phase>"
```

`git archive` cannot do this: `lib/` and `node_modules/` are both gitignored
and both are exactly what a release tree is. **`node_modules` ships in the
tar**, native addons included — laptop and mini are both arm64 macOS on node
25.x, so the installed tree is portable as-is. That is what lets the mini need
no pnpm, no repository and no network during a deploy; if either machine stops
being arm64 macOS on the same major node, this is what breaks first. Excluded:
`.git`, `.worktrees`, `.helium*`, browser scratch.

**Receiver — `scripts/receive-deploy.sh`**, tracked in the repo as the source
of truth and installed by hand to `~/.config/helium/receive-deploy.sh` on the
mini (same class as `run-option-wizard.sh`). Reads the `tar.gz` on **stdin**.
Steps, in order:

1. Validate `$1` as `[0-9a-f]{7,40}` and `$2` as one of the five phases
   (default premarket); exit 2 otherwise. Those two arguments are the whole
   surface of the deploy path.
2. `[ "$(readlink current)" = "<sha>" ] && exit 0` — idempotent: same sha,
   nothing happens (no cap reset, no kickstart).
3. `mkdir helium-releases/<sha>.tmp && tar -xzf - -C <sha>.tmp`, then
   `mv <sha>.tmp <sha>`. No install step.
4. `ln -sfn <sha> current` — the only moment anything live changes.
5. `rm -f ~/.helium/state/reports/email-counters.json` (the daily-cap reset,
   unchanged semantics: a deploy that changes code resets the cap).
6. Re-install the five plists from `current/launchd/` (plutil + plistlib
   check, bootout/bootstrap, as `deploy.sh` did today) and
   `launchctl kickstart -k` the requested phase.
7. Prune: keep the newest 5 release dirs, never the live one.

`scripts/receive-deploy.test.sh` covers 1, 2, 5, 6 and 7 with stubbed
`launchctl`/`plutil` and a temp `$HOME`; CI runs it as `pnpm test:scripts`.

No GitHub-hosted deploy: no workflow, no Tailscale, no deploy key, no forced
command, no secrets (doctrine 6 — that was ceremony, and none of it had caught
a defect).

### Provenance: `code_version` in the audit table

- The tar includes a `RELEASE` file at the tree root: `<sha>\n`, written by
  the sender.
- `packages/cli` resolves the running code's version once per process:
  `RELEASE` file next to the package root if present, else
  `git rev-parse --short HEAD`, else `"unknown"`.
- `Span` (`packages/core/src/audit.ts`) gains `codeVersion: string`;
  column `code_version TEXT NOT NULL DEFAULT 'unknown'` (ALTER for existing
  DBs — `audit.db` outlives releases on purpose). Every `audit.append` in
  `packages/cli/src/runner.ts` carries it.
- `helium audit <run>` prints `code: <sha>` as its first line.
- Delete `"version"` from the root `package.json`. Tests that read it, if
  any, change to `RELEASE`/git.

### Names

- `scripts/deploy.sh`. Its `CHECKOUT`/`STATE_ROOT` defaults go away — the
  laptop sender no longer knows the mini's layout beyond the receiver's path.
- `run-option-wizard.sh`: `cd ~/projects/helium-releases/current`,
  `HELIUM_STATE_ROOT=~/.helium/state`.
- `helium.env`: add `HELIUM_DEPLOYMENT=production` (pending since PR #80;
  without it every production mail says `[TEST]`).

## Rollout order (mini changes are operator-gated: never during an

acceptance window, and each step is verified before the next)

1. Repo PR: `code_version` + `RELEASE` reader + `package.json` version
   removal + new `scripts/deploy.sh` (sender) + `scripts/receive-deploy.sh`
   and its test + docs. CI green. Merge on the user's word.
2. Mini: install `receive-deploy.sh` from the repo copy; move v1 dirs aside;
   `state-v2 → state`; edit `run-option-wizard.sh` + `helium.env`. (Between
   "move state" and "edit the script" no phase may fire — do it outside the
   18:00/… slots.)
3. Laptop `scripts/deploy.sh premarket` → verify `readlink current`, the
   premarket log, and `helium audit <run>` shows `code: <sha>`.
4. Remove `~/projects/helium-v2`.

## Not doing

- semver / CHANGELOG / `cut.sh` / `rollback.sh` — rollback is
  `ln -sfn <previous sha> current`, by hand, from `ls helium-releases`.
- A self-hosted runner on the mini, and a GitHub-hosted deploy of any kind
  (tag trigger, Tailscale, deploy key, forced command, secrets).
- Deleting v1 data dirs (`~/.helium/{ops,canary,quarantine,promotions,…}`) —
  separate cleanup, not part of this.
