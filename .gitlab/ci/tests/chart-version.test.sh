#!/usr/bin/env bash
# Unit tests for .gitlab/ci/scripts/chart-version.sh (issue #22).
# Run: bash .gitlab/ci/tests/chart-version.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../scripts/chart-version.sh"
SHA="1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }

# chart <dir> <version-line>
chart() { mkdir -p "$1"; printf 'apiVersion: v2\nname: platform\n%s\nappVersion: "0.0.0"\n' "$2" > "$1/Chart.yaml"; }

# run <name> <chart_dir> <tag> <sha> [short_sha]  -> sets OUT, RC
run() {
  if [ -n "${5:-}" ]; then
    OUT="$(env -i PATH="$PATH" CI_COMMIT_TAG="$3" CI_COMMIT_SHA="$4" CI_COMMIT_SHORT_SHA="$5" sh "$SCRIPT" "$2" 2>&1)"
  else
    OUT="$(env -i PATH="$PATH" CI_COMMIT_TAG="$3" CI_COMMIT_SHA="$4" sh "$SCRIPT" "$2" 2>&1)"
  fi
  RC=$?
}

expect_ok() { # name chart tag sha expected_output [short_sha]
  run "$1" "$2" "$3" "$4" "${6:-}"
  if [ "$RC" -eq 0 ] && [ "$OUT" = "$5" ]; then ok "$1"; else bad "$1" "rc=$RC out=$(printf '%s' "$OUT" | tr '\n' '|')"; fi
}

expect_fail() { # name chart tag sha message_fragment [short_sha]
  run "$1" "$2" "$3" "$4" "${6:-}"
  if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF -- "$5"; then ok "$1"; else bad "$1" "rc=$RC out=$(printf '%s' "$OUT" | tr '\n' '|')"; fi
}

chart "$TMP/good" 'version: 0.4.0'
chart "$TMP/quoted" 'version: "1.2.0" # pinned'
chart "$TMP/pre" 'version: 0.4.0-rc.1'
chart "$TMP/noversion" 'description: x'
mkdir -p "$TMP/empty"

expect_ok "tag v1.2.3 -> version and appVersion from tag" "$TMP/good" "v1.2.3" "$SHA" \
"CHART_VERSION=1.2.3
CHART_APP_VERSION=1.2.3"

expect_ok "prerelease tag v2.0.0-rc.1 is kept" "$TMP/good" "v2.0.0-rc.1" "$SHA" \
"CHART_VERSION=2.0.0-rc.1
CHART_APP_VERSION=2.0.0-rc.1"

expect_ok "tag pipeline does not need Chart.yaml version" "$TMP/empty" "v0.9.1" "$SHA" \
"CHART_VERSION=0.9.1
CHART_APP_VERSION=0.9.1"

expect_ok "branch pipeline -> Chart.yaml base + commit, appVersion = short sha (pushed image tag)" "$TMP/good" "" "$SHA" \
"CHART_VERSION=0.4.0-g1a2b3c4d
CHART_APP_VERSION=1a2b3c4d"

expect_ok "CI_COMMIT_SHORT_SHA is used when GitLab provides it" "$TMP/good" "" "$SHA" \
"CHART_VERSION=0.4.0-g1a2b3c4d5e
CHART_APP_VERSION=1a2b3c4d5e" "1a2b3c4d5e"

expect_ok "quoted Chart.yaml version with comment" "$TMP/quoted" "" "$SHA" \
"CHART_VERSION=1.2.0-g1a2b3c4d
CHART_APP_VERSION=1a2b3c4d"

expect_ok "all-digit short sha still valid semver (g prefix)" "$TMP/good" "" "0123456789abcdef0123456789abcdef01234567" \
"CHART_VERSION=0.4.0-g01234567
CHART_APP_VERSION=01234567"

expect_fail "tag without v prefix is rejected" "$TMP/good" "1.2.3" "$SHA" "v1.2.3"
expect_fail "non-semver tag is rejected" "$TMP/good" "v1.2" "$SHA" "v1.2.3"
expect_fail "leading zero tag is rejected" "$TMP/good" "v01.2.3" "$SHA" "v1.2.3"
expect_fail "build metadata tag is rejected" "$TMP/good" "v1.2.3+abc" "$SHA" "v1.2.3"
expect_fail "missing Chart.yaml on branch pipeline fails with prerequisite" "$TMP/missing" "" "$SHA" "Chart.yaml not found"
expect_fail "Chart.yaml without version fails" "$TMP/noversion" "" "$SHA" "no plain X.Y.Z"
expect_fail "prerelease base version in Chart.yaml fails" "$TMP/pre" "" "$SHA" "no plain X.Y.Z"
expect_fail "missing CI_COMMIT_SHA fails" "$TMP/good" "" "" "CI_COMMIT_SHA"
expect_fail "malformed CI_COMMIT_SHA fails" "$TMP/good" "" "not-a-sha" "CI_COMMIT_SHA"
expect_fail "missing chart dir argument fails" "" "" "$SHA" "usage"
expect_fail "CI_COMMIT_SHORT_SHA not matching CI_COMMIT_SHA fails" "$TMP/good" "" "$SHA" "not a prefix" "deadbeef"
expect_fail "malformed CI_COMMIT_SHORT_SHA fails" "$TMP/good" "" "$SHA" "7-40 hex" "1a2b"

# End-to-end with real helm when available: derived version must be accepted by helm package.
if command -v helm >/dev/null 2>&1; then
  helm create "$TMP/platform" >/dev/null
  sed -i.bak 's/^version: .*/version: 0.4.0/' "$TMP/platform/Chart.yaml"
  run "helm" "$TMP/platform" "" "$SHA"
  if [ "$RC" -eq 0 ]; then
    eval "$OUT"
    if helm package "$TMP/platform" --version "$CHART_VERSION" --app-version "$CHART_APP_VERSION" -d "$TMP/out" >/dev/null 2>&1 \
       && [ -f "$TMP/out/platform-0.4.0-g1a2b3c4d.tgz" ] \
       && helm show chart "$TMP/out/platform-0.4.0-g1a2b3c4d.tgz" | grep -q "appVersion: 1a2b3c4d"; then
      ok "helm package accepts derived version/appVersion"
    else
      bad "helm package accepts derived version/appVersion"
    fi
  else
    bad "helm package accepts derived version/appVersion" "helper failed: $OUT"
  fi
else
  printf 'SKIP helm package check (helm not installed)\n'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
