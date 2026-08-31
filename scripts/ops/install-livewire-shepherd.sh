#!/usr/bin/env bash
# Install a pre-signed, exact Livewire Shepherd package. Never invokes launchctl.
set -euo pipefail
umask 077

release=""
root=""
launchd_root=""
promotion=""
ops_source=""
shepherd_source=""

usage() {
  echo "usage: install-livewire-shepherd.sh --release ABS --root ABS --launchd-root ABS --promotion-dir ABS --ops-config ABS --shepherd-config ABS" >&2
  exit 64
}
resolve_file() {
  local candidate="$1"
  local hops=0
  while [ -L "$candidate" ]; do
    [ "$hops" -lt 32 ] || { echo "too many symlinks resolving $1" >&2; return 1; }
    local target
    target="$(/usr/bin/readlink "$candidate")"
    case "$target" in
      /*) candidate="$target" ;;
      *) candidate="$(cd "$(dirname "$candidate")" && pwd -P)/$target" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd -P)" "$(basename "$candidate")"
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) [ "$#" -ge 2 ] || usage; release="$2"; shift 2 ;;
    --root) [ "$#" -ge 2 ] || usage; root="$2"; shift 2 ;;
    --launchd-root) [ "$#" -ge 2 ] || usage; launchd_root="$2"; shift 2 ;;
    --promotion-dir) [ "$#" -ge 2 ] || usage; promotion="$2"; shift 2 ;;
    --ops-config) [ "$#" -ge 2 ] || usage; ops_source="$2"; shift 2 ;;
    --shepherd-config) [ "$#" -ge 2 ] || usage; shepherd_source="$2"; shift 2 ;;
    *) usage ;;
  esac
done
case "$root" in */.helium/livewire-shepherd) ;; *) echo "install root must end in /.helium/livewire-shepherd" >&2; exit 65;; esac
case "$launchd_root" in */Library/LaunchAgents) ;; *) echo "launchd root must end in /Library/LaunchAgents" >&2; exit 65;; esac
for path in "$release" "$root" "$launchd_root" "$promotion" "$ops_source" "$shepherd_source"; do
  case "$path" in /*) [ "$path" != / ] || { echo "refusing broad target /" >&2; exit 65; };; *) echo "all paths must be absolute" >&2; exit 65;; esac
done
[ ! -e "$root" ] || { echo "refusing existing Livewire Shepherd install root: $root" >&2; exit 73; }
plist="$launchd_root/com.helium.livewire-opsd.plist"
[ ! -e "$plist" ] || { echo "refusing existing Livewire Shepherd launchd label: $plist" >&2; exit 73; }
claim="$launchd_root/.com.helium.livewire-opsd.installing"

node_bin="${HELIUM_NODE_BIN:-}"
if [ -z "$node_bin" ]; then node_bin="$(command -v node)" || { echo "node is required" >&2; exit 69; }; fi
case "$node_bin" in
  /*) [ -x "$node_bin" ] || { echo "node is not executable: $node_bin" >&2; exit 69; } ;;
  *) echo "HELIUM_NODE_BIN must be an absolute executable path" >&2; exit 69 ;;
esac
node_bin="$(resolve_file "$node_bin")"
binary="$release/plugins/livewire-shepherd/lib/bin/livewire-opsd.js"
runner="$release/scripts/ops/run-livewire-opsd.sh"
template="$release/launchd/com.helium.livewire-opsd.plist.template"
transaction_source="$promotion/actions/livewire-repair-transaction"
postcondition_source="$promotion/actions/livewire-repair-postcondition"
for required in "$binary" "$runner" "$template" "$ops_source" "$shepherd_source" \
  "$promotion/authority-manifest.json" "$promotion/promotion-input.json" \
  "$promotion/registered-probes.json" "$transaction_source" "$postcondition_source"; do
  [ -f "$required" ] && [ ! -L "$required" ] || { echo "required package file missing or unsafe: $required" >&2; exit 66; }
done
signed_node_path="$(/usr/bin/plutil -extract nodeBinary.path raw -o - "$promotion/promotion-input.json")"
signed_node_sha="$(/usr/bin/plutil -extract nodeBinary.sha256 raw -o - "$promotion/promotion-input.json")"
runtime_manifest="$(/usr/bin/plutil -extract runtimeManifest.path raw -o - "$promotion/promotion-input.json")"
runtime_manifest_sha="$(/usr/bin/plutil -extract runtimeManifest.sha256 raw -o - "$promotion/promotion-input.json")"
[ "$node_bin" = "$signed_node_path" ] || { echo "selected Node differs from signed promotion" >&2; exit 66; }
[ "$(/usr/bin/shasum -a 256 "$node_bin" | /usr/bin/awk '{print $1}')" = "$signed_node_sha" ] || {
  echo "selected Node bytes differ from signed promotion" >&2; exit 66;
}
[ "$runtime_manifest" = "$promotion/node-runtime.sha256" ] && [ -f "$runtime_manifest" ] && [ ! -L "$runtime_manifest" ] || {
  echo "signed Node runtime manifest path is unsafe" >&2; exit 66;
}
[ "$(/usr/bin/shasum -a 256 "$runtime_manifest" | /usr/bin/awk '{print $1}')" = "$runtime_manifest_sha" ] || {
  echo "signed Node runtime manifest changed" >&2; exit 66;
}
(cd "$release" && /usr/bin/shasum -a 256 -c "$runtime_manifest" >/dev/null) || {
  echo "signed Node runtime bytes changed before installer preflight" >&2; exit 66;
}
"$node_bin" - "$ops_source" "$shepherd_source" "$release" "$promotion" "$root" \
  "$transaction_source" "$postcondition_source" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const [opsPath, shepherdPath, release, promotion, root, transactionSource, postconditionSource] = process.argv.slice(2);
const ops = JSON.parse(readFileSync(opsPath, "utf8"));
const shepherd = JSON.parse(readFileSync(shepherdPath, "utf8"));
const same = (left, right) => resolve(left) === resolve(right);
if (!same(ops.releaseDir, release) || !same(ops.promotionBundleDir, promotion) ||
    !same(ops.stateDir, join(root, "ops-state")) ||
    !same(ops.socketPath, join(root, "run", "livewire-opsd.sock"))) {
  throw new Error("Ops config is not bound to the requested install root and promotion");
}
if (!same(shepherd.appendLockRoot, join(root, "append-locks")) ||
    !same(ops.automaticAuthority?.manifestRoot, shepherd.livewire?.repair?.readyDir)) {
  throw new Error("Shepherd config is not bound to the requested install root and ready directory");
}
const scripts = new Map((shepherd.scripts ?? []).map((script) => [script.executorId, script]));
const expected = [
  ["livewire-repair-transaction", join(root, "actions", "livewire-repair-transaction"), transactionSource],
  ["livewire-repair-postcondition", join(root, "actions", "livewire-repair-postcondition"), postconditionSource],
];
for (const [id, target, source] of expected) {
  const script = scripts.get(id);
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (script === undefined || !same(script.path, target) ||
      script.identity?.kind !== "sha256" || script.identity.value !== digest) {
    throw new Error(`Shepherd script is not bound to the staged ${id}`);
  }
}
const executorFiles = readdirSync(join(promotion, "executors")).filter((name) => /\.ya?ml$/.test(name));
if (executorFiles.length !== 2) throw new Error("promotion must contain exactly two Livewire executors");
NODE

created_root=0
created_plist=0
created_launchd_root=0
created_claim=0
created_root_parent=0
root_parent="${root%/*}"
cleanup() {
  rm -f "$plist.tmp.$$"
  if [ "$created_plist" -eq 1 ]; then rm -f "$plist"; fi
  if [ "$created_root" -eq 1 ]; then rm -rf "$root"; fi
  if [ "$created_claim" -eq 1 ]; then rmdir "$claim" 2>/dev/null || true; fi
  if [ "$created_root_parent" -eq 1 ]; then rmdir "$root_parent" 2>/dev/null || true; fi
  if [ "$created_launchd_root" -eq 1 ]; then rmdir "$launchd_root" 2>/dev/null || true; fi
}
trap cleanup EXIT
if [ ! -d "$launchd_root" ]; then
  mkdir -p "$launchd_root"
  created_launchd_root=1
fi
mkdir "$claim" || { echo "another Livewire Shepherd installation is in progress" >&2; exit 73; }
created_claim=1
if [ ! -d "$root_parent" ]; then
  mkdir -p "$root_parent"
  created_root_parent=1
fi
mkdir "$root" || { echo "Livewire Shepherd install root was claimed concurrently" >&2; exit 73; }
created_root=1
mkdir -p "$root/config" "$root/actions" "$root/logs" "$root/run" "$root/ops-state" "$root/append-locks"
chmod 700 "$root" "$root/config" "$root/actions" "$root/logs" "$root/run" "$root/ops-state" "$root/append-locks"
cp -p "$transaction_source" "$root/actions/livewire-repair-transaction"
cp -p "$postcondition_source" "$root/actions/livewire-repair-postcondition"
chmod 500 "$root/actions/livewire-repair-transaction" "$root/actions/livewire-repair-postcondition"
cp -p "$ops_source" "$root/config/ops.json"
cp -p "$shepherd_source" "$root/config/shepherd.json"
chmod 600 "$root/config/ops.json" "$root/config/shepherd.json"

"$node_bin" "$binary" check-config \
  --ops-config "$root/config/ops.json" \
  --shepherd-config "$root/config/shepherd.json" >/dev/null

case "$root" in */.helium/livewire-shepherd) user_home="${root%/.helium/livewire-shepherd}";; esac
"$node_bin" - "$template" "$plist.tmp.$$" "$release" "$root" "$node_bin" "$user_home" \
  "$runtime_manifest" "$runtime_manifest_sha" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [template, output, release, root, node, home, runtimeManifest, runtimeManifestSha] = process.argv.slice(2);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
let body = readFileSync(template, "utf8");
for (const [key, value] of Object.entries({
  __RELEASE__: release,
  __OPS_CONFIG__: `${root}/config/ops.json`,
  __SHEPHERD_CONFIG__: `${root}/config/shepherd.json`,
  __LOG_ROOT__: `${root}/logs`,
  __NODE_BIN__: node,
  __NODE_BIN_DIR__: node.slice(0, node.lastIndexOf("/")),
  __NODE_RUNTIME_MANIFEST__: runtimeManifest,
  __NODE_RUNTIME_MANIFEST_SHA256__: runtimeManifestSha,
  __HOME__: home,
})) body = body.replaceAll(key, xml(value));
if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved launchd placeholder");
writeFileSync(output, body, { mode: 0o644 });
NODE
mv "$plist.tmp.$$" "$plist"
created_plist=1
chmod 644 "$plist"
plutil -lint "$plist" >/dev/null
created_root=0
created_plist=0
created_claim=0
rmdir "$claim"
created_root_parent=0
created_launchd_root=0
trap - EXIT
echo "installed and validated Livewire Shepherd package: $root"
echo "rendered launchd service: $plist"
echo "not loaded or started; explicit operator bootstrap remains required"
