#!/usr/bin/env bash
# Policy tests for .gitlab/ci/release.gitlab-ci.yml (issue #22).
# Parses the YAML with helm's YAML loader (no extra deps), resolves `extends`
# with jq, then asserts the security/integration rules from the issue.
# Run: bash .gitlab/ci/tests/release-config.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CI_FILE="$HERE/../release.gitlab-ci.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
check() { # name jq-filter-that-must-return-true
  if [ "$(jq -r "$JQ_LIB $2" "$TMP/ci.json" 2>&1)" = "true" ]; then ok "$1"; else bad "$1" "$(jq -r "$JQ_LIB $2" "$TMP/ci.json" 2>&1 | head -5)"; fi
}

for bin in helm jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL $bin is required to run these tests"; exit 1; }
done

if [ ! -f "$CI_FILE" ]; then
  echo "FAIL $CI_FILE does not exist"
  printf '\n0 passed, 1 failed\n'
  exit 1
fi

# --- 1. YAML parses -------------------------------------------------------
mkdir -p "$TMP/chart/templates"
printf 'apiVersion: v2\nname: parse\nversion: 0.0.0\n' > "$TMP/chart/Chart.yaml"
printf '{{ toJson .Values }}\n' > "$TMP/chart/templates/dump.yaml"
cp "$CI_FILE" "$TMP/chart/values.yaml"
# No --show-only: helm v4 errors on it after rendering; the chart has one template anyway.
if helm template p "$TMP/chart" 2>"$TMP/err" | grep -v -e '^---' -e '^#' > "$TMP/ci.json" \
   && jq -e 'type == "object"' "$TMP/ci.json" >/dev/null 2>&1; then
  ok "release.gitlab-ci.yml is valid YAML"
else
  bad "release.gitlab-ci.yml is valid YAML" "$(cat "$TMP/err")"
  printf '\n%d passed, %d failed\n' "$pass" "$fail"
  exit 1
fi

