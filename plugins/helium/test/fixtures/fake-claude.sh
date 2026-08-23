#!/usr/bin/env bash
# Fake `claude -p`: records argv+stdin, prints a claude --output-format json
# envelope. Used only by the local E2E harness (Task 3.1) — no live LLM call.
set -euo pipefail
: "${FAKE_CLAUDE_LOG:?FAKE_CLAUDE_LOG must be set}"
printf '%s\n' "$*" >> "$FAKE_CLAUDE_LOG"
cat > "${FAKE_CLAUDE_LOG}.prompt"
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"# Macro read\n\nRate path unchanged at the front end; long end steepened. No action.\n"}'
