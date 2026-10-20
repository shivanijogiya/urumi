#!/usr/bin/env bash
# The CI `canary` job (#23, H2; .gitlab/ci/canary.gitlab-ci.yml), runnable anywhere with Docker:
#   1. ephemeral k3d cluster `urumi` (ADR 000 Q9) with Traefik on port 80
#   2. builds the gateway, woo-mcp and everything images and imports them into k3d
#   3. generates .env.local (scripts/gen-env.sh) -> Secret urumi-env; no external secrets needed
#   4. installs the stable release (fault-free), seeds users + B's API key (tests/e2e/seed.sh
#      without the GitLab upstream)
#   5. deploys this commit as the canary (scripts/canary/run.sh deploy); CANARY_FORCE_BAD=1 injects
#      FAULT_INJECT_ERROR_RATE=$CANARY_BAD_ERROR_RATE (default 0.5) into the canary only
#   6. scripts/canary/verdict.py decides; PROMOTE -> run.sh promote, ROLLBACK/HOLD -> run.sh rollback
#   7. writes verdict.json and verdict.env (VERDICT=..., CANARY_ACTION=...) in the repo root
# Exit 0 when the decision was applied (PROMOTE promoted, ROLLBACK rolled back). Non-zero on HOLD
# (no decision possible), on any setup failure, or when CANARY_FORCE_BAD=1 was not rolled back.
#
# Env:
#   CANARY_FORCE_BAD        1 = forced bad release
#   CANARY_KUBE_HOST        rewrite the kubeconfig's API host (DinD: docker)
#   CANARY_INGRESS_IP       map app/store.localtest.me to this IP in /etc/hosts (DinD: docker's IP)
#   CANARY_TAG              canary image tag, default canary-<git short sha>
#   K3D_KEEP                1 = keep an existing cluster `urumi` (default: create, fail if it exists)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/../lib/common.sh"

CANARY_FORCE_BAD=${CANARY_FORCE_BAD:-0}
CANARY_BAD_ERROR_RATE=${CANARY_BAD_ERROR_RATE:-0.5}
CANARY_TAG=${CANARY_TAG:-canary-$(git -C "$ROOT" rev-parse --short HEAD)}
CHART="$ROOT/charts/platform"
VERDICT_JSON="$ROOT/verdict.json"
VERDICT_ENV="$ROOT/verdict.env"
KEY_FILE="$ROOT/tests/e2e/.out/userb2.key"

for c in docker k3d kubectl helm node jq curl python3 openssl git; do need "$c" "Install $c"; done

say "1/7 k3d cluster $CLUSTER_NAME"
if k3d cluster get "$CLUSTER_NAME" >/dev/null 2>&1; then
  [ "${K3D_KEEP:-0}" = 1 ] || die "cluster $CLUSTER_NAME already exists (K3D_KEEP=1 to reuse it)"
else
  k3d cluster create "$CLUSTER_NAME" --wait --timeout 300s \
    --api-port 0.0.0.0:6550 --port "80:80@loadbalancer" \
    --k3s-arg "--tls-san=${CANARY_KUBE_HOST:-127.0.0.1}@server:0"
fi
if [ -n "${CANARY_KUBE_HOST:-}" ]; then
  sed -i "s#https://0.0.0.0:6550#https://$CANARY_KUBE_HOST:6550#" "${KUBECONFIG:-$HOME/.kube/config}"
fi
if [ -n "${CANARY_INGRESS_IP:-}" ]; then
  echo "$CANARY_INGRESS_IP app.localtest.me store.localtest.me" >>/etc/hosts
fi
require_context
for _ in $(seq 1 90); do kc -n kube-system get deploy/traefik >/dev/null 2>&1 && break || sleep 2; done
kc -n kube-system rollout status deploy/traefik --timeout=180s

say "2/7 images"
for c in gateway woo-mcp everything; do
  docker build -q -f "$ROOT/apps/$c/Dockerfile" -t "urumi-$c:ci" "$ROOT" >/dev/null
done
k3d image import urumi-gateway:ci urumi-woo-mcp:ci urumi-everything:ci -c "$CLUSTER_NAME"

say "3/7 Secret urumi-env (generated)"
[ -f "$ROOT/.env.local" ] || "$ROOT/scripts/gen-env.sh"
kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f -
"$ROOT/scripts/secrets-apply.sh"

say "4/7 stable release + seed"
helm --kube-context "$KUBE_CONTEXT" upgrade --install urumi "$CHART" -n "$NAMESPACE" \
  -f "$CHART/values-local.yaml" -f "$ROOT/scripts/canary/values-ci.yaml" --wait --timeout 15m
E2E_SKIP_GITLAB=1 "$ROOT/tests/e2e/run.sh" seed ||
  die "seed failed: $(cat "$ROOT/tests/e2e/.out/seed.log" 2>/dev/null | tail -20)"

say "5/7 canary $CANARY_TAG"
fault=()
if [ "$CANARY_FORCE_BAD" = 1 ]; then
  warn "CANARY_FORCE_BAD=1: the canary fails $CANARY_BAD_ERROR_RATE of tools/call requests"
  fault=(--error-rate "$CANARY_BAD_ERROR_RATE")
fi
IMAGE_MODE=import "$ROOT/scripts/canary/run.sh" deploy "$CANARY_TAG" ${fault[@]+"${fault[@]}"}

say "6/7 verdict"
set +e
python3 "$ROOT/scripts/canary/verdict.py" --key-file "$KEY_FILE" --out "$VERDICT_JSON"
code=$?
set -e
case "$code" in
  0) verdict=PROMOTE action=promoted ;;
  1) verdict=ROLLBACK action=rolled-back ;;
  2) verdict=HOLD action=rolled-back ;;
  *) die "verdict.py failed (exit $code)" ;;
esac
if [ "$verdict" = PROMOTE ]; then
  IMAGE_MODE=none "$ROOT/scripts/canary/run.sh" promote "$CANARY_TAG"
else
  IMAGE_MODE=none "$ROOT/scripts/canary/run.sh" rollback "$CANARY_TAG"
fi
printf 'VERDICT=%s\nCANARY_ACTION=%s\nCANARY_TAG=%s\n' "$verdict" "$action" "$CANARY_TAG" >"$VERDICT_ENV"

say "7/7 result"
echo "================================================================"
echo " CANARY VERDICT: $verdict -> $action ($CANARY_TAG, force_bad=$CANARY_FORCE_BAD)"
jq -r '.reasons[] | "   - " + .' "$VERDICT_JSON"
echo "================================================================"
[ "$verdict" != HOLD ] || die "HOLD: not enough evidence to decide; canary rolled back"
if [ "$CANARY_FORCE_BAD" = 1 ] && [ "$verdict" != ROLLBACK ]; then
  die "forced bad release was not rolled back (verdict $verdict)"
fi
