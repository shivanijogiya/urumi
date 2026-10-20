#!/usr/bin/env bash
# Policy tests for .gitlab/ci/release.gitlab-ci.yml and its wiring in the root .gitlab-ci.yml
# (issue #22). Parses the YAML with helm's YAML loader (no extra deps), resolves `extends`
# with jq, then asserts the security/integration rules from the issue.
# Run: bash .gitlab/ci/tests/release-config.test.sh   (needs helm, jq)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CI_FILE="$HERE/../release.gitlab-ci.yml"
ROOT_CI_FILE="$ROOT/.gitlab-ci.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
# check <name> <jq filter that must return true>; `.`/$ci is the release file, $root the root file.
check() {
  local out
  out="$(jq -r --slurpfile r "$TMP/root.json" "$JQ_LIB . as \$ci | \$r[0] as \$root | $2" "$TMP/ci.json" 2>&1)"
  if [ "$out" = "true" ]; then ok "$1"; else bad "$1" "$(printf '%s' "$out" | head -5)"; fi
}

for bin in helm jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL $bin is required to run these tests"; exit 1; }
done

# --- 1. YAML parses -------------------------------------------------------
# to_json <yaml file> <out json>: helm renders the file as chart values, dumped as JSON.
to_json() {
  rm -rf "$TMP/chart"
  mkdir -p "$TMP/chart/templates"
  printf 'apiVersion: v2\nname: parse\nversion: 0.0.0\n' > "$TMP/chart/Chart.yaml"
  printf '{{ toJson .Values }}\n' > "$TMP/chart/templates/dump.yaml"
  cp "$1" "$TMP/chart/values.yaml"
  # No --show-only: helm v4 errors on it after rendering; the chart has one template anyway.
  helm template p "$TMP/chart" 2>"$TMP/err" | grep -v -e '^---' -e '^#' > "$2" \
    && jq -e 'type == "object"' "$2" >/dev/null 2>&1
}
for pair in "$CI_FILE:ci.json" "$ROOT_CI_FILE:root.json"; do
  f="${pair%%:*}"
  if [ -f "$f" ] && to_json "$f" "$TMP/${pair##*:}"; then
    ok "$(basename "$f") is valid YAML"
  else
    bad "$(basename "$f") is valid YAML" "$(cat "$TMP/err" 2>/dev/null)"
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
  fi
done

# Apps with a Dockerfile in the repo: each must get an image + scan job.
APPS_JSON="$(cd "$ROOT/apps" && for d in */Dockerfile; do printf '%s\n' "${d%/Dockerfile}"; done | jq -R . | jq -sc 'sort')"

