#!/usr/bin/env bash
# The CI `canary` job (#23, H2; .gitlab/ci/canary.gitlab-ci.yml), runnable anywhere with Docker:
#   1. ephemeral k3d cluster `urumi` (ADR 000 Q9) with Traefik on port 80
#   2. builds the gateway, woo-mcp and everything images and imports them into k3d
#   3. generates .env.local (scripts/gen-env.sh) -> Secret urumi-env; no external secrets needed
#   4. installs the stable release (fault-free), seeds users + B's API key (tests/e2e/seed.sh
#      without the GitLab upstream)
#   5. deploys this commit as the canary (scripts/canary/run.sh deploy); CANARY_FORCE_BAD=1 injects
#      FAULT_INJECT_ERROR_RATE=$CANARY_BAD_ERROR_RATE (default 0.5) into the canary only
#   6. scripts/canary/verdict.py decides; PROMOTE -> run.sh promote, ROLLBACK/HOLD -> rollback.
#      A PROMOTE of a high-risk change (RISK, scripts/canary/risk.py) is not promoted: the canary
#      is rolled back and DECISION=PROMOTE_PENDING_APPROVAL waits for release:human-approval
#   7. writes verdict.json (verdict.py's report + decision, timeline, CI links) and verdict.env
#      (VERDICT=..., DECISION=..., CANARY_ACTION=...) in the repo root, and prints the report as
#      one `CANARY_VERDICT_JSON: {...}` log line for the incident flow (.gitlab/flows/incident.yaml)
# Exit 0 only on PROMOTE (promoted, or pending approval when high risk). Exit 1 on ROLLBACK
# ("RELEASE REJECTED: canary rolled back", so the pipeline fails and the incident flow's Pipeline
# Failed trigger fires), on HOLD (no decision possible), on any setup failure, and when
# CANARY_FORCE_BAD=1 was not rolled back. A forced bad release therefore always fails the job:
# DECISION and the log tell a drill that worked (ROLLBACK) from one that did not.
#
# Env:
#   CANARY_FORCE_BAD        1 = forced bad release
#   CANARY_KUBE_HOST        rewrite the kubeconfig's API host (DinD: docker)
#   CANARY_INGRESS_IP       map app/store.localtest.me to this IP in /etc/hosts (DinD: docker's IP)
#   CANARY_TAG              canary image tag, default canary-<git short sha>
#   K3D_KEEP                1 = keep an existing cluster `urumi` (default: create, fail if it exists)
#   RISK                    low|high from risk:classify; unset = run risk.py here; other = high
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
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

for c in docker k3d kubectl helm node jq curl python3 openssl git; do need "$c" "Install $c"; done

# Release risk (#24): CI passes RISK from risk:classify's dotenv; elsewhere classify here. Anything
# but an explicit `low` is high (fail closed): a PROMOTE then waits for release:human-approval.
if [ -z "${RISK:-}" ]; then
  python3 "$ROOT/scripts/canary/risk.py" --out "$ROOT/risk.json" --env "$ROOT/risk.env" || true
  RISK=$(sed -n 's/^RISK=//p' "$ROOT/risk.env" 2>/dev/null || true)
fi
[ "$RISK" = low ] || RISK=high
say "release risk: $RISK"

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
"$ROOT/scripts/canary/k3d-import.sh" "$CLUSTER_NAME" urumi-gateway:ci urumi-woo-mcp:ci urumi-everything:ci

say "3/7 Secret urumi-env (generated)"
[ -f "$ROOT/.env.local" ] || "$ROOT/scripts/gen-env.sh"
kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f -
"$ROOT/scripts/secrets-apply.sh"

say "4/7 stable release + seed"
helm --kube-context "$KUBE_CONTEXT" upgrade --install urumi "$CHART" -n "$NAMESPACE" \
  -f "$CHART/values-local.yaml" -f "$ROOT/scripts/canary/values-ci.yaml" --wait --timeout 15m || {
  # Shared runners are sometimes slow to pull/start the store; show why before failing.
  kc -n "$NAMESPACE" get pods -o wide || true
  kc -n "$NAMESPACE" get events --sort-by=.lastTimestamp | tail -30 || true
  die "stable install did not become ready within 15m"
}
E2E_SKIP_GITLAB=1 "$ROOT/tests/e2e/run.sh" seed ||
  die "seed failed: $(cat "$ROOT/tests/e2e/.out/seed.log" 2>/dev/null | tail -20)"

