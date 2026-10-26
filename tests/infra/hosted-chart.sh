#!/usr/bin/env bash
# Offline checks for the hosted-MCP-server RBAC and isolation in charts/platform (ADR 014). Renders
# the chart with `helm template` and asserts that:
#   - no ClusterRole / ClusterRoleBinding is rendered at all;
#   - the gateway's Role lives in the hosted namespace and grants EXACTLY:
#       apps/deployments get,list,create,patch,delete; services + secrets create,patch,delete;
#       pods get,list — no wildcards, no pods/exec|log|attach, no RBAC, no Secret reads;
#   - its RoleBinding (in the hosted namespace) binds only the gateway ServiceAccount of the release
#     namespace; the ServiceAccount has automountServiceAccountToken false;
#   - the hosted namespace enforces Pod Security `restricted` and has a default deny (Ingress +
#     Egress), ingress only from the gateway, internet egress only for the egress label;
#   - the gateway pods use that ServiceAccount with a projected, expiring token;
#   - with hosted.enabled=false none of it is rendered and the gateway has no ServiceAccount token.
#   tests/infra/hosted-chart.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHART="$ROOT/charts/platform"
for cmd in helm kubectl node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "FAIL '$cmd' not found on PATH"
    exit 1
  }
done

render() { # render <values file> [helm args...] -> JSON documents on stdout
  local values=$1
  shift
  helm template urumi "$CHART" -n urumi -f "$CHART/$values" "$@" |
    kubectl --kubeconfig /dev/null annotate --local -f - hosted-chart=1 -o json
}

