#!/usr/bin/env bash
# Checks that the Helm chart is in lockstep with the app version.
#
# apps/api/package.json is the version source of truth. The root and
# apps/web package.json files, and in charts/betterdb-monitor/Chart.yaml the
# chart `version`, `appVersion` and both artifacthub.io/images tags
# (<v>-no-ai and <v>), must all carry the same version. scripts/bump-version.mjs
# updates every one of them.
#
#   scripts/check-chart-version.sh            check the files agree
#   scripts/check-chart-version.sh v1.2.3     also require them to equal 1.2.3
#                                             (the release tag; a leading v is
#                                             stripped)
#
# Exits 1 and names both versions on every mismatch. Used by chart-tests.yml
# on pull requests and by helm-publish.yml before anything is packaged.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="${repo_root}/charts/betterdb-monitor/Chart.yaml"

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  prefix="::error::"
else
  prefix="error: "
fi

failures=0
fail() {
  echo "${prefix}$1" >&2
  failures=$((failures + 1))
}

json_version() {
  node -p "require(process.argv[1]).version" "${repo_root}/$1"
}

# Top-level scalar from Chart.yaml, quotes stripped.
chart_field() {
  grep "^$1:" "$chart" | head -n 1 | sed 's/^[^:]*: *//; s/ *#.*$//; s/"//g; s/'"'"'//g'
}

app_version="$(json_version apps/api/package.json)"
expected="${1:-}"
expected="${expected#v}"

if [ -n "$expected" ] && [ "$app_version" != "$expected" ]; then
  fail "apps/api/package.json version (${app_version}) != release tag v${expected}. Run: node scripts/bump-version.mjs ${expected}"
fi
want="${expected:-$app_version}"
if [ -n "$expected" ]; then
  source_of_want="release tag v${want}"
else
  source_of_want="apps/api/package.json ${want}"
fi

for pkg in package.json apps/web/package.json; do
  v="$(json_version "$pkg")"
  if [ "$v" != "$want" ]; then
    fail "${pkg} version (${v}) != ${source_of_want}. Run: node scripts/bump-version.mjs ${want}"
  fi
done

chart_app_version="$(chart_field appVersion)"
if [ "$chart_app_version" != "$want" ]; then
  fail "Chart.yaml appVersion (${chart_app_version}) != ${source_of_want}. Run: node scripts/bump-version.mjs ${want}"
fi

chart_version="$(chart_field version)"
if [ "$chart_version" != "$want" ]; then
  fail "Chart.yaml version (${chart_version}) != ${source_of_want}. The chart is released in lockstep with the app. Run: node scripts/bump-version.mjs ${want}"
fi

for image in "betterdb/monitor:${want}-no-ai" "betterdb/monitor:${want}"; do
  if ! grep -qE "^ +image: ${image//./\\.}\$" "$chart"; then
    fail "Chart.yaml artifacthub.io/images does not list ${image}. Run: node scripts/bump-version.mjs ${want}"
  fi
done

if [ "$failures" -gt 0 ]; then
  exit 1
fi
echo "Chart and app versions in sync at ${want}"
