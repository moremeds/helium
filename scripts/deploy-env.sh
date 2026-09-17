#!/usr/bin/env bash
# Copy operator settings from the laptop's helium.env to the mini's. Run by
# scripts/deploy.sh before every deploy:
#
#   scripts/deploy-env.sh <host> KEY [KEY...]
#
# Why this exists: the launchd jobs on the mini never read ~/.zshenv, so every
# variable a run needs has to live in ~/.config/helium/helium.env there. The
# email channel skips with "no RESEND_HELIUM_TOKEN configured" when it is
# absent — a deploy that shipped the code but not the setting would deliver
# nothing and call it success.
#
# Two rules the whole script is shaped around: a key that is empty locally
# warns and is skipped, never fails (a missing mail setting must not block a
# code deploy), and a value never appears on a command line or in output — it
# travels to the mini on stdin, so `ps` on either machine and this script's
# own logs carry key names only.
set -euo pipefail

SSH="${HELIUM_SSH:-ssh}"   # overridable so the test can stub it
ENV_FILE="${HELIUM_ENV_FILE:-$HOME/.config/helium/helium.env}"

if [ $# -lt 2 ]; then
  echo "usage: deploy-env.sh <host> KEY [KEY...]" >&2
  exit 2
fi
HOST="$1"
shift

for key in "$@"; do
  # Last occurrence wins, matching how the run reads the file. A missing file
  # is the same as an unset key: warn and move on.
  value="$(sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [ -z "$value" ]; then
    printf '[deploy-env] %s is not set locally; leaving the mini'"'"'s value untouched\n' "$key" >&2
    continue
  fi
  # The key name is interpolated into the remote command; the value is not —
  # it only reaches the mini through `read` on stdin. chmod lands on the tmp
  # file because mv would otherwise replace the 600 with the umask mode.
  # shellcheck disable=SC2016  # every $ in the remote command expands THERE
  printf '%s\n' "$value" | "$SSH" "$HOST" 'f="$HOME/.config/helium/helium.env"; IFS= read -r v; mkdir -p "$(dirname "$f")"; tmp="$f.tmp.$$"; { [ -f "$f" ] && grep -v "^'"$key"'=" "$f" || true; printf "%s=%s\n" '"$key"' "$v"; } > "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$f"'
  printf '[deploy-env] synced %s to %s\n' "$key" "$HOST"
done
