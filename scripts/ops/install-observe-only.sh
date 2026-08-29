#!/usr/bin/env bash
# Render the observe-only opsd package. This script never invokes launchctl.
set -euo pipefail
umask 077

FREEZE_END="2026-08-31"
COMMISSIONING_WAIVER="ops-phase-d-weekend-2026-08-30"
release=""
root=""
launchd_root=""
commissioning_waiver=""
now="$(/bin/date -u +%F)"

usage() {
  echo "usage: install-observe-only.sh --release ABS --root ABS --launchd-root ABS [--commissioning-waiver ID]" >&2
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) [ "$#" -ge 2 ] || usage; release="$2"; shift 2 ;;
    --root) [ "$#" -ge 2 ] || usage; root="$2"; shift 2 ;;
    --launchd-root) [ "$#" -ge 2 ] || usage; launchd_root="$2"; shift 2 ;;
    --commissioning-waiver) [ "$#" -ge 2 ] || usage; commissioning_waiver="$2"; shift 2 ;;
    *) usage ;;
  esac
done
case "$root" in
  */.helium/ops) ;;
  *) echo "ops root must end in /.helium/ops" >&2; exit 65 ;;
esac
case "$launchd_root" in
  */Library/LaunchAgents) ;;
  *) echo "launchd root must end in /Library/LaunchAgents" >&2; exit 65 ;;
esac

for value in "$release" "$root" "$launchd_root"; do
  case "$value" in
    /*) [ "$value" != "/" ] || { echo "refusing broad target /" >&2; exit 65; } ;;
    *) echo "all target paths must be absolute" >&2; exit 65 ;;
  esac
done
[[ "$now" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
  echo "host UTC date must be YYYY-MM-DD" >&2
  exit 64
}
node_bin="${HELIUM_NODE_BIN:-}"
if [ -z "$node_bin" ]; then
  node_bin="$(command -v node)" || { echo "node is required" >&2; exit 69; }
fi
case "$node_bin" in
  /*) [ -x "$node_bin" ] || { echo "node is not executable: $node_bin" >&2; exit 69; } ;;
  *) echo "HELIUM_NODE_BIN must be an absolute executable path" >&2; exit 69 ;;
esac
# shellcheck disable=SC2016 # The template expression belongs to Node, not Bash.
if ! "$node_bin" \
  -e 'const d=process.argv[1]; if(new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)!==d) process.exit(1)' \
  "$now"; then
  echo "host UTC date is not a calendar date" >&2
  exit 64
fi
if [ -n "$commissioning_waiver" ] && [ "$commissioning_waiver" != "$COMMISSIONING_WAIVER" ]; then
  echo "unknown commissioning waiver: $commissioning_waiver" >&2
  exit 77
fi
if [[ ! "$now" > "$FREEZE_END" ]] && [ "$commissioning_waiver" != "$COMMISSIONING_WAIVER" ]; then
  echo "observe-only install refused: AC#1 freeze is in force through $FREEZE_END" >&2
  exit 77
fi
if [[ ! "$now" > "$FREEZE_END" ]]; then
  echo "operator commissioning waiver accepted: $COMMISSIONING_WAIVER" >&2
fi

template="$release/launchd/com.helium.opsd.plist.template"
deadman_template="$release/launchd/com.helium.opsd-deadman.plist.template"
runner="$release/scripts/ops/run-opsd.sh"
deadman="$release/scripts/deadman/check-opsd-heartbeat.sh"
alerter="$release/scripts/deadman/send-alert.mjs"
binary="$release/plugins/ops-agent/lib/bin/opsd.js"
manifest="$release/ops/authority-manifest.json"
public_key="$release/ops/authority-manifest.pub.pem"
for required in "$template" "$deadman_template" "$runner" "$deadman" "$alerter" "$binary" "$manifest" "$public_key"; do
  [ -f "$required" ] || { echo "required release file missing: $required" >&2; exit 66; }
done

config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
deadman_plist="$launchd_root/com.helium.opsd-deadman.plist"
[ ! -e "$config" ] || { echo "refusing existing opsd config: $config" >&2; exit 73; }
[ ! -e "$plist" ] || { echo "refusing existing launchd label: $plist" >&2; exit 73; }
[ ! -e "$deadman_plist" ] || { echo "refusing existing launchd label: $deadman_plist" >&2; exit 73; }

mkdir -p "$root/config" "$root/logs" "$root/run" "$root/state" "$launchd_root"
chmod 700 "$root" "$root/config" "$root/logs" "$root/run" "$root/state"
config_tmp="$config.tmp.$$"
plist_tmp="$plist.tmp.$$"
deadman_plist_tmp="$deadman_plist.tmp.$$"
trap 'rm -f "$config_tmp" "$plist_tmp" "$deadman_plist_tmp"' EXIT

"$node_bin" - "$config_tmp" "$release" "$root" <<'NODE'
const { writeFileSync } = require("node:fs");
const [out, release, root] = process.argv.slice(2);
const config = {
  version: 1,
  mode: "observe",
  releaseDir: release,
  componentsDir: "ops/components",
  dependenciesDir: "ops/dependencies",
  checksDir: "ops/checks",
  sopsDir: "ops/sops",
  executorsDir: "ops/executors",
  authorityManifestPath: `${release}/ops/authority-manifest.json`,
  trustedKeyPath: `${release}/ops/authority-manifest.pub.pem`,
  stateDir: `${root}/state`,
  socketPath: `${root}/run/opsd.sock`,
  intervalMs: 60000,
  maxFiles: 500,
  maxComponents: 200,
  maxSops: 200,
  maxChecks: 500,
  maxFileBytes: 1000000
};
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

case "$root" in
  */.helium/ops) user_home="${root%/.helium/ops}" ;;
  *) user_home="${HOME:-$(dirname "$root")}" ;;
