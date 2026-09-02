#!/usr/bin/env bash
# Filesystem-only render drill for scripts/release/install-dsh-plist.sh.
# Never invokes launchctl and never touches ~/Library/LaunchAgents.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/helium-dsh-plist-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*"; exit 1; }

bash -n "$here/install-dsh-plist.sh" || fail "install-dsh-plist.sh does not parse"

# A release directory is just something that carries launchd/<template>.
release="$tmp/release"
mkdir -p "$release/launchd"
cp "$repo/launchd/com.helium.dsh.plist.template" "$release/launchd/"
releases="$tmp/releases"

value() { plutil -extract "EnvironmentVariables.$2" raw -o - "$1" 2>/dev/null; }

echo "case 1: a rendered plist carries no placeholder and parses two ways"
HELIUM_EMAIL_TO="ops@example.com" bash "$here/install-dsh-plist.sh" render \
  --release-dir "$release" --releases-dir "$releases" --out "$tmp/a.plist" \
  >/dev/null || fail "render with HELIUM_EMAIL_TO failed"
if grep -o '__[A-Z0-9_]\{1,\}__' "$tmp/a.plist" >/dev/null 2>&1; then
  fail "rendered plist still carries a placeholder"
fi
plutil -lint "$tmp/a.plist" >/dev/null || fail "rendered plist failed plutil -lint"
python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' \
  "$tmp/a.plist" || fail "rendered plist failed plistlib"
[ "$(value "$tmp/a.plist" HELIUM_EMAIL_TO)" = "ops@example.com" ] ||
  fail "HELIUM_EMAIL_TO did not come from the environment"
[ "$(value "$tmp/a.plist" HELIUM_TENANTS_DIR)" = "$releases/current/plugins" ] ||
  fail "__RELEASE__ did not resolve to <releases>/current"

echo "case 2: with no HELIUM_EMAIL_TO and no installed plist, it refuses"
set +e
out=$(bash "$here/install-dsh-plist.sh" render --release-dir "$release" \
  --releases-dir "$releases" --out "$tmp/never.plist" 2>&1)
rc=$?
set -e
[ "$rc" -eq 65 ] || fail "expected exit 65 with no alert address, got $rc"
printf '%s\n' "$out" | grep -q 'no alert address' ||
  fail "refusal did not name the missing alert address"
if [ -e "$tmp/never.plist" ]; then fail "refusal still wrote an output plist"; fi

echo "case 3: __EMAIL_TO__ and operator state come from the installed plist"
installed="$tmp/installed.plist"
cp "$tmp/a.plist" "$installed"
plutil -replace EnvironmentVariables.HELIUM_EMAIL_TO -string "kept@example.com" "$installed"
plutil -replace EnvironmentVariables.HELIUM_TEAM_PROMOTION_MODE -string "review-only" "$installed"
plutil -replace EnvironmentVariables.HELIUM_TEAM_CANARY_TENANTS -string "option-wizard" "$installed"
plutil -replace EnvironmentVariables.HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY -string "3" "$installed"
plutil -replace EnvironmentVariables.HELIUM_TENANT_DELIVERY -string "1" "$installed"
# A knob the template no longer ships. It must NOT come back.
plutil -insert EnvironmentVariables.HELIUM_TEAM_CANARY_JOBS -string "legacy" "$installed"

bash "$here/install-dsh-plist.sh" render --release-dir "$release" \
  --releases-dir "$releases" --out "$tmp/b.plist" --installed "$installed" \
  >/dev/null || fail "render against an installed plist failed"
[ "$(value "$tmp/b.plist" HELIUM_EMAIL_TO)" = "kept@example.com" ] ||
  fail "__EMAIL_TO__ was not taken from the installed plist"
[ "$(value "$tmp/b.plist" HELIUM_TEAM_PROMOTION_MODE)" = "review-only" ] ||
  fail "HELIUM_TEAM_PROMOTION_MODE was not carried over"
[ "$(value "$tmp/b.plist" HELIUM_TEAM_CANARY_TENANTS)" = "option-wizard" ] ||
  fail "HELIUM_TEAM_CANARY_TENANTS was not carried over"
[ "$(value "$tmp/b.plist" HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY)" = "3" ] ||
  fail "HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY was not carried over"
[ "$(value "$tmp/b.plist" HELIUM_TENANT_DELIVERY)" = "1" ] ||
  fail "HELIUM_TENANT_DELIVERY was not carried over"
if value "$tmp/b.plist" HELIUM_TEAM_CANARY_JOBS >/dev/null 2>&1; then
  fail "a key the template dropped was resurrected from the installed plist"
fi
# Release content, by contrast, always comes from the new template.
[ "$(value "$tmp/b.plist" HELIUM_MCP_BIN)" = "$releases/current/plugins/helium/lib/mcp/server.js" ] ||
  fail "release content was overwritten by installed state"

echo "case 3b: review-only with no canary tenant is downgraded, not shipped"
# The v1 plist named its canary with HELIUM_TEAM_CANARY_JOBS, a key the tenant
# lane retired. Carrying review-only over from such a plist leaves the allow-list
# empty, and the daemon refuses to boot on that combination.
v1="$tmp/v1.plist"
cp "$release/launchd/com.helium.dsh.plist.template" "$v1"
sed -i '' 's|__RELEASE__|'"$releases/current"'|g; s|__HOME__|'"$HOME"'|g; s|__NODE_BIN_DIR__|/usr/bin|g; s|__EMAIL_TO__|ops@example.com|g' "$v1"
plutil -replace EnvironmentVariables.HELIUM_TEAM_PROMOTION_MODE -string "review-only" "$v1"
plutil -replace EnvironmentVariables.HELIUM_TEAM_CANARY_TENANTS -string "" "$v1"
out=$(bash "$here/install-dsh-plist.sh" render --release-dir "$release" \
  --releases-dir "$releases" --out "$tmp/d.plist" --installed "$v1" 2>&1)
[ "$(value "$tmp/d.plist" HELIUM_TEAM_PROMOTION_MODE)" = "off" ] ||
  fail "review-only with an empty canary allow-list was shipped instead of downgraded"
printf '%s\n' "$out" | grep -q "downgrading to off" ||
  fail "the downgrade was silent: $out"

echo "case 4: a template plutil -lint accepts but launchd rejects is refused"
bad="$tmp/bad-release"
mkdir -p "$bad/launchd"
# `--` inside an XML comment: well-formed to plutil, rejected by a strict XML
# parser (and by launchd). This is why plistlib runs alongside plutil -lint.
sed 's|<plist version="1.0">|<!-- oops -- not legal XML -->\n<plist version="1.0">|' \
  "$release/launchd/com.helium.dsh.plist.template" \
  >"$bad/launchd/com.helium.dsh.plist.template"
set +e
out=$(HELIUM_EMAIL_TO="ops@example.com" bash "$here/install-dsh-plist.sh" render \
  --release-dir "$bad" --releases-dir "$releases" --out "$tmp/c.plist" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "a template with '--' in a comment was accepted"
printf '%s\n' "$out" | grep -q 'plistlib' ||
  fail "the refusal did not name the plistlib parse: $out"
if [ -e "$tmp/c.plist" ]; then fail "a rejected template still produced an output plist"; fi

echo "PASS: install-dsh-plist.sh render drill"
