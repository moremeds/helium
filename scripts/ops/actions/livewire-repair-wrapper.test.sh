#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/helium-livewire-wrapper.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
ready="$tmp/ready"
livewire="$tmp/livewire"
mkdir -p "$ready" "$livewire/livewire_scripts" "$livewire/clients"
chmod 700 "$ready" "$livewire"
printf '' >"$livewire/livewire_scripts/__init__.py"
cat >"$livewire/livewire_scripts/shepherd_repair.py" <<'PY'
import json
import pathlib
import sys
import time
if "transaction" in sys.argv and (pathlib.Path(sys.argv[sys.argv.index("--data-lake-root") + 1]) / "hang").exists():
    time.sleep(30)
print(json.dumps({"argv": sys.argv[1:]}))
PY
printf '# pinned mutator\n' >"$livewire/clients/shepherd_repair.py"
python_bin="$(command -v python3)"
python_sha="$(shasum -a 256 "$python_bin" | awk '{print $1}')"
python_dependency="$tmp/python-dependency.py"
printf '# pinned dependency\n' >"$python_dependency"
python_dependency_sha="$(shasum -a 256 "$python_dependency" | awk '{print $1}')"
python_runtime_manifest="$tmp/python-runtime.sha256"
printf '%s  %s\n%s  %s\n' "$python_sha" "$python_bin" "$python_dependency_sha" "$python_dependency" >"$python_runtime_manifest"
python_runtime_manifest_sha="$(shasum -a 256 "$python_runtime_manifest" | awk '{print $1}')"
source_manifest="$tmp/livewire.sha256"
(cd "$livewire" && find livewire_scripts clients -type f -name '*.py' -print | sort | xargs shasum -a 256) >"$source_manifest"
source_manifest_sha="$(shasum -a 256 "$source_manifest" | awk '{print $1}')"
data_lake_root="$tmp/lake"
mkdir -p "$data_lake_root"

render() {
  local command="$1"
  local out="$2"
  sed \
    -e "s|__READY_DIR__|$ready|g" \
    -e "s|__PYTHON_BIN__|$python_bin|g" \
    -e "s|__PYTHON_SHA256__|$python_sha|g" \
    -e "s|__LIVEWIRE_ROOT__|$livewire|g" \
    -e "s|__SOURCE_MANIFEST__|$source_manifest|g" \
    -e "s|__SOURCE_MANIFEST_SHA256__|$source_manifest_sha|g" \
    -e "s|__PYTHON_RUNTIME_MANIFEST__|$python_runtime_manifest|g" \
    -e "s|__PYTHON_RUNTIME_MANIFEST_SHA256__|$python_runtime_manifest_sha|g" \
    -e "s|__DATA_LAKE_ROOT__|$data_lake_root|g" \
    -e "s|__COMMAND__|$command|g" \
    -e "s|__CHILD_TIMEOUT_SECONDS__|1|g" \
    "$here/livewire-repair-wrapper.sh.template" >"$out"
  chmod 500 "$out"
}

transaction="$tmp/transaction"
postcondition="$tmp/postcondition"
render transaction "$transaction"
render postcondition "$postcondition"
manifest="$ready/sha256:$(printf manifest | shasum -a 256 | awk '{print $1}').json"
printf '{}\n' >"$manifest"
chmod 600 "$manifest"

out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0)"
printf '%s\n' "$out" | grep -Fq '"transaction"'
printf '%s\n' "$out" | grep -Fq -- '--data-lake-root'
printf '%s\n' "$out" | grep -Fq "$data_lake_root"
out="$(printf 'go\n' | "$postcondition" --manifest "$manifest" 3<&0)"
printf '%s\n' "$out" | grep -Fq '"postcondition"'

touch "$data_lake_root/hang"
printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 >/dev/null 2>&1 &
hung_pid=$!
killed_by_test=1
for _ in $(seq 1 30); do
  if ! kill -0 "$hung_pid" 2>/dev/null; then killed_by_test=0; break; fi
  sleep 0.1
done
if [ "$killed_by_test" -eq 1 ]; then
  kill -KILL "$hung_pid" 2>/dev/null || true
fi
set +e
wait "$hung_pid"
hung_rc=$?
set -e
rm "$data_lake_root/hang"
[ "$killed_by_test" -eq 0 ] && [ "$hung_rc" -ne 0 ] || {
  echo "FAIL: orphan transaction has no child-side deadline" >&2
  exit 1
}

for bad in \
  "printf 'go\\n' | $transaction --manifest relative.json 3<&0" \
  "printf 'go\\n' | $transaction --manifest $manifest --extra x 3<&0" \
  "printf 'go\\n' | $transaction --manifest $tmp/outside.json 3<&0"; do
  set +e
  eval "$bad" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "FAIL: widened wrapper invocation succeeded: $bad"; exit 1; }
done

printf '# omitted runtime\n' >"$livewire/clients/omitted.py"
set +e
out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'omits Python runtime files'
rm "$livewire/clients/omitted.py"

printf 'raise RuntimeError("shadowed stdlib")\n' >"$livewire/json.py"
set +e
out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'unsafe Python import shadow' || {
  echo "FAIL: unsigned top-level Python shadow was accepted" >&2
  exit 1
}
rm "$livewire/json.py"

mkdir "$livewire/clients/__pycache__"
printf 'unsigned bytecode\n' >"$livewire/clients/__pycache__/shadow.pyc"
set +e
out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'unsigned Python bytecode' || {
  echo "FAIL: unsigned Python bytecode was accepted" >&2
  exit 1
}
rm -rf "$livewire/clients/__pycache__"

printf '# drift\n' >>"$python_dependency"
set +e
out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'Python runtime bytes changed' || {
  echo "FAIL: changed Python dependency was accepted" >&2
  exit 1
}
printf '# pinned dependency\n' >"$python_dependency"

chmod 700 "$transaction"
printf '# drift\n' >>"$livewire/livewire_scripts/shepherd_repair.py"
chmod 500 "$transaction"
set +e
out="$(printf 'go\n' | "$transaction" --manifest "$manifest" 3<&0 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'source bytes changed'

echo "livewire repair wrapper tests passed"
