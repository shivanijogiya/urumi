#!/bin/sh
# Derive a deterministic Helm chart version + appVersion for the release pipeline (issue #22).
#
#   Tag pipeline (CI_COMMIT_TAG=v1.2.3 or v1.2.3-rc.1)
#       CHART_VERSION=1.2.3          CHART_APP_VERSION=1.2.3
#   Any other pipeline
#       CHART_VERSION=<X.Y.Z from Chart.yaml>-g<first 8 chars of CI_COMMIT_SHA>
#       CHART_APP_VERSION=<CI_COMMIT_SHA>
#
# CHART_APP_VERSION is always an image tag the release jobs push, so templates can
# default image.tag to .Chart.AppVersion. Prints dotenv lines on stdout; on any
# ambiguity it exits non-zero with instructions instead of guessing.
#
# Usage: sh .gitlab/ci/scripts/chart-version.sh <chart-dir>
set -eu

die() { printf 'chart-version: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 1 ] && [ -n "$1" ] || die "usage: chart-version.sh <chart-dir>"
chart_yaml="$1/Chart.yaml"

sha="${CI_COMMIT_SHA:-}"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$' \
  || die "CI_COMMIT_SHA must be a 40-character commit SHA (got '$sha')."

semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
tag="${CI_COMMIT_TAG:-}"

if [ -n "$tag" ]; then
  printf '%s' "$tag" | grep -Eq "^v${semver}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?\$" \
    || die "tag '$tag' is not a release tag. Release tags must look like v1.2.3 or v1.2.3-rc.1 (no +build metadata)."
  version="${tag#v}"
  printf 'CHART_VERSION=%s\nCHART_APP_VERSION=%s\n' "$version" "$version"
  exit 0
fi

[ -f "$chart_yaml" ] \
  || die "$chart_yaml not found. Prerequisite: the Helm chart (charts/platform) must exist before a chart version can be derived."

base="$(sed -n 's/^version:[[:space:]]*//p' "$chart_yaml" | head -n 1 \
  | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')"
printf '%s' "$base" | grep -Eq "^${semver}\$" \
  || die "$chart_yaml has no plain X.Y.Z 'version:' (got '$base'). Set it to the next release base (e.g. version: 0.1.0) or push a v1.2.3 tag."

short="$(printf '%s' "$sha" | cut -c1-8)"
printf 'CHART_VERSION=%s-g%s\nCHART_APP_VERSION=%s\n' "$base" "$short" "$sha"
