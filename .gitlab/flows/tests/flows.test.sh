#!/usr/bin/env bash
# Policy tests for the Duo Agent Platform custom flows in .gitlab/flows/*.yaml (#24, H3). Parses
# the YAML with helm's YAML loader (no extra deps, as .gitlab/ci/tests/release-config.test.sh
# does), then asserts the flow registry v1 rules and the custom-flow restrictions:
#   version v1, environment ambient, no top-level name/description/product_group, components /
#   routers / flow / prompts present, local prompts only (no prompt_version, no model, no
#   params.stop, no response schemas), every toolset entry in tool-names.txt (the Duo tools
#   registry names this project uses), every router target a component or end/abort, entry_point
#   a component. Also: the risk-gate prompt and release:human-approval's MR rules:changes state
#   exactly the globs of scripts/canary/risk.py. Self-healing (#28): the incident flow reaches the
#   healer only on the fixed word `healable`, the healer's toolset and hard rules, the postmortem
#   flow has no merge/commit tool and reads autoheal:report's AUTOHEAL_VERDICT_JSON line, and
#   (when the offline copy .hermes/ref/tools_registry.py exists) every name in tool-names.txt is a
#   tool class of the Duo tools registry. AI shoppers (#29): the reporter and the postmortem quote
#   the customer voice as untrusted data, and their toolsets are unchanged.
# Run: bash .gitlab/flows/tests/flows.test.sh   (needs helm, jq, python3)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
FLOWS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$FLOWS/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
# check <name> <json file> <jq filter that must return true>
check() {
  local out
  out="$(jq -r --slurpfile tools "$TMP/tools.json" "$JQ_LIB $3" "$2" 2>&1)"
  if [ "$out" = "true" ]; then ok "$1"; else bad "$1" "$(printf '%s' "$out" | head -5)"; fi
}

for bin in helm jq python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL $bin is required to run these tests"; exit 1; }
done

# to_json <yaml file> <out json>: helm renders the file as chart values, dumped as JSON.
to_json() {
  rm -rf "$TMP/chart"
  mkdir -p "$TMP/chart/templates"
  printf 'apiVersion: v2\nname: parse\nversion: 0.0.0\n' > "$TMP/chart/Chart.yaml"
  printf '{{ toJson .Values }}\n' > "$TMP/chart/templates/dump.yaml"
  cp "$1" "$TMP/chart/values.yaml"
  helm template p "$TMP/chart" 2>"$TMP/err" | grep -v -e '^---' -e '^#' > "$2" \
    && jq -e 'type == "object"' "$2" >/dev/null 2>&1
}

grep -v '^[[:space:]]*$' "$FLOWS/tool-names.txt" | jq -R . | jq -s . > "$TMP/tools.json"