# jq helpers: resolve GitLab `extends` (deep-merge hashes, replace arrays).
JQ_LIB='
def resolved($n): . as $root
  | ([$root[$n].extends // []] | flatten | map(. as $p | $root | resolved($p)) | add // {}) * ($root[$n] | del(.extends));
def jobs: [keys[] | select(startswith(".") | not)];
def job($n): resolved($n);
def ifs($n): [job($n).rules[] | select((.when // "on_success") != "never") | .if // "<always>"];
def scripts($n): [job($n) | (.before_script // []), (.script // [])] | flatten | join("\n");
'

APPS="woo-mcp gateway dashboard"
EXPECTED='["release:preflight","release:chart:package","release:chart:publish"'
for a in $APPS; do EXPECTED="$EXPECTED,\"release:image:build:$a\",\"release:image:publish:$a\""; done
EXPECTED="$EXPECTED]"

# --- 2. Shape / integration with #2 ---------------------------------------
check "expected release jobs exist" "($EXPECTED - jobs) == []"
check "only release-namespaced keys at top level (no stages/workflow/include/default/variables)" \
  '[keys[] | select((startswith(".release") or startswith("release:")) | not)] == []'
check "jobs use GitLab default stages only (build/test/deploy)" \
  '[jobs[] as $j | job($j).stage | select(. != "build" and . != "test" and . != "deploy")] == []'
check "no scanner jobs (owned by #2)" \
  '[jobs[] | select(test("secret|sast|iac|container_scanning|dependency"; "i"))] == []'

# --- 3. Images: pinned, no dind/privileged ---------------------------------
check "every job has a pinned image (explicit version, never latest)" \
  '[jobs[] as $j | (job($j).image | if type == "object" then .name else . end) // "<none>"
    | select(test(":(v?[0-9]+\\.[0-9]+[0-9A-Za-z.\\-]*)(@sha256:[0-9a-f]{64})?$") | not)] == []'
check "no latest tag anywhere in images" \
  '[jobs[] as $j | job($j).image | tostring | select(test("latest"))] == []'
check "no services (no Docker-in-Docker)" '[jobs[] as $j | job($j).services // empty] == []'
check "no docker:* images" '[jobs[] as $j | job($j).image | tostring | select(test("(^|\")docker:"))] == []'

# --- 4. Build vs publish conditions -----------------------------------------
JQ_LIB="$JQ_LIB
def publish_jobs: [\"release:chart:publish\", (\"$APPS\" | split(\" \")[] | \"release:image:publish:\" + .)];
def build_jobs: [\"release:chart:package\", (\"$APPS\" | split(\" \")[] | \"release:image:build:\" + .)];
"
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
  '[build_jobs[] as $j | scripts($j) | select(test("push=true|helm push|registry login|CI_REGISTRY_PASSWORD"))] == []'
check "publish scripts re-check protected ref before pushing (defence in depth)" \
  '[publish_jobs[] as $j | scripts($j) | select(contains("CI_COMMIT_REF_PROTECTED") | not)] == []'

# --- 5. Dormant until inputs exist -------------------------------------------
for a in $APPS; do
  check "image jobs for $a gated on apps/$a/Dockerfile" \
    "[[\"release:image:build:$a\",\"release:image:publish:$a\"][] as \$j
      | [job(\$j).rules[] | select((.when // \"on_success\") != \"never\") | (.exists // []) | index(\"apps/$a/Dockerfile\")] | all(. != null)] | all"
done
check "chart jobs gated on charts/platform/Chart.yaml" \
  '[["release:chart:package","release:chart:publish"][] as $j
    | [job($j).rules[] | select((.when // "on_success") != "never") | (.exists // []) | index("charts/platform/Chart.yaml")] | all(. != null)] | all'
check "preflight is NOT gated on exists (reports missing inputs loudly)" \
  '[job("release:preflight").rules[] | select(.exists)] == []'
check "preflight fails tag pipelines when inputs are missing" \
  'scripts("release:preflight") | test("CI_COMMIT_TAG") and test("exit 1")'
check "chart publish runs after image publish and #2 scanners (deploy stage, no needs shortcut)" \
  '(job("release:chart:publish") | .stage == "deploy" and (has("needs") | not))
    and ([publish_jobs[] | select(startswith("release:image:"))] as $pj | [$pj[] as $j | job($j).stage] | all(. == "build"))'
check "publish jobs are not interruptible (no half-pushed releases)" \
  '[publish_jobs[] as $j | job($j).interruptible | select(. == true)] == []'

# --- 6. Registry conventions + secret hygiene (raw text) ---------------------
check "images pushed under \$CI_REGISTRY_IMAGE" \
  '[scripts("release:image:publish:gateway")] | .[0] | test("\\$CI_REGISTRY_IMAGE/")'
check "chart pushed as OCI under \$CI_REGISTRY_IMAGE/charts" \
  'scripts("release:chart:publish") | test("oci://\\$CI_REGISTRY_IMAGE/charts")'
check "chart version comes from the tested helper" \
  'scripts("release:chart:publish") | test("chart-version.sh")'

if grep -nE 'set -x|set -o xtrace' "$CI_FILE" >/dev/null; then bad "no shell tracing (would leak credentials)"; else ok "no shell tracing (would leak credentials)"; fi
LEAKS="$(grep -nE 'CI_REGISTRY_PASSWORD|CI_JOB_TOKEN' "$CI_FILE" | grep -vE 'password-stdin|base64' || true)"
if [ -z "$LEAKS" ]; then ok "registry credentials only piped to --password-stdin/base64"; else bad "registry credentials only piped to --password-stdin/base64" "$LEAKS"; fi
if grep -nE '^[[:space:]]*-?[[:space:]]*(echo|printf)[^|]*\$\{?CI_REGISTRY_PASSWORD' "$CI_FILE" | grep -v '|' >/dev/null; then
  bad "credentials never echoed to job log"
else
  ok "credentials never echoed to job log"
fi
if grep -nE ':latest|"latest"' "$CI_FILE" >/dev/null; then bad "no mutable latest tag pushed"; else ok "no mutable latest tag pushed"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
