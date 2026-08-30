#!/usr/bin/env bash
# Rebind an existing observe-only installation to helium-releases/current, or
# restore its exact prior binding. This script changes packaging only: both
# launchd labels must already be unloaded and it never calls bootstrap/bootout.
set -euo pipefail
umask 077

action="${1:-}"
[ "$action" = "apply" ] || [ "$action" = "restore" ] || {
  echo "usage: rebind-observe-only.sh apply --release ABS/current --root ABS --launchd-root ABS --backup-dir ABS" >&2
  echo "       rebind-observe-only.sh restore --root ABS --launchd-root ABS --backup-dir ABS" >&2
  exit 64
}
shift

release=""
root=""
launchd_root=""
backup_dir=""
usage() {
  echo "invalid rebind arguments" >&2
  exit 64
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) [ "$#" -ge 2 ] || usage; release="$2"; shift 2 ;;
    --root) [ "$#" -ge 2 ] || usage; root="$2"; shift 2 ;;
    --launchd-root) [ "$#" -ge 2 ] || usage; launchd_root="$2"; shift 2 ;;
    --backup-dir) [ "$#" -ge 2 ] || usage; backup_dir="$2"; shift 2 ;;
    *) usage ;;
  esac
done

for value in "$root" "$launchd_root" "$backup_dir"; do
  case "$value" in
    /*) [ "$value" != "/" ] || { echo "refusing broad target /" >&2; exit 65; } ;;
    *) echo "all target paths must be absolute" >&2; exit 65 ;;
  esac
done
case "$root" in */.helium/ops) ;; *) echo "ops root must end in /.helium/ops" >&2; exit 65 ;; esac
case "$launchd_root" in */Library/LaunchAgents) ;; *) echo "launchd root must end in /Library/LaunchAgents" >&2; exit 65 ;; esac
case "$backup_dir" in "$root"/rebind-backups/*) ;; *) echo "backup must be under the ops rebind-backups directory" >&2; exit 65 ;; esac
if [ "$action" = "apply" ]; then
  case "$release" in /*/helium-releases/current) ;; *) echo "release must be the absolute helium-releases/current path" >&2; exit 65 ;; esac
  [ -L "$release" ] || { echo "release current path must be a symlink" >&2; exit 66; }
elif [ -n "$release" ]; then
  usage
fi

node_bin="${HELIUM_NODE_BIN:-}"
if [ -z "$node_bin" ]; then
  node_bin="$(command -v node)" || { echo "node is required" >&2; exit 69; }
