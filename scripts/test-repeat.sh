#!/usr/bin/env bash
# Repeat an exact test command because Vitest 3 does not provide --repeat.
set -euo pipefail

count="${1:-}"
if ! [[ "$count" =~ ^[1-9][0-9]*$ ]] || [ "$#" -lt 2 ]; then
  echo "usage: test-repeat.sh COUNT COMMAND [ARG ...]" >&2
  exit 64
fi
shift

iteration=1
while [ "$iteration" -le "$count" ]; do
  printf '[repeat %d/%d]\n' "$iteration" "$count"
  "$@"
  iteration=$((iteration + 1))
done