esac
"$node_bin" - "$template" "$plist_tmp" "$release" "$config" "$root/logs" "$node_bin" "$user_home" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [template, out, release, config, logs, node, home] = process.argv.slice(2);
const root = logs.slice(0, -"/logs".length);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
let body = readFileSync(template, "utf8");
for (const [key, value] of Object.entries({
  "__RELEASE__": release,
  "__CONFIG__": config,
  "__LOG_ROOT__": logs,
  "__STATE_ROOT__": `${root}/state`,
  "__NODE_BIN__": node,
  "__NODE_BIN_DIR__": node.slice(0, node.lastIndexOf("/")),
  "__HOME__": home
})) body = body.replaceAll(key, xml(value));
if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved launchd placeholder");
writeFileSync(out, body, { mode: 0o644 });
NODE

"$node_bin" - "$deadman_template" "$deadman_plist_tmp" "$release" "$config" "$root/logs" "$node_bin" "$user_home" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [template, out, release, config, logs, node, home] = process.argv.slice(2);
const root = logs.slice(0, -"/logs".length);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
let body = readFileSync(template, "utf8");
for (const [key, value] of Object.entries({
  "__RELEASE__": release,
  "__CONFIG__": config,
  "__LOG_ROOT__": logs,
  "__STATE_ROOT__": `${root}/state`,
  "__NODE_BIN__": node,
  "__NODE_BIN_DIR__": node.slice(0, node.lastIndexOf("/")),
  "__HOME__": home
})) body = body.replaceAll(key, xml(value));
if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved launchd placeholder");
writeFileSync(out, body, { mode: 0o644 });
NODE

mv "$config_tmp" "$config"
mv "$plist_tmp" "$plist"
mv "$deadman_plist_tmp" "$deadman_plist"
chmod 600 "$config"
chmod 644 "$plist" "$deadman_plist"
trap - EXIT
echo "rendered observe-only config: $config"
echo "rendered launchd plist: $plist"
echo "rendered independent deadman plist: $deadman_plist"
echo "not loaded or started; a separate explicit operator action is required"
