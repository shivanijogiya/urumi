#!/usr/bin/env bash
# Offline checks for charts/platform (no cluster needed). For each values file it renders the
# chart with `helm template` and asserts that:
#   - every container (incl. init containers) in a Deployment/StatefulSet has livenessProbe,
#     readinessProbe, resources.requests and resources.limits
#   - no `kind: Secret` is rendered (the chart only references an existing Secret)
#   - at least one workload is rendered (guards against an empty render passing silently)
# YAML -> JSON uses `kubectl annotate --local` (no API server); node does the assertions.
# Prints PASS/FAIL per values file; exits non-zero if any check fails.
# Extra arguments go to `helm template` (e.g. to prove a check fails: --set mariadb.resources=null).
#   tests/infra/chart-checks.sh [helm template args...]
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHART="$ROOT/charts/platform"

for cmd in helm kubectl node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "FAIL '$cmd' not found on PATH"
    exit 1
  }
done

# shellcheck disable=SC2016 # JS source, not shell
CHECK_JS='
const raw =require("fs").readFileSync(0, "utf8").trim();
// kubectl prints one pretty JSON object per document, each starting with "{" at column 0.
const docs = raw ? JSON.parse("[" + raw.replace(/\n}\n{/g, "\n},\n{") + "]") : [];
const problems = [];
let workloads = 0;
for (const d of docs) {
  const id = `${d.kind}/${d.metadata && d.metadata.name}`;
  if (d.kind === "Secret") problems.push(`${id}: chart must not render a Secret`);
  if (d.kind !== "Deployment" && d.kind !== "StatefulSet") continue;
  workloads++;
  const spec = (d.spec && d.spec.template && d.spec.template.spec) || {};
  const containers = [...(spec.containers || []), ...(spec.initContainers || [])];
  if (containers.length === 0) problems.push(`${id}: no containers`);
  for (const c of containers) {
    const r = c.resources || {};
    for (const [ok, what] of [
      [c.livenessProbe, "livenessProbe"],
      [c.readinessProbe, "readinessProbe"],
      [r.requests && Object.keys(r.requests).length, "resources.requests"],
      [r.limits && Object.keys(r.limits).length, "resources.limits"],
    ]) {
      // Init containers run to completion; probes are not allowed on them.
      const isInit = (spec.initContainers || []).includes(c);
      if (isInit && what.endsWith("Probe")) continue;
      if (!ok) problems.push(`${id} container ${c.name}: missing ${what}`);
    }
  }
}
if (workloads === 0) problems.push("no Deployment/StatefulSet rendered");
for (const p of problems) console.log("  " + p);
console.log(`  ${docs.length} objects, ${workloads} workloads checked`);
process.exit(problems.length ? 1 : 0);
'

failed=0
for values in values-local.yaml values-prod.yaml; do
  name="chart-checks ($values)"
  if ! rendered=$(helm template urumi "$CHART" -n urumi -f "$CHART/$values" "$@" 2>&1); then
    echo "$rendered"
    echo "FAIL $name: helm template failed"
    failed=1
    continue
  fi
  if ! json=$(printf '%s\n' "$rendered" |
    kubectl --kubeconfig /dev/null annotate --local -f - chart-checks=1 -o json 2>&1); then
    echo "$json"
    echo "FAIL $name: rendered YAML did not parse"
    failed=1
    continue
  fi
  if printf '%s\n' "$json" | node -e "$CHECK_JS"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    failed=1
  fi
done

exit "$failed"
