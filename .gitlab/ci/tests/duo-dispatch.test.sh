#!/usr/bin/env bash
# Policy test for the Duo flow dispatch jobs in .gitlab/ci/duo-dispatch.gitlab-ci.yml (#27,
# docs/adr/007-duo-dispatch.md):
#   - the root .gitlab-ci.yml includes the file
#   - duo:risk-gate runs on every MR pipeline and only there, first (stage .pre, needs []), and
#     runs `dispatch.py risk-gate "$CI_MERGE_REQUEST_IID"`
#   - duo:incident runs only on default-branch (non-MR) pipelines, `when: on_failure`, and needs
#     `canary` with its artifacts; duo:incident:bad-release does the same for `canary:bad-release`
#     (`when: always`, since an allowed failure does not trigger on_failure); both run
#     `dispatch.py incident --record verdict.json`
#   - duo:postmortem (#33) runs only on autoheal/ MR pipelines, after autoheal:report wrote the
#     verdict block (needs autoheal:report and canary with its artifacts, `when: always`, since
#     autoheal:report always fails on purpose), and runs
#     `dispatch.py postmortem "$CI_MERGE_REQUEST_IID" --record verdict.json`
#   - duo:release-close (#34) runs only on default-branch (non-MR) pipelines, needs `canary` with
#     its artifacts, `when: on_success`, and runs `dispatch.py release-close --record verdict.json`
#   - the canary jobs keep `verdict.json` as an artifact even when they fail
#   - every dispatch job is allow_failure, small (python:3.12-alpine) and times out in 2 minutes
#   - DUO_DISPATCH_TOKEN is never named in a job script (read from the environment by
#     dispatch.py only), no shell tracing, no echo of a token
#   - dispatch.py without the token prints one line and exits 0; its unit tests pass
#   - release:config-tests runs this test
# Run: bash .gitlab/ci/tests/duo-dispatch.test.sh   (needs helm, jq, python3)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CI_FILE="$ROOT/.gitlab/ci/duo-dispatch.gitlab-ci.yml"
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

for bin in helm jq python3; do
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

