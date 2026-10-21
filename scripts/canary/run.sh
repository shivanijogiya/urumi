#!/usr/bin/env bash
# Canary of the gateway (#23, H2; docs/adr/003-canary.md) on an installed release:
#   scripts/canary/run.sh deploy <tag>     build the gateway image as <tag>, make it available to
#                                          the cluster, and run it as the canary: Deployment
#                                          <release>-gateway-canary receives CANARY_WEIGHT % of
#                                          /api + /mcp. FAULT_INJECT_ERROR_RATE (0..1) and
#                                          FAULT_INJECT_LATENCY_MS force a bad release (canary only);
#                                          or the flags --error-rate <0..1> --latency-ms <n>.
#   scripts/canary/run.sh promote <tag>    stable gateway image := <tag>; canary disabled
#   scripts/canary/run.sh rollback [<tag>] canary disabled; stable untouched
#   scripts/canary/run.sh status           current stable tag, canary state
# Idempotent: re-running a command converges on the same state (rollback/promote with nothing to
# do skip the upgrade). Every upgrade reuses the release's values (--reset-then-reuse-values) and
# changes only gateway(Canary) keys; --no-hooks, because the store bootstrap hook is unaffected.
#
# Env:
#   IMAGE_MODE      push (default): docker build + push to localhost:$REGISTRY_PORT (k3d registry,
#                   scripts/cluster-up.sh); import: docker build + k3d image import (CI, no
#                   registry); none: the image <repository>:<tag> already exists
#   REGISTRY_PORT   default 5005
#   CANARY_WEIGHT   default 20
#   RELEASE, NAMESPACE, CLUSTER_NAME, KUBE_CONTEXT, APP_URL (http://app.localtest.me)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../lib/common.sh"

RELEASE=${RELEASE:-urumi}
IMAGE_MODE=${IMAGE_MODE:-push}
REGISTRY_PORT=${REGISTRY_PORT:-5005}
CANARY_WEIGHT=${CANARY_WEIGHT:-20}
APP_URL=${APP_URL:-http://app.localtest.me}
CHART="$ROOT/charts/platform"
HELM_TIMEOUT=${HELM_TIMEOUT:-5m}

usage() {
  die "usage: scripts/canary/run.sh deploy <tag> [--error-rate X] [--latency-ms N] | promote <tag> | rollback [<tag>] | status"
}
[ "$#" -ge 1 ] || usage
cmd=$1
tag=${2:-}
shift
[ "$#" -eq 0 ] || shift
# deploy flags (override the env vars): --error-rate <0..1> --latency-ms <n>
while [ "$#" -gt 0 ]; do
  case "$1" in
    --error-rate) FAULT_INJECT_ERROR_RATE=${2:-} && shift 2 ;;
    --latency-ms) FAULT_INJECT_LATENCY_MS=${2:-} && shift 2 ;;
    *) usage ;;
  esac
done

need helm "Install it with: brew install helm"
need kubectl "Install it with: brew install kubectl"
need curl "Install curl"
need node "Install Node.js 22"
require_context

GW="$RELEASE-gateway"
CANARY="$RELEASE-gateway-canary"

valid_tag() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'; }
valid_num() { printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; }

# value <dotted.path> : one computed value of the release (empty if unset).
value() {
  helm --kube-context "$KUBE_CONTEXT" -n "$NAMESPACE" get values "$RELEASE" -a -o json |
    node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        let v = JSON.parse(s);
        for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
        process.stdout.write(v == null ? "" : String(v));
      });' "$1"
}

upgrade() {
  helm --kube-context "$KUBE_CONTEXT" -n "$NAMESPACE" upgrade "$RELEASE" "$CHART" \
    --reset-then-reuse-values --no-hooks --wait --timeout "$HELM_TIMEOUT" "$@" >/dev/null
}

# track_seen <track> <tries> : true once an /api response through the Ingress carries that track.
track_seen() {
  local i
  for i in $(seq 1 "$2"); do
    curl -s -o /dev/null -D - --max-time 5 "$APP_URL/api/auth/me" | tr -d '\r' |
      grep -qi "^x-urumi-track: $1\$" && return 0
    [ $((i % 10)) = 0 ] && sleep 1
  done
  return 1
}

