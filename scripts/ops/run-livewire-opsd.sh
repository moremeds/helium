#!/usr/bin/env bash
set -euo pipefail
umask 077

release="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
node_bin="${HELIUM_NODE_BIN:-node}"
ops_config="${HELIUM_LIVEWIRE_OPS_CONFIG:-}"
shepherd_config="${HELIUM_SHEPHERD_CONFIG:-}"
runtime_manifest="${HELIUM_NODE_RUNTIME_MANIFEST:-}"
runtime_manifest_sha="${HELIUM_NODE_RUNTIME_MANIFEST_SHA256:-}"
[ -r "$ops_config" ] || { echo "Livewire Ops config is not readable" >&2; exit 66; }
[ -r "$shepherd_config" ] || { echo "Shepherd config is not readable" >&2; exit 66; }
[ -f "$runtime_manifest" ] && [ ! -L "$runtime_manifest" ] || {
  echo "signed Node runtime manifest is missing or unsafe" >&2; exit 66;
}
[ "$(/usr/bin/shasum -a 256 "$runtime_manifest" | /usr/bin/awk '{print $1}')" = "$runtime_manifest_sha" ] || {
  echo "signed Node runtime manifest changed" >&2; exit 66;
}
(cd "$release" && /usr/bin/shasum -a 256 -c "$runtime_manifest" >/dev/null) || {
  echo "signed Node runtime bytes changed" >&2; exit 66;
}
binary="$release/plugins/livewire-shepherd/lib/bin/livewire-opsd.js"
[ -f "$binary" ] || { echo "livewire-opsd binary is missing: $binary" >&2; exit 66; }

exec "$node_bin" "$binary" run \
  --ops-config "$ops_config" \
  --shepherd-config "$shepherd_config"
