#!/usr/bin/env bash
# Reversible launchd switch for the bounded P4 review-only canary.
set -euo pipefail

command="${1:-}"
shift || true
plist="${HOME}/Library/LaunchAgents/com.helium.dsh.plist"
restart=1
while [ $# -gt 0 ]; do
  case "$1" in
    --plist) plist="${2:-}"; shift 2 ;;
    --no-restart) restart=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
case "$command" in enable|off|restore|status) ;; *)
  echo "usage: configure-review-canary.sh enable|off|restore|status [--plist PATH] [--no-restart]" >&2
  exit 64
esac

[ -f "$plist" ] || { echo "missing DSH plist: $plist" >&2; exit 65; }
plutil -lint "$plist" >/dev/null
label="$(plutil -extract Label raw -o - "$plist")"
[ "$label" = "com.helium.dsh" ] || { echo "refusing non-DSH plist: $label" >&2; exit 65; }
backup="${plist}.pre-p4-review-canary"

value() {
  plutil -extract "EnvironmentVariables.$1" raw -o - "$plist" 2>/dev/null || true
}

domain="gui/$(id -u)"
reload_dsh() {
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label" || return 1
    local end=$((SECONDS + 15))
    while launchctl print "$domain/$label" >/dev/null 2>&1; do
      [ $SECONDS -lt $end ] || {
        echo "DSH did not unload before plist reload" >&2
        return 1
      }
      sleep 1
    done
  fi
  launchctl bootstrap "$domain" "$plist"
}

if [ "$command" = "status" ]; then
  printf '{"mode":"%s","jobs":"%s","dailyCap":"%s","backup":%s}\n' \
    "$(value HELIUM_TEAM_PROMOTION_MODE)" \
    "$(value HELIUM_TEAM_CANARY_JOBS)" \
    "$(value HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY)" \
    "$([ -f "$backup" ] && printf true || printf false)"
  exit 0
fi

if [ "$command" = "restore" ]; then
  [ -f "$backup" ] || { echo "no canary backup to restore: $backup" >&2; exit 65; }
  transaction="${plist}.transaction.$$"
  cp -p "$plist" "$transaction"
  cp -p "$backup" "$plist"
  plutil -lint "$plist" >/dev/null
  if [ "$restart" = "1" ] && ! reload_dsh; then
    mv "$transaction" "$plist"
    reload_dsh || true
    echo "DSH plist reload failed; restored the pre-command plist" >&2
    exit 66
  fi
  rm -f "$backup"
  rm -f "$transaction"
  echo "restored exact pre-canary DSH plist"
  exit 0
fi

if [ "$command" = "enable" ] && [ ! -f "$backup" ]; then
  cp -p "$plist" "$backup"
fi

temporary="$(mktemp "${plist}.tmp.XXXXXX")"
transaction="${plist}.transaction.$$"
cp -p "$plist" "$temporary"
cp -p "$plist" "$transaction"
cleanup() { rm -f "$temporary" "$transaction"; }
trap cleanup EXIT

set_string() {
  local key="$1" setting="$2"
  if plutil -extract "EnvironmentVariables.$key" raw -o - "$temporary" >/dev/null 2>&1; then
    plutil -replace "EnvironmentVariables.$key" -string "$setting" "$temporary"
  else
    plutil -insert "EnvironmentVariables.$key" -string "$setting" "$temporary"
  fi
}

if [ "$command" = "enable" ]; then
  current_path="$(plutil -extract EnvironmentVariables.PATH raw -o - "$temporary")"
  case ":$current_path:" in
    *:/Applications/ChatGPT.app/Contents/Resources:*) ;;
    *) current_path="/Applications/ChatGPT.app/Contents/Resources:$current_path" ;;
  esac
  set_string PATH "$current_path"
  set_string CODEX_HOME "/Users/moremeds/.codex"
  set_string HELIUM_TEAM_PROMOTION_MODE "review-only"
  set_string HELIUM_TEAM_CANARY_JOBS "macro-watch"
  set_string HELIUM_TEAM_CANARY_MAX_PER_UTC_DAY "1"
  set_string HELIUM_TEAMS_DIR "/Users/moremeds/projects/helium-releases/current/teams"
  set_string HELIUM_OPS_EVENT_LOG "/Users/moremeds/.helium/ops/state/events.jsonl"
else
  set_string HELIUM_TEAM_PROMOTION_MODE "off"
fi

plutil -lint "$temporary" >/dev/null
mv "$temporary" "$plist"
if [ "$restart" = "1" ] && ! reload_dsh; then
  mv "$transaction" "$plist"
  reload_dsh || true
  echo "DSH plist reload failed; restored the pre-command plist" >&2
  exit 66
fi
rm -f "$transaction"
trap - EXIT
printf 'P4 review canary mode: %s\n' "$(value HELIUM_TEAM_PROMOTION_MODE)"
