#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
bash -n "$here/install-livewire-shepherd.sh"
bash -n "$here/run-livewire-opsd.sh"
node --check "$here/prepare-livewire-shepherd-promotion.mjs"
plutil -lint "$repo/launchd/com.helium.livewire-opsd.plist.template" >/dev/null
node --test "$here/prepare-livewire-shepherd-promotion.test.mjs"
