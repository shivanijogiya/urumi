#!/bin/sh
# Lint and package the Helm chart for the release pipeline (issue #22).
#
# Works on a copy of <chart-dir>, so the checkout is never modified:
# 1. version + appVersion from chart-version.sh (appVersion = the image tag this pipeline pushes),
# 2. the placeholder image repositories registry.gitlab.com/<group>/<project>/<app> in
#    values*.yaml become $CI_REGISTRY_IMAGE/<app>, so the published chart's defaults pull the
#    images this pipeline pushed,
# 3. helm lint with the default values and with values-local.yaml / values-prod.yaml,
# 4. helm package into <dest-dir>.
#
# Prints dotenv lines (CHART_NAME, CHART_VERSION, CHART_APP_VERSION, CHART_PACKAGE) on stdout;
# helm output goes to stderr.
#
# Usage: sh .gitlab/ci/scripts/chart-package.sh <chart-dir> <dest-dir>
set -eu

die() { printf 'chart-package: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || die "usage: chart-package.sh <chart-dir> <dest-dir>"
[ -f "$1/Chart.yaml" ] || die "$1/Chart.yaml not found."
registry_image="${CI_REGISTRY_IMAGE:-}"
[ -n "$registry_image" ] || die "CI_REGISTRY_IMAGE must be set (the project's container registry path)."
command -v helm >/dev/null 2>&1 || die "helm is required."

here="$(cd "$(dirname "$0")" && pwd)"
versions="$(sh "$here/chart-version.sh" "$1")"
eval "$versions"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$1" "$work/chart"
chart="$work/chart"

for f in "$chart"/values*.yaml; do
  sed "s#registry\.gitlab\.com/<group>/<project>/#$registry_image/#g" "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
done
if grep -n '<group>/<project>' "$chart"/values*.yaml >&2; then
  die "image repository placeholders left in values (see above)."
fi

helm lint "$chart" >&2
for f in values-local.yaml values-prod.yaml; do
  [ -f "$chart/$f" ] || die "$1/$f not found."
  helm lint "$chart" -f "$chart/$f" >&2
done

name="$(sed -n 's/^name:[[:space:]]*//p' "$chart/Chart.yaml" | head -n 1 | tr -d "\"' ")"
[ -n "$name" ] || die "$1/Chart.yaml has no name."
mkdir -p "$2"
helm package "$chart" --version "$CHART_VERSION" --app-version "$CHART_APP_VERSION" --destination "$2" >&2

package="$2/$name-$CHART_VERSION.tgz"
[ -f "$package" ] || die "helm package did not produce $package."
printf '%s\nCHART_NAME=%s\nCHART_PACKAGE=%s\n' "$versions" "$name" "$package"
