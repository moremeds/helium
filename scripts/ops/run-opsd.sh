#!/usr/bin/env bash
# launchd entrypoint for the standalone ops daemon.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release="$(cd "$here/../.." && pwd -P)"
node_bin="${HELIUM_NODE_BIN:-node}"
config="${HELIUM_OPSD_CONFIG:-}"
log_root="${HELIUM_OPSD_LOG_ROOT:-}"
[ -n "$config" ] || { echo "HELIUM_OPSD_CONFIG is required" >&2; exit 64; }
[ -r "$config" ] || { echo "opsd config is not readable: $config" >&2; exit 66; }
[ -n "$log_root" ] || { echo "HELIUM_OPSD_LOG_ROOT is required" >&2; exit 64; }
binary="$release/plugins/ops-agent/lib/bin/opsd.js"
[ -f "$binary" ] || { echo "opsd binary is missing: $binary" >&2; exit 66; }
mkdir -p "$log_root"

# Keep at most one prior file per stream. opsd is intentionally quiet during
# healthy operation; rotation at each supervised restart bounds accumulated
# history across releases and crash loops without another daemon.
for stream in out err; do
  log="$log_root/opsd.$stream.log"
  if [ -f "$log" ]; then
    mv -f "$log" "$log.1"
  fi
done

exec "$node_bin" "$binary" --config "$config"
