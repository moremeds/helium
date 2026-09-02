#!/usr/bin/env bash
# Render com.helium.dsh.plist for a release. Runs ON the mini, from deploy.sh
# and rollback.sh.
#
#   install-dsh-plist.sh render --release-dir <DEST> --releases-dir <RELEASES> \
#       --out <FILE> [--installed <PLIST>]
#
# The plist is the KEY SET that changes between releases; `__RELEASE__` resolves
# to `<RELEASES>/current` (the mutable symlink) so the paths stay valid across
# flips. A launchd label keeps the config it was bootstrapped with, so
# `kickstart -k` never picks up a new key -- rendering here is only half the
# fix; the caller must bootout+bootstrap.
set -euo pipefail

command="${1:-}"
[ "$command" = "render" ] || { echo "usage: install-dsh-plist.sh render --release-dir <DEST> --releases-dir <RELEASES> --out <FILE> [--installed <PLIST>]" >&2; exit 64; }
shift

release_dir=""; releases_dir=""; out=""; installed=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release-dir) release_dir="${2:-}"; shift 2 ;;
    --releases-dir) releases_dir="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --installed) installed="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$release_dir" ] && [ -n "$releases_dir" ] && [ -n "$out" ] || {
  echo "usage: install-dsh-plist.sh render --release-dir <DEST> --releases-dir <RELEASES> --out <FILE> [--installed <PLIST>]" >&2
  exit 64
}

template="$release_dir/launchd/com.helium.dsh.plist.template"
[ -f "$template" ] || { echo "no DSH plist template in the release: $template" >&2; exit 66; }

node_bin="$(command -v node)" || { echo "node not on PATH; cannot render the DSH plist" >&2; exit 69; }
node_bin_dir="$(dirname "$node_bin")"

# Only read a key off the installed plist when one is actually installed.
installed_value() {
  [ -n "$installed" ] && [ -f "$installed" ] || return 1
  plutil -extract "EnvironmentVariables.$1" raw -o - "$installed" 2>/dev/null
}

# HELIUM_EMAIL_TO is operator state, not release content: keep whatever the
# host is already alerting to unless the operator overrides it explicitly.
email_to="${HELIUM_EMAIL_TO:-}"
if [ -z "$email_to" ]; then
  email_to="$(installed_value HELIUM_EMAIL_TO || true)"
fi
[ -n "$email_to" ] || {
  echo "no alert address: set HELIUM_EMAIL_TO, or install a plist carrying EnvironmentVariables.HELIUM_EMAIL_TO first" >&2
  exit 65
}

tmp="$out.tmp.$$"
trap 'rm -f "$tmp"' EXIT

"$node_bin" - "$template" "$tmp" "$releases_dir/current" "$HOME" "$node_bin_dir" "$email_to" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [template, out, release, home, nodeBinDir, emailTo] = process.argv.slice(2);
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
let body = readFileSync(template, "utf8");
for (const [key, value] of Object.entries({
  "__RELEASE__": release,
  "__HOME__": home,
  "__NODE_BIN_DIR__": nodeBinDir,
  "__EMAIL_TO__": emailTo
})) body = body.replaceAll(key, xml(value));
const left = body.match(/__[A-Z0-9_]+__/);
if (left) throw new Error(`unresolved launchd placeholder: ${left[0]}`);
writeFileSync(out, body, { mode: 0o644 });
NODE

# Operator state the release must not reset. Carried over ONLY when the key is
# in both files: a key the template dropped stays dropped (no resurrection of
# retired knobs), and a key the template added ships its shipped default.
for key in HELIUM_TEAM_PROMOTION_MODE HELIUM_TEAM_CANARY_TENANTS \
  HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY HELIUM_TENANT_DELIVERY; do
  plutil -extract "EnvironmentVariables.$key" raw -o - "$tmp" >/dev/null 2>&1 || continue
  value="$(installed_value "$key")" || continue
  plutil -replace "EnvironmentVariables.$key" -string "$value" "$tmp" || {
    echo "could not carry over $key into the rendered DSH plist" >&2
    exit 70
  }
done

plutil -lint "$tmp" >/dev/null || { echo "rendered DSH plist failed plutil -lint" >&2; exit 71; }
# plutil -lint is NOT sufficient: it accepts files launchd rejects (e.g. a `--`
# inside an XML comment). plistlib is the stricter XML parser of the two.
python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$tmp" || {
  echo "rendered DSH plist failed plistlib parse (launchd would reject it)" >&2
  exit 72
}

mv "$tmp" "$out"
trap - EXIT
chmod 644 "$out"
echo "rendered DSH plist: $out"
