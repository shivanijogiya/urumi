#!/usr/bin/env bash
# Deletes the local k3d cluster. Keeps the local registry (and its pushed images)
# unless --all is given. Destructive, so it requires --yes.
#   scripts/cluster-down.sh --yes          # delete the cluster
#   scripts/cluster-down.sh --yes --all    # delete the cluster and the registry
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

REGISTRY_HOST=k3d-${CLUSTER_NAME}-registry.localhost

yes=0
all=0
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --all) all=1 ;;
    -h | --help)
      sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg (expected --yes and optionally --all)" ;;
  esac
done

need k3d "Install it with: brew install k3d"

if [ "$yes" -ne 1 ]; then
  what="cluster '$CLUSTER_NAME'"
  [ "$all" -eq 1 ] && what="$what and registry '$REGISTRY_HOST'"
  die "this deletes $what and all data in it. Re-run with --yes to confirm."
fi

if k3d cluster get "$CLUSTER_NAME" >/dev/null 2>&1; then
  say "Deleting cluster $CLUSTER_NAME"
  k3d cluster delete "$CLUSTER_NAME"
else
  say "Cluster $CLUSTER_NAME does not exist"
fi

if [ "$all" -eq 1 ]; then
  if k3d registry get "$REGISTRY_HOST" >/dev/null 2>&1; then
    say "Deleting registry $REGISTRY_HOST"
    k3d registry delete "$REGISTRY_HOST"
  else
    say "Registry $REGISTRY_HOST does not exist"
  fi
else
  say "Kept registry $REGISTRY_HOST (pass --all to delete it too)"
fi
