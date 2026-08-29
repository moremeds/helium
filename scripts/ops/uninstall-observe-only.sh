#!/usr/bin/env bash
# Remove only the files owned by install-observe-only.sh. Never invokes launchctl.
set -euo pipefail

root=""
launchd_root=""
usage() {
  echo "usage: uninstall-observe-only.sh --root ABS --launchd-root ABS" >&2
  exit 64
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || usage; root="$2"; shift 2 ;;
    --launchd-root) [ "$#" -ge 2 ] || usage; launchd_root="$2"; shift 2 ;;
    *) usage ;;
  esac
done
for value in "$root" "$launchd_root"; do
  case "$value" in
    /*) [ "$value" != "/" ] || { echo "refusing broad target /" >&2; exit 65; } ;;
    *) echo "all target paths must be absolute" >&2; exit 65 ;;
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

config="$root/config/opsd.json"
plist="$launchd_root/com.helium.opsd.plist"
rm -f "$config" "$plist"
# Remove only installer-owned directories, and only when empty. Neighboring
# files or state make rmdir fail harmlessly and remain untouched.
rmdir "$root/config" "$root/logs" "$root/run" "$root/state" 2>/dev/null || true
rmdir "$root" 2>/dev/null || true
echo "removed observe-only packaging; no launchd action was attempted"