say "5/7 canary $CANARY_TAG"
fault=()
if [ "$CANARY_FORCE_BAD" = 1 ]; then
  warn "CANARY_FORCE_BAD=1: the canary fails $CANARY_BAD_ERROR_RATE of tools/call requests"
  fault=(--error-rate "$CANARY_BAD_ERROR_RATE")
fi
IMAGE_MODE=import "$ROOT/scripts/canary/run.sh" deploy "$CANARY_TAG" ${fault[@]+"${fault[@]}"}
canary_live_at=$(now)

say "6/7 verdict"
set +e
python3 "$ROOT/scripts/canary/verdict.py" --key-file "$KEY_FILE" --out "$VERDICT_JSON"
code=$?
set -e
verdict_at=$(now)
case "$code" in
  0) verdict=PROMOTE action=promoted ;;
  1) verdict=ROLLBACK action=rolled-back ;;
  2) verdict=HOLD action=rolled-back ;;
  *) die "verdict.py failed (exit $code)" ;;
esac
decision=$verdict
if [ "$verdict" = PROMOTE ] && [ "$RISK" != low ]; then
  # High-risk change: the verdict is recorded but nothing is promoted without a person.
  decision=PROMOTE_PENDING_APPROVAL action=rolled-back-pending-approval
fi
if [ "$decision" = PROMOTE ]; then
  IMAGE_MODE=none "$ROOT/scripts/canary/run.sh" promote "$CANARY_TAG"
else
  IMAGE_MODE=none "$ROOT/scripts/canary/run.sh" rollback "$CANARY_TAG"
fi
applied_at=$(now)
printf 'VERDICT=%s\nDECISION=%s\nCANARY_ACTION=%s\nCANARY_TAG=%s\n' \
  "$verdict" "$decision" "$action" "$CANARY_TAG" >"$VERDICT_ENV"
# Record the decision next to the measurements (record.jq).
jq -f "$ROOT/scripts/canary/record.jq" --arg decision "$decision" --arg action "$action" \
  --arg tag "$CANARY_TAG" --arg force_bad "$CANARY_FORCE_BAD" --arg risk "$RISK" \
  --arg weight "${CANARY_WEIGHT:-20}" --arg live "$canary_live_at" --arg verdict_at "$verdict_at" \
  --arg applied "$applied_at" --arg pipeline_id "${CI_PIPELINE_ID:-}" \
  --arg pipeline_url "${CI_PIPELINE_URL:-}" --arg job_name "${CI_JOB_NAME:-}" \
  --arg job_url "${CI_JOB_URL:-}" --arg sha "$(git -C "$ROOT" rev-parse HEAD)" \
  --arg ref "${CI_COMMIT_REF_NAME:-}" "$VERDICT_JSON" >"$VERDICT_JSON.tmp"
mv "$VERDICT_JSON.tmp" "$VERDICT_JSON"

say "7/7 result"
echo "================================================================"
echo " CANARY VERDICT: $verdict -> $decision, $action ($CANARY_TAG, force_bad=$CANARY_FORCE_BAD)"
jq -r '.reasons[] | "   - " + .' "$VERDICT_JSON"
echo "================================================================"
# One machine-readable line for the incident flow, which reads this job's log.
echo "CANARY_VERDICT_JSON: $(jq -c . "$VERDICT_JSON")"
[ "$verdict" != HOLD ] || die "HOLD: not enough evidence to decide; canary rolled back"
if [ "$CANARY_FORCE_BAD" = 1 ] && [ "$verdict" != ROLLBACK ]; then
  die "forced bad release was not rolled back (verdict $verdict)"
fi
if [ "$verdict" = ROLLBACK ]; then
  [ "$CANARY_FORCE_BAD" != 1 ] || warn "forced bad release drill: ROLLBACK is the expected outcome"
  die "RELEASE REJECTED: canary rolled back"
fi
if [ "$decision" = PROMOTE_PENDING_APPROVAL ]; then
  say "HIGH RISK: verdict PROMOTE, not promoted. A person must run release:human-approval."
fi