# resolved($n): the job with GitLab `extends` applied (deep-merge hashes, replace arrays).
JQ_LIB='
def resolved($n): . as $root
  | ([$root[$n].extends // []] | flatten | map(. as $p | $root | resolved($p)) | add // {}) * ($root[$n] | del(.extends));
def duo_jobs: ["duo:risk-gate", "duo:incident", "duo:incident:bad-release", "duo:postmortem",
  "duo:release-close"];
def mr_if: . == "$CI_PIPELINE_SOURCE == \"merge_request_event\"";
def main_only_if: contains("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH")
  and contains("$CI_PIPELINE_SOURCE != \"merge_request_event\"");
def autoheal_mr_if: . == "$CI_PIPELINE_SOURCE == \"merge_request_event\" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^autoheal\\//";
'

D="$TMP/duo.json"
C="$TMP/canary.json"
G="$TMP/root.json"
for pair in "$CI_FILE:$D" "$ROOT/.gitlab/ci/canary.gitlab-ci.yml:$C" "$ROOT/.gitlab-ci.yml:$G" \
  "$ROOT/.gitlab/ci/release.gitlab-ci.yml:$TMP/release.json"; do
  f="${pair%%:*}"
  if to_json "$f" "${pair#*:}"; then ok "$(basename "$f") is valid YAML"; else
    bad "$(basename "$f") is valid YAML" "$(cat "$TMP/err")"
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
  fi
done

check "root .gitlab-ci.yml includes duo-dispatch.gitlab-ci.yml" "$G" \
  '[.include[] | select(.local == ".gitlab/ci/duo-dispatch.gitlab-ci.yml")] | length == 1'
check "only the five duo jobs and the hidden template" "$D" \
  '(keys | sort) == ([".duo-dispatch"] + duo_jobs | sort)'
out="$(jq -r --slurpfile r "$G" "$JQ_LIB"' [duo_jobs[] as $j | .[$j]]
  | all(.stage as $s | $s == ".pre" or ($r[0].stages | index($s) != null))' "$D" 2>&1)"
[ "$out" = true ] && ok "every duo job stage is .pre or a root stage" \
  || bad "every duo job stage is .pre or a root stage" "$out"
check "every duo job: python:3.12-alpine, 2m timeout, no cache" "$D" \
  '. as $f | duo_jobs | all(. as $j | $f | resolved($j)
     | .image == "python:3.12-alpine" and .timeout == "2m" and .cache == [])'
check "every duo job rule is allow_failure" "$D" \
  '. as $f | duo_jobs | all(. as $j | $f | resolved($j) | (.rules | length > 0) and (.rules | all(.allow_failure == true)))'

# risk gate: every MR pipeline, first, nothing else
check "duo:risk-gate: one rule, MR pipelines only, runs automatically" "$D" \
  '.["duo:risk-gate"].rules as $r | ($r | length) == 1 and ($r[0].if | mr_if)
   and (($r[0].when // "on_success") == "on_success")'
check "duo:risk-gate: runs first (stage .pre, needs [])" "$D" \
  '.["duo:risk-gate"] | .stage == ".pre" and .needs == []'
check "duo:risk-gate: requests review for this MR via dispatch.py" "$D" \
  '.["duo:risk-gate"].script == ["python3 scripts/duo/dispatch.py risk-gate \"$CI_MERGE_REQUEST_IID\""]'

# incident: default branch, after a failed canary, with the verdict artifact
check "duo:incident: one rule, default branch only (never MR), when on_failure" "$D" \
  '.["duo:incident"].rules as $r | ($r | length) == 1 and ($r[0].if | main_only_if)
   and $r[0].when == "on_failure"'
check "duo:incident: needs canary with artifacts, in canary's stage" "$D" \
  '.["duo:incident"] | .needs == [{"job": "canary", "artifacts": true}] and .stage == "deploy"'
check "duo:incident:bad-release: default branch only, needs canary:bad-release with artifacts" "$D" \
  '.["duo:incident:bad-release"] | (.rules | length == 1 and (.[0].if | main_only_if))
   and .needs == [{"job": "canary:bad-release", "artifacts": true}] and .stage == "deploy"'
check "duo:incident:bad-release: when always (allowed failures do not trigger on_failure)" "$D" \
  '.["duo:incident:bad-release"].rules[0].when == "always"'
check "both incident jobs run dispatch.py incident on verdict.json" "$D" \
  '[.["duo:incident"].script, .["duo:incident:bad-release"].script]
   == [["python3 scripts/duo/dispatch.py incident --record verdict.json"],
       ["python3 scripts/duo/dispatch.py incident --record verdict.json"]]'

# postmortem (#33): autoheal MR pipelines, after autoheal:report wrote the verdict block
check "duo:postmortem: one rule, autoheal/ MR pipelines only, when always" "$D" \
  '.["duo:postmortem"].rules as $r | ($r | length) == 1 and ($r[0].if | autoheal_mr_if)
   and $r[0].when == "always"'
check "duo:postmortem: needs autoheal:report and canary with artifacts, in their stage" "$D" \
  '.["duo:postmortem"] | .stage == "deploy"
   and ([.needs[] | if type == "string" then {"job": .} else . end | .job] | sort) == ["autoheal:report", "canary"]
   and ([.needs[] | objects | select(.job == "canary") | .artifacts] == [true])'
check "duo:postmortem: autoheal:report has the same autoheal/ MR rule (so the need exists)" "$C" \
  '.["autoheal:report"].rules | length == 1 and (.[0].if | autoheal_mr_if) and .[0].when == "always"'
check "duo:postmortem: runs dispatch.py postmortem for this MR on verdict.json" "$D" \
  '.["duo:postmortem"].script
   == ["python3 scripts/duo/dispatch.py postmortem \"$CI_MERGE_REQUEST_IID\" --record verdict.json"]'

# release-close (#34): default branch, after main's canary passed
check "duo:release-close: one rule, default branch only (never MR), when on_success" "$D" \
  '.["duo:release-close"].rules as $r | ($r | length) == 1 and ($r[0].if | main_only_if)
   and $r[0].when == "on_success"'
check "duo:release-close: needs canary with artifacts, in canary's stage" "$D" \
  '.["duo:release-close"] | .needs == [{"job": "canary", "artifacts": true}] and .stage == "deploy"'
check "duo:release-close: runs dispatch.py release-close on verdict.json" "$D" \
  '.["duo:release-close"].script == ["python3 scripts/duo/dispatch.py release-close --record verdict.json"]'

check "canary jobs keep verdict.json as an artifact when they fail" "$C" \
  '.canary.artifacts | .when == "always" and (.paths | index("verdict.json") != null)'
check "canary:bad-release inherits canary's artifacts" "$C" \
  '.["canary:bad-release"] | .extends == "canary" and (has("artifacts") | not)'
check "canary and canary:bad-release are deploy-stage jobs (the incident jobs need them)" "$C" \
  '.canary.stage == "deploy" and ((.["canary:bad-release"].stage // .canary.stage) == "deploy")'
check "release:config-tests runs this test" "$TMP/release.json" \
  '.["release:config-tests"].script | join("\n") | contains(".gitlab/ci/tests/duo-dispatch.test.sh")'

# --- secret hygiene (raw text) ---------------------------------------------------------------
SCRIPT_LINES="$(jq -r "$JQ_LIB"' . as $f | duo_jobs[]
  | . as $j | $f[$j] | (.before_script // []), .script, (.after_script // []) | .[]' "$D")"
if printf '%s\n' "$SCRIPT_LINES" | grep -q 'DUO_DISPATCH_TOKEN'; then
  bad "no job script names DUO_DISPATCH_TOKEN (dispatch.py reads it from the environment)"
else
  ok "no job script names DUO_DISPATCH_TOKEN (dispatch.py reads it from the environment)"
fi
if grep -nE 'set -x|set -o xtrace|(echo|printf).*(TOKEN|PRIVATE)' "$CI_FILE" >/dev/null; then
  bad "no shell tracing and no echo of a token in duo-dispatch.gitlab-ci.yml"
else
  ok "no shell tracing and no echo of a token in duo-dispatch.gitlab-ci.yml"
fi
if grep -nE 'print\(.*(token|_token|PRIVATE)' "$ROOT/scripts/duo/dispatch.py" >/dev/null; then
  bad "dispatch.py never prints the token" "$(grep -nE 'print\(.*(token|_token|PRIVATE)' "$ROOT/scripts/duo/dispatch.py")"
else
  ok "dispatch.py never prints the token"
fi

# --- dispatch.py behaviour --------------------------------------------------------------------
for args in "risk-gate 1" "postmortem 1 --record verdict.json" "release-close --record verdict.json"; do
  # shellcheck disable=SC2086 # word splitting of $args is intended
  out="$(env -u DUO_DISPATCH_TOKEN python3 "$ROOT/scripts/duo/dispatch.py" $args 2>&1)"
  code=$?
  if [ "$code" -eq 0 ] && [ "$out" = "DUO_DISPATCH_TOKEN not set; skipping Duo dispatch" ]; then
    ok "dispatch.py ${args%% *} without DUO_DISPATCH_TOKEN prints one line and exits 0"
  else
    bad "dispatch.py ${args%% *} without DUO_DISPATCH_TOKEN prints one line and exits 0" "exit $code: $out"
  fi
done
if out="$(python3 -m unittest discover -s "$ROOT/scripts/duo" -p 'test_*.py' 2>&1)"; then
  ok "scripts/duo unit tests pass ($(printf '%s\n' "$out" | grep -E '^Ran ' || true))"
else
  bad "scripts/duo unit tests pass" "$(printf '%s\n' "$out" | tail -15)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
