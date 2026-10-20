#!/usr/bin/env bash
# D8: GET /api/audit (as admin, from the run's start) has a row for every tool call the steps made
# (.out/expected-audit.jsonl): User A's chat calls under A with source chat, User B's MCP calls
# under B with source mcp, with the right server, tool and outcome, and durationMs >= 0. No extra
# rows for A or B: in particular the request D5 rejected with 401 left no row (also checked
# against D5's time window).
set -uo pipefail
STEP=${STEP:-D8}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

[ -s "$EXPECT" ] || fail "no tool calls recorded in this run ($EXPECT); run D2..D7 first"

# rows <user-id> <label> : every audit row of that user since RUN_START, labelled, as a JSON array.
rows() {
  local cursor="" all="[]" code query
  while :; do
    query="userId=$1&from=$RUN_START&limit=200"
    [ -n "$cursor" ] && query="$query&cursor=$(jq -rn --arg c "$cursor" '$c | @uri')"
    code=$(api "$ADMIN_JAR" GET "/api/audit?$query")
    [ "$code" = 200 ] || {
      note "GET /api/audit -> HTTP $code: $(err_of)"
      return 1
    }
    all=$(jq -c --argjson all "$all" --arg l "$2" '$all + [.items[] | . + {user: $l}]' "$LAST")
    cursor=$(jq -r '.nextCursor // empty' "$LAST")
    [ -n "$cursor" ] || break
  done
  printf '%s' "$all"
}
rows_a=$(rows "$A_ID" A) || fail "audit query for User A failed"
rows_b=$(rows "$B_ID" B) || fail "audit query for User B failed"

report=$(jq -n --slurpfile exp "$EXPECT" --argjson a "$rows_a" --argjson b "$rows_b" \
  --arg ae "$A_EMAIL" --arg be "$B_EMAIL" '
  def norm: gsub("[^a-zA-Z0-9_-]"; "_");
  ($a + $b) as $rows
  | reduce $exp[] as $e ({rows: $rows, missing: []};
      ([.rows | to_entries[] | select((.value.used | not) and .value.user == $e.user
          and .value.source == $e.source and .value.serverSlug == $e.serverSlug
          and (.value.tool | norm) == $e.tool and .value.outcome == $e.outcome) | .key] | first) as $i
      | if $i == null then .missing += [$e] else .rows[$i].used = true end)
  | {
      expected: ($exp | length),
      rows: ($rows | length),
      missing: .missing,
      extra: [.rows[] | select(.used | not) | {user, source, serverSlug, tool, outcome, startedAt}],
      badDuration: [$rows[] | select((.durationMs | type) != "number" or .durationMs < 0)],
      badEmail: [$rows[] | select((.user == "A" and .userEmail != $ae) or (.user == "B" and .userEmail != $be))],
      badSource: [$rows[] | select((.user == "A" and .source != "chat") or (.user == "B" and .source != "mcp"))]
    }')
note "audit: $(printf '%s' "$report" | jq -c '{expected, rows, missing: (.missing | length), extra: (.extra | length)}')"

problem() { printf '%s' "$report" | jq -c "$1"; }
[ "$(problem '.missing | length')" = 0 ] || fail "audit rows missing for: $(problem '.missing')"
[ "$(problem '.extra | length')" = 0 ] || fail "unexpected audit rows: $(problem '.extra')"
[ "$(problem '.badDuration | length')" = 0 ] || fail "rows with invalid durationMs: $(problem '.badDuration')"
[ "$(problem '.badEmail | length')" = 0 ] || fail "rows with the wrong userEmail: $(problem '.badEmail')"
[ "$(problem '.badSource | length')" = 0 ] || fail "rows with the wrong source: $(problem '.badSource')"

# The request D5 rejected (401) must have no row: nothing of B's inside D5's window.
if [ -f "$E2E_OUT/d5-window" ]; then
  read -r from to <"$E2E_OUT/d5-window"
  in_window=$(printf '%s' "$rows_b" | jq --arg f "$from" --arg t "$to" '
    ($t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 + 1) as $end
    | [.[] | select(.startedAt >= $f and (.startedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $end)] | length')
  [ "$in_window" = 0 ] || fail "$in_window audit row(s) for User B during D5's rejected request"
else
  fail "no D5 window recorded ($E2E_OUT/d5-window); run D5 first"
fi
pass
