#!/bin/sh
# app/ as the gh-pages branch, for GitHub Pages served from a branch (Settings → Pages → Deploy from a branch →
# gh-pages, / (root)): one parentless commit with app/'s files and .nojekyll, replaced on each run.
#
#   scripts/pages.sh          # the local gh-pages branch
#   scripts/pages.sh --push   # and force-push it
#
# Never commit to gh-pages by hand. The site is then https://<owner>.github.io/minidaw/.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
node scripts/gen_precache.mjs
if ! git diff --quiet -- app/precache.json app/sw.js; then
  echo "app/precache.json or app/sw.js changed: commit them first" >&2
  exit 1
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_INDEX_FILE="$TMP/index"
git read-tree --empty
git read-tree --prefix= "$(git rev-parse HEAD:app)"
EMPTY=$(git hash-object -w --stdin </dev/null)
git update-index --add --cacheinfo 100644 "$EMPTY" .nojekyll
TREE=$(git write-tree)
unset GIT_INDEX_FILE
if [ "$(git rev-parse -q --verify 'refs/heads/gh-pages^{tree}' || true)" = "$TREE" ]; then
  echo "== gh-pages: unchanged"
else
  git update-ref refs/heads/gh-pages "$(git commit-tree "$TREE" -m "minidaw $(git rev-parse --short HEAD): app/ for GitHub Pages")"
  echo "== gh-pages: app/ from $(git rev-parse --short HEAD)"
fi
if [ "$PUSH" = 1 ]; then
  git push --force origin gh-pages
fi
