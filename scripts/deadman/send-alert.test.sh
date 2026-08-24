#!/usr/bin/env bash
# Local drill for send-alert.mjs config resolution. No network: SMTP points at a
# closed port, so a config-resolution PASS shows up as exit 3 (send failed) and a
# config-resolution FAILURE as exit 2 (missing keys). That distinction is the
# whole point of the test — the 3.4 mini drill found the alerter exiting 2
# because HELIUM_EMAIL_TO lives in the launchd plist, not in the 0600 env file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp=$(mktemp -d -t helium-sendalert-test)
trap 'rm -rf "$tmp"' EXIT

# Everything except the recipient. Port 1 is reserved and never listening.
cat > "$tmp/helium.env" <<'EOS'
SMTP_HOST=127.0.0.1
SMTP_PORT=1
SMTP_SECURE=false
SMTP_USER=drill@example.invalid
SMTP_PASS=not-a-real-password
SMTP_FROM=drill@example.invalid
EOS

run() {
  set +e
  node "$here/send-alert.mjs" --env-file "$tmp/helium.env" \
    --subject "drill" --body "drill" > "$tmp/out.json" 2>/dev/null
  echo $?
  set -e
}

echo "case 1: recipient absent from BOTH file and env -> 2 (config error)"
code=$(env -u HELIUM_EMAIL_TO bash -c "$(declare -f run); here=$here tmp=$tmp; run")
[ "$code" = 2 ] || { echo "FAIL-1: expected 2, got $code"; cat "$tmp/out.json"; exit 1; }
grep -q HELIUM_EMAIL_TO "$tmp/out.json" || { echo "FAIL-1b: key not named in error"; exit 1; }

echo "case 2: recipient supplied by process env only -> past config, reaches SMTP (3)"
code=$(HELIUM_EMAIL_TO=drill@example.invalid bash -c "$(declare -f run); here=$here tmp=$tmp; run")
[ "$code" = 3 ] || { echo "FAIL-2: expected 3 (send failed), got $code"; cat "$tmp/out.json"; exit 1; }

echo "case 3: the 0600 file wins over process env (secrets stay authoritative)"
echo "SMTP_USER=from-file@example.invalid" >> "$tmp/helium.env"
out=$(SMTP_USER=from-env@example.invalid HELIUM_EMAIL_TO=drill@example.invalid \
  node "$here/send-alert.mjs" --env-file "$tmp/helium.env" --subject d --body d 2>/dev/null || true)
case "$out" in
  *from-env*) echo "FAIL-3: process env overrode the 0600 file"; exit 1 ;;
esac

echo "ALL PASS"