fi
case "$node_bin" in /*) [ -x "$node_bin" ] || { echo "node is not executable: $node_bin" >&2; exit 69; } ;; *) echo "node path must be absolute" >&2; exit 69 ;; esac
launchctl_bin="${HELIUM_LAUNCHCTL_BIN:-/bin/launchctl}"
case "$launchctl_bin" in /*) [ -x "$launchctl_bin" ] || { echo "launchctl is not executable: $launchctl_bin" >&2; exit 69; } ;; *) echo "launchctl path must be absolute" >&2; exit 69 ;; esac

domain="gui/$(id -u)"
for label in com.helium.opsd com.helium.opsd-deadman; do
  if "$launchctl_bin" print "$domain/$label" >/dev/null 2>&1; then
    echo "refusing rebind while $label is loaded; unload both exact labels first" >&2
    exit 75
  fi
done

config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
deadman_plist="$launchd_root/com.helium.opsd-deadman.plist"

backup_config="$backup_dir/opsd.json"
backup_plist="$backup_dir/com.helium.opsd.plist"
backup_deadman="$backup_dir/com.helium.opsd-deadman.plist"
backup_manifest="$backup_dir/binding.json"

verify_backup() {
  "$node_bin" - "$backup_manifest" "$backup_config" "$backup_plist" "$backup_deadman" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [manifestPath, ...paths] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== paths.length) {
  throw new Error("invalid backup hash manifest");
}
for (let i = 0; i < paths.length; i += 1) {
  const digest = createHash("sha256").update(readFileSync(paths[i])).digest("hex");
  if (manifest.files[i]?.sha256 !== digest) throw new Error(`backup hash mismatch: ${paths[i]}`);
}
NODE
}

restore_active_from_backup() {
  local suffix=".restore.$$"
  mkdir -p "$root/config" "$launchd_root"
  chmod 700 "$root" "$root/config"
  cp -p "$backup_config" "$config$suffix"
  cp -p "$backup_plist" "$plist$suffix"
  cp -p "$backup_deadman" "$deadman_plist$suffix"
  chmod 600 "$config$suffix"
  chmod 644 "$plist$suffix" "$deadman_plist$suffix"
  mv -f "$config$suffix" "$config"
  mv -f "$plist$suffix" "$plist"
  mv -f "$deadman_plist$suffix" "$deadman_plist"
}

if [ "$action" = "restore" ]; then
  for required in "$backup_config" "$backup_plist" "$backup_deadman" "$backup_manifest"; do
    [ -f "$required" ] || { echo "backup file missing: $required" >&2; exit 66; }
  done
  verify_backup
  restore_active_from_backup
  echo "restored prior observe-only binding from $backup_dir"
  echo "labels remain unloaded; explicit operator bootstrap is required"
  exit 0
fi

[ ! -e "$backup_dir" ] || { echo "backup already exists: $backup_dir" >&2; exit 73; }
for required in "$config" "$plist" "$deadman_plist"; do
  [ -f "$required" ] || { echo "active observe-only file missing: $required" >&2; exit 66; }
done
"$node_bin" - "$config" "$root" <<'NODE'
const { readFileSync } = require("node:fs");
const [path, root] = process.argv.slice(2);
const config = JSON.parse(readFileSync(path, "utf8"));
if (config.mode !== "observe") throw new Error("active config is not observe mode");
if (config.stateDir !== `${root}/state` || config.socketPath !== `${root}/run/opsd.sock`) {
  throw new Error("active config does not use the expected private state paths");
}
NODE

template="$release/launchd/com.helium.opsd.plist.template"
deadman_template="$release/launchd/com.helium.opsd-deadman.plist.template"
binary="$release/plugins/ops-agent/lib/bin/opsd.js"
for required in \
  "$template" "$deadman_template" "$binary" \
  "$release/scripts/ops/run-opsd.sh" \
  "$release/scripts/deadman/check-opsd-heartbeat.sh" \
  "$release/scripts/deadman/send-alert.mjs" \
  "$release/ops/authority-manifest.json" \
  "$release/ops/authority-manifest.pub.pem" \
  "$release/ops/observation-targets.yaml" \
  "$release/ops/registered-probes.json"; do
  [ -f "$required" ] || { echo "target release file missing: $required" >&2; exit 66; }
done
for required_dir in components dependencies checks sops executors; do
  [ -d "$release/ops/$required_dir" ] || { echo "target release directory missing: $release/ops/$required_dir" >&2; exit 66; }
done

mkdir -p "$(dirname "$backup_dir")"
chmod 700 "$(dirname "$backup_dir")"
mkdir "$backup_dir"
chmod 700 "$backup_dir"
cp -p "$config" "$backup_config"
cp -p "$plist" "$backup_plist"
cp -p "$deadman_plist" "$backup_deadman"
chmod 600 "$backup_config"
chmod 644 "$backup_plist" "$backup_deadman"
"$node_bin" - "$backup_manifest" "$backup_config" "$backup_plist" "$backup_deadman" <<'NODE'
const { createHash } = require("node:crypto");
const { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const [manifestPath, ...paths] = process.argv.slice(2);
const files = paths.map((path) => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
}));
writeFileSync(manifestPath, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, { mode: 0o600 });
for (const path of [...paths, manifestPath]) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
NODE
verify_backup

config_tmp="$config.rebind.$$"
plist_tmp="$plist.rebind.$$"
deadman_tmp="$deadman_plist.rebind.$$"
replaced=0
committed=0
cleanup() {
  local rc=$?
  rm -f "$config_tmp" "$plist_tmp" "$deadman_tmp"
  if [ "$committed" != "1" ] && [ "$replaced" = "1" ]; then
    restore_active_from_backup || true
  fi
  exit "$rc"
}
trap cleanup EXIT

case "$root" in */.helium/ops) user_home="${root%/.helium/ops}" ;; esac
"$node_bin" - "$config_tmp" "$plist_tmp" "$deadman_tmp" "$release" "$root" "$template" "$deadman_template" "$config" "$node_bin" "$user_home" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [configOut, plistOut, deadmanOut, release, root, template, deadmanTemplate, activeConfig, node, home] = process.argv.slice(2);
const config = {
  version: 1, mode: "observe", releaseDir: release,
  componentsDir: "ops/components", dependenciesDir: "ops/dependencies",
  checksDir: "ops/checks", sopsDir: "ops/sops", executorsDir: "ops/executors",
  authorityManifestPath: `${release}/ops/authority-manifest.json`,
  trustedKeyPath: `${release}/ops/authority-manifest.pub.pem`,
  stateDir: `${root}/state`, socketPath: `${root}/run/opsd.sock`,
  observationTargetsPath: `${release}/ops/observation-targets.yaml`,
  intervalMs: 60000, maxFiles: 500, maxComponents: 200, maxSops: 200,
  maxChecks: 500, maxFileBytes: 1000000,
};
writeFileSync(configOut, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
const logs = `${root}/logs`;
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const render = (source, out) => {
  let body = readFileSync(source, "utf8");
  for (const [key, value] of Object.entries({
    "__RELEASE__": release, "__CONFIG__": activeConfig, "__LOG_ROOT__": logs,
    "__STATE_ROOT__": `${root}/state`, "__NODE_BIN__": node,
    "__NODE_BIN_DIR__": node.slice(0, node.lastIndexOf("/")), "__HOME__": home,
  })) body = body.replaceAll(key, xml(value));
  if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved launchd placeholder");
  writeFileSync(out, body, { mode: 0o644 });
};
render(template, plistOut);
render(deadmanTemplate, deadmanOut);
NODE

chmod 600 "$config_tmp"
chmod 644 "$plist_tmp" "$deadman_tmp"
plutil -lint "$plist_tmp" >/dev/null
plutil -lint "$deadman_tmp" >/dev/null
"$node_bin" "$binary" --check-config "$config_tmp" --release "$release"

replaced=1
mv -f "$config_tmp" "$config"
mv -f "$plist_tmp" "$plist"
mv -f "$deadman_tmp" "$deadman_plist"
committed=1
trap - EXIT
echo "rebound observe-only packaging to $release"
echo "backup: $backup_dir"
echo "state and evidence were not changed; labels remain unloaded"
