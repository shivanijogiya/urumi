#!/usr/bin/env bash
# Creates the local k3d cluster `urumi` (1 server + 1 agent) with a local image
# registry, k3s's default Traefik ingress on ports 80/443, the `urumi` namespace, and the
# `urumi-env` Secret from .env.local. Idempotent: a second run changes nothing and exits 0.
#
# Overrides (env):
#   CLUSTER_NAME   default urumi
#   HTTP_PORT      host port for ingress HTTP, default 80 (use e.g. 8080 if 80 is busy)
#   HTTPS_PORT     host port for ingress HTTPS, default 443
#   REGISTRY_PORT  host port for the local registry, default 5005
# Ports are fixed when the cluster is created; to change them, cluster-down.sh first.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

HTTP_PORT=${HTTP_PORT:-80}
HTTPS_PORT=${HTTPS_PORT:-443}
REGISTRY_PORT=${REGISTRY_PORT:-5005}
# k3d prefixes the name with `k3d-`, so the registry is k3d-urumi-registry.localhost.
REGISTRY_NAME=${CLUSTER_NAME}-registry.localhost
REGISTRY_HOST=k3d-${REGISTRY_NAME}

need docker "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
need k3d "Install it with: brew install k3d (or scripts/dev-setup.sh)"
need kubectl "Install it with: brew install kubectl (or scripts/dev-setup.sh)"
need helm "Install it with: brew install helm (or scripts/dev-setup.sh)"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and retry."

# port_free <port>: true when nothing on the host listens on it (best effort; needs lsof).
port_free() {
  have lsof || return 0
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# --- Registry -------------------------------------------------------------------------
if k3d registry get "$REGISTRY_HOST" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_HOST" 2>/dev/null)" != "true" ]; then
    say "Starting stopped registry $REGISTRY_HOST"
    docker start "$REGISTRY_HOST" >/dev/null
  else
    say "Registry $REGISTRY_HOST:$REGISTRY_PORT exists"
  fi
else
  port_free "$REGISTRY_PORT" ||
    die "port $REGISTRY_PORT is in use; re-run with REGISTRY_PORT=<free port>."
  say "Creating registry $REGISTRY_HOST:$REGISTRY_PORT"
  k3d registry create "$REGISTRY_NAME" --port "$REGISTRY_PORT"
fi

# --- Cluster --------------------------------------------------------------------------
# `k3d cluster get` prints e.g. "urumi 1/1 1/1 true"; column 2 is running/total servers.
if k3d cluster get "$CLUSTER_NAME" >/dev/null 2>&1; then
  servers=$(k3d cluster get "$CLUSTER_NAME" --no-headers | awk '{print $2}')
  if [ "${servers%/*}" != "${servers#*/}" ] || [ "${servers%/*}" = "0" ]; then
    say "Starting stopped cluster $CLUSTER_NAME"
    k3d cluster start "$CLUSTER_NAME" --wait
  else
    say "Cluster $CLUSTER_NAME exists and is running"
  fi
  # Re-add the context if the kubeconfig was reset since the cluster was created.
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 ||
    k3d kubeconfig merge "$CLUSTER_NAME" --kubeconfig-merge-default >/dev/null
else
  port_free "$HTTP_PORT" ||
    die "port $HTTP_PORT is in use; re-run with HTTP_PORT=8080 (then use http://<host>.localtest.me:8080)."
  port_free "$HTTPS_PORT" ||
    die "port $HTTPS_PORT is in use; re-run with HTTPS_PORT=8443."
  say "Creating cluster $CLUSTER_NAME (1 server + 1 agent)"
  # k3s ships Traefik as the default ingress controller; we keep it.
  # k3s also embeds a NetworkPolicy controller (kube-router). Keep it enabled — do NOT
  # pass --disable-network-policy — our charts rely on NetworkPolicy being enforced
  # (woo-mcp accepts traffic only from the gateway). smoke-ingress.sh proves it works.
  k3d cluster create "$CLUSTER_NAME" \
    --servers 1 --agents 1 \
    --port "${HTTP_PORT}:80@loadbalancer" \
    --port "${HTTPS_PORT}:443@loadbalancer" \
    --registry-use "${REGISTRY_HOST}:${REGISTRY_PORT}" \
    --wait --timeout 300s
fi

kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 ||
  die "kubectl context $KUBE_CONTEXT missing after cluster setup."

# --- Ingress controller ---------------------------------------------------------------
# k3s installs Traefik through a Helm job, so the Deployment can appear a little after
# the API server is ready. Wait for it to exist, then for its rollout.
say "Waiting for Traefik"
i=0
until kc -n kube-system get deploy/traefik >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 90 ] || die "Traefik Deployment did not appear in kube-system within 180s."
  sleep 2
done
kc -n kube-system rollout status deploy/traefik --timeout=180s

# --- Namespace and Secret -------------------------------------------------------------
# Last, so a missing .env.local fails the script without leaving the cluster half-ready.
say "Namespace $NAMESPACE"
kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f -

say "Secret urumi-env from .env.local"
"$ROOT/scripts/secrets-apply.sh"

say "Cluster $CLUSTER_NAME is ready (kubectl context $KUBE_CONTEXT)"
port_suffix=""
[ "$HTTP_PORT" = "80" ] || port_suffix=":$HTTP_PORT"
cat <<EOF

Ingress:  http://<name>.localtest.me${port_suffix}  (*.localtest.me resolves to 127.0.0.1)
Registry: push from your machine to localhost:${REGISTRY_PORT}, reference it in-cluster as
          ${REGISTRY_HOST}:${REGISTRY_PORT}
  docker tag my-image:dev localhost:${REGISTRY_PORT}/my-image:dev
  docker push localhost:${REGISTRY_PORT}/my-image:dev
  # in manifests/values: image: ${REGISTRY_HOST}:${REGISTRY_PORT}/my-image:dev
Smoke test: scripts/smoke-ingress.sh
EOF
