#!/usr/bin/env bash
# Import local images into a k3d cluster and verify they landed (#24).
# `k3d image import` can log "ctr: open /k3d/images/...tar: no such file or directory" under
# Docker-in-Docker and still exit 0; the pod then sits in ImagePullBackOff until helm times out.
# So: import with --mode direct (no tools container), confirm each image with crictl on every
# node, retry up to 3 times (direct, tools-node, direct), and fail loudly otherwise.
# Usage: scripts/canary/k3d-import.sh <cluster> <image:tag>...
set -euo pipefail
cluster=${1:?cluster name}
shift
[ "$#" -gt 0 ] || { echo "usage: $0 <cluster> <image:tag>..." >&2; exit 2; }

nodes() { k3d node list -o json | jq -r --arg c "$cluster" '.[] | select(.runtimeLabels["k3d.cluster"] == $c and (.role == "server" or .role == "agent")) | .name'; }

present() { # image on every node?
  local img=$1 n ref
  case "$img" in */*) ref=$img ;; *) ref="docker.io/library/$img" ;; esac
  for n in $(nodes); do
    docker exec "$n" crictl images -o json 2>/dev/null |
      jq -e --arg r "$ref" '[.images[].repoTags[]] | index($r) != null' >/dev/null || return 1
  done
}

attempt=0
for mode in direct tools-node direct; do # direct first; tools-node handles what direct can't
  attempt=$((attempt + 1))
  k3d image import --mode "$mode" "$@" -c "$cluster" >/dev/null 2>&1 || true
  missing=()
  for img in "$@"; do present "$img" || missing+=("$img"); done
  [ "${#missing[@]}" -eq 0 ] && { echo "imported into $cluster: $*"; exit 0; }
  echo "k3d import attempt $attempt: missing ${missing[*]}" >&2
  sleep $((attempt * 3))
done
echo "ERROR: images not present in k3d cluster $cluster after 3 attempts: ${missing[*]}" >&2
exit 1
