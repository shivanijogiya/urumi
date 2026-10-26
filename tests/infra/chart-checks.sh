#!/usr/bin/env bash
# Offline checks for charts/platform (no cluster needed). For each values file it renders the
# chart with `helm template` and asserts that:
#   - every container (incl. init containers) in a Deployment/StatefulSet has livenessProbe,
#     readinessProbe, resources.requests and resources.limits
#   - every container (incl. init containers) in a Job has resources.requests and
#     resources.limits (Jobs run to completion: exempt from the probe requirement)
#   - no `kind: Secret` is rendered (the chart only references an existing Secret)
#   - at least one workload is rendered (guards against an empty render passing silently)
#   - NetworkPolicies (networkPolicy.enabled): a namespace default-deny with podSelector {} and
#     policyTypes Ingress + Egress is rendered, and every workload's pod template is selected by at
#     least one other (allow) policy, so default deny never silently cuts a workload off
# YAML -> JSON uses `kubectl annotate --local` (no API server); node does the assertions.
# Each values file is rendered as is and with the gateway canary enabled (+canary).
# Prints PASS/FAIL per variant; exits non-zero if any check fails.
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
let jobs = 0;
for (const d of docs) {
  const id = `${d.kind}/${d.metadata && d.metadata.name}`;
  if (d.kind === "Secret") problems.push(`${id}: chart must not render a Secret`);
  const isJob = d.kind === "Job";
  if (d.kind !== "Deployment" && d.kind !== "StatefulSet" && !isJob) continue;
  if (isJob) jobs++;
  else workloads++;
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
      // Init containers and Jobs run to completion; probes do not apply to them.
      const isInit = (spec.initContainers || []).includes(c);
      if ((isInit || isJob) && what.endsWith("Probe")) continue;
      if (!ok) problems.push(`${id} container ${c.name}: missing ${what}`);
    }
  }
}
if (workloads === 0) problems.push("no Deployment/StatefulSet rendered");
const policies = docs.filter((d) => d.kind === "NetworkPolicy");
const selects = (sel, labels) =>
  Object.entries(sel.matchLabels || {}).every(([k, v]) => labels[k] === v) &&
  (sel.matchExpressions || []).every((e) => e.operator === "In" && e.values.includes(labels[e.key]));
const isDefaultDeny = (p) =>
  Object.keys(p.spec.podSelector || {}).length === 0 && !p.spec.ingress && !p.spec.egress;
if (process.env.EXPECT_NETPOL === "1") {
  const deny = policies.find(isDefaultDeny);
  if (!deny) problems.push("no default-deny NetworkPolicy (podSelector {}, no rules)");
  else if (!["Ingress", "Egress"].every((t) => (deny.spec.policyTypes || []).includes(t)))
    problems.push(`NetworkPolicy/${deny.metadata.name}: default deny must cover Ingress and Egress`);
  for (const d of docs) {
    if (!["Deployment", "StatefulSet", "Job"].includes(d.kind)) continue;
    const labels = (d.spec.template.metadata || {}).labels || {};
    const allows = policies.filter(
      (p) => !isDefaultDeny(p) && Object.keys(p.spec.podSelector).length && selects(p.spec.podSelector, labels),
    );
    if (!allows.length) problems.push(`${d.kind}/${d.metadata.name}: no allow NetworkPolicy selects its pods`);
  }
}
console.log(`  ${policies.length} NetworkPolicies`);
for (const p of problems) console.log("  " + p);
console.log(`  ${docs.length} objects, ${workloads} workloads + ${jobs} jobs checked`);
process.exit(problems.length ? 1 : 0);
'

failed=0
# <values file>[+canary]: +canary also renders the gateway canary (#23) with a fault injected.
for variant in values-local.yaml values-prod.yaml values-local.yaml+canary values-prod.yaml+canary; do
  values=${variant%+canary}
  extra=""
  [ "$variant" = "$values" ] || extra="--set gatewayCanary.enabled=true --set gatewayCanary.image.tag=c1 --set gatewayCanary.faultInject.errorRate=0.5"
  name="chart-checks ($variant)"
  # shellcheck disable=SC2086 # $extra is a list of flags
  if ! rendered=$(helm template urumi "$CHART" -n urumi -f "$CHART/$values" $extra "$@" 2>&1); then
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
  # Both shipped values files enable the default-deny NetworkPolicies.
  if printf '%s\n' "$json" | EXPECT_NETPOL=1 node -e "$CHECK_JS"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    failed=1
  fi
done

exit "$failed"
