#!/usr/bin/env bash
# Policy test for the self-healing CI rules in .gitlab/ci/canary.gitlab-ci.yml (#28,
# docs/adr/005-self-healing.md):
#   - MR pipelines from an `autoheal/` branch run `canary` automatically (no `when: manual`) and
#     not allow_failure, so a fix is verified with no human click and a failed fix is visible
#   - that rule comes before the generic MR rule (first match wins), and other MRs keep the manual,
#     allow_failure canary
#   - `canary:bad-release` never runs automatically for autoheal branches
#   - `autoheal:report` exists only on autoheal MR pipelines, needs `canary` (with artifacts), runs
#     even when the canary failed, is allow_failure and runs scripts/canary/autoheal_report.py,
#     which writes the verdict into the MR description (#32); the job never echoes the token
#   - the canary job keeps full git history (the stable baseline commit must be in the clone)
#   - release:config-tests runs this test
# Run: bash .gitlab/ci/tests/autoheal-ci.test.sh   (needs helm, jq)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
check() {
  local out
  out="$(jq -r "$JQ_LIB $3" "$2" 2>&1)"
  if [ "$out" = "true" ]; then ok "$1"; else bad "$1" "$(printf '%s' "$out" | head -5)"; fi
}

for bin in helm jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL $bin is required to run these tests"; exit 1; }
done

to_json() {
  rm -rf "$TMP/chart"
  mkdir -p "$TMP/chart/templates"
  printf 'apiVersion: v2\nname: parse\nversion: 0.0.0\n' > "$TMP/chart/Chart.yaml"
  printf '{{ toJson .Values }}\n' > "$TMP/chart/templates/dump.yaml"
  cp "$1" "$TMP/chart/values.yaml"
  helm template p "$TMP/chart" 2>"$TMP/err" | grep -v -e '^---' -e '^#' > "$2" \
    && jq -e 'type == "object"' "$2" >/dev/null 2>&1
}

JQ_LIB='
def autoheal_if: test("CI_PIPELINE_SOURCE == \"merge_request_event\"") and test("CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /\\^autoheal\\\\//");
def mr_if: test("CI_PIPELINE_SOURCE == \"merge_request_event\"");
'

C="$TMP/canary.json"
R="$TMP/release.json"
to_json "$ROOT/.gitlab/ci/canary.gitlab-ci.yml" "$C" || { bad "canary.gitlab-ci.yml is valid YAML" "$(cat "$TMP/err")"; exit 1; }
to_json "$ROOT/.gitlab/ci/release.gitlab-ci.yml" "$R" || { bad "release.gitlab-ci.yml is valid YAML" "$(cat "$TMP/err")"; exit 1; }

check "canary: one autoheal MR rule, automatic and not allow_failure" "$C" \
  '[.canary.rules[] | select(.if | autoheal_if)] as $r
   | ($r | length) == 1 and ($r[0] | has("when") | not) and $r[0].allow_failure == false'
check "canary: the autoheal rule comes before the generic MR rule" "$C" \
  '[.canary.rules[] | .if] as $ifs
   | ([$ifs | to_entries[] | select(.value | autoheal_if) | .key][0])
     < ([$ifs | to_entries[] | select((.value | mr_if) and ((.value | autoheal_if) | not)) | .key][0])'
check "canary: other MRs stay manual and allow_failure" "$C" \
  '[.canary.rules[] | select((.if | mr_if) and ((.if | autoheal_if) | not)) | [.when, .allow_failure]]
   == [["manual", true]]'
check "canary: keeps full git history for the stable baseline" "$C" '.canary.variables.GIT_DEPTH == "0"'
check "canary:bad-release: never automatic on MRs (no autoheal rule)" "$C" \
  '[.["canary:bad-release"].rules[] | select(.if | mr_if) | .when] | all(. == "manual")'

check "autoheal:report: only on autoheal MR pipelines" "$C" \
  '.["autoheal:report"].rules | length == 1 and (.[0].if | autoheal_if)'
check "autoheal:report: needs canary with artifacts, runs even if canary failed" "$C" \
  '.["autoheal:report"] | (.needs == [{"job": "canary", "artifacts": true}])
   and (.rules[0].when == "always")'
check "autoheal:report: allow_failure (it exits 1 on purpose)" "$C" \
  '.["autoheal:report"].rules[0].allow_failure == true'
check "autoheal:report: runs autoheal_report.py on verdict.json" "$C" \
  '.["autoheal:report"].script | join("\n") | contains("scripts/canary/autoheal_report.py")'
# #32: the script reads DUO_DISPATCH_TOKEN from the environment; the job never echoes it, passes it
# as an argument or turns on shell tracing.
check "autoheal:report: still runs autoheal_report.py and never echoes or passes the token" "$C" \
  '.["autoheal:report"] | ([.before_script, .script, .after_script] | map(. // []) | add | join("\n")) as $s
   | ($s | contains("python3 scripts/canary/autoheal_report.py"))
     and ($s | test("DUO_DISPATCH_TOKEN") | not) and ($s | test("set +-[a-z]*x") | not)
     and (.variables // {} | has("DUO_DISPATCH_TOKEN") | not)'
check "release:config-tests runs this test" "$R" \
  '.["release:config-tests"].script | join("\n") | contains(".gitlab/ci/tests/autoheal-ci.test.sh")'

# The report line is what the postmortem flow parses (flows.test.sh checks the flow uses it).
out="$(cd "$TMP" && python3 "$ROOT/scripts/canary/autoheal_report.py" --verdict missing.json --no-mr-update 2>/dev/null)"
code=$?
if [ "$code" -eq 1 ] && printf '%s\n' "$out" | grep -q '^AUTOHEAL_VERDICT_JSON: {"decision":"NONE"'; then
  ok "autoheal_report.py prints the marker line and exits 1"
else
  bad "autoheal_report.py prints the marker line and exits 1" "exit $code: $out"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