# shellcheck disable=SC2016 # JS source, not shell
CHECK_JS='
const raw = require("fs").readFileSync(0, "utf8").trim();
const docs = raw ? JSON.parse("[" + raw.replace(/\n}\n{/g, "\n},\n{") + "]") : [];
const enabled = process.env.HOSTED === "1";
const NS = "urumi-hosted";
const problems = [];
const of = (kind) => docs.filter((d) => d.kind === kind);
for (const k of ["ClusterRole", "ClusterRoleBinding"]) if (of(k).length) problems.push(`renders a ${k}`);
const roles = of("Role").filter((r) => r.metadata.name.endsWith("hosted-manager"));
const gwDeploy = of("Deployment").find((d) => d.metadata.name === "urumi-gateway");
const pod = gwDeploy.spec.template.spec;
const gwSa = of("ServiceAccount").find((s) => s.metadata.name === "urumi-gateway");
if (!enabled) {
  if (roles.length) problems.push("hosted Role rendered while hosted.enabled=false");
  if (of("Namespace").length) problems.push("Namespace rendered while hosted.enabled=false");
  if (gwSa) problems.push("gateway ServiceAccount rendered while hosted.enabled=false");
  if (pod.serviceAccountName) problems.push("gateway pod has a serviceAccountName while hosted is off");
  if ((pod.volumes || []).some((v) => v.projected)) problems.push("gateway pod mounts a token while hosted is off");
  if (pod.automountServiceAccountToken !== false) problems.push("gateway automounts a token");
} else {
  if (roles.length !== 1) problems.push(`expected 1 hosted Role, got ${roles.length}`);
  const role = roles[0] || { metadata: {}, rules: [] };
  if (role.metadata.namespace !== NS) problems.push(`hosted Role is in namespace ${role.metadata.namespace}, not ${NS}`);
  const want = {
    "apps/deployments": "create,delete,get,list,patch",
    "/services": "create,delete,patch",
    "/secrets": "create,delete,patch",
    "/pods": "get,list",
  };
  const got = {};
  for (const r of role.rules) {
    for (const g of r.apiGroups) for (const res of r.resources) {
      if (r.resourceNames) problems.push("unexpected resourceNames");
      got[`${g}/${res}`] = [...r.verbs].sort().join(",");
      if (r.verbs.includes("*") || res.includes("*") || g === "*") problems.push(`wildcard in rule ${g}/${res}`);
    }
  }
  if (JSON.stringify(got, Object.keys(got).sort()) !== JSON.stringify(want, Object.keys(want).sort()))
    problems.push(`hosted Role rules are not minimal: ${JSON.stringify(got)}`);
  const rbs = of("RoleBinding").filter((b) => b.roleRef.name === role.metadata.name);
  if (rbs.length !== 1) problems.push(`expected 1 RoleBinding for the hosted Role, got ${rbs.length}`);
  for (const b of rbs) {
    if (b.metadata.namespace !== NS) problems.push(`RoleBinding is in ${b.metadata.namespace}`);
    if (b.roleRef.kind !== "Role") problems.push("RoleBinding does not reference a Role");
    const s = JSON.stringify(b.subjects);
    if (s !== JSON.stringify([{ kind: "ServiceAccount", name: "urumi-gateway", namespace: "urumi" }]))
      problems.push(`RoleBinding subjects: ${s}`);
  }
  if (!gwSa || gwSa.automountServiceAccountToken !== false) problems.push("gateway ServiceAccount missing or automounts");
  const hostedSa = of("ServiceAccount").find((s) => s.metadata.namespace === NS);
  if (!hostedSa || hostedSa.automountServiceAccountToken !== false) problems.push("hosted pods ServiceAccount missing or automounts");
  const ns = of("Namespace").find((n) => n.metadata.name === NS);
  if (!ns || ns.metadata.labels["pod-security.kubernetes.io/enforce"] !== "restricted")
    problems.push("hosted Namespace missing or not enforcing Pod Security restricted");
  if (pod.serviceAccountName !== "urumi-gateway") problems.push("gateway pod does not use its ServiceAccount");
  if (pod.automountServiceAccountToken !== false) problems.push("gateway automounts a token");
  const proj = (pod.volumes || []).find((v) => v.projected);
  const tok = proj && proj.projected.sources.find((s) => s.serviceAccountToken);
  if (!tok || !(tok.serviceAccountToken.expirationSeconds <= 3600)) problems.push("gateway token is not projected with a <= 1 h expiry");
  const nps = of("NetworkPolicy").filter((p) => p.metadata.namespace === NS);
  const deny = nps.find((p) => Object.keys(p.spec.podSelector).length === 0 && !p.spec.ingress && !p.spec.egress);
  if (!deny || !["Ingress", "Egress"].every((t) => deny.spec.policyTypes.includes(t))) problems.push("no default deny in the hosted namespace");
  const ingress = nps.filter((p) => p.spec.ingress);
  if (ingress.length !== 1 || ingress[0].spec.ingress[0].from[0].podSelector.matchExpressions[0].values[0] !== "gateway")
    problems.push("hosted ingress is not exactly from the gateway pods");
  const internet = nps.find((p) => p.metadata.name === "hosted-internet-egress");
  if (!internet || internet.spec.podSelector.matchLabels["urumi.io/hosted-egress"] !== "internet")
    problems.push("internet egress is not limited to the egress label");
  const except = internet ? internet.spec.egress[0].to[0].ipBlock.except : [];
  for (const c of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"])
    if (!except.includes(c)) problems.push(`internet egress does not exclude ${c}`);
  if (!of("ResourceQuota").some((q) => q.metadata.namespace === NS)) problems.push("no ResourceQuota in the hosted namespace");
  const gwEgress = of("NetworkPolicy").find((p) => p.metadata.name === "urumi-gateway-egress");
  if (!JSON.stringify(gwEgress.spec.egress).includes(NS)) problems.push("gateway egress does not allow the hosted namespace");
}
for (const p of problems) console.log("  " + p);
process.exit(problems.length ? 1 : 0);
'

failed=0
check() { # check <name> <HOSTED 0|1> <values> [helm args...]
  local name=$1 hosted=$2 values=$3
  shift 3
  if render "$values" "$@" | HOSTED=$hosted node -e "$CHECK_JS"; then
    echo "PASS hosted-chart ($name)"
  else
    echo "FAIL hosted-chart ($name)"
    failed=1
  fi
}
check "values-local.yaml" 1 values-local.yaml
check "values-prod.yaml" 1 values-prod.yaml
check "values-local.yaml+canary" 1 values-local.yaml --set gatewayCanary.enabled=true --set gatewayCanary.image.tag=c1
check "hosted off" 0 values-local.yaml --set hosted.enabled=false
exit "$failed"
