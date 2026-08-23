#!/usr/bin/env bash
# Cut a helium release tag. Laptop only. Refuses a dirty tree.
# usage: cut.sh vX.Y.Z [--allow-branch <name>] [--no-push]
#
# --no-push: create the version-bump commit, CHANGELOG.md entry and
# annotated tag locally, but skip `git push`. Exists so this script can be
# drilled locally (task 3.5 AC#6) without touching the remote — the caller
# is responsible for cleaning up the local commit/tag afterwards (run on a
# throwaway branch, then delete the branch and `git tag -d` the tag).
set -euo pipefail

version="${1:-}"
allow_branch=""
push=1
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-branch) allow_branch="${2:-}"; shift 2 ;;
    --no-push) push=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: cut.sh vX.Y.Z [--allow-branch <name>] [--no-push]" >&2; exit 64; }
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

[ -z "$(git status --porcelain)" ] || { echo "refusing: working tree is dirty" >&2; exit 65; }
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "master" ] && [ "$branch" != "$allow_branch" ]; then
  echo "refusing: on '$branch'; cut from master or pass --allow-branch $branch" >&2
  exit 65
fi
git fetch origin --tags --quiet
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
  echo "refusing: tag $version already exists" >&2
  exit 65
fi

node -e '
  const {readFileSync,writeFileSync}=require("node:fs");
  const p=JSON.parse(readFileSync("package.json","utf8"));
  p.version=process.argv[1].slice(1);
  writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");' "$version"

prev="$(git describe --tags --abbrev=0 2>/dev/null || true)"
range="${prev:+$prev..}HEAD"
entry="$(mktemp -t helium-changelog)"
{
  echo "## $version — $(date -u +%Y-%m-%d)"
  echo
  git log --no-merges --pretty='- %s' "$range"
  echo
} > "$entry"
"${EDITOR:-vi}" "$entry"
touch CHANGELOG.md
cat "$entry" CHANGELOG.md > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md
rm -f "$entry"

git add package.json CHANGELOG.md
git commit -m "release: $version"
git tag -a "$version" -m "helium $version"

if [ "$push" = "1" ]; then
  git push origin "HEAD:$branch" && git push origin "$version"
  echo "cut $version on $branch"
else
  echo "cut $version on $branch (--no-push: local commit + tag only, nothing pushed)"
fi
