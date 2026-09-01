# dsh canary — diff intel

What `scripts/canary/run.sh` does, and how to act on its report.

## The seam list

Upstream does publish per-tag release notes, bilingual and attributed, at
<https://github.com/deepseek-ai/deepseek-harness/releases> — read them first.
They are organised by user-facing feature, not by API surface, so they answer
"what changed" but not "what changed *for helium*". The seam list below is
the second question. The DeepSeek-summary prompt encodes it explicitly so the
model is scored against helium's real usage:

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
map (`fields: [versions]`), not `dist-tags.latest`. `@deepseek-ai/dsh` is a
prerelease-only preview — every published version is a prerelease (`-rc.N`
through 0.1.1-rc.2, `-alpha.N` from 0.1.2-alpha.1 on),
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

1. Edit EVERY pin site to the new version. They must all agree, and missing
   one is the known failure mode: the 0.1.2-alpha.3 promotion left `DSH_PIN`
   on the old version while build, typecheck, unit and contracts were all
   green, so the mini would have installed the previous dsh.
   - `package.json` — `@deepseek-ai/dsh`
   - `plugins/helium/package.json` — every `@deepseek-ai/dsh-*` devDependency
     (including `@deepseek-ai/dsh-tool-todo`), plus `@deepseek-ai/cordis` and
     `@deepseek-ai/cordis-plugin-loader`, which move on their own numbering
   - `profile/package.json` — `@deepseek-ai/dsh-web-app`, same exact version
   - `contracts/fixtures/{plugin-live-dispatch,plugin-restrict-proof,team-host}/package.json`
   - `contracts/src/dsh.ts` — `PINNED_DSH_VERSION`
   - `scripts/release/deploy.sh` — `DSH_PIN`. **No test reads this file.**
   Then grep the tree for the outgoing version string: comments in this repo
   cite line numbers measured against the installed package, and those rot
   silently on a bump.
2. `pnpm install` (updates `pnpm-lock.yaml`).
3. `HELIUM_LIVE=1 pnpm -F @helium/contracts test` — the real (non-isolated)
   contract suite, against the newly pinned version, with real API calls.
4. Cut a release the normal way (`scripts/release/cut.sh`) and deploy it
   (`scripts/release/deploy.sh`) — the pin promotion ships like any other
   change, with the same drain/flip/health-window/rollback safety net.

## Known defects, measured on 0.1.1-rc.2 — NOT re-measured on the current pin

The pin is now 0.1.2-alpha.3. Nothing below has been re-checked against it, so
treat each entry as a dated rc.2 observation and re-measure before citing it.

Recheck these when promoting the pin — a candidate that fixes one of them is a
reason to upgrade, and a candidate that still carries it is not a regression.

### Interactive sessions cannot execute ANY tool

Every tool call in an interactive dsh session (the web UI on :3080) dies with:

```
This turn failed  Cannot read properties of undefined (reading 'prepare')
```

`scheduler.prepare(` lives in `@deepseek-ai/dsh-session`; the scheduler is
undefined on the tool-execution path. Isolated by controlled comparison during
the 3.7 AC#7 pass:

| session does | result |
|---|---|
| no tool at all ("reply PONG") | works, 0s |
| calls a helium tool (`argon_api`) | fails, `scheduler.prepare` undefined |
| calls dsh's OWN built-in `Bash` tool | fails, identically |

It is dsh's own defect, not the helium toolkit's: `.prepare(` appears nowhere in
helium's source, helium's tools register correctly (they appear in the session
and are selected before the turn dies), and dsh's built-in tools break exactly as
much as ours.

**No production lane is affected.** Triage reaches the model through the agents
API and calls no tools by design; the senior lane reaches tools through the MCP
stdio server under `claude -p`, which is proven working end to end. Only the
interactive UI is impaired, and only for tool calls — reading sessions,
trajectories and telemetry all work.
