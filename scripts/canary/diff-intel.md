# dsh canary — diff intel

What `scripts/canary/run.sh` does, and how to act on its report.

## The seam list

`@deepseek-ai/dsh` is an RC-only developer preview with no changelog — the
only way to know whether a new release is safe is to check the specific
surfaces helium actually depends on. The DeepSeek-summary prompt encodes
that list explicitly so the model is scored against helium's real usage,
not a generic "what changed":

- `cordis` plugin `apply()` — helium's whole runtime is one cordis plugin.
- `ctx.effect` timers — the harness lifecycle hook (spec §9.1).
- `ctx.agents.create` / `.followup` / `.whenIdle` — the triage lane's agent
  turn (`dispatch.ts`'s `TriageRunner`).
- The session-event watermark (`session.seq` + `assistant/message` events)
  — how a triage turn's final reply is extracted (`finalText()`).
- `ctx.sessions.flush` — the durability checkpoint after every turn.
- Profile bundles + `dsh plugin add file:` — how `dsh-plugin-helium`
  installs into a `$DSH_HOME` (`scripts/deploy-profile.sh`).
- The dsh web server — the operator UI (`launchd/com.helium.dsh.plist.template`).

A candidate that changes none of these is very likely safe to promote even
if its own changelog looks large; a candidate that touches one of them
needs a human to read the diff, not just trust the contract suite.

## Why dist-tag equality is the wrong sentinel

`jobs/dsh-canary.yaml`'s sensor hashes the packument's entire `versions`
map (`fields: [versions]`), not `dist-tags.latest`. `@deepseek-ai/dsh` is an
RC-only preview — every published version so far is an `-rc.N` prerelease,
and an npm publish does not have to move the `latest` dist-tag to a
prerelease at all (npm's default behavior is the opposite: `npm publish`
without an explicit `--tag` only moves `latest` for a version without a
prerelease identifier). Watching `dist-tags.latest` would mean the sentinel
might never fire again after the first RC. Hashing `versions` instead makes
any new version _key_ appear as a state change, regardless of dist-tag.

## Where the isolated `DSH_HOME` lives

Every run gets its own throwaway root: `run.sh` does
`work="$(mktemp -d -t helium-canary)"` and `export DSH_HOME="$work/dsh-home"`
before installing anything, then `trap 'rm -rf "$work"' EXIT`. The candidate
version is pulled in only via a `pnpm.overrides` entry written into a
**copy** of the release tree under `$work` — the release's own
`package.json`/`pnpm-lock.yaml` and the operator's real `~/.dsh` (or
whatever `$DSH_HOME` the production profile uses) are never touched or even
opened. Nothing this script does can affect the production `dsh-plugin-helium`
profile that the deployed daemon actually runs.

## Promoting a pin

The canary never upgrades anything automatically — it only reports. Once a
human has read the report (contract suite result + change intel + diff) and
decided the candidate is safe:

1. Edit root `package.json`'s `@deepseek-ai/dsh` entry to the new version.
2. `pnpm install` (updates `pnpm-lock.yaml`).
3. `HELIUM_LIVE=1 pnpm -F @helium/contracts test` — the real (non-isolated)
   contract suite, against the newly pinned version, with real API calls.
4. Cut a release the normal way (`scripts/release/cut.sh`) and deploy it
   (`scripts/release/deploy.sh`) — the pin promotion ships like any other
   change, with the same drain/flip/health-window/rollback safety net.