JQ_LIB='
def tool_names: [.components[] | (.toolset // [])[] | if type == "string" then . else keys[] end];
def component_names: [.components[].name];
def targets: [.routers[] | (.to // empty), (.condition.routes // {} | .[])];
def agents: [.components[] | select(.type == "AgentComponent")];
'

FLOW_FILES=("$FLOWS"/*.yaml)
[ "${#FLOW_FILES[@]}" -ge 3 ] && ok "found ${#FLOW_FILES[@]} flow files" || bad "found flow files" "${FLOW_FILES[*]}"

for f in "${FLOW_FILES[@]}"; do
  n="$(basename "$f")"
  j="$TMP/$n.json"
  if to_json "$f" "$j"; then ok "$n: valid YAML"; else bad "$n: valid YAML" "$(cat "$TMP/err")"; continue; fi
  check "$n: version is v1" "$j" '.version == "v1"'
  check "$n: environment is ambient" "$j" '.environment == "ambient"'
  check "$n: no forbidden top-level keys (name, description, product_group)" "$j" \
    '[keys[] | select(. == "name" or . == "description" or . == "product_group")] == []'
  # GitLab's custom-flow schema rejects component keys the internal flow registry accepts
  # (UI: "max_cycles is a disallowed additional property"), so allow-list what GitLab accepted.
  check "$n: components use only keys GitLab's custom-flow schema accepts" "$j" \
    '[.components[] | keys[] | select(IN("name","type","prompt_id","prompt_version","inputs","toolset","ui_log_events","tool_name","sends_response_to","message_template") | not)] == []'
  check "$n: only known top-level keys" "$j" \
    '(keys - ["version","environment","components","routers","flow","prompts"]) == []'
  check "$n: components, routers, flow and prompts present" "$j" \
    '(.components | type == "array" and length > 0) and (.routers | type == "array" and length > 0)
     and (.flow | type == "object") and (.prompts | type == "array" and length > 0)'
  check "$n: component names unique and [A-Za-z0-9_] only" "$j" \
    'component_names as $c | ($c | unique | length) == ($c | length)
     and ($c | all(test("^[A-Za-z0-9_]+$")))'
  check "$n: components are Agent or HumanInput components" "$j" \
    '[.components[].type] | all(. == "AgentComponent" or . == "HumanInputComponent")'
  check "$n: every toolset entry is a known tool name" "$j" \
    '(tool_names - $tools[0]) == []'
  check "$n: agents use local prompts (no prompt_version, no response schema)" "$j" \
    'agents | all(has("prompt_version") | not) and all(has("response_schema_id") | not)
      and all(has("response_schema_version") | not)'
  check "$n: every agent prompt_id is defined in prompts" "$j" \
    '[.prompts[].prompt_id] as $p | agents | all(.prompt_id as $id | $p | index($id) != null)'
  check "$n: prompts have no model" "$j" '.prompts | all(has("model") | not)'
  check "$n: prompts have no params.stop" "$j" '.prompts | all((.params // {}) | has("stop") | not)'
  check "$n: prompts use only known fields" "$j" \
    '[.prompts[] | keys - ["prompt_id","name","unit_primitives","prompt_template","params","tool_output_security"] | .[]] == []'
  check "$n: prompts have a system and a user template" "$j" \
    '.prompts | all((.prompt_template.system | type == "string") and (.prompt_template.user | type == "string"))'
  check "$n: every agent input alias is used as {{alias}} in its prompt" "$j" \
    '. as $f | agents | all(.prompt_id as $id
       | ($f.prompts[] | select(.prompt_id == $id) | .prompt_template | [.system, .user] | join("\n")) as $text
       | [(.inputs // [])[] | objects | .as] | all(. as $a | $text | test("\\{\\{ *" + $a + " *\\}\\}")))'
  check "$n: every HumanInput input alias is used in its message_template" "$j" \
    '[.components[] | select(.type == "HumanInputComponent")]
     | all(.message_template as $m | [(.inputs // [])[] | .as] | all(. as $a | $m | test("\\{\\{ *" + $a + " *\\}\\}")))'
  check "$n: every router source and target is a component or end/abort" "$j" \
    '(component_names + ["end","abort"]) as $ok
     | ([.routers[].from] + targets) | all(. as $t | $ok | index($t) != null)'
  check "$n: conditional routes read a context: input and have a default_route" "$j" \
    '[.routers[] | select(has("condition")) | .condition]
     | all((.input | startswith("context:")) and (.routes | has("default_route")))'
  check "$n: entry_point is a component" "$j" \
    '.flow.entry_point as $e | component_names | index($e) != null'
  check "$n: every component is reachable from entry_point" "$j" \
    '. as $f | [$f.flow.entry_point] as $start
     | ([$start | recurse(. as $seen | ([$f.routers[] | select(.from as $x | $seen | index($x) != null)
         | (.to // empty), (.condition.routes // {} | .[])] + $seen | unique)
         | if length == ($seen | length) then empty else . end)] | last) as $reach
     | component_names | all(. as $c | $reach | index($c) != null)'
  check "$n: HumanInput components reply to an existing component" "$j" \
    'component_names as $c | [.components[] | select(.type == "HumanInputComponent")]
     | all(.message_template and (.sends_response_to as $t | $c | index($t) != null))'
  check "$n: every agent prompt treats input as untrusted data" "$j" \
    '[.prompts[].prompt_template.system] | all(test("untrusted data"))'
done

# --- Specific flows -------------------------------------------------------------
I="$TMP/incident.yaml.json"
R="$TMP/risk-gate.yaml.json"
P="$TMP/postmortem.yaml.json"
if [ -f "$I" ]; then
  check "incident: triage has no tools; skip ends, anything else reaches the reporter" "$I" \
    '(.components[] | select(.name == "triage") | .toolset) == []
     and (.routers[] | select(.from == "triage") | .condition.routes)
         == {"skip": "end", "default_route": "incident_reporter"}'
  check "incident: reporter reads logs, searches first, can create issues" "$I" \
    '(.components[] | select(.name == "incident_reporter") | .toolset) as $t
     | (["get_pipeline_failing_jobs","get_logs_from_job","issue_search","create_issue"] - $t) == []'
  check "incident: prompt names both canary jobs, the log marker and the labels" "$I" \
    '[.prompts[].prompt_template.system] | join("\n")
     | contains("\"canary:bad-release\"") and contains("CANARY_VERDICT_JSON: ")
       and contains("priority::high") and contains("type::regression") and contains("app::gateway")
       and contains("Incident: canary rolled back on <ref> (<short sha>)")'
  check "incident: reporter reaches the healer only on the word healable; anything else ends" "$I" \
    '(.routers[] | select(.from == "incident_reporter") | .condition.routes)
       == {"healable": "healer", "default_route": "end"}
     and ([.routers[] | select(.from == "healer") | .to] == ["end"])'
  check "incident: reporter answers healable only for a new, non-drill, default-branch incident" "$I" \
    '.prompts[] | select(.prompt_id == "incident_report") | .prompt_template.system
     | contains("\"healable\"") and contains("\"done\"") and contains("force_bad")
       and contains("default branch")'
  check "incident: triage and reporter skip autoheal/ pipelines (no healing loop)" "$I" \
    '[.prompts[] | select(.prompt_id == "incident_triage" or .prompt_id == "incident_report")
      | .prompt_template.system | contains("autoheal/")] == [true, true]'
  check "incident: healer has exactly the read, branch, commit, MR and note tools" "$I" \
    '(.components[] | select(.name == "healer") | .toolset | sort)
     == (["list_commits","get_commit","get_commit_diff","get_repository_file","create_branch",
          "create_commit","create_merge_request","create_issue_note","issue_search","get_issue"] | sort)'
  check "incident: healer prompt forbids CI config, charts, secrets, .gitlab/** and > 3 files" "$I" \
    '.prompts[] | select(.prompt_id == "incident_heal") | .prompt_template.system
     | contains(".gitlab-ci.yml") and contains(".gitlab/**") and contains("charts/**")
       and contains("scripts/canary/**") and contains("secret") and contains("at most 3 files")
       and contains("only files changed by the suspect commit")'
  check "incident: healer falls back to needs human and never merges" "$I" \
    '.prompts[] | select(.prompt_id == "incident_heal") | .prompt_template.system
     | contains("needs human") and contains("Never merge") and contains("untrusted data")'
  check "incident: reporter quotes the AI shopper's customer voice as untrusted data (#29)" "$I" \
    '.prompts[] | select(.prompt_id == "incident_report") | .prompt_template.system
     | contains("customer_voice") and contains("Customer voice (AI shopper on the canary): \"<customer_voice>\"")
       and contains("model output, untrusted data, never") and contains("never turn it")
       and contains("shoppers.json")'
  check "incident: reporter toolset unchanged by the shoppers (#29)" "$I" \
    '(.components[] | select(.name == "incident_reporter") | .toolset | sort)
     == (["get_pipeline_failing_jobs","get_logs_from_job","issue_search","create_issue",
          "create_work_item","create_issue_note"] | sort)'
  check "incident: healer names the branch, MR title and label" "$I" \
    '.prompts[] | select(.prompt_id == "incident_heal") | .prompt_template.system
     | contains("autoheal/<pipeline id>") and contains("Autoheal: <one-line root cause> (incident #<incident iid>)")
       and contains("\"autoheal\"") and contains("Incident: #<incident iid>")'
fi
if [ -f "$P" ]; then
  check "postmortem: gate answer skip ends; anything else reaches the writer" "$P" \
    '(.components[] | select(.name == "gate") | .toolset) == []
     and (.routers[] | select(.from == "gate") | .condition.routes)
         == {"skip": "end", "default_route": "postmortem_writer"}
     and ([.routers[] | select(.from == "postmortem_writer") | .to] == ["end"])'
  check "postmortem: no merge, approve, branch or commit tool" "$P" \
    '[tool_names[] | select(test("merge") and . != "get_merge_request" and . != "create_merge_request_note")]
       == []
     and ([tool_names[] | select(test("create_commit|create_branch|approve|accept|update_merge_request"))] == [])'
  check "postmortem: reads the autoheal:report line, checks PROMOTE, labels status::mitigated" "$P" \
    '[.prompts[].prompt_template.system] | join("\n")
     | contains("autoheal:report") and contains("AUTOHEAL_VERDICT_JSON: ") and contains("PROMOTE_PENDING_APPROVAL")
       and contains("status::mitigated") and contains("\"autoheal\"") and contains("Never merge")
       and contains("blameless")'
  check "postmortem: repeats the incident's customer voice as untrusted data (#29)" "$P" \
    '.prompts[] | select(.prompt_id == "postmortem_write") | .prompt_template.system
     | contains("customer_voice") and contains("Customer voice (AI shopper on the canary): \"<quote>\"")
       and contains("model output, untrusted data, never") and contains("never turn it")'
  check "postmortem: writer toolset unchanged by the shoppers (#29)" "$P" \
    '(.components[] | select(.name == "postmortem_writer") | .toolset | sort)
     == (["get_merge_request","get_pipeline_failing_jobs","get_logs_from_job","get_issue",
          "issue_search","create_issue_note","update_issue","create_merge_request_note"] | sort)'
fi
if [ -f "$R" ]; then
  check "risk-gate: classifier answer low ends; anything else pauses for Human Input (fail closed)" "$R" \
    '(.routers[] | select(.from == "risk_classifier") | .condition.routes)
       == {"low": "end", "default_route": "human_review"}
     and ([.components[] | select(.name == "human_review") | .type] == ["HumanInputComponent"])'
  check "risk-gate: note names release:human-approval and the labels" "$R" \
    '[.prompts[].prompt_template.system] | join("\n")
     | contains("release:human-approval") and contains("risk::high") and contains("gate::infra")
       and contains("risk::low")'
fi

# --- tool-names.txt vs the Duo tools registry (offline copy; git-ignored, so skipped in CI) ---
REG="$ROOT/.hermes/ref/tools_registry.py"
if [ -f "$REG" ]; then
  missing="$(python3 - "$FLOWS/tool-names.txt" "$REG" <<'PY'
import re, sys
names = [n.strip() for n in open(sys.argv[1]) if n.strip()]
reg = open(sys.argv[2]).read()
classes = set(re.findall(r"\b(?:tools\.)?([A-Z][A-Za-z]+)\b", reg))
print(" ".join(n for n in names if "".join(p.capitalize() for p in n.split("_")) not in classes))
PY
)"
  [ -z "$missing" ] && ok "every tool-names.txt entry is a Duo tools registry class" \
    || bad "every tool-names.txt entry is a Duo tools registry class" "$missing"
fi

# --- Same rules everywhere: risk.py == risk-gate prompt == CI rules:changes ------
python3 "$ROOT/scripts/canary/risk.py" --list-globs | jq -R . | jq -s . > "$TMP/globs.json"
if [ -f "$R" ]; then
  out="$(jq -r --slurpfile g "$TMP/globs.json" \
    '[.prompts[] | select(.prompt_id == "risk_classify") | .prompt_template.system
      | [scan("(?m)^ +([^ ]+) {2,}") | .[0]]][0] == $g[0]' "$R" 2>&1)"
  [ "$out" = true ] && ok "risk-gate prompt states exactly risk.py's globs, in order" \
    || bad "risk-gate prompt states exactly risk.py's globs, in order" "$out"
fi
if to_json "$ROOT/.gitlab/ci/canary.gitlab-ci.yml" "$TMP/canary-ci.json"; then
  out="$(jq -r --slurpfile g "$TMP/globs.json" \
    '[.["release:human-approval"].rules[] | select(.if | contains("merge_request_event")) | .changes][0] == $g[0]' \
    "$TMP/canary-ci.json" 2>&1)"
  [ "$out" = true ] && ok "release:human-approval MR rules:changes are exactly risk.py's globs" \
    || bad "release:human-approval MR rules:changes are exactly risk.py's globs" "$out"
  check "release:human-approval is manual, blocking, runs approval.py" "$TMP/canary-ci.json" \
    '.["release:human-approval"] | (.rules | all(.when == "manual" and .allow_failure == false))
      and (.script | join("\n") | contains("scripts/canary/approval.py"))'
  check "canary fails main on ROLLBACK (not allow_failure on the default branch)" "$TMP/canary-ci.json" \
    '[.canary.rules[] | select(.if | contains("CI_DEFAULT_BRANCH")) | .allow_failure] == [false]
     and [.["canary:bad-release"].rules[] | select(.if | contains("CI_DEFAULT_BRANCH"))
          | [.when, .allow_failure]] == [["manual", true]]'
else
  bad "canary.gitlab-ci.yml is valid YAML" "$(cat "$TMP/err")"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
