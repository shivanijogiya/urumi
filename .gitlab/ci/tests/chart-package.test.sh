#!/usr/bin/env bash
# Tests for .gitlab/ci/scripts/chart-package.sh (issue #22) against the real charts/platform.
# The packaged chart must default every app image to $CI_REGISTRY_IMAGE/<app>:<tag pushed by
# the same pipeline>, lint with both values files, and leave the checkout untouched.
# Run: bash .gitlab/ci/tests/chart-package.test.sh   (needs helm)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$HERE/../scripts/chart-package.sh"
CHART="$ROOT/charts/platform"
SHA="1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"
REG="registry.example.com/group/project"
APPS="woo-mcp gateway dashboard everything"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }

command -v helm >/dev/null 2>&1 || { echo "FAIL helm is required to run these tests"; exit 1; }

# run <dest> <tag> [registry]  -> sets OUT, ERR, RC
run() {
  OUT="$(env -i PATH="$PATH" HOME="$TMP" CI_COMMIT_SHA="$SHA" CI_COMMIT_SHORT_SHA="1a2b3c4d" \
    CI_COMMIT_TAG="$2" CI_REGISTRY_IMAGE="${3-$REG}" sh "$SCRIPT" "$CHART" "$1" 2>"$TMP/err")"
  RC=$?
  ERR="$(cat "$TMP/err")"
}

# expect_images <name> <package> <tag>: every app Deployment uses $REG/<app>:<tag>.
expect_images() {
  local rendered missing=""
  rendered="$(helm template t "$2" --set dashboard.enabled=true 2>&1)"
  for a in $APPS; do
    printf '%s' "$rendered" | grep -qF "image: \"$REG/$a:$3\"" || missing="$missing $a"
  done
  if [ -z "$missing" ] && ! printf '%s' "$rendered" | grep -q '<group>'; then ok "$1"
  else bad "$1" "missing/wrong:$missing; images: $(printf '%s' "$rendered" | grep 'image:' | sort -u | tr -s ' ' | tr '\n' '|')"; fi
}

before="$(cat "$CHART"/Chart.yaml "$CHART"/values*.yaml | cksum)"

# --- default-branch pipeline ---------------------------------------------------
run "$TMP/branch" ""
if [ "$RC" -eq 0 ]; then ok "branch pipeline packages the chart"; else bad "branch pipeline packages the chart" "$ERR"; fi
expected="CHART_VERSION=0.1.0-g1a2b3c4d
CHART_APP_VERSION=1a2b3c4d
CHART_NAME=platform
CHART_PACKAGE=$TMP/branch/platform-0.1.0-g1a2b3c4d.tgz"
if [ "$OUT" = "$expected" ]; then ok "branch pipeline prints dotenv for the publish job"; else bad "branch pipeline prints dotenv for the publish job" "$(printf '%s' "$OUT" | tr '\n' '|')"; fi
pkg="$TMP/branch/platform-0.1.0-g1a2b3c4d.tgz"
if [ -f "$pkg" ] && helm show chart "$pkg" | grep -q '^appVersion: 1a2b3c4d$'; then ok "package has appVersion = short sha"; else bad "package has appVersion = short sha"; fi
expect_images "branch chart defaults to this pipeline's images (:<short sha>)" "$pkg" "1a2b3c4d"
if [ "$(printf '%s' "$ERR" | grep -c '1 chart(s) linted, 0 chart(s) failed')" -eq 3 ]; then
  ok "lints with default, values-local and values-prod"
else
  bad "lints with default, values-local and values-prod" "$ERR"
fi

# --- release tag pipeline ------------------------------------------------------
run "$TMP/tag" "v1.4.2"
pkg="$TMP/tag/platform-1.4.2.tgz"
if [ "$RC" -eq 0 ] && [ -f "$pkg" ] && helm show chart "$pkg" | grep -q '^version: 1.4.2$'; then ok "tag v1.4.2 -> chart 1.4.2"; else bad "tag v1.4.2 -> chart 1.4.2" "$ERR"; fi
expect_images "tag chart defaults to the release images (:1.4.2)" "$pkg" "1.4.2"

# --- failures ------------------------------------------------------------------
run "$TMP/noreg" "" ""
if [ "$RC" -ne 0 ] && printf '%s' "$ERR" | grep -q 'CI_REGISTRY_IMAGE'; then ok "missing CI_REGISTRY_IMAGE fails"; else bad "missing CI_REGISTRY_IMAGE fails" "rc=$RC $ERR"; fi
run "$TMP/badtag" "release-1"
if [ "$RC" -ne 0 ] && [ ! -d "$TMP/badtag" ] && printf '%s' "$ERR" | grep -q 'v1.2.3'; then ok "invalid tag fails before packaging"; else bad "invalid tag fails before packaging" "rc=$RC $ERR"; fi

after="$(cat "$CHART"/Chart.yaml "$CHART"/values*.yaml | cksum)"
if [ "$before" = "$after" ]; then ok "checkout's chart is not modified"; else bad "checkout's chart is not modified"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
