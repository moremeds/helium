#!/usr/bin/env bash
# dsh upgrade canary. Never upgrades anything. Isolated install + contract
# suite + mirror-repo diff intel -> report -> inbox drop + immediate email.
#
# Deliberately never touches the production $DSH_HOME or profile: everything
# below runs against a throwaway `$work` copy of the release tree with its
# own DSH_HOME, and only reads the pinned version from the release's own
# package.json (never writes it).
set -euo pipefail

release="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE_ROOT="${HELIUM_STATE_ROOT:-/Users/moremeds/.helium/state}"
ENV_FILE="${HELIUM_ENV_FILE:-/Users/moremeds/.config/helium/helium.env}"
CACHE="${HELIUM_CANARY_CACHE:-$HOME/.helium/canary}"
REGISTRY="${HELIUM_CANARY_REGISTRY:-https://registry.npmjs.org}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="$STATE_ROOT/reports/dsh-canary/$stamp.md"
mkdir -p "$(dirname "$report")" "$STATE_ROOT/inbox" "$CACHE"

pin="$(node -p "require('$release/package.json').devDependencies['@deepseek-ai/dsh']")"
# semver is resolved explicitly from $release rather than by bare name: a bare
# require() in `node -e` resolves against the CALLER's cwd, and semver is a
# dependency of the release tree, not of wherever the operator happens to be
# standing. Production survived that only by accident — runScript() spawns with
# cwd=<release>/jobs, which walks up into <release>/node_modules — but the
# documented by-hand invocation runs from $HOME and died with
# "Cannot find module 'semver'" the first time the AC#4 drill ran it (task 3.6
# step 15). require.resolve with an explicit paths[] is layout-agnostic, so it
# keeps working whether pnpm hoists semver or nests it.
candidate="$(node -e '
  const semver=require(require.resolve("semver",{paths:[process.argv[3]]}));
  const cmd="npm view @deepseek-ai/dsh versions --json --registry="+process.argv[2];
  const list=JSON.parse(require("node:child_process").execSync(cmd,{encoding:"utf8"}));
  const newer=list.filter((v)=>semver.gt(v,process.argv[1])).sort(semver.rcompare);
  process.stdout.write(newer[0] ?? "");' "$pin" "$REGISTRY" "$release")"

if [ -z "$candidate" ]; then
  echo "canary: no version newer than $pin"
  exit 0
fi
echo "canary: pin=$pin candidate=$candidate"

work="$(mktemp -d -t helium-canary)"
trap 'rm -rf "$work"' EXIT
export DSH_HOME="$work/dsh-home"
mkdir -p "$DSH_HOME"

# `scripts` and `profile` are copied alongside the workspace packages
# because `contracts/src/dsh.ts`'s `deployHeliumProfile()` shells out to
# `<repoRoot>/scripts/deploy-profile.sh`, which in turn reads
# `<repoRoot>/profile/{package.json,cordis.yml,cordis.patch.yml}` — both
# contract specs that mount the helium profile (profile-mount,
# effect-timer) would otherwise fail on a missing file regardless of
# whether the candidate dsh is actually compatible, masking the real signal.
cp -R "$release/packages" "$release/plugins" "$release/contracts" \
      "$release/scripts" "$release/profile" \
      "$release/package.json" "$release/pnpm-workspace.yaml" \
      "$release/pnpm-lock.yaml" "$release/tsconfig.base.json" "$work/"
find "$work" -maxdepth 4 -type d -name node_modules -exec rm -rf {} + 2>/dev/null || true

# The override goes in pnpm-workspace.yaml, NOT package.json. pnpm 11.0.3
# SILENTLY IGNORES `pnpm.overrides` in package.json — no warning, no error, it
# just resolves the original version. Verified on the mini with two real
# published versions: depend on 0.1.1-rc.2 and override to 0.1.1-rc.1, and the
# lockfile still says rc.2 from package.json but says rc.1 from
# pnpm-workspace.yaml. This is why the AC#4 drill's first run reported
# `contracts=PASS` against a candidate whose tarball does not even exist: the
# isolated tree had quietly installed the PINNED version, so the canary was
# testing production's own dsh and would have green-lit any breaking upgrade.
printf '\noverrides:\n  "@deepseek-ai/dsh": %s\n' "$candidate" >> "$work/pnpm-workspace.yaml"

