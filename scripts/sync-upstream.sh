#!/usr/bin/env bash
# Merge an upstream @gotgenes/pi-subagents release into this fork.
#
# Usage: scripts/sync-upstream.sh <version>    (e.g. 25.0.5)
#
# Clones gotgenes/pi-packages into a temp directory, splits
# packages/pi-subagents at tag pi-subagents-v<version> with git subtree,
# fetches the split into this repository and merges it into the current branch.
set -euo pipefail

UPSTREAM_URL="https://github.com/gotgenes/pi-packages.git"
PREFIX="packages/pi-subagents"

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <version>   (e.g. 25.0.5)" >&2
  exit 2
fi
VERSION="$1"
TAG="pi-subagents-v$VERSION"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning $UPSTREAM_URL ..."
git clone --quiet "$UPSTREAM_URL" "$TMP/pi-packages"
UPSTREAM_COMMIT="$(git -C "$TMP/pi-packages" rev-parse "$TAG^{commit}")"

echo "Splitting $PREFIX at $TAG ..."
SPLIT="$(git -C "$TMP/pi-packages" subtree split --prefix "$PREFIX" "$TAG")"

git fetch --quiet "$TMP/pi-packages" "$SPLIT"

if ! git merge --no-edit -m "chore: merge upstream $TAG" "$SPLIT"; then
  echo >&2
  echo "Merge stopped with conflicts in:" >&2
  git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  echo "Resolve them, add rows to UPSTREAM.md for any new local edits, then commit." >&2
  STATUS=1
else
  STATUS=0
fi

cat <<EOF

Update the "## Upstream" section of UPSTREAM.md:
  - Tag: \`$TAG\`
  - Commit: \`$UPSTREAM_COMMIT\`
  - Upstream split commit: \`$SPLIT\`
Then run: bun run test
EOF
exit "$STATUS"
