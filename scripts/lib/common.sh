# shellcheck shell=bash disable=SC2034
# Shared helpers for the local-cluster scripts. Source it; do not run it.
# Works with macOS's bash 3.2 (no associative arrays, no mapfile).
# (SC2034: the variables here are used by the scripts that source this file.)

# Repo root, resolved from this file's location so scripts work from any cwd.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

CLUSTER_NAME=${CLUSTER_NAME:-urumi}
NAMESPACE=${NAMESPACE:-urumi}
# Every kubectl call is pinned to the k3d context so a script never touches
# another cluster that happens to be the current context.
KUBE_CONTEXT=${KUBE_CONTEXT:-k3d-${CLUSTER_NAME}}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# need <cmd> <install hint>
need() {
  have "$1" || die "'$1' not found on PATH. $2"
}

kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

require_context() {
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 ||
    die "kubectl context '$KUBE_CONTEXT' not found. Run scripts/cluster-up.sh first."
}
