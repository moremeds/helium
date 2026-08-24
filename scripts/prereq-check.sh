#!/usr/bin/env bash
# helium mini prerequisites. Read-only: no installs, no writes, no secret values printed.
#
# Every check is guarded so a missing/misbehaving mini-only dependency (Clash,
# argon, the launchd GUI domain, ...) degrades to a FAIL/WARN line instead of
# tripping `set -e` and aborting the script. Run this on the mini via ssh
# (task-3.3-brief.md Step 2); running it elsewhere is expected to print mostly
# FAIL — the script must still finish and exit nonzero.
set -euo pipefail

fail=0
pass() { printf 'PASS  %-14s %s\n' "$1" "$2"; }
bad() {
  printf 'FAIL  %-14s %s\n' "$1" "$2"
  fail=1
}
warn() { printf 'WARN  %-14s %s\n' "$1" "$2"; }

if node_bin=$(command -v node 2>/dev/null); then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  node_ver=$(node -v 2>/dev/null || echo '(unknown)')
  if [ "$major" -ge 20 ]; then
    pass node "$node_bin $node_ver"
  else
    bad node "$node_bin $node_ver — need >= 20"
  fi
else
  bad node "not on PATH (PATH=$PATH)"
fi

if pnpm_bin=$(command -v pnpm 2>/dev/null); then
  pnpm_ver=$(pnpm -v 2>/dev/null || echo '(unknown)')
  pass pnpm "$pnpm_bin $pnpm_ver"
else
  bad pnpm "not on PATH"
fi

if claude_bin=$(command -v claude 2>/dev/null); then
  claude_ver=$(claude --version 2>&1 | head -1 || echo '(unknown)')
  pass claude "$claude_bin $claude_ver"
else
  bad claude "not on PATH"
fi

if nc -z -w 2 127.0.0.1 7897 2>/dev/null; then
  pass clash "127.0.0.1:7897 accepting"
else
  bad clash "127.0.0.1:7897 closed — start Clash Verge (mixed port)"
fi

tok="$HOME/.config/helium/claude-token.env"
if [ -f "$tok" ]; then
  mode=$(stat -f '%Lp' "$tok")
  if [ "$mode" = "600" ]; then
    pass token-file "$tok mode 600"
  else
    bad token-file "$tok mode $mode — run: chmod 600 $tok"
  fi
else
  bad token-file "$tok missing"
fi

env_file="$HOME/.config/helium/helium.env"
if [ -f "$env_file" ]; then
  mode=$(stat -f '%Lp' "$env_file")
  if [ "$mode" = "600" ]; then
    pass env-file "$env_file mode 600"
  else
    bad env-file "$env_file mode $mode — run: chmod 600 $env_file"
  fi
else
  bad env-file "$env_file missing (DEEPSEEK_API_KEY + SMTP)"
fi

sleep_val=$(pmset -g custom 2>/dev/null | awk '$1=="sleep"{print $2; exit}') || sleep_val=""
if [ "${sleep_val:-x}" = "0" ]; then
  pass pmset "system sleep disabled"
else
  warn pmset "sleep=${sleep_val:-unknown} — fix: sudo pmset -a sleep 0"
fi

code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8400/api/health 2>/dev/null || true)
if [ "$code" = "200" ]; then
  pass argon "GET /api/health 200"
else
  bad argon "GET /api/health -> ${code:-no-response}"
fi

if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
  pass launchd-gui "gui/$(id -u) reachable"
else
  bad launchd-gui "gui/$(id -u) unreachable from this session — see Step 3"
fi

# token-age (spec §4): mtime of the token file approximates the setup-token
# issue date, so its age surfaces in every deploy report. 1-year token; warn
# past 330d so there is room to re-run `claude setup-token` before expiry.
if [ -f "$tok" ]; then
  age_days=$((($(date +%s) - $(stat -f %m "$tok")) / 86400))
  if [ "$age_days" -gt 330 ]; then
    warn token-age "${age_days}d — 1-year token, re-run 'claude setup-token' soon"
  else
    pass token-age "${age_days}d"
  fi
else
  bad token-age "$tok missing"
fi

exit "$fail"
