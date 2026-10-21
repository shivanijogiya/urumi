#!/usr/bin/env bash
# Demo regression (#28; scripts/demo/README.md). Creates branch demo/faster-tool-results in a
# worktree under .hermes/ with ONE innocent-looking gateway change: tools/call refuses a page of a
# paginated tool (inputSchema has `per_page`) over 4 KB, "so pages stay fast".
#   - `npm test -w apps/gateway` still passes: the unit tests' fake upstream has no paginated tool,
#     and every size test is about MAX_RESULT_BYTES (256 KB), which is unchanged.
#   - In a cluster with real orders it breaks the business path: a normal woo__list_orders page
#     (20 of today's orders with line items, ~6-9 KB) now fails with "Tool result too large". The
#     canary seeds today's orders (scripts/canary/seed-orders.sh), so verdict.py's woo__list_orders
#     check sees 0 % canary success and decides ROLLBACK.
#   - node scripts/demo/check-regression.mjs shows it offline: PASS without, FAIL with the change.
# Never pushes. Prints the `git push` and `glab mr create` commands to run by hand.
#
#   bash scripts/demo/regression.sh            create the branch + commit (base: HEAD)
#   bash scripts/demo/regression.sh --verify   also run the gateway unit tests and the check there
#   BASE=main bash scripts/demo/regression.sh  branch from another commit
# The worktree is .hermes/demo-faster-tool-results (git-ignored). An earlier one and the demo
# branch are replaced; the current branch and working tree are not touched.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BRANCH=demo/faster-tool-results
WT="$ROOT/.hermes/demo-faster-tool-results"
BASE=${BASE:-HEAD}
VERIFY=0
[ "${1:-}" = --verify ] && VERIFY=1

say() { printf '==> %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

base_sha=$(git -C "$ROOT" rev-parse --verify "$BASE^{commit}") || die "unknown BASE $BASE"
if git -C "$ROOT" worktree list --porcelain | grep -qxF "worktree $WT"; then
  git -C "$ROOT" worktree remove --force "$WT"
fi
rm -rf "$WT"
mkdir -p "$ROOT/.hermes"
say "worktree $WT on branch $BRANCH from ${base_sha:0:8}"
git -C "$ROOT" worktree add -q -B "$BRANCH" "$WT" "$base_sha"

say "applying the change (apps/gateway/src/core/limits.ts, call-tool.ts)"
git -C "$WT" apply --whitespace=nowarn - <<'PATCH'
diff --git a/apps/gateway/src/core/call-tool.ts b/apps/gateway/src/core/call-tool.ts
--- a/apps/gateway/src/core/call-tool.ts
+++ b/apps/gateway/src/core/call-tool.ts
@@ -17,7 +17,7 @@ import {
   type UpstreamClient,
 } from '../mcp-client/upstream-client.js';
 import { findUpstreamBySlug } from '../upstreams/repo.js';
-import { jsonBytes, MAX_RESULT_BYTES } from './limits.js';
+import { jsonBytes, MAX_PAGE_RESULT_BYTES, MAX_RESULT_BYTES } from './limits.js';
 import { isListable, type RegisteredTool, type ToolRegistry } from './registry.js';

 export const DEFAULT_CALL_TIMEOUT_MS = MCP_TIMEOUTS.callMs;
@@ -90,6 +90,12 @@ function isPlainObject(v: unknown): v is Record<string, unknown> {
   return typeof v === 'object' && v !== null && !Array.isArray(v);
 }

+/** A tool that returns pages: its inputSchema takes `per_page`. */
+function isPaginated(tool: RegisteredTool): boolean {
+  const props = tool.inputSchema.properties;
+  return isPlainObject(props) && 'per_page' in props;
+}
+
 export function createCallTool(deps: CallToolDeps): CallTool {
   const callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
   const notFound = () => new GatewayError('TOOL_NOT_FOUND', 'Tool not found');
@@ -177,7 +183,8 @@ export function createCallTool(deps: CallToolDeps): CallTool {
         throw toGatewayError(err, row.slug);
       }
       const resultBytes = jsonBytes(result);
-      if (resultBytes > MAX_RESULT_BYTES) throw tooLarge(resultBytes);
+      const maxBytes = isPaginated(tool) ? MAX_PAGE_RESULT_BYTES : MAX_RESULT_BYTES;
+      if (resultBytes > maxBytes) throw tooLarge(resultBytes);
       if (result.isError) {
         record.outcome = 'error';
         record.errorCode = 'UPSTREAM_ERROR';
diff --git a/apps/gateway/src/core/limits.ts b/apps/gateway/src/core/limits.ts
--- a/apps/gateway/src/core/limits.ts
+++ b/apps/gateway/src/core/limits.ts
@@ -8,6 +8,12 @@ export const MAX_TOOLS_PER_UPSTREAM = 200;
 export const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;
 /** tools/call: a JSON-serialised result over this (UTF-8 bytes) fails with UPSTREAM_ERROR. */
 export const MAX_RESULT_BYTES = 256 * 1024;
+/**
+ * tools/call: a page of a paginated tool (its inputSchema has `per_page`) over this (UTF-8 bytes)
+ * fails like an oversized result. Big pages are slow to ship to MCP clients and to the chat model,
+ * and the caller can always ask for a smaller `per_page`.
+ */
+export const MAX_PAGE_RESULT_BYTES = 4 * 1024;
 /**
  * tools/call: raw HTTP response body bytes read before the upstream is cut off (same error). The
  * body wraps the result in a JSON-RPC envelope (and SSE framing), hence the slack; the check on
PATCH
git -C "$WT" add apps/gateway/src/core/limits.ts apps/gateway/src/core/call-tool.ts
git -C "$WT" -c user.name="${GIT_AUTHOR_NAME:-Demo Developer}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-demo@urumi.test}" commit -q -F - <<'MSG'
perf(gateway): cap paginated tool results at 4 KB so pages stay fast

A page of a paginated tool (inputSchema takes per_page) over 4 KB now fails like an oversized
result. Big pages are slow to ship to MCP clients and to the chat model; callers can ask for a
smaller per_page. Other tools keep the 256 KB cap.
MSG
say "committed $(git -C "$WT" rev-parse --short HEAD) on $BRANCH"

if [ "$VERIFY" = 1 ]; then
  say "gateway unit tests on $BRANCH (expected: pass)"
  (cd "$WT/apps/gateway" && npx vitest run --maxWorkers=2) || die "gateway tests failed on $BRANCH"
  say "realistic woo__list_orders page on $BRANCH (expected: FAIL)"
  if node "$WT/scripts/demo/check-regression.mjs"; then
    die "check-regression passed on $BRANCH: the regression is not reproduced"
  fi
  say "reproduced: unit tests pass, a realistic page fails"
fi

cat <<EOF

Branch $BRANCH is ready in $WT (not pushed). To run the demo:

  git -C "$WT" push -u origin $BRANCH
  cd "$WT" && glab mr create --source-branch $BRANCH --target-branch main \\
    --title "perf(gateway): cap paginated tool results at 4 KB so pages stay fast" \\
    --description "Smaller pages come back faster. Unit tests pass." --yes

Then merge the MR (scripts/demo/README.md). Remove the worktree afterwards with:
  git -C "$ROOT" worktree remove --force "$WT"
EOF