contracts_status=FAIL
contracts_log="$work/contracts.log"
installed_dsh=""
if ( cd "$work" && pnpm install --no-frozen-lockfile >"$contracts_log" 2>&1 \
     && pnpm build >>"$contracts_log" 2>&1 ); then
  # A successful install is NOT evidence the candidate was installed. Whatever
  # the override mechanism happens to do in some future pnpm, the only thing
  # worth trusting is the version actually on disk — assert it, so a silently
  # ignored override can never again be reported as a passing contract run.
  installed_dsh="$(node -p "require('$work/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || true)"
  if [ "$installed_dsh" != "$candidate" ]; then
    contracts_status=INVALID
    echo "canary: ABORT — asked for $candidate but the isolated tree installed '${installed_dsh:-nothing}'." >&2
    echo "canary: the contract suite was NOT run; a result would have described the wrong version." >&2
  else
    if [ -r "$ENV_FILE" ]; then
      set -a
      # shellcheck disable=SC1090 # operator-supplied path, never present in this repo.
      . "$ENV_FILE"
      set +a
    fi
    if ( cd "$work" && HELIUM_LIVE=1 HELIUM_DSH_VERSION="$candidate" \
         pnpm -F @helium/contracts test >>"$contracts_log" 2>&1 ); then
      contracts_status=PASS
    fi
  fi
fi
echo "canary: contracts=$contracts_status"

# Mirror-repo diff intel — the repo URL is read from the packument, never
# hard-coded, so this keeps working if the upstream repo ever moves.
mirror="$(npm view @deepseek-ai/dsh repository.url --registry="$REGISTRY" 2>/dev/null \
  | sed -e 's#^git+##' -e 's#\.git$##' || true)"
diff_file="$work/diff.patch"
: > "$diff_file"
if [ -n "$mirror" ]; then
  clone="$CACHE/dsh-mirror"
  if [ -d "$clone/.git" ]; then
    git -C "$clone" fetch --tags --quiet || true
  else
    git clone --filter=blob:none --quiet "$mirror" "$clone" || true
  fi
  resolve_tag() {
    # Upstream tags the monorepo per-app: `dsh-v0.1.2-alpha.3`, not `v0.1.2-alpha.3`.
    # Without the `dsh-` form this function never matched a single published tag,
    # so every canary run since the first one reported "(tags not resolvable)"
    # instead of a diff. The bare forms stay as fallbacks if upstream ever moves.
    for cand in "dsh-v$1" "v$1" "$1"; do
      if git -C "$clone" rev-parse -q --verify "refs/tags/$cand" >/dev/null; then
        echo "$cand"
        return
      fi
    done
    echo ""
  }
  a="$(resolve_tag "$pin")"
  b="$(resolve_tag "$candidate")"
  if [ -n "$a" ] && [ -n "$b" ]; then
    git -C "$clone" diff "$a..$b" -- packages bundles README.md > "$diff_file" || true
  else
    echo "(tags not resolvable in mirror: pin=$a candidate=$b)" > "$diff_file"
  fi
else
  echo "(no repository.url in the packument — diff intel skipped)" > "$diff_file"
fi
head -c 51200 "$diff_file" > "$work/diff.trunc"

# DeepSeek summary via curl. The key never touches argv/ps — it goes into a
# 0600 `curl -K` config file, removed immediately after the call.
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090 # operator-supplied path, never present in this repo.
  . "$ENV_FILE"
  set +a
fi
umask 077
curlcfg="$work/curl.cfg"
printf 'header = "Authorization: Bearer %s"\n' "${DEEPSEEK_API_KEY:-}" > "$curlcfg"
model="${HELIUM_CANARY_MODEL:-deepseek-v4-flash}"
node -e '
  const {readFileSync,writeFileSync}=require("node:fs");
  const diff=readFileSync(process.argv[1],"utf8");
  writeFileSync(process.argv[2],JSON.stringify({model:process.argv[3],messages:[
    {role:"system",content:"You review upstream diffs for a downstream integrator."},
    {role:"user",content:
      "helium depends on these dsh seams: cordis plugin apply(), ctx.effect timers, "+
      "ctx.agents.create/followup/whenIdle, the session-event watermark "+
      "(session.seq + assistant/message), ctx.sessions.flush, profile bundles + "+
      "\"dsh plugin add file:\", and the dsh web server. Read the diff and answer: "+
      "(1) which of those seams changed, (2) what breaks if we upgrade blind, "+
      "(3) upgrade recommendation in one line. Diff follows.\n\n"+diff}],
    max_tokens:1200}));' "$work/diff.trunc" "$work/req.json" "$model"

intel="$(curl -sS -m 120 -K "$curlcfg" -H 'content-type: application/json' \
  --data @"$work/req.json" https://api.deepseek.com/chat/completions \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{
      try{console.log(JSON.parse(s).choices[0].message.content);}
      catch(e){console.log("(intel call failed: "+String(e)+")");}});')"
rm -f "$curlcfg"

{
  echo "# dsh canary — $candidate (pinned $pin)"
  echo
  echo "- checked: $stamp"
  echo "- contract suite: **$contracts_status**"
  echo "- dsh actually installed in the isolated tree: ${installed_dsh:-none} (candidate $candidate)"
  echo "- mirror: ${mirror:-none}"
  echo "- production profile: untouched (isolated DSH_HOME=$DSH_HOME)"
  echo
  echo "## Change intel"
  echo
  echo "$intel"
  echo
  echo "## Contract log (tail)"
  echo '```'
  tail -40 "$contracts_log" 2>/dev/null || echo "(no log)"
  echo '```'
  echo
  echo "**Never auto-upgrade.** A human promotes the pin in package.json, then ships"
  echo "it as an ordinary release; the canary's isolated profile is the smoke test."
} > "$report"

node -e '
  const {writeFileSync}=require("node:fs");
  writeFileSync(process.argv[1],JSON.stringify({kind:"canary",ts:new Date().toISOString(),
    pin:process.argv[2],candidate:process.argv[3],contracts:process.argv[4],
    report:process.argv[5]},null,2));' \
  "$STATE_ROOT/inbox/canary-$stamp.json" "$pin" "$candidate" "$contracts_status" "$report"

node "$release/scripts/deadman/send-alert.mjs" --env-file "$ENV_FILE" \
  --subject "[helium/canary] dsh $candidate released — contracts $contracts_status" \
  --body-file "$report"
cat "$report"
