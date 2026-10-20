# shellcheck shell=bash
# Gateway admin-API helpers for the e2e and infra scripts. Source it after scripts/lib/common.sh;
# do not run it. Works with macOS's bash 3.2.
#
#   gw_start     port-forward to the gateway Service (local port GW_PORT, default 18080); with
#                GW_URL set (e.g. http://app.localtest.me) it uses that URL (the app Ingress) instead
#   gw_login     sign in as the seed admin; the session cookie goes to $GW_JAR (tests/e2e/.out/)
#   gw_api <METHOD> <path> [body-on-stdin]   prints the response body; returns non-zero on HTTP >= 400
#   gw_stop      ends the port-forward (call it from the EXIT trap)
#
# Secrets: the seed admin's credentials are read from the Secret into variables of the
# subshell that runs node, which builds the JSON body from its environment; nothing secret is
# ever in an argv, echoed, or written to disk (the cookie jar holds only the session cookie).
# CSRF (#14): every body is application/json and no Origin header is sent, which the guard allows.

RELEASE=${RELEASE:-urumi}
ENV_SECRET=${ENV_SECRET:-urumi-env}
GW_PORT=${GW_PORT:-18080}
GW_URL=${GW_URL:-}
GW_BASE=${GW_URL:-http://127.0.0.1:$GW_PORT}
GW_OUT="$ROOT/tests/e2e/.out"
GW_JAR="$GW_OUT/gateway-cookies.txt"
GW_PF_PID=""
GW_PF_LOG="$GW_OUT/gateway-port-forward.log"

set +x

# secret_value <key>: one key of $ENV_SECRET, decoded. Only use it inside $(...) assignments.
secret_value() {
  kc -n "$NAMESPACE" get secret "$ENV_SECRET" -o "jsonpath={.data.$1}" | base64 -d
}

gw_start() {
  mkdir -p "$GW_OUT"
  kc -n "$NAMESPACE" rollout status "deploy/$RELEASE-gateway" --timeout=180s >/dev/null ||
    die "deploy/$RELEASE-gateway is not ready"
  if [ -n "$GW_URL" ]; then
    # Only /api and /mcp are routed by the Ingress; any HTTP answer means the gateway is there.
    # Right after a rollout the Ingress can briefly have no ready endpoint (502/503/000): retry.
    local _code _
    for _ in $(seq 1 30); do
      _code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$GW_BASE/api/auth/me")
      case "$_code" in 000 | 502 | 503 | 504) sleep 2 ;; *) break ;; esac
    done
    case "$_code" in 000 | 502 | 503 | 504) die "gateway not reachable on $GW_BASE (HTTP $_code)" ;; esac
    return 0
  fi
  kc -n "$NAMESPACE" port-forward "svc/$RELEASE-gateway" "$GW_PORT:80" >"$GW_PF_LOG" 2>&1 &
  GW_PF_PID=$!
  local _
  for _ in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 "$GW_BASE/healthz" && return 0
    kill -0 "$GW_PF_PID" 2>/dev/null || die "port-forward failed: $(cat "$GW_PF_LOG")"
    sleep 0.5
  done
  die "gateway not reachable on $GW_BASE"
}

gw_stop() {
  [ -n "$GW_PF_PID" ] && kill "$GW_PF_PID" 2>/dev/null || true
  GW_PF_PID=""
}

# gw_api <METHOD> <path>: request with the session cookie; a body, if any, comes on stdin.
gw_api() {
  local method=$1 path=$2 out code
  out=$(mktemp "$GW_OUT/resp.XXXXXX")
  if [ "$method" = GET ] || [ "$method" = DELETE ]; then
    code=$(curl -sS --max-time 20 -b "$GW_JAR" -c "$GW_JAR" -o "$out" -w '%{http_code}' \
      -X "$method" "$GW_BASE$path") || code=000
  else
    code=$(curl -sS --max-time 20 -b "$GW_JAR" -c "$GW_JAR" -o "$out" -w '%{http_code}' \
      -X "$method" -H 'content-type: application/json' --data-binary @- "$GW_BASE$path") || code=000
  fi
  cat "$out"
  rm -f "$out"
  [ "$code" -lt 400 ] 2>/dev/null || {
    warn "$method $path -> HTTP $code"
    return 1
  }
}

gw_login() {
  rm -f "$GW_JAR"
  (
    SEED_EMAIL=$(secret_value SEED_ADMIN_EMAIL)
    SEED_PASSWORD=$(secret_value SEED_ADMIN_PASSWORD)
    export SEED_EMAIL SEED_PASSWORD
    node -e 'process.stdout.write(JSON.stringify({ email: process.env.SEED_EMAIL, password: process.env.SEED_PASSWORD }))'
  ) | gw_api POST /api/auth/login >/dev/null || die "seed admin login failed"
}

# json <js-expression> : evaluates the expression with `d` = JSON on stdin, prints the result.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const d = JSON.parse(s);
      const v = (0, eval)("(d) => (" + process.argv[1] + ")")(d);
      process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}
