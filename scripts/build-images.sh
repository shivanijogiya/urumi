#!/usr/bin/env bash
# Builds app images and pushes them to the local k3d registry (scripts/cluster-up.sh).
# For each component <c> with an apps/<c>/Dockerfile (default: all of them), builds with the repo
# root as context, tags localhost:5005/urumi-<c>:<git short sha> and :dev, pushes both, and prints
# the tags. In-cluster the same image is k3d-urumi-registry.localhost:5005/urumi-<c>:<tag>.
#   REGISTRY   push registry, default localhost:5005
#   scripts/build-images.sh [component...]      e.g. scripts/build-images.sh gateway
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib/common.sh"

REGISTRY=${REGISTRY:-localhost:5005}

need docker "Install Docker Desktop or colima"
need git "Install git"

if [ "$#" -gt 0 ]; then
  components="$*"
else
  components=""
  for f in "$ROOT"/apps/*/Dockerfile; do
    [ -f "$f" ] || continue
    components="$components $(basename "$(dirname "$f")")"
  done
fi
[ -n "${components// /}" ] || die "No apps/<component>/Dockerfile found"

sha=$(git -C "$ROOT" rev-parse --short HEAD)
# Mark images built from a dirty tree so a :<sha> tag never claims to be that exact commit.
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  sha="$sha-dirty"
fi

built=""
for c in $components; do
  dockerfile="$ROOT/apps/$c/Dockerfile"
  [ -f "$dockerfile" ] || die "No Dockerfile for '$c' ($dockerfile)"
  image="$REGISTRY/urumi-$c"
  say "Building $image:$sha"
  docker build -f "$dockerfile" -t "$image:$sha" -t "$image:dev" "$ROOT"
  for tag in "$sha" dev; do
    docker push "$image:$tag" >/dev/null
    built="$built $image:$tag"
  done
done

say "Pushed:"
for t in $built; do
  echo "  $t"
done
