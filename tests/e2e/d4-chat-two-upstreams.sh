#!/usr/bin/env bash
# D4 (User A, real Claude API): one chat prompt that needs two different upstreams, read-only and
# deterministic: everything's echo + today's store orders. toolCalls must contain at least one
# everything__ and one woo__ call, and the reply must contain the echoed text.
set -uo pipefail
STEP=${STEP:-D4}
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../../scripts/lib/common.sh"
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/e2e.sh"
load_state

code=$(chat "$A_JAR" "Use the tools: call everything's echo tool with message 'urumi' and list today's store orders. Reply with the echo text and the number of orders.")
[ "$code" = 200 ] || fail "chat -> HTTP $code: $(err_of)"
expect_chat_calls A
calls=$(jq -c '[.toolCalls[] | "\(.name):\(.outcome)"]' "$LAST")
note "toolCalls: $calls"
note "chat reply: $(jq -r .reply "$LAST" | head -c 300)"
jq -e '[.toolCalls[] | select(.serverSlug == "everything" and .outcome == "ok")] | length > 0' "$LAST" >/dev/null ||
  fail "no successful everything__ call in toolCalls: $calls"
jq -e '[.toolCalls[] | select(.serverSlug == "woo" and .outcome == "ok")] | length > 0' "$LAST" >/dev/null ||
  fail "no successful woo__ call in toolCalls: $calls"
jq -r .reply "$LAST" | grep -qi urumi || fail "reply does not contain the echo text 'urumi'"
pass