# jq helpers: resolve GitLab `extends` (deep-merge hashes, replace arrays).
JQ_LIB='
def resolved($n): . as $root
  | ([$root[$n].extends // []] | flatten | map(. as $p | $root | resolved($p)) | add // {}) * ($root[$n] | del(.extends));
def jobs: [keys[] | select(startswith(".") | not) | select(. != "include" and . != "container_scanning")];
def job($n): resolved($n);
def ifs($n): [job($n).rules[] | select((.when // "on_success") != "never") | .if // "<always>"];
def scripts($n): [job($n) | (.before_script // []), (.script // [])] | flatten | join("\n");
def matrix_apps($n): [job($n).parallel.matrix[].RELEASE_APP] | flatten | sort;
def publish_jobs: ["release:image:publish", "release:chart:publish"];
def build_jobs: ["release:image:build", "release:chart:package"];
'

check "hidden GitLab templates are mappings" '[to_entries[] | select(.key | startswith(".")) | select(.value | type != "object")] == []'

# --- 2. Shape -----------------------------------------------------------------
check "expected release jobs exist" \
  '(["release:preflight","release:config-tests","release:image:build","release:image:publish",
     "release:container-scanning","release:chart:package","release:chart:publish"] - jobs) == []'
check "only release-namespaced keys plus scanner include at top level" \
  '[keys[] | select((startswith(".release") or startswith("release:") or . == "include" or . == "container_scanning") | not)] == []'
check "Secret Detection, SAST and IaC are not duplicated here (root file owns them)" \
  '[jobs[] | select(test("secret|sast|iac|dependency"; "i"))] == []'
check "image build, publish and scan jobs cover exactly the apps with a Dockerfile ($APPS_JSON)" \
  "[\"release:image:build\",\"release:image:publish\",\"release:container-scanning\"] | map(. as \$j | \$ci | matrix_apps(\$j)) | all(. == $APPS_JSON)"

# --- 3. Wiring in the root .gitlab-ci.yml -------------------------------------
check "root .gitlab-ci.yml includes the release file" \
  '[$root.include[] | select(.local == ".gitlab/ci/release.gitlab-ci.yml")] | length == 1'
check "root still includes Secret Detection, SAST and IaC templates" \
  '(["Jobs/Secret-Detection.gitlab-ci.yml","Jobs/SAST.gitlab-ci.yml","Jobs/SAST-IaC.gitlab-ci.yml"] - [$root.include[].template // empty]) == []'
check "existing root jobs keep their stages" \
  '[$root.lint.stage, $root.test.stage, $root.secret_detection.stage, $root["semgrep-sast"].stage, $root["kics-iac-sast"].stage]
    == ["lint","test","secure","secure","secure"]'
check "every release job stage is declared in root stages" \
  '[jobs[] as $j | job($j).stage | select(. as $s | $root.stages | index($s) == null)] == []'
check "stage order: lint < test < build < secure < release" \
  '[("lint","test","build","secure","release") as $s | $root.stages | index($s)] | (all(. != null)) and (. == sort)'
check "workflow allows MR, default-branch and tag pipelines" \
  '[$root.workflow.rules[] | select((.when // "always") != "never") | .if]
    | (index("$CI_PIPELINE_SOURCE == \"merge_request_event\"") != null)
      and (index("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH") != null)
      and (index("$CI_COMMIT_TAG") != null)'
check "release jobs do not inherit the root npm cache" \
  '[jobs[] as $j | select(job($j).cache != []) | $j] == []'

# --- 4. Images: pinned, no dind/privileged ---------------------------------
check "every non-template job has a pinned image (explicit version, never latest)" \
  '[jobs[] as $j | select($j != "release:container-scanning") | (job($j).image | if type == "object" then .name else . end) // "<none>"
    | select(test(":(v?[0-9]+\\.[0-9]+[0-9A-Za-z.\\-]*)(@sha256:[0-9a-f]{64})?$") | not)] == []'
check "no latest tag anywhere in images" \
  '[jobs[] as $j | job($j).image | tostring | select(test("latest"))] == []'
check "no services (no Docker-in-Docker)" '[jobs[] as $j | job($j).services // empty] == []'
check "no docker:* images" '[jobs[] as $j | job($j).image | tostring | select(test("(^|\")docker:"))] == []'
check "images built with repo root context and apps/<app>/Dockerfile (like scripts/build-images.sh)" \
  '["release:image:build","release:image:publish"] | map(. as $j | $ci | scripts($j)
    | contains("--local context=.") and contains("--local dockerfile=\"apps/$RELEASE_APP\"") and contains("--opt filename=Dockerfile"))
    | all'

# --- 5. Build vs publish conditions -----------------------------------------
check "publish jobs run only on protected default branch or protected semver tag" \
  '([publish_jobs[] as $j | ifs($j) | length] | all(. > 0)) and
   ([publish_jobs[] as $j | ifs($j)[]
     | select((contains("$CI_COMMIT_REF_PROTECTED == \"true\"")
               and (contains("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH") or contains("$CI_COMMIT_TAG =~"))) | not)] == [])'
check "publish jobs never run on merge_request_event" \
  '[publish_jobs[] as $j | ifs($j)[] | select(contains("merge_request_event"))] == []'
check "build jobs run only on merge request pipelines" \
  '([build_jobs[] as $j | ifs($j) | length] | all(. > 0)) and
   ([build_jobs[] as $j | ifs($j)[] | select(startswith("$CI_PIPELINE_SOURCE == \"merge_request_event\"") | not)] == [])'
check "build jobs never push or log in" \
  '[build_jobs[] as $j | scripts($j) | select(test("push=true|helm push|registry login|CI_REGISTRY_PASSWORD|docker/config"))] == []'
check "MR image builds export nothing (no --output, no artifacts)" \
  '(scripts("release:image:build") | contains("--output") | not) and (job("release:image:build") | has("artifacts") | not)'
check "published image tags: <short sha>, plus X.Y.Z from a vX.Y.Z tag" \
  'scripts("release:image:publish")
    | contains("$CI_REGISTRY_IMAGE/$RELEASE_APP:$CI_COMMIT_SHORT_SHA")
      and contains("$CI_REGISTRY_IMAGE/$RELEASE_APP:${CI_COMMIT_TAG#v}") and contains("push=true")'
check "publish scripts re-check protected ref before pushing (defence in depth)" \
  '[publish_jobs[] as $j | scripts($j) | select(contains("CI_COMMIT_REF_PROTECTED") | not)] == []'
check "publish jobs are not interruptible (no half-pushed releases)" \
  '[publish_jobs[] as $j | job($j).interruptible | select(. != false)] == []'
check "images publish in build; chart publishes in release (after scans), no needs shortcut" \
  '(job("release:image:publish").stage == "build")
    and (job("release:chart:publish") | .stage == "release" and (has("needs") | not))'

# --- 6. Tag preflight ----------------------------------------------------------
check "preflight runs on every tag pipeline (and only there)" \
  'ifs("release:preflight") == ["$CI_COMMIT_TAG"]'
check "preflight fails unprotected tags and validates the version" \
  'scripts("release:preflight") | contains("CI_COMMIT_REF_PROTECTED") and contains("exit 1") and contains("chart-version.sh")'

# --- 7. Container scanning --------------------------------------------------
check "GitLab Container Scanning template is included" \
  '[.include[] | select(.template == "Jobs/Container-Scanning.gitlab-ci.yml")] | length == 1'
check "default scanner job is disabled; the matrix job is used" \
  '.container_scanning.rules == [{"when":"never"}]'
check "container scan extends the template job, scans the pushed image, blocks the release" \
  '(.["release:container-scanning"].extends | index("container_scanning") != null)
    and (job("release:container-scanning") | .stage == "secure" and .allow_failure == false
         and .variables.CS_IMAGE == "$CI_REGISTRY_IMAGE/$RELEASE_APP:$CI_COMMIT_SHORT_SHA")'
check "container scan runs only on protected default branch / tag pipelines" \
  'ifs("release:container-scanning") as $s | ($s | length == 2) and ([$s[] | select(contains("CI_COMMIT_REF_PROTECTED == \"true\"") | not)] == [])'

# --- 8. Chart -------------------------------------------------------------------
check "chart jobs use the tested packaging helper (version, lint both values files, package)" \
  '["release:chart:package","release:chart:publish"] | map(. as $j | $ci | scripts($j) | contains("chart-package.sh charts/platform dist")) | all'
check "chart pushed as OCI under \$CI_REGISTRY_IMAGE/charts" \
  'scripts("release:chart:publish") | contains("helm push \"$CHART_PACKAGE\" \"oci://$CI_REGISTRY_IMAGE/charts\"")'
check "released chart versions are never overwritten" \
  'scripts("release:chart:publish") | contains("helm show chart") and contains("refusing to overwrite") and contains("not found")'
check "MR chart package is kept as an artifact" \
  'job("release:chart:package").artifacts.paths == ["dist/"]'

# --- 9. These tests run in CI ---------------------------------------------------
TESTS_JSON="$(cd "$HERE" && ls *.test.sh | jq -R . | jq -sc 'sort')"
check "release:config-tests runs every .gitlab/ci/tests/*.test.sh in the lint stage" \
  "(job(\"release:config-tests\").stage == \"lint\")
    and ([job(\"release:config-tests\").script[] | capture(\"bash .gitlab/ci/tests/(?<t>[^ ]+)\").t] | sort == $TESTS_JSON)"

# --- 10. Secret hygiene (raw text) ---------------------------------------------
if grep -nE 'set -x|set -o xtrace' "$CI_FILE" >/dev/null; then bad "no shell tracing (would leak credentials)"; else ok "no shell tracing (would leak credentials)"; fi
LEAKS="$(grep -nE 'CI_REGISTRY_PASSWORD|CI_JOB_TOKEN' "$CI_FILE" | grep -vE 'password-stdin|base64|CS_REGISTRY_PASSWORD' || true)"
if [ -z "$LEAKS" ]; then ok "registry credentials only used for BuildKit, helm and scanner auth"; else bad "registry credentials only used for BuildKit, helm and scanner auth" "$LEAKS"; fi
if grep -nE '^[[:space:]]*-?[[:space:]]*(echo|printf)[^|]*\$\{?CI_REGISTRY_PASSWORD' "$CI_FILE" | grep -v '|' >/dev/null; then
  bad "credentials never echoed to job log"
else
  ok "credentials never echoed to job log"
fi
if grep -nE ':latest|"latest"' "$CI_FILE" >/dev/null; then bad "no mutable latest tag pushed"; else ok "no mutable latest tag pushed"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
