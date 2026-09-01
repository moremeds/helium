#!/usr/bin/env bash
# launchd entry point for the helium dsh daemon. The plist must not contain
# secrets, so this wrapper — not launchd — sources the 0600 env file and then
# execs the release's own dsh binary.
#
# Invocation proven in task 1.7 Spike A: `dsh --profile helium web` is NOT a
# valid form (`web` is a hardcoded top-level subcommand alias incompatible
# with the parent `--profile` flag). The web UI is enabled by the
# `@deepseek-ai/dsh-web-app` bundle in the profile instead; the correct
# invocation is `--port <n> --no-open`.
set -euo pipefail

release="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
env_file="${HELIUM_ENV_FILE:-$HOME/.config/helium/helium.env}"

if [ -r "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
else
  echo "run-dsh: env file $env_file unreadable — deepseek lane will fail" >&2
fi

dsh_bin="$release/node_modules/.bin/dsh"
[ -x "$dsh_bin" ] || {
  echo "run-dsh: $dsh_bin not executable" >&2
  exit 78
}

exec "$dsh_bin" --profile helium --port 3080 --no-open
