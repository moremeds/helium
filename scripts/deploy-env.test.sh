#!/usr/bin/env bash
# Tests for scripts/deploy-env.sh. Plain bash, no framework:
#
#   bash scripts/deploy-env.test.sh
#
# The sync moves secrets, so the test proves the three properties a wrong
# version would break: the value travels on stdin and never reaches a command
# line, an existing mini file keeps its other keys, and a key absent or empty
# locally warns without touching the mini. ssh is stubbed (HELIUM_SSH) with a
# script that drops the host argument and runs the remote command locally
# under a tmp HOME — stdin passes straight through, which is where the value
# travels.
set -uo pipefail

DEPLOY_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy-env.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

ok() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: expected '$3', got '$2'"; fi; }

# --- stubs -------------------------------------------------------------------
# ssh is called as `ssh <host> <remote-command>`; the stub records the full
# argv (so a value on the command line would be caught) and runs the command
# under the fake mini's HOME.
BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG/ssh"
HOME="$REMOTE_HOME" exec sh -c "$2"
STUB
chmod +x "$BIN/ssh"

export STUB_LOG="$WORK/log"
export REMOTE_HOME="$WORK/mini-home"
mkdir -p "$STUB_LOG" "$REMOTE_HOME"

LAPTOP_ENV="$WORK/laptop.env"
MINI_ENV="$REMOTE_HOME/.config/helium/helium.env"

sync_env() { # sync_env KEY... -- stubbed ssh, tmp laptop env, tmp mini home
  HELIUM_SSH="$BIN/ssh" HELIUM_ENV_FILE="$LAPTOP_ENV" \
    bash "$DEPLOY_ENV" mini.test "$@" > "$WORK/out" 2> "$WORK/err"
}

# --- 1. a fresh mini file gets both keys, mode 600 ----------------------------
cat > "$LAPTOP_ENV" <<'EOF'
RESEND_HELIUM_TOKEN=re_test_value_abc
HELIUM_EMAIL_TO=ops@example.test
EOF
rm -f "$MINI_ENV"
sync_env RESEND_HELIUM_TOKEN HELIUM_EMAIL_TO; check "fresh sync exits 0" "$?" "0"
check "token landed" \
  "$(grep -c '^RESEND_HELIUM_TOKEN=re_test_value_abc$' "$MINI_ENV" 2>/dev/null)" "1"
check "recipient landed" \
  "$(grep -c '^HELIUM_EMAIL_TO=ops@example.test$' "$MINI_ENV" 2>/dev/null)" "1"
check "mini file is mode 600" "$(stat -f %Lp "$MINI_ENV")" "600"
check "both keys reported by name" \
  "$(grep -c '\[deploy-env\] synced' "$WORK/out")" "2"

# --- 2. an existing file keeps its other keys, replaces only the named one ---
cat > "$MINI_ENV" <<'EOF'
SMTP_HOST=x
HELIUM_EMAIL_TO=old@x
EOF
sync_env RESEND_HELIUM_TOKEN HELIUM_EMAIL_TO; check "merge exits 0" "$?" "0"
check "unrelated line preserved" "$(grep -c '^SMTP_HOST=x$' "$MINI_ENV")" "1"
check "recipient replaced exactly once" "$(grep -c '^HELIUM_EMAIL_TO=' "$MINI_ENV")" "1"
check "recipient is the new value" "$(grep -c '^HELIUM_EMAIL_TO=ops@example.test$' "$MINI_ENV")" "1"
check "token appended" "$(grep -c '^RESEND_HELIUM_TOKEN=re_test_value_abc$' "$MINI_ENV")" "1"

# --- 3. a key empty locally warns and leaves the mini untouched ---------------
printf 'RESEND_HELIUM_TOKEN=re_test_value_abc\nHELIUM_EMAIL_TO=\n' > "$LAPTOP_ENV"
before="$(cat "$MINI_ENV")"
sync_env HELIUM_EMAIL_TO; check "empty key exits 0" "$?" "0"
check "empty key warns on stderr" \
  "$(grep -c 'HELIUM_EMAIL_TO is not set locally' "$WORK/err")" "1"
check "mini file unchanged" "$(cat "$MINI_ENV")" "$before"
cat > "$LAPTOP_ENV" <<'EOF'
RESEND_HELIUM_TOKEN=re_test_value_abc
EOF
sync_env HELIUM_EMAIL_TO; check "missing key exits 0" "$?" "0"
check "missing key warns on stderr" \
  "$(grep -c 'HELIUM_EMAIL_TO is not set locally' "$WORK/err")" "1"

# --- 4. the value never reaches output or a command line ----------------------
cat > "$LAPTOP_ENV" <<'EOF'
RESEND_HELIUM_TOKEN=re_test_value_abc
HELIUM_EMAIL_TO=ops@example.test
EOF
sync_env RESEND_HELIUM_TOKEN HELIUM_EMAIL_TO
check "value absent from stdout" "$(grep -c 're_test_value_abc' "$WORK/out")" "0"
check "value absent from stderr" "$(grep -c 're_test_value_abc' "$WORK/err")" "0"
check "value absent from the ssh command line" "$(grep -c 're_test_value_abc' "$STUB_LOG/ssh")" "0"

if [ "$failures" -ne 0 ]; then
  printf '\n%s test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall deploy-env tests passed\n'