build_image() {
  local repo=$1
  need docker "Install Docker Desktop or colima"
  case "$IMAGE_MODE" in
    push)
      local push="localhost:$REGISTRY_PORT/${repo##*/}:$tag"
      say "Building $push"
      docker build -q -f "$ROOT/apps/gateway/Dockerfile" -t "$push" "$ROOT" >/dev/null
      docker push -q "$push" >/dev/null
      ;;
    import)
      need k3d "Install k3d"
      say "Building $repo:$tag and importing it into k3d cluster $CLUSTER_NAME"
      docker build -q -f "$ROOT/apps/gateway/Dockerfile" -t "$repo:$tag" "$ROOT" >/dev/null
      "$ROOT/scripts/canary/k3d-import.sh" "$CLUSTER_NAME" "$repo:$tag" >/dev/null
      ;;
    none) say "Using existing image $repo:$tag" ;;
    *) die "IMAGE_MODE must be push, import or none" ;;
  esac
}

status() {
  local enabled
  enabled=$(value gatewayCanary.enabled)
  echo "stable: $(value gateway.image.repository):$(value gateway.image.tag)"
  if [ "$enabled" = true ]; then
    echo "canary: $(value gatewayCanary.image.tag) at $(value gatewayCanary.weight)%" \
      "(faultInject errorRate=$(value gatewayCanary.faultInject.errorRate)" \
      "latencyMs=$(value gatewayCanary.faultInject.latencyMs))"
  else
    echo "canary: disabled"
  fi
}

case "$cmd" in
  deploy)
    valid_tag "$tag" || usage
    err=${FAULT_INJECT_ERROR_RATE:-0} lat=${FAULT_INJECT_LATENCY_MS:-0}
    valid_num "$err" || die "FAULT_INJECT_ERROR_RATE must be a number 0..1"
    printf '%s' "$lat" | grep -Eq '^[0-9]+$' || die "FAULT_INJECT_LATENCY_MS must be an integer"
    printf '%s' "$CANARY_WEIGHT" | grep -Eq '^[0-9]+$' || die "CANARY_WEIGHT must be 0..100"
    repo=$(value gateway.image.repository)
    [ -n "$repo" ] || die "release $RELEASE not found in namespace $NAMESPACE"
    build_image "$repo"
    [ "$err" = 0 ] && [ "$lat" = 0 ] || warn "FORCED BAD RELEASE: errorRate=$err latencyMs=$lat"
    say "Deploying canary $tag ($CANARY_WEIGHT% of /api + /mcp)"
    upgrade --set gatewayCanary.enabled=true \
      --set-string gatewayCanary.image.tag="$tag" \
      --set gatewayCanary.weight="$CANARY_WEIGHT" \
      --set gatewayCanary.faultInject.errorRate="$err" \
      --set gatewayCanary.faultInject.latencyMs="$lat"
    kc -n "$NAMESPACE" rollout status "deploy/$CANARY" --timeout=180s >/dev/null
    kc -n "$NAMESPACE" rollout status "deploy/$GW" --timeout=180s >/dev/null
    # Traefik picks up the IngressRoute asynchronously; wait until the canary answers.
    track_seen canary 100 || die "the canary is not receiving traffic through $APP_URL"
    say "Canary $tag is live"
    ;;
  promote)
    valid_tag "$tag" || usage
    if [ "$(value gateway.image.tag)" = "$tag" ] && [ "$(value gatewayCanary.enabled)" != true ]; then
      say "Stable already runs $tag and no canary is deployed: nothing to do"
    else
      say "Promoting $tag to stable and removing the canary"
      upgrade --set-string gateway.image.tag="$tag" --set gatewayCanary.enabled=false \
        --set gatewayCanary.faultInject.errorRate=0 --set gatewayCanary.faultInject.latencyMs=0
      kc -n "$NAMESPACE" rollout status "deploy/$GW" --timeout=180s >/dev/null
    fi
    ;;
  rollback)
    [ -z "$tag" ] || valid_tag "$tag" || usage
    if [ "$(value gatewayCanary.enabled)" != true ]; then
      say "No canary is deployed: nothing to roll back"
    else
      say "Rolling back canary ${tag:-$(value gatewayCanary.image.tag)}; stable untouched"
      upgrade --set gatewayCanary.enabled=false \
        --set gatewayCanary.faultInject.errorRate=0 --set gatewayCanary.faultInject.latencyMs=0
    fi
    kc -n "$NAMESPACE" wait --for=delete "deploy/$CANARY" --timeout=120s >/dev/null 2>&1 || true
    ;;
  status) ;;
  *) usage ;;
esac

if [ "$cmd" != deploy ] && [ "$cmd" != status ]; then
  kc -n "$NAMESPACE" get "deploy/$CANARY" >/dev/null 2>&1 && die "deploy/$CANARY still exists"
  track_seen stable 10 || die "the stable gateway is not answering through $APP_URL"
fi
status
